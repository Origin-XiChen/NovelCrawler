# -*- coding: utf-8 -*-
"""WebRTC 扫码直连 —— 手机在任何网络(含校园网/流量)与 PC 点对点直连。

原理:
    PC 生成 offer(SDP) → 压缩 base64 编码 → 显示为二维码
    手机(任意网络)扫码得到 offer 文本 → 在信令页粘贴 → 生成 answer 二维码
    PC 摄像头扫 answer → 握手完成 → DataChannel 建立
    手机经 DataChannel 发送 JSON-RPC(HTTP 桥接),转发到本机 HTTP 服务。

依赖(可选): aiortc。未安装时 available=False,相关 API 返回降级提示。

协议(DataChannel 消息,均为 JSON 文本):
    请求:  {"id": 1, "method": "GET", "path": "/api/files", "query": ""}
    响应:  {"id": 1, "status": 200, "type": "json", "body": {...}}
          或 {"id": 1, "status": 200, "type": "b64", "body_b64": "...", "content_type": "..."}
"""
from __future__ import annotations

import asyncio
import base64
import collections
import json
import threading
import time
import urllib.request
import uuid
import zlib
from concurrent.futures import ThreadPoolExecutor

_events: "collections.deque[str]" = collections.deque(maxlen=200)
# HTTP 桥接线程池:forward() 是同步阻塞调用(urllib),必须丢到线程池执行。
# 否则会卡死会话的 asyncio 事件循环 —— ICE/DTLS/SCTP 心跳全部停摆,
# 大文件下载或打包时连接会被对端判定死亡而断开。
_bridge_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="wrtc-bridge")


def _ev(line: str) -> None:
    _events.append(f"[{time.strftime('%H:%M:%S')}] {line}")


def note(line: str) -> None:
    """供外部模块(gui_server)写入事件日志,前端状态面板会展示。"""
    _ev(line)


def available() -> bool:
    try:
        import aiortc  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


# STUN 服务器:Google 系 + 国内可达节点(小米)。多挂几个,哪个通用哪个。
STUN_SERVERS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
    "stun:stun.miwifi.com:3478",
]


def _ice_servers_from_settings() -> list:
    """从设置读 TURN 配置(novel.config),构造 aiortc iceServers。

    校园网多为对称 NAT,STUN 打洞经常失败;用户可在设置里填免费 TURN
    (如 metered.ca 的 openrelay)作为中继兜底。
    """
    servers = [dict(urls=STUN_SERVERS)]
    try:
        from novel.config import load_settings
        turn_url = (load_settings().get("webrtc_turn_url") or "").strip()
        if turn_url:
            turn_user = (load_settings().get("webrtc_turn_user") or "").strip()
            turn_pass = (load_settings().get("webrtc_turn_pass") or "").strip()
            entry = {"urls": [u.strip() for u in turn_url.split(",") if u.strip()]}
            if turn_user:
                entry["username"] = turn_user
            if turn_pass:
                entry["credential"] = turn_pass
            servers.append(entry)
    except Exception:  # noqa: BLE001
        pass
    return servers


def phone_ice_hints() -> dict:
    """手机端 ICE 提示(随连接码 # 段下发):STUN 列表 + 可选 TURN。

    手机浏览器不能用电脑端的 aiortc 配置,STUN/TURN 只能这样带过去;
    老版本手机页遇到 # 段会自动忽略(正则只取 v1/ 之后的 base64)。
    """
    import json as _json
    hints: dict = {"stun": STUN_SERVERS}
    try:
        from novel.config import load_settings
        s = load_settings()
        turn_url = (s.get("webrtc_turn_url") or "").strip()
        if turn_url:
            hints["turn"] = {
                "urls": [u.strip() for u in turn_url.split(",") if u.strip()],
                "user": (s.get("webrtc_turn_user") or "").strip(),
                "pass": (s.get("webrtc_turn_pass") or "").strip(),
            }
    except Exception:  # noqa: BLE001
        pass
    # 压缩体积:二维码里多一个字节都嫌贵
    return _json.loads(_json.dumps(hints, separators=(",", ":")))


def encode_phone_hints(hints: dict) -> str:
    """hints → urlsafe base64(连接码 # 段)。"""
    import json as _json
    raw = _json.dumps(hints, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_phone_hints(hint_b64: str) -> dict:
    import json as _json
    raw = base64.urlsafe_b64decode(hint_b64)
    return _json.loads(raw.decode("utf-8"))


def encode_sdp(sdp: str) -> str:
    """SDP → 压缩 → urlsafe base64。"""
    return base64.urlsafe_b64encode(zlib.compress(sdp.encode("utf-8"))).decode("ascii")


def decode_sdp(b64: str) -> str:
    return zlib.decompress(base64.urlsafe_b64decode(b64)).decode("utf-8")


class WrtcSession:
    """一个手机↔PC 会话:独立 asyncio 事件循环线程 + RTCPeerConnection。"""

    def __init__(self, manager: "WrtcManager", target_port: int) -> None:
        self.manager = manager
        self.sid = uuid.uuid4().hex[:10]
        self.target_port = target_port
        self.created_at = time.time()
        self.last_activity = time.time()
        self.connected = False
        self.answer_ok = False
        self.error = ""
        self.pc = None
        self.dc = None
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()

    # ---------------- 事件循环 ----------------
    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def _run(self, coro, timeout: float = 20):
        fut = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return fut.result(timeout=timeout)

    # ---------------- 信令 ----------------
    def create_offer(self) -> str:
        """创建 offer,返回压缩 base64(失败抛异常)。"""
        return self._run(self._make_offer())

    async def _make_offer(self) -> str:
        try:
            from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"未安装 aiortc: {exc}") from exc
        config = RTCConfiguration(iceServers=[
            RTCIceServer(**entry) for entry in _ice_servers_from_settings()
        ])
        pc = RTCPeerConnection(configuration=config)
        self.pc = pc
        dc = pc.createDataChannel("novelist", ordered=True)
        self.dc = dc
        dc.on("open", self._on_open)
        dc.on("message", self._on_message)
        dc.on("close", self._on_close)
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        # 等待 ICE gathering 完成:无 trickle 信令,offer 必须携带全部候选
        for _ in range(100):
            if pc.iceGatheringState == "complete":
                break
            await asyncio.sleep(0.1)
        sdp = pc.localDescription.sdp
        _ev(f"会话 {self.sid} 已生成 offer")
        return encode_sdp(sdp)

    def submit_answer(self, answer_b64: str) -> bool:
        """提交手机端 answer(SDP),成功返回 True。"""
        self.last_activity = time.time()
        try:
            sdp = decode_sdp(answer_b64)
        except Exception:  # noqa: BLE001
            self.error = "answer 解码失败"
            return False
        try:
            ok = self._run(self._set_answer(sdp))
            return bool(ok)
        except Exception as exc:  # noqa: BLE001
            self.error = f"answer 设置失败: {exc}"
            _ev(f"会话 {self.sid} answer 失败: {exc}")
            return False

    async def _set_answer(self, sdp: str) -> bool:
        from aiortc import RTCSessionDescription
        if self.pc is None:
            return False
        await self.pc.setRemoteDescription(
            RTCSessionDescription(sdp=sdp, type="answer"))
        self.answer_ok = True
        _ev(f"会话 {self.sid} 已收到 answer,等待 ICE 连接...")
        return True

    # ---------------- DataChannel ----------------
    def _on_open(self) -> None:
        self.connected = True
        self.last_activity = time.time()
        _ev(f"会话 {self.sid} 已连接(手机在线)")

    def _on_close(self) -> None:
        if self.connected:
            _ev(f"会话 {self.sid} 连接关闭")
        self.connected = False

    async def _on_message(self, msg) -> None:
        """处理手机端请求。

        必须声明为 async:aiortc 用 pyee.AsyncIOEventEmitter,协程处理器会被
        ensure_future 调度 —— 事件循环不会被阻塞。若写成同步函数,urllib 的
        长时间阻塞(下载/打包可达 120s)会冻结 ICE/DTLS/SCTP,连接必断。
        """
        self.last_activity = time.time()
        rid = None
        resp: dict = {"id": None, "status": 500, "type": "json",
                      "error": "internal error"}
        try:
            req = json.loads(msg) if isinstance(msg, (str, bytes)) else msg
            if isinstance(req, bytes):
                req = json.loads(req.decode("utf-8", "replace"))
            if isinstance(req, dict):
                rid = req.get("id")
            loop = asyncio.get_running_loop()
            resp = await loop.run_in_executor(
                _bridge_pool, self.manager.forward, self.target_port, req)
        except Exception as exc:  # noqa: BLE001
            resp = {"id": rid, "status": 500, "type": "json",
                    "error": f"处理失败: {exc}"}
        try:
            if self.dc is not None and self.dc.readyState == "open":
                self.dc.send(json.dumps(resp, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass

    # ---------------- 清理 ----------------
    def stop(self) -> None:
        try:
            self._run(self._close_pc(), timeout=6)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.loop.call_soon_threadsafe(self.loop.stop)
        except Exception:  # noqa: BLE001  # 循环已关闭
            pass
        if self.thread is not threading.current_thread():
            self.thread.join(timeout=3)
        # 只有线程已退出才能安全关闭循环(否则 selector fd 泄漏)
        if not self.thread.is_alive():
            try:
                self.loop.close()
            except Exception:  # noqa: BLE001
                pass

    async def _close_pc(self) -> None:
        if self.pc is not None:
            try:
                await self.pc.close()
            except Exception:  # noqa: BLE001
                pass
        self.connected = False

    def stale(self, now: float) -> bool:
        """创建超 180s 未连接,或连接后 120s 无活动 → 可清理。"""
        if not self.connected:
            return now - self.created_at > 180
        return now - self.last_activity > 120


class WrtcManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, WrtcSession] = {}
        self._target_port = 0
        self._cleaner: threading.Thread | None = None

    def set_port(self, port: int) -> None:
        with self._lock:
            self._target_port = port
            if self._cleaner is None:
                self._cleaner = threading.Thread(target=self._clean_loop, daemon=True)
                self._cleaner.start()

    def _clean_loop(self) -> None:
        while True:
            time.sleep(15)
            now = time.time()
            dead: list[str] = []
            with self._lock:
                for sid, s in self._sessions.items():
                    if s.stale(now):
                        dead.append(sid)
            for sid in dead:
                self.drop(sid)

    def create_offer(self) -> dict:
        if not available():
            return {"ok": False,
                    "error": "未安装 aiortc(WebRTC 库)。请在程序目录执行: pip install aiortc"}
        if self._target_port <= 0:
            return {"ok": False, "error": "服务端口未初始化"}
        self._cleanup()
        # 重新生成连接码时,丢弃此前所有「尚未连上」的会话:
        # 否则用户多点几次会堆积一堆等待中的会话(占端口 + STUN 探测),
        # 且摄像头扫码时可能把应答提交给旧的会话。
        self._drop_waiting()
        s = WrtcSession(self, self._target_port)
        try:
            offer_b64 = s.create_offer()
        except Exception as exc:  # noqa: BLE001
            s.stop()
            return {"ok": False, "error": f"创建连接失败: {exc}"}
        with self._lock:
            self._sessions[s.sid] = s
        return {"ok": True, "session": s.sid,
                "offer": f"novelist-wrtc://v1/{offer_b64}",
                "qr_text": f"novelist-wrtc://v1/{offer_b64}"}

    def submit_answer(self, session: str, answer_b64: str) -> dict:
        s = self._session(session)
        if s is None:
            return {"ok": False, "error": "会话不存在或已过期,请重新生成"}
        if s.connected:
            return {"ok": False, "error": "该会话已连接,无需重复提交应答码"}
        if "://" in answer_b64:  # 兼容整段 novelist-wrtc://v1/... 粘贴
            answer_b64 = answer_b64.rsplit("/", 1)[-1]
        if s.submit_answer(answer_b64):
            return {"ok": True}
        return {"ok": False, "error": s.error or "提交失败"}

    def status(self) -> dict:
        # 前端每 2s 轮询一次;drop() 内部会 join 线程(最长 3s/会话),
        # 直接在请求线程里清理会阻塞 HTTP 响应,故丢到后台线程。
        self._cleanup_async()
        items = []
        with self._lock:
            for sid, s in self._sessions.items():
                items.append({
                    "session": sid,
                    "connected": s.connected,
                    "answer_ok": s.answer_ok,
                    "age": round(time.time() - s.created_at, 1),
                    "activity": round(time.time() - s.last_activity, 1),
                })
        return {
            "available": available(),
            "sessions": items,
            "connected_count": sum(1 for i in items if i["connected"]),
            "events": list(_events)[-60:],
        }

    def drop(self, session: str) -> dict:
        s = self._session(session)
        if s is None:
            return {"ok": False, "error": "会话不存在"}
        with self._lock:
            self._sessions.pop(session, None)
        s.stop()
        return {"ok": True}

    def drop_all(self) -> dict:
        """断开全部会话(前端「断开」按钮)。"""
        with self._lock:
            items = list(self._sessions.items())
            self._sessions.clear()
        for _sid, s in items:
            try:
                s.stop()
            except Exception:  # noqa: BLE001
                pass
        _ev(f"已断开全部会话({len(items)} 个)")
        return {"ok": True, "dropped": len(items)}

    def _session(self, session: str) -> WrtcSession | None:
        with self._lock:
            return self._sessions.get(session)

    def _cleanup(self) -> None:
        now = time.time()
        with self._lock:
            dead = [sid for sid, s in self._sessions.items() if s.stale(now)]
        for sid in dead:
            self.drop(sid)

    def _cleanup_async(self) -> None:
        threading.Thread(target=self._cleanup, daemon=True).start()

    def _drop_waiting(self) -> None:
        """丢弃所有尚未建立 DataChannel 的会话(已连上的保持不动)。"""
        victims = []
        with self._lock:
            for sid, s in list(self._sessions.items()):
                if not s.connected:
                    self._sessions.pop(sid, None)
                    victims.append(s)
        if not victims:
            return
        _ev(f"清理 {len(victims)} 个未连接会话")
        # stop() 会 join 线程,放到后台避免阻塞调用方(HTTP 请求线程)
        def _kill(items: list["WrtcSession"]) -> None:
            for s in items:
                try:
                    s.stop()
                except Exception:  # noqa: BLE001
                    pass
        threading.Thread(target=_kill, args=(victims,), daemon=True).start()

    # ---------------- HTTP 桥接 ----------------
    @staticmethod
    def forward(port: int, req: dict) -> dict:
        method = str(req.get("method", "GET")).upper()
        path = str(req.get("path", "/"))
        query = str(req.get("query", ""))
        if not path.startswith("/"):
            path = "/" + path
        url = f"http://127.0.0.1:{port}{path}"
        if query:
            url += ("&" if "?" in url else "?") + query
        headers = {"User-Agent": "novelist-wrtc/1.0"}
        data = None
        body_b64 = req.get("body_b64")
        if method == "POST" and body_b64:
            data = base64.b64decode(body_b64)
            headers["Content-Type"] = str(req.get("content_type", "application/json"))
        r = urllib.request.Request(url, data=data, headers=headers, method=method)
        timeout = 120 if ("download" in path or "pack" in path or "img" in path) else 30
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            ct = resp.headers.get("Content-Type", "")
            out: dict = {"id": req.get("id"), "status": resp.status}
            if "application/json" in ct:
                try:
                    out["type"] = "json"
                    out["body"] = json.loads(raw.decode("utf-8"))
                    return out
                except Exception:  # noqa: BLE001
                    pass
            out["type"] = "b64"
            out["body_b64"] = base64.b64encode(raw).decode("ascii")
            out["content_type"] = ct
            out["filename"] = _extract_filename(resp.headers.get("Content-Disposition", ""))
            return out


def _extract_filename(cd: str) -> str:
    if not cd:
        return ""
    m = None
    try:
        import re
        m = re.search(r"filename\*?=(?:UTF-8''|\"?)([^\";]+)", cd, re.IGNORECASE)
    except Exception:  # noqa: BLE001
        pass
    if not m:
        return ""
    import urllib.parse
    try:
        return urllib.parse.unquote(m.group(1).strip())
    except Exception:  # noqa: BLE001
        return m.group(1).strip()


# 全局单例
_manager: WrtcManager | None = None


def get_manager() -> WrtcManager:
    global _manager
    if _manager is None:
        _manager = WrtcManager()
    return _manager

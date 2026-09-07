# -*- coding: utf-8 -*-
"""云端信令总线 —— 纯标准库实现的 MQTT over WebSocket(WSS) 客户端。

用途:WebRTC「一键扫码直连」的应答码自动回传。
    电脑生成 offer 后,按 offer 内容派生一个云端主题并在公共 MQTTBroker 上订阅;
    手机扫码后把 answer 直接 publish 到同一主题,电脑端即时收到并完成握手 ——
    手机全程只扫一次码,不需要电脑摄像头再扫应答码,也不用复制粘贴。

主题派生(两端独立计算,无需额外传输):
    topic = "novelist-wrtc/v1/" + sha256(offer_b64).hexdigest()[:24]
    offer 本身就是唯一输入,不知道完整 offer 的人推不出主题。

Broker 全部是免注册的公共服务,按国内可达性排序,多 broker 同时订阅互为备份:
    wss://broker-cn.emqx.io:8084/mqtt      (EMQ 国内节点)
    wss://broker.emqx.io:8084/mqtt         (EMQ 国际节点)
    wss://test.mosquitto.org:8081/mqtt     (Mosquitto 官方测试服)

实现说明:
    - WebSocket:HTTP Upgrade 握手 + RFC6455 帧编解码(客户端帧必须掩码),
      MQTT 报文直接作为二进制帧负载(MQTT-over-WS 标准规定)。
    - MQTT:3.1.1 最小子集 CONNECT/CONNACK/SUBSCRIBE/SUBACK/PUBLISH(QoS0)/
      PINGREQ/PINGRESP,足够「订阅收消息」与「发布一条消息」。
    - 每个 broker 一个守护线程,断线自动重连(指数退避),failures 不互相影响。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import threading
import time

# 免注册公共 Broker(WebSocket 端点)。URL 即 wss://host:port/path
BROKERS = [
    "wss://broker-cn.emqx.io:8084/mqtt",
    "wss://broker.emqx.io:8084/mqtt",
    "wss://test.mosquitto.org:8081/mqtt",
]

_KEEPALIVE = 60          # MQTT keepalive(秒);PINGREQ 周期取其一半
_RECV_TIMEOUT = 5.0      # 阻塞收包超时:留出停机检查窗口


def derive_topic(offer_b64: str) -> str:
    """由 offer 连接码派生云端主题(两端算法一致)。"""
    h = hashlib.sha256(offer_b64.strip().encode("utf-8")).hexdigest()
    return f"novelist-wrtc/v1/{h[:24]}"


def parse_signal_payload(text: str) -> str:
    """从信令消息里提取 answer_b64(去掉 novelist-wrtc-answer:// 前缀)。"""
    text = (text or "").strip()
    if "://" in text:
        return text.rsplit("/", 1)[-1]
    return text


# ---------------- WebSocket 最小实现(RFC6455 客户端侧) ----------------

def _ws_connect(url: str) -> socket.socket:
    """建立 WSS 连接并完成 Upgrade 握手,返回可读写帧的 SSL socket。"""
    from urllib.parse import urlparse
    u = urlparse(url)
    if u.scheme != "wss":
        raise ValueError("仅支持 wss://")
    host = u.hostname
    port = u.port or 443
    path = u.path or "/"
    raw = socket.create_connection((host, port), timeout=10)
    ctx = ssl.create_default_context()
    sock = ctx.wrap_socket(raw, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: mqtt\r\n"
        "User-Agent: novelist-signal/1.0\r\n\r\n"
    )
    sock.sendall(req.encode("ascii"))
    # 读响应头(逐字节直到空行,避免读走帧数据)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(1)
        if not chunk:
            raise ConnectionError("握手中断")
        buf += chunk
        if len(buf) > 16384:
            raise ConnectionError("握手响应过大")
    head = buf.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    status = head.split("\r\n", 1)[0]
    if " 101 " not in status + " ":
        raise ConnectionError(f"WebSocket 握手失败: {status}")
    return sock


def _ws_send(sock: socket.socket, payload: bytes, opcode: int = 0x2) -> None:
    """发送一帧(客户端帧必须掩码)。opcode: 0x2=binary 0x8=close 0x9=ping。"""
    mask = os.urandom(4)
    header = bytearray([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", n)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + mask + masked)


def _ws_recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("连接已关闭")
        buf += chunk
    return buf


def _ws_recv(sock: socket.socket) -> tuple[int, bytes]:
    """读一帧,自动应答 ping/转发 close。返回 (opcode, payload)。"""
    while True:
        b1, b2 = _ws_recv_exact(sock, 2)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        ln = b2 & 0x7F
        if ln == 126:
            (ln,) = struct.unpack(">H", _ws_recv_exact(sock, 2))
        elif ln == 127:
            (ln,) = struct.unpack(">Q", _ws_recv_exact(sock, 8))
        if ln > 1 << 22:
            raise ConnectionError(f"帧过大: {ln}")
        mask = _ws_recv_exact(sock, 4) if masked else b""
        payload = _ws_recv_exact(sock, ln) if ln else b""
        if masked and payload:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        if opcode == 0x9:                 # ping → pong
            _ws_send(sock, payload, opcode=0xA)
            continue
        if opcode == 0x8:                 # close
            raise ConnectionError("对端关闭")
        return opcode, payload


class _WsStream:
    """把 WebSocket 帧流变成可靠字节流。

    MQTT-over-WS 的报文可能跨帧、也可能多包挤进一帧,必须先在缓冲区里
    排队,再按 MQTT 需要的字节数取用 —— 直接 recv 裸字节会把 WebSocket
    帧头(0x82…)误当成 MQTT 报文类型。
    """

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.buf = bytearray()

    def read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            _, payload = _ws_recv(self.sock)
            if payload:
                self.buf.extend(payload)
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out


# ---------------- MQTT 3.1.1 最小编解码 ----------------

def _mqtt_str(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack(">H", len(b)) + b


def _mqtt_packet(flags: int, body: bytes) -> bytes:
    """变长剩余长度编码的完整 MQTT 报文。"""
    n = len(body)
    rem = b""
    while True:
        d = n % 128
        n //= 128
        if n:
            d |= 0x80
        rem += bytes([d])
        if not n:
            break
    return bytes([flags]) + rem + body


def _mqtt_connect(client_id: str, keepalive: int) -> bytes:
    vh = _mqtt_str("MQTT") + bytes([4]) + bytes([0x02]) + struct.pack(">H", keepalive)
    return _mqtt_packet(0x10, vh + _mqtt_str(client_id))       # clean session


def _mqtt_subscribe(pid: int, topic: str) -> bytes:
    vh = struct.pack(">H", pid)
    return _mqtt_packet(0x82, vh + _mqtt_str(topic) + bytes([0]))  # QoS0


def _mqtt_publish(topic: str, payload: str) -> bytes:
    body = _mqtt_str(topic) + payload.encode("utf-8")
    return _mqtt_packet(0x30, body)                            # QoS0, 无 retain


def _mqtt_read(stream: "_WsStream") -> tuple[int, bytes]:
    """读一个 MQTT 报文,返回 (packet_type, body)。"""
    b1 = stream.read_exact(1)[0]
    ptype = b1 >> 4
    mult, rem = 1, 0
    while True:
        d = stream.read_exact(1)[0]
        rem += (d & 0x7F) * mult
        if not d & 0x80:
            break
        mult *= 128
    body = stream.read_exact(rem) if rem else b""
    return ptype, body


# ---------------- 信令总线 ----------------

class _BrokerLink:
    """单个 broker 的订阅连接(守护线程,断线重连)。"""

    def __init__(self, url: str, topic: str, on_msg) -> None:
        self.url = url
        self.topic = topic
        self.on_msg = on_msg
        self.state = "init"        # init/connecting/online/offline/stopped
        self.last_err = ""
        self.connected_at = 0.0
        self._stop = threading.Event()
        self._th: threading.Thread | None = None

    def start(self) -> None:
        self._th = threading.Thread(target=self._run, daemon=True, name="signal-mqtt")
        self._th.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            sock = None
            try:
                self.state = "connecting"
                sock = _ws_connect(self.url)
                sock.settimeout(_RECV_TIMEOUT)
                stream = _WsStream(sock)
                cid = "nvl-" + os.urandom(8).hex()
                _ws_send(sock, _mqtt_connect(cid, _KEEPALIVE))
                ptype, body = _mqtt_read(stream)
                if ptype != 2 or not body or body[1] != 0:
                    raise ConnectionError(f"CONNACK 异常: {ptype}/{body.hex()}")
                _ws_send(sock, _mqtt_subscribe(1, self.topic))
                ptype, _ = _mqtt_read(stream)
                if ptype != 9:
                    raise ConnectionError(f"SUBACK 异常: {ptype}")
                self.state = "online"
                self.connected_at = time.time()
                self.last_err = ""
                backoff = 1.0
                # 常驻收包:QoS0 PUBLISH + keepalive
                last_ping = time.time()
                while not self._stop.is_set():
                    try:
                        ptype, body = _mqtt_read(stream)
                    except socket.timeout:
                        ptype = 0
                    if ptype == 3:  # PUBLISH(QoS0): 2字节主题长度 + 主题 + 载荷
                        (tl,) = struct.unpack(">H", body[:2])
                        payload = body[2 + tl:].decode("utf-8", "replace")
                        try:
                            self.on_msg(self.url, payload)
                        except Exception:  # noqa: BLE001
                            pass
                    elif ptype == 0xD:  # PINGRESP
                        pass
                    if time.time() - last_ping > _KEEPALIVE / 2:
                        try:
                            _ws_send(sock, _mqtt_packet(0xC0, b""))
                            last_ping = time.time()
                        except Exception:  # noqa: BLE001
                            raise ConnectionError("keepalive 发送失败")
            except Exception as exc:  # noqa: BLE001
                self.state = "offline"
                self.last_err = str(exc)[:200]
                self.connected_at = 0.0
                if self._stop.is_set():
                    return
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
            finally:
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:  # noqa: BLE001
                        pass


class SignalBus:
    """云端信令:对给定主题在全部 broker 上订阅,收到的消息回调给业务层。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._links: list[_BrokerLink] = []
        self._topic = ""
        self._on_msg = None
        self._seen: dict[str, float] = {}     # 去重(多 broker 会重复投递)
        self._start_at = 0.0

    def listen(self, topic: str, on_msg) -> None:
        """切换到新主题并(重)启动全部订阅。重复调用会先停旧连接。"""
        with self._lock:
            if topic == self._topic and self._links:
                return
            self._stop_locked()
            self._topic = topic
            self._on_msg = on_msg
            self._seen.clear()
            self._start_at = time.time()
            for url in BROKERS:
                link = _BrokerLink(url, topic, self._dispatch)
                link.start()
                self._links.append(link)

    def _dispatch(self, broker_url: str, payload: str) -> None:
        with self._lock:
            key = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            now = time.time()
            if now - self._seen.get(key, 0) < 30:   # 同一应答码 30s 内去重
                return
            self._seen[key] = now
            if len(self._seen) > 64:                # 防字典无限增长
                cut = now - 120
                self._seen = {k: v for k, v in self._seen.items() if v > cut}
            cb = self._on_msg
        if cb:
            try:
                cb(payload)
            except Exception:  # noqa: BLE001
                pass

    def status(self) -> dict:
        with self._lock:
            return {
                "topic": self._topic,
                "brokers": [{
                    "url": l.url,
                    "state": l.state,
                    "last_err": l.last_err,
                } for l in self._links],
                "online": sum(1 for l in self._links if l.state == "online"),
            }

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    def _stop_locked(self) -> None:
        for l in self._links:
            l.stop()
        self._links = []
        self._topic = ""


# ---------------- 一次性发布(手机端回传应答码;PC 端测试用) ----------------

def publish_once(topic: str, payload: str, timeout: float = 8.0) -> dict:
    """把一条消息发布到主题:逐个 broker 尝试,首个成功即返回。

    手机端用 JS 原生 WebSocket 走同一套报文格式;这个 Python 版本供测试
    与 CLI 使用。
    """
    err = "全部 broker 均不可达"
    for url in BROKERS:
        try:
            sock = _ws_connect(url)
            sock.settimeout(timeout)
            stream = _WsStream(sock)
            _ws_send(sock, _mqtt_connect("nvl-pub-" + os.urandom(6).hex(), 30))
            ptype, body = _mqtt_read(stream)
            if ptype != 2 or not body or body[1] != 0:
                raise ConnectionError("CONNACK 异常")
            _ws_send(sock, _mqtt_publish(topic, payload))
            time.sleep(0.25)   # 给 broker 一点处理时间再断开
            try:
                sock.close()
            except Exception:  # noqa: BLE001
                pass
            return {"ok": True, "broker": url}
        except Exception as exc:  # noqa: BLE001
            err = str(exc)[:200]
            continue
    return {"ok": False, "error": err}


# 全局单例(gui_server 使用)
_bus: SignalBus | None = None


def get_bus() -> SignalBus:
    global _bus
    if _bus is None:
        _bus = SignalBus()
    return _bus


if __name__ == "__main__":  # 自测:两个进程分别跑 main 里的收/发
    import sys
    topic = "novelist-wrtc-selftest/" + os.urandom(4).hex()
    if len(sys.argv) > 1 and sys.argv[1] == "pub":
        time.sleep(3)
        r = publish_once(topic, "hello-signal")
        print("publish:", r)
    else:
        got = threading.Event()

        def on_msg(p: str) -> None:
            print("received:", p)
            got.set()

        bus = SignalBus()
        bus.listen(topic, on_msg)
        print("topic:", topic)
        if got.wait(40):
            print("SELFTEST-OK")
        else:
            print("SELFTEST-TIMEOUT; status:", json.dumps(bus.status(), ensure_ascii=False))
        bus.stop()

# -*- coding: utf-8 -*-
"""内网穿透隧道守护 —— 拉起并守护第三方隧道客户端(natapp/cpolar/frp 等)。

原理:校园网只拦入站、不拦出站。PC 主动出站连接公网隧道服务器 → 获得公网
域名,手机访问公网域名即经服务器中转到达本机,绕开校园网隔离。

用法:
    mgr = TunnelManager()
    mgr.start(cmd="C:/tools/natapp.exe", args=["-authtoken=xxx"])
    mgr.status()  # {running, url, log_tail, ...}
    mgr.stop()
"""
from __future__ import annotations

import collections
import os
import re
import shlex
import subprocess
import threading
import time

DEFAULT_URL_REGEX = (
    r"(?:https?://[a-zA-Z0-9][a-zA-Z0-9._-]*\.[a-zA-Z]{2,}"
    r"(?::\d{1,5})?(?:/[^\s\"']*)?)"
)

# ---------------- 免注册 SSH 临时隧道预设(方法一) ----------------
# Windows 10+ 自带 ssh.exe;这些服务无需账号,一条命令即得随机公网 HTTPS 地址,
# 用于「任意网络首次准备」:手机扫公网二维码直接加载连接页/手机页。
# {port} 由程序替换为实际服务端口。BatchMode 禁止交互式密码提示(连不上快速失败换下一个)。
SSH_TUNNEL_PRESETS = [
    # 顺序 = 尝试顺序:真免注册的靠前;localhost.run 现已要求账号/密钥,殿后
    {
        "name": "pinggy.io",
        "cmd": "ssh",
        "args": "-o StrictHostKeyChecking=no -o BatchMode=yes "
                "-o ServerAliveInterval=15 -o ConnectTimeout=10 "
                "-R 80:localhost:{port} a.pinggy.io",
    },
    {
        "name": "serveo.net",
        "cmd": "ssh",
        "args": "-o StrictHostKeyChecking=no -o BatchMode=yes "
                "-o ServerAliveInterval=15 -o ConnectTimeout=10 "
                "-R 80:localhost:{port} serveo.net",
    },
    {
        "name": "localhost.run",
        "cmd": "ssh",
        "args": "-o StrictHostKeyChecking=no -o BatchMode=yes "
                "-o ServerAliveInterval=15 -o ConnectTimeout=10 "
                "-R 80:localhost:{port} no-ssh-key@localhost.run",
    },
]

# 厂商官网 / 控制台地址:客户端启动横幅里几乎都会打印,但它们不是隧道地址,
# 抓到会得到一个「能打开却连不到本机」的假地址,必须排除。
# 注意:不要写厂商的隧道域名后缀(cpolar 免费域名是 *.cpolar.top、
# natapp 是 *.natappfree.cc),否则会把真地址一起误杀。
_VENDOR_HOSTS = (
    "cpolar.com", "cpolar.cn", "cpolar.io",
    "natapp.cn", "natapp.cc",
    "ngrok.com", "ngrok.io", "ngrok.app", "ngrok.dev",
    "github.com", "gitee.com", "frp.io", "gofrp.org",
    # ssh 免注册服务的官网/控制台域名(真隧道地址在 lhr.life / pinggy.link 等
    # 子域上不会误杀;serveo 的隧道域名恰好就是 serveo.net,故不加)
    "localhost.run", "pinggy.io",
)
# 常见客户端输出中的 URL 行(优先匹配这些关键字,避免误抓本机地址)
_URL_KEYWORDS = ("http", "url=", "established", "tunnel", "proxy", "https://",
                 "forwarding", "traffic")


def get_ssh_presets(port: int) -> list[dict]:
    """按当前服务端口展开免注册隧道预设(供 start_auto 依次尝试)。

    TunnelManager 要求 cmd 是可执行文件的真实路径,而 ssh 通常只在 PATH 上,
    这里先解析成绝对路径;解析不到再试 Windows 固定安装位置。
    """
    import shutil
    ssh = shutil.which("ssh")
    if not ssh and os.name == "nt":
        cand = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                            "System32", "OpenSSH", "ssh.exe")
        if os.path.isfile(cand):
            ssh = cand
    if not ssh:
        ssh = "ssh"   # 保持原样让 start 报出明确错误
    out = []
    for p in SSH_TUNNEL_PRESETS:
        out.append({
            "name": p["name"],
            "cmd": ssh,
            "args": p["args"].replace("{port}", str(port)),
        })
    return out


def _is_vendor_url(url: str) -> bool:
    """判断是否为厂商官网/文档地址(非隧道地址)。"""
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower().rstrip(".")
    except Exception:  # noqa: BLE001
        return False
    if not host:
        return False
    return any(host == v or host.endswith("." + v) for v in _VENDOR_HOSTS)

_log: "collections.deque[str]" = collections.deque(maxlen=300)


def _log_add(line: str) -> None:
    _log.append(line)


class TunnelManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._url = ""
        self._running = False
        self._wanted = False          # 用户意图:stop() 后不再自动重启
        self._restart_count = 0
        self._started_at = 0.0
        self._cmd = ""
        self._args: list[str] = []
        self._url_regex = DEFAULT_URL_REGEX
        self._reader_th: threading.Thread | None = None
        # 「世代」计数:start()/stop() 各自 +1。守护线程只在同一世代内重启,
        # 防止「进程自退 → 用户点停止 → 再点启动」时旧线程复活多开一个客户端。
        self._gen = 0

    # ---------------- 对外接口 ----------------
    def start(self, cmd: str, args: list[str] | None = None,
              url_regex: str = "") -> dict:
        cmd = (cmd or "").strip()
        if not cmd:
            return {"ok": False, "error": "未填写隧道客户端路径(如 natapp.exe / cpolar.exe / frpc.exe)"}
        if not os.path.isfile(cmd):
            return {"ok": False, "error": f"找不到客户端: {cmd}"}
        with self._lock:
            if self._proc and self._proc.poll() is None:
                return {"ok": True, "running": True, "url": self._url,
                        "error": "隧道已在运行"}
            self._cmd = cmd
            self._args = args or []
            if url_regex and url_regex.strip():
                try:
                    re.compile(url_regex)
                    self._url_regex = url_regex.strip()
                except re.error:
                    self._url_regex = DEFAULT_URL_REGEX
            self._wanted = True
            self._gen += 1
            self._url = ""
            self._restart_count = 0
            ok, err = self._spawn()
            if not ok:
                self._wanted = False
                return {"ok": False, "error": err}
            return {"ok": True, "running": True, "url": "", "pid": self._proc.pid}

    def stop(self) -> dict:
        with self._lock:
            self._wanted = False
            self._gen += 1
            proc = self._proc
            self._proc = None
            self._url = ""
            self._running = False
        if proc:
            try:
                proc.terminate()
            except Exception:  # noqa: BLE001
                pass
            try:
                proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        return {"ok": True, "running": False}

    def status(self) -> dict:
        with self._lock:
            proc = self._proc
            alive = proc is not None and proc.poll() is None
            if not alive and self._running:
                self._running = False
            return {
                "running": alive,
                "url": self._url,
                "cmd": self._cmd,
                "args": self._args,
                "pid": proc.pid if alive else None,
                "restart_count": self._restart_count,
                "uptime": round(time.time() - self._started_at, 1) if self._running else 0,
                "log_tail": list(_log)[-120:],
                "config": {
                    "cmd": self._cmd,
                    "args": self._args,
                    "url_regex": self._url_regex,
                },
            }

    # ---------------- 内部 ----------------
    def _spawn(self) -> tuple[bool, str]:
        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
                subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        try:
            self._proc = subprocess.Popen(
                [self._cmd, *self._args],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=flags,
                text=True, encoding="utf-8", errors="replace",
            )
        except Exception as exc:  # noqa: BLE001
            self._proc = None
            return False, f"启动失败: {exc}"
        self._running = True
        self._started_at = time.time()
        _log_add(f"[tunnel] 已启动: {self._cmd} {' '.join(self._args)} (pid={self._proc.pid})")
        self._reader_th = threading.Thread(target=self._reader, daemon=True)
        self._reader_th.start()
        return True, ""

    def _reader(self) -> None:
        proc = self._proc
        gen = self._gen
        if proc is None:
            return
        for raw in iter(proc.stdout.readline, ""):  # type: ignore[union-attr]
            line = raw.rstrip()
            if not line:
                continue
            _log_add(line)
            self._extract_url(line)
        # 进程退出
        with self._lock:
            # 关键:只有「自己登记的进程」才允许清空 _proc。
            # 否则 stop() → 立刻 start() 时,旧 reader 线程醒来会把新进程
            # 引用抹掉 —— 状态显示未运行、且再也停不掉(变成僵尸客户端)。
            if self._proc is proc:
                self._running = False
                self._proc = None
            wanted = self._wanted and self._gen == gen
        if wanted:
            # 守护重启(退避 3s,最多无限次但限制计数上限防刷屏)
            _log_add("[tunnel] 客户端退出,3 秒后自动重启...")
            time.sleep(3)
            with self._lock:
                if self._wanted and self._gen == gen:
                    self._restart_count += 1
                    # 公网地址通常随重启变化(cpolar 免费版必变),必须清空重抓,
                    # 否则前端一直显示已失效的旧地址。
                    self._url = ""
                    ok, err = self._spawn()
                    if not ok:
                        _log_add(f"[tunnel] 重启失败: {err}")

    def _extract_url(self, line: str) -> None:
        low = line.lower()
        if not any(k in low for k in _URL_KEYWORDS):
            return
        try:
            m = re.search(self._url_regex, line)
        except re.error:
            return
        if not m:
            return
        url = m.group(0).rstrip("/")
        # 排除本机回环/隧道服务器本地地址
        if url.startswith(("http://127.", "http://localhost", "https://localhost")):
            return
        # 排除厂商官网/控制台横幅地址
        if _is_vendor_url(url):
            return
        with self._lock:
            if "forwarding" in low or "traffic" in low:
                # ssh 类客户端(serveo/pinggy/localhost.run)的「Forwarding HTTP
                # traffic from …」行才是真隧道地址;它可能晚于 banner 里的控制台
                # 地址出现,一旦出现必须覆盖之前抓到的假地址。
                if self._url != url:
                    self._url = url
                    _log_add(f"[tunnel] 获取到公网地址: {url}")
            elif not self._url:
                self._url = url
                _log_add(f"[tunnel] 获取到公网地址: {url}")


# 单例(由 gui_server 使用)
_manager: TunnelManager | None = None


def get_manager() -> TunnelManager:
    global _manager
    if _manager is None:
        _manager = TunnelManager()
    return _manager


def parse_args(s: str) -> list[str]:
    """把配置字符串拆成参数列表,兼容引号(如 -authtoken=\"a b\")。"""
    s = (s or "").strip()
    if not s:
        return []
    try:
        return shlex.split(s, posix=False)
    except ValueError:
        return s.split()

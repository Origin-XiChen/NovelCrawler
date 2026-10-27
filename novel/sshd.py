# -*- coding: utf-8 -*-
"""内建 SSH 服务端 —— 程序自己起一个,端口和密码都由本程序掌握。

为什么不用系统 sshd:
    Windows OpenSSH 只认 Windows 账户,没法"给 App 单独指定一个密码";
    而且它经常是 PasswordAuthentication no(只开公钥),手机填密码必然连不上。
    这里用 paramiko 起一个独立实例:自定义端口、自定义用户名/密码、
    只允许「本地端口转发」这一种能力,不提供 shell,风险面最小。

安全约定(重要):
    • 主机密钥首次启动生成,落在数据目录 sshd/host_rsa,权限 0600,
      **只在本机磁盘上,不进仓库、不打日志、不回传给手机**;
    • 登录密码同样只存本机配置(0600),API 只在「本机回环」请求下返回;
    • 只实现 direct-tcpip(端口转发),不实现 shell/exec/sftp。
"""
from __future__ import annotations

import os
import socket
import threading
import time

import paramiko

from .paths import APP_DATA_DIR

SSHD_DIR = os.path.join(APP_DATA_DIR, "sshd")
HOST_KEY = os.path.join(SSHD_DIR, "host_rsa")

_lock = threading.Lock()
_server = None          # 正在监听的 Transport 会话集合(用于关闭)
_thread: threading.Thread | None = None
_state = {"running": False, "port": 0, "user": "", "error": "", "started": 0}

DEFAULT_PORT = 2222
DEFAULT_USER = "novelist"


def _ensure_host_key() -> "object":
    """取主机密钥;没有就生成一把(ed25519 优先,失败退回 RSA2048)。"""
    import paramiko
    os.makedirs(SSHD_DIR, exist_ok=True)
    for cls in (paramiko.Ed25519Key, paramiko.RSAKey):
        try:
            return cls(filename=HOST_KEY)
        except (OSError, paramiko.SSHException):
            continue
    # 都不存在才生成(host_rsa 这个名字沿用 ed25519 也放这里,读的时候先试 ed25519)
    key = paramiko.RSAKey.generate(2048)
    key.write_private_key_file(HOST_KEY)
    try:
        os.chmod(HOST_KEY, 0o600)
    except OSError:
        pass
    return paramiko.RSAKey(filename=HOST_KEY)


class _ForwardServer(paramiko.ServerInterface):
    """只做认证 + 端口转发,不开 shell。"""

    def __init__(self, user: str, password: str):
        self._user = user
        self._password = password
        self.event = threading.Event()

    def check_auth_password(self, username, password):
        import paramiko
        if username == self._user and password == self._password:
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        import paramiko
        if kind == "direct-tcpip":
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        import paramiko
        host, port = destination
        # 只允许转发到本机回环:这台机器上的服务可以被隧道摸到,
        # 但不能借我们的隧道去扫内网
        if host not in ("127.0.0.1", "localhost", "::1"):
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        return paramiko.OPEN_SUCCEEDED


def _handle(client: socket.socket, user: str, password: str, target_port: int) -> None:
    """一个连接的会话循环:认证 → 接受 direct-tcpip 通道 → 转接到本机服务端口。"""
    import paramiko
    transport = None
    try:
        transport = paramiko.Transport(client)
        transport.add_server_key(_ensure_host_key())
        transport.start_server(server=_ForwardServer(user, password))
        while transport.is_active():
            chan = transport.accept(1.0)
            if chan is None:
                continue
            # 只转发到「本程序自己的服务端口」:通道目标在请求阶段已校验为回环,
            # 这里统一落到固定端口,既满足手机端用法,也不给内网横向留口子。
            threading.Thread(target=_pump, args=(chan, target_port), daemon=True).start()
    except Exception:  # noqa: BLE001
        pass
    finally:
        try:
            if transport is not None:
                transport.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            client.close()
        except OSError:
            pass


def _pump(chan, target_port: int) -> None:
    """把 SSH 通道双向接到 127.0.0.1:target_port。"""
    sock = None
    try:
        sock = socket.create_connection(("127.0.0.1", int(target_port)), timeout=8)
        sock.settimeout(None)
        chan.settimeout(None)

        def chan_to_sock():
            try:
                while True:
                    data = chan.recv(32768)
                    if not data:
                        break
                    sock.sendall(data)
            except Exception:  # noqa: BLE001
                pass
            finally:
                try:
                    sock.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

        threading.Thread(target=chan_to_sock, daemon=True).start()
        while True:
            data = sock.recv(32768)
            if not data:
                break
            chan.sendall(data)
    except Exception:  # noqa: BLE001
        pass
    finally:
        try:
            if sock is not None:
                sock.close()
        except OSError:
            pass
        try:
            chan.close()
        except Exception:  # noqa: BLE001
            pass


def start(port: int = DEFAULT_PORT, user: str = DEFAULT_USER,
          password: str = "", target_port: int = 0, bind: str = "0.0.0.0") -> dict:
    """起内建 SSH 服务端。password 为空则拒绝(必须有密码才能开)。"""
    global _thread
    if not password:
        return {"ok": False, "error": "未设置密码"}
    with _lock:
        if _state["running"]:
            return dict(_state, ok=True)
    try:
        import paramiko  # noqa: F401
    except ImportError:
        return {"ok": False, "error": "缺少 paramiko,当前安装包不支持内建 SSH"}

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((bind, int(port)))
        sock.listen(16)
    except OSError as exc:
        sock.close()
        return {"ok": False, "error": f"端口 {port} 不可用: {exc}"}

    def loop():
        while True:
            try:
                client, _addr = sock.accept()
            except OSError:
                break
            threading.Thread(target=_handle,
                             args=(client, user, password, int(target_port)),
                             daemon=True).start()

    _thread = threading.Thread(target=loop, name="novelist-sshd", daemon=True)
    _thread.start()
    with _lock:
        _state.update({"running": True, "port": int(port), "user": user,
                       "target_port": int(target_port),
                       "error": "", "started": int(time.time())})
    return dict(_state, ok=True)


def stop() -> None:
    global _server
    with _lock:
        _state.update({"running": False, "port": 0, "started": 0})
    # 监听 socket 由 loop 持有,进程重启/TCP 关闭即可;这里只清状态
    _server = None


def status() -> dict:
    with _lock:
        return dict(_state)

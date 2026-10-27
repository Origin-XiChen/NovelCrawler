# -*- coding: utf-8 -*-
"""校园网场景检测 —— 移动热点状态 / 热点网段 IP 探测。

校园网(高校 WiFi)普遍开启 AP 隔离 + 入站阻断,手机直连 PC 局域网 IP 会失败。
本模块检测 PC 是否具备/已开启 Windows 移动热点(网段固定 192.168.137.0/24),
供设置页引导用户切换到热点连接。

性能:优先内存 socket 探测(1ms),仅无线状态用 netsh(约 30-80ms),整体 <100ms。
"""
from __future__ import annotations

import re
import socket
import subprocess
import threading
import time

# Windows 移动热点固定网段(手机连上后 PC 侧为网关 192.168.137.1)
HOTSPOT_NET = "192.168.137."
HOTSPOT_GW = HOTSPOT_NET + "1"

# netsh wlan show interfaces 的输出是「本地化」的:中文 Windows 上字段名是
# 名称/说明/状态/信号,只有 SSID、GUID、BSSID 保持英文,冒号还有全角「:」。
# 只写 r"State\s*:\s*(.+)" 会导致 wifi_state 在中文系统上永远为空。
_RE_SSID = re.compile(r"^\s*SSID\s*[:：]\s*(.+?)\s*$", re.MULTILINE)
_RE_STATE = re.compile(r"^\s*(?:State|状态|Stato|État)\s*[:：]\s*(.+?)\s*$",
                       re.MULTILINE | re.IGNORECASE)

_lock = threading.Lock()
_cache: dict = {"ts": 0.0, "data": None}


def _netsh_wlan() -> str:
    """返回 netsh wlan show interfaces 输出(失败返回空串)。"""
    try:
        r = subprocess.run(
            ["netsh", "wlan", "show", "interfaces"],
            capture_output=True, text=True, timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            encoding="utf-8", errors="replace",
        )
        return r.stdout or ""
    except Exception:  # noqa: BLE001
        return ""


def _local_ips() -> list[str]:
    """本机所有 IPv4 地址,按「手机可达性」排序(热点 > 虚拟组网 > 有线 > 无线)。

    走 novel.netinfo 的网卡枚举:只靠 UDP 探测 8.8.8.8 拿默认路由地址是不够的,
    校园网下那张网卡恰恰手机连不上,而 ZeroTier/Radmin 这类虚拟组网才可达。
    """
    try:
        from .netinfo import local_ips as _all
        ips = _all()
        if ips:
            return ips
    except Exception:  # noqa: BLE001
        pass
    ips: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:  # noqa: BLE001
        pass
    return ips


def detect(force: bool = False) -> dict:
    """返回热点/无线环境快照(5 秒缓存,force=True 时强制刷新)。"""
    with _lock:
        now = time.time()
        if _cache["data"] and not force and now - _cache["ts"] < 5:
            return _cache["data"]

        ips = _local_ips()
        hotspot_on = any(ip.startswith(HOTSPOT_NET) for ip in ips)
        hotspot_ips = [ip for ip in ips if ip.startswith(HOTSPOT_NET)]
        try:
            from .netinfo import adapters as _adapters
            adapter_list = _adapters()
        except Exception:  # noqa: BLE001
            adapter_list = []

        wifi_ssid = ""
        wifi_state = ""
        try:
            out = _netsh_wlan()
            m = _RE_SSID.search(out)
            if m:
                wifi_ssid = m.group(1).strip()
            m = _RE_STATE.search(out)
            if m:
                wifi_state = m.group(1).strip()
        except Exception:  # noqa: BLE001
            pass

        data = {
            "hotspot_on": hotspot_on,          # 移动热点是否已开启(检测到 192.168.137.x)
            "hotspot_ips": hotspot_ips,        # 本机热点网段 IP 列表
            "hotspot_gw": HOTSPOT_GW,          # 热点网关(手机扫码目标)
            "wifi_ssid": wifi_ssid,            # 当前无线连接 SSID(空=未连 WiFi)
            "wifi_state": wifi_state,          # 无线接口状态(disconnected/connected/...)
            "ips": ips,                        # 全部本机 IPv4(已按手机可达性排序)
            "primary_ip": ips[0] if ips else "",
            "adapters": adapter_list,          # 网卡明细:ip/kind/label/name/recommended
        }
        _cache["ts"] = now
        _cache["data"] = data
        return data


def best_lan_ip() -> str:
    """推荐给手机连接的地址:热点开启时用热点网关,否则按网卡优先级选。

    不再默认取「默认路由那张网卡」—— 校园网/公司网那张往往手机连不上。
    """
    d = detect()
    if d["hotspot_on"] and d["hotspot_ips"]:
        return d["hotspot_ips"][0]
    try:
        from .netinfo import best_ip as _best
        ip = _best()
        if ip and ip != "127.0.0.1":
            return ip
    except Exception:  # noqa: BLE001
        pass
    return d["primary_ip"] or "127.0.0.1"

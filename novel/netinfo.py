# -*- coding: utf-8 -*-
"""网卡枚举与地址分类 —— 选对「手机真正能连到的那个 IP」。

背景:一台电脑往往同时挂着多张网卡。校园网/公司网的无线地址普遍开 AP 隔离
与入站阻断,手机连不上;而 ZeroTier / Radmin VPN / Tailscale 这类虚拟组网
地址反而跨网络可达。原先只取「默认路由那张网卡」(UDP 探测 8.8.8.8)的地址,
会稳定选中不可达的那一个,于是扫码/配对必失败 —— 这正是本模块要解决的问题。

做法:Windows 下用 ctypes 调 GetAdaptersAddresses(纯标准库,无第三方依赖),
拿到网卡「驱动名 + 全部单播地址」,再按驱动名归类。用驱动名而不是系统字段名,
是因为 FriendlyName 来自驱动本身,不受中文/英文系统本地化影响
(netsh/ipconfig 的输出字段名会随语言变化,解析必然踩坑)。

排序意图(仅决定默认推荐项,界面始终列出全部候选):
    热点(192.168.137.x) > 虚拟组网 > 有线 > 无线 > 其他
虚拟组网排在物理网卡之前,因为它跨网络可达;物理地址在 AP 隔离下常常连不通。
"""
from __future__ import annotations

import socket
import threading
import time

KIND_HOTSPOT = "hotspot"
KIND_VIRTUAL = "virtual"
KIND_ETHERNET = "ethernet"
KIND_WIFI = "wifi"
KIND_OTHER = "other"

# 推荐顺序(数字越小越优先),同时也是界面展示顺序
_RANK = {
    KIND_HOTSPOT: 0,
    KIND_VIRTUAL: 1,
    KIND_ETHERNET: 2,
    KIND_WIFI: 3,
    KIND_OTHER: 4,
}

KIND_LABEL = {
    KIND_HOTSPOT: "移动热点",
    KIND_VIRTUAL: "虚拟组网",
    KIND_ETHERNET: "有线局域网",
    KIND_WIFI: "无线局域网",
    KIND_OTHER: "其他网卡",
}

# 驱动名关键词(小写匹配)。虚拟网卡厂商名基本都是英文,且写在驱动里。
_VIRTUAL_KEYS = (
    "zerotier", "radmin", "tailscale", "hamachi", "wireguard", "wintun",
    "tap-windows", "tap-win", "openvpn", "softether", "vpn", "vmware",
    "virtualbox", "hyper-v", "vethernet", "wsl", "docker", "npcap", "loopback",
    "虚拟", "加速", "tunnel", "tun",
)
_WIFI_KEYS = ("wlan", "wi-fi", "wifi", "wireless", "802.11", "无线")
_ETHERNET_KEYS = ("ethernet", "以太网", "gbe", "gigabit", "pcie", "realtek", "intel")

HOTSPOT_NET = "192.168.137."

# IF_TYPE 常量(GetAdaptersAddresses 的 IfType 字段)
_IF_TYPE_ETHERNET = 6
_IF_TYPE_IEEE80211 = 71
_IF_TYPE_LOOPBACK = 24
_IF_TYPE_TUNNEL = 131
_OPER_STATUS_UP = 1

_lock = threading.Lock()
_cache: dict = {"ts": 0.0, "data": None}
_CACHE_TTL = 5.0


# ---------------- Windows: GetAdaptersAddresses ----------------

def _win_adapters() -> list[dict]:
    """枚举网卡(仅 IPv4 单播,已过滤未启用/回环/链路本地)。失败返回空列表。"""
    import ctypes
    from ctypes import wintypes

    class SOCKADDR(ctypes.Structure):
        _fields_ = [("sa_family", ctypes.c_ushort), ("sa_data", ctypes.c_ubyte * 26)]

    class SOCKET_ADDRESS(ctypes.Structure):
        _fields_ = [("lpSockaddr", ctypes.POINTER(SOCKADDR)),
                    ("iSockaddrLength", ctypes.c_int)]

    class IP_ADAPTER_UNICAST_ADDRESS(ctypes.Structure):
        pass

    IP_ADAPTER_UNICAST_ADDRESS._fields_ = [
        ("Length", wintypes.ULONG),
        ("Flags", wintypes.DWORD),
        ("Next", ctypes.POINTER(IP_ADAPTER_UNICAST_ADDRESS)),
        ("Address", SOCKET_ADDRESS),
        ("PrefixOrigin", ctypes.c_int),
        ("SuffixOrigin", ctypes.c_int),
        ("DadState", ctypes.c_int),
        ("ValidLifetime", wintypes.ULONG),
        ("PreferredLifetime", wintypes.ULONG),
        ("LeaseLifetime", wintypes.ULONG),
        ("OnLinkPrefixLength", ctypes.c_ubyte),
    ]

    class IP_ADAPTER_ADDRESSES(ctypes.Structure):
        pass

    # 首字段是 union{ULONGLONG Alignment; struct{ULONG Length; DWORD IfIndex;}}
    # 展开成两个 4 字节字段后偏移与 C 定义一致。
    IP_ADAPTER_ADDRESSES._fields_ = [
        ("Length", wintypes.ULONG),
        ("IfIndex", wintypes.DWORD),
        ("Next", ctypes.POINTER(IP_ADAPTER_ADDRESSES)),
        ("AdapterName", ctypes.c_char_p),
        ("FirstUnicastAddress", ctypes.POINTER(IP_ADAPTER_UNICAST_ADDRESS)),
        ("FirstAnycastAddress", ctypes.c_void_p),
        ("FirstMulticastAddress", ctypes.c_void_p),
        ("FirstDnsServerAddress", ctypes.c_void_p),
        ("DnsSuffix", ctypes.c_wchar_p),
        ("Description", ctypes.c_wchar_p),
        ("FriendlyName", ctypes.c_wchar_p),
        ("PhysicalAddress", ctypes.c_ubyte * 8),
        ("PhysicalAddressLength", wintypes.ULONG),
        ("Flags", wintypes.ULONG),
        ("Mtu", wintypes.ULONG),
        ("IfType", wintypes.ULONG),
        ("OperStatus", ctypes.c_int),
        ("Ipv6IfIndex", wintypes.ULONG),
        ("ZoneIndices", wintypes.ULONG * 16),
        ("FirstPrefix", ctypes.c_void_p),
    ]

    iphlpapi = ctypes.WinDLL("iphlpapi.dll")
    fn = iphlpapi.GetAdaptersAddresses
    fn.argtypes = [wintypes.ULONG, wintypes.ULONG, ctypes.c_void_p,
                   ctypes.POINTER(IP_ADAPTER_ADDRESSES), ctypes.POINTER(wintypes.ULONG)]
    fn.restype = wintypes.ULONG

    AF_INET = 2
    # SKIP_ANYCAST|SKIP_MULTICAST|SKIP_DNS_SERVER —— 只要单播 IPv4
    flags = 0x02 | 0x04 | 0x08
    size = wintypes.ULONG(16 * 1024)
    buf = None
    for _ in range(4):
        buf = ctypes.create_string_buffer(size.value)
        ret = fn(AF_INET, flags, None,
                 ctypes.cast(buf, ctypes.POINTER(IP_ADAPTER_ADDRESSES)),
                 ctypes.byref(size))
        if ret == 0:
            break
        if ret != 111:      # 111 = ERROR_BUFFER_OVERFLOW,其余均为失败
            return []
    else:
        return []

    out: list[dict] = []
    node = ctypes.cast(buf, ctypes.POINTER(IP_ADAPTER_ADDRESSES))
    while node:
        a = node.contents
        name = a.FriendlyName or a.Description or ""
        if a.OperStatus == _OPER_STATUS_UP and a.IfType != _IF_TYPE_LOOPBACK:
            uni = a.FirstUnicastAddress
            while uni:
                sa = uni.contents.Address
                if sa.lpSockaddr:
                    sock = sa.lpSockaddr.contents
                    if sock.sa_family == AF_INET:
                        raw = bytes(bytearray(sock.sa_data[2:6]))
                        ip = ".".join(str(b) for b in raw)
                        if ip and not ip.startswith(("127.", "169.254.")):
                            out.append({
                                "ip": ip,
                                "name": name,
                                "desc": a.Description or "",
                                "if_type": int(a.IfType),
                                "if_index": int(a.IfIndex),
                            })
                uni = uni.contents.Next
        node = a.Next
    return out


def _fallback_adapters() -> list[dict]:
    """非 Windows 或不支持 ctypes 时的兜底:只有地址,没有驱动名。"""
    ips: list[str] = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith(("127.", "169.254.")):
                ips.append(ip)
    except OSError:
        pass
    return [{"ip": ip, "name": "", "desc": "", "if_type": 0, "if_index": 0} for ip in ips]


def classify(item: dict) -> str:
    """按 IP 网段 + 驱动名判定网卡类型。"""
    ip = str(item.get("ip") or "")
    if ip.startswith(HOTSPOT_NET):
        return KIND_HOTSPOT
    text = f"{item.get('name') or ''} {item.get('desc') or ''}".lower()
    # 热点网段不一定永远是 192.168.137.x(部分驱动/旧版 ICS 会给 192.168.0.1 等),
    # 这里再用驱动名兜一层:Windows 移动热点的虚拟网卡通常叫
    # "Microsoft Wi-Fi Direct Virtual Adapter" / "本地连接* N"。
    if any(k in text for k in ("wi-fi direct", "wifi direct", "hosted network", "移动热点")):
        return KIND_HOTSPOT
    if any(k in text for k in _VIRTUAL_KEYS):
        return KIND_VIRTUAL
    if any(k in text for k in _WIFI_KEYS):
        return KIND_WIFI
    if any(k in text for k in _ETHERNET_KEYS):
        return KIND_ETHERNET
    if_type = int(item.get("if_type") or 0)
    if if_type == _IF_TYPE_IEEE80211:
        return KIND_WIFI
    if if_type == _IF_TYPE_ETHERNET:
        return KIND_ETHERNET
    if if_type == _IF_TYPE_TUNNEL:
        return KIND_VIRTUAL
    return KIND_OTHER


def adapters(force: bool = False) -> list[dict]:
    """全部可用 IPv4 网卡,已归类并按推荐顺序排序。"""
    with _lock:
        now = time.time()
        if not force and _cache["data"] is not None and now - _cache["ts"] < _CACHE_TTL:
            return list(_cache["data"])

    items = _win_adapters() if _has_win_api() else _fallback_adapters()
    seen: set[str] = set()
    result: list[dict] = []
    for item in items:
        ip = item["ip"]
        if ip in seen:          # 同一地址可能挂在多张网卡上
            continue
        seen.add(ip)
        kind = classify(item)
        result.append({
            "ip": ip,
            "kind": kind,
            "label": KIND_LABEL.get(kind, "其他网卡"),
            "name": item.get("name") or "",
            "rank": _RANK.get(kind, 9),
        })
    result.sort(key=lambda a: (a["rank"], a["ip"]))
    for idx, item in enumerate(result):
        item["recommended"] = idx == 0

    with _lock:
        _cache["ts"] = time.time()
        _cache["data"] = result
    return list(result)


def _has_win_api() -> bool:
    import os
    return os.name == "nt"


def local_ips(force: bool = False) -> list[str]:
    """按推荐顺序排列的本机 IPv4 列表。"""
    return [a["ip"] for a in adapters(force)]


def candidates(port: int | str, scheme: str = "http", force: bool = False) -> list[dict]:
    """给手机用的候选地址列表:[{url, ip, kind, label, recommended}]。"""
    port_text = str(port or "").strip()
    out: list[dict] = []
    for item in adapters(force):
        host = item["ip"]
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        url = f"{scheme}://{host}" + (f":{port_text}" if port_text else "")
        out.append({
            "url": url,
            "ip": item["ip"],
            "kind": item["kind"],
            "label": item["label"],
            "name": item["name"],
            "recommended": bool(item.get("recommended")),
        })
    return out


def best_ip(force: bool = False) -> str:
    """推荐地址(热点 > 虚拟组网 > 有线 > 无线),没有网卡时回退 127.0.0.1。"""
    for item in adapters(force):
        return item["ip"]
    return "127.0.0.1"


if __name__ == "__main__":  # 自测:python -m novel.netinfo
    import json
    print(json.dumps(adapters(True), ensure_ascii=False, indent=2))
    print("best =", best_ip(True))
    print("candidates =", json.dumps(candidates(8899, force=True), ensure_ascii=False, indent=2))

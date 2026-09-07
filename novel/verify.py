# -*- coding: utf-8 -*-
"""验证中心:cookie 管理(Cloudflare 等手动验证后保存,请求层自动携带)。

存储:verify_cookies.json
  { "<hostname>": {"name": "...", "cookies": [...], "ts": 1234567890.0} }
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from urllib.parse import urlparse

from novel.paths import VERIFY_PATH as _VERIFY_PATH, VERIFY_PENDING_PATH as _PENDING_PATH

_TTL = 7 * 24 * 3600  # 7 天

# 与验证浏览器一致的 UA:cf_clearance 绑定验证时的 UA,请求层需用同一 UA 才能生效
DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# 请求层多线程并发读写验证记录(多个下载/搜索线程同时 401 → 同时写),需加锁
_lock = threading.Lock()


def _load() -> dict:
    try:
        with open(_VERIFY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _atomic_dump(path: str, data: dict) -> None:
    """原子写 JSON:先写临时文件再 replace,避免进程崩溃截断主文件。"""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _save(data: dict) -> None:
    _atomic_dump(_VERIFY_PATH, data)


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def save_cookies(url: str, cookies: list[dict], name: str = "", ua: str = "") -> str:
    """保存某域名验证后的 cookies。返回 hostname。

    空 cookies(验证未通过)不落盘:避免空记录把该域名的待验证条目"吞掉"。
    """
    if not cookies:
        return ""
    host = host_of(url)
    with _lock:
        data = _load()
        data[host] = {"name": name or host, "cookies": cookies, "ts": time.time(),
                      "ua": ua or DEFAULT_UA}
        _save(data)
    return host


def get_cookies(url: str):
    """按 URL 域名取验证 cookies。

    返回 (cookiejar, 验证时UA) 或 None(未验证/过期)。
    UA 需与验证时一致:Cloudflare 的 cf_clearance 与 UA/IP 绑定,
    请求层重试时必须用该 UA 而非随机 UA。
    """
    host = host_of(url)
    data = _load()
    rec = data.get(host)
    if not rec or not rec.get("cookies"):
        return None
    if time.time() - rec.get("ts", 0) > _TTL:
        return None
    import requests
    cj = requests.utils.cookiejar_from_dict(
        {c["name"]: c["value"] for c in rec["cookies"] if c.get("name")})
    return (cj, rec.get("ua") or DEFAULT_UA)


def list_verified() -> list[dict]:
    """返回已保存的验证记录(含过期的标记)。"""
    out = []
    for host, rec in _load().items():
        expired = time.time() - rec.get("ts", 0) > _TTL
        out.append({
            "host": host, "name": rec.get("name") or host,
            "count": len(rec.get("cookies") or []),
            "ts": rec.get("ts", 0),
            "expired": expired,
        })
    return sorted(out, key=lambda x: -x["ts"])


def remove(url_or_host: str) -> bool:
    """删除某域名的验证记录(接受 URL 或 hostname)。"""
    host = host_of(url_or_host) if "://" in url_or_host or "/" in url_or_host else url_or_host.lower()
    with _lock:
        data = _load()
        if host in data:
            del data[host]
            _save(data)
            return True
    return False


# ---- 待验证列表(请求遇到 401/403 自动登记) ----


def _load_pending() -> dict:
    try:
        with open(_PENDING_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_pending(data: dict) -> None:
    _atomic_dump(_PENDING_PATH, data)


def add_pending(url: str, name: str = "") -> str:
    """登记一个需要验证的网址(按域名去重,刷新时间)。返回 host。"""
    host = host_of(url)
    if not host:
        return ""
    with _lock:
        data = _load_pending()
        data[host] = {"url": url, "name": name or host, "ts": time.time()}
        _save_pending(data)
    return host


def list_pending() -> list[dict]:
    """返回待验证列表(排除仍有效的已验证记录;过期的重新出现,提示再验证)。"""
    verified = {h for h, rec in _load().items()
                if time.time() - rec.get("ts", 0) <= _TTL and rec.get("cookies")}
    out = []
    for host, rec in _load_pending().items():
        if host in verified:
            continue
        if not isinstance(rec, dict):
            continue  # 历史脏数据(如误写入的 list 条目),直接跳过避免崩溃
        out.append({"host": host, "name": rec.get("name") or host,
                    "url": rec.get("url", ""), "ts": rec.get("ts", 0)})
    return sorted(out, key=lambda x: -x["ts"])


def clear_pending(host: str) -> bool:
    with _lock:
        data = _load_pending()
        if host in data:
            del data[host]
            _save_pending(data)
            return True
    return False

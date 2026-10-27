# -*- coding: utf-8 -*-
"""手机配对与访问令牌:一次性配对码换取长期 Bearer token。

服务端只保存 token 的 SHA-256,明文仅在配对成功时返回一次。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from urllib.parse import quote, urlparse

from .paths import MOBILE_DEVICES_PATH

API_VERSION = 1
PAIR_TTL = 300
MAX_PAIR_ATTEMPTS = 5
MAX_FAILS = 12
FAIL_WINDOW = 600
ONLINE_WINDOW = 300

_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")

_lock = threading.RLock()
_pairs: dict[str, dict] = {}
_fails: dict[str, list[float]] = {}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _clean_name(name: str) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]", "", str(name or "")).strip()
    return text[:40] or "手机"


def _valid_id(device_id: str) -> bool:
    return bool(_DEVICE_ID_RE.fullmatch(str(device_id or "")))


def _load_unlocked() -> dict:
    try:
        with open(MOBILE_DEVICES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    devices = data.get("devices")
    if not isinstance(devices, list):
        devices = []
    data["version"] = 1
    data["devices"] = [
        d for d in devices
        if isinstance(d, dict) and d.get("id") and d.get("token_hash")
    ]
    return data


def _save_unlocked(data: dict) -> None:
    folder = os.path.dirname(MOBILE_DEVICES_PATH)
    if folder:
        os.makedirs(folder, exist_ok=True)
    tmp = MOBILE_DEVICES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, MOBILE_DEVICES_PATH)


def _public_device(d: dict, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    return {
        "id": d.get("id", ""),
        "name": d.get("name") or "手机",
        "created": int(d.get("created") or 0),
        "last_seen": int(d.get("last_seen") or 0),
        "last_ip": d.get("last_ip") or "",
        "online": now - float(d.get("last_seen") or 0) < ONLINE_WINDOW,
    }


def _prune_pairs_unlocked(now: float) -> None:
    for code in [c for c, p in _pairs.items() if p["expires"] <= now]:
        _pairs.pop(code, None)


def _record_fail(ip: str, now: float) -> None:
    bucket = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
    bucket.append(now)
    _fails[ip] = bucket[-MAX_FAILS:]


def start_pair(server_name: str, base_url: str, ttl: int = PAIR_TTL,
               candidates: list[str] | None = None, pin: str = "",
               ssh: str = "", ssh_password: str = "") -> dict:
    """生成一次性配对码与扫码链接(base_url 例如 http://192.168.1.5:8765)。

    candidates:全部候选地址(含 base_url)。除主地址外的会以 host:port 形式
    拼进 `alt` 参数 —— 手机端扫码后逐个探测,不通就换下一个。校园网/AP 隔离
    场景下主地址常常连不通,靠这一层自动落到虚拟组网地址上。

    pin:开启 HTTPS 时带上本机 CA 的短指纹。手机取回 CA 证书的同时用这个值
    校验 —— 指纹走的是「用户肉眼可见的二维码」这条可信通道,证书被替换会
    直接对不上,不依赖系统信任库里的一堆第三方 CA。
    """
    now = time.time()
    ttl = max(60, min(int(ttl or PAIR_TTL), 900))
    with _lock:
        _prune_pairs_unlocked(now)
        while True:
            code = f"{secrets.randbelow(900000) + 100000}"
            if code not in _pairs:
                break
        _pairs[code] = {"expires": now + ttl, "attempts": 0, "created": now}
    base = str(base_url or "").rstrip("/")
    name = quote(server_name or "NovelCrawler")
    uri = f"{base}/m?pair={code}&v=1&name={name}"
    alts: list[str] = []
    for item in (candidates or [])[:6]:
        try:
            parsed = urlparse(str(item or "").strip())
        except ValueError:
            continue
        if parsed.scheme in ("http", "https") and parsed.netloc:
            if parsed.netloc and f"{parsed.scheme}://{parsed.netloc}" != base:
                alts.append(parsed.netloc)
    if alts:
        # 去重保序,最多 4 个备用地址(再多二维码会变密,扫不动)
        seen: set[str] = set()
        uniq = [a for a in alts if not (a in seen or seen.add(a))]
        uri += "&alt=" + quote(",".join(uniq[:4]), safe=",:")
    pin = str(pin or "").strip()
    if pin:
        uri += "&pin=" + quote(pin, safe="")
    ssh = str(ssh or "").strip()
    if ssh:
        uri += "&ssh=" + quote(ssh, safe="@:")
        if ssh_password:
            # 内建 sshd 的密码:只在二维码里传一次(屏幕 → 手机这条视觉信道),
            # 不写日志、不进 URL 之外的任何地方
            uri += "&sshp=" + quote(str(ssh_password), safe="")
    legacy = f"{base}/mobile?pair={code}&v=1&name={name}"
    return {
        "ok": True,
        "code": code,
        "ttl": ttl,
        "expires_at": int(now + ttl),
        "uri": uri,
        "legacy_uri": legacy,
        "api": API_VERSION,
        "pin": pin,
        "ssh": ssh,
        "ssh_password": ssh_password,
    }


def confirm_pair(code: str, device_id: str, device_name: str = "",
                 remote_ip: str = "", user_agent: str = "") -> dict:
    """校验配对码并签发 token。返回 {ok, token, device} 或 {ok: False, error, status}。"""
    code = str(code or "").strip()
    device_id = str(device_id or "").strip()
    ip = str(remote_ip or "")
    if not re.fullmatch(r"\d{6}", code):
        return {"ok": False, "error": "配对码格式不正确", "status": 400}
    if not _valid_id(device_id):
        return {"ok": False, "error": "设备标识不合法", "status": 400}

    now = time.time()
    with _lock:
        recent = [t for t in _fails.get(ip, []) if now - t < FAIL_WINDOW]
        _fails[ip] = recent
        if len(recent) >= MAX_FAILS:
            return {"ok": False, "error": "尝试次数过多，请稍后再试", "status": 429}
        _prune_pairs_unlocked(now)
        session = _pairs.get(code)
        if not session:
            _record_fail(ip, now)
            return {"ok": False, "error": "配对码无效或已过期", "status": 401}
        if session["attempts"] >= MAX_PAIR_ATTEMPTS:
            _pairs.pop(code, None)
            _record_fail(ip, now)
            return {"ok": False, "error": "配对码已失效，请重新生成", "status": 401}

        token = secrets.token_urlsafe(32)
        entry = {
            "id": device_id,
            "name": _clean_name(device_name),
            "token_hash": _hash(token),
            "created": int(now),
            "last_seen": int(now),
            "last_ip": ip,
            "ua": str(user_agent or "")[:160],
        }
        data = _load_unlocked()
        data["devices"] = [d for d in data["devices"] if d.get("id") != device_id]
        data["devices"].append(entry)
        try:
            _save_unlocked(data)
        except OSError as exc:
            return {"ok": False, "error": f"保存配对信息失败: {exc}", "status": 500}
        _pairs.pop(code, None)
        _fails.pop(ip, None)
        return {
            "ok": True,
            "token": token,
            "device": _public_device(entry, now),
            "api": API_VERSION,
        }


def verify_token(token: str, remote_ip: str = "", user_agent: str = "") -> dict | None:
    """校验 Bearer token,成功返回设备公开信息并刷新最后在线时间。"""
    token = str(token or "").strip()
    if not 20 <= len(token) <= 200:
        return None
    digest = _hash(token)
    now = time.time()
    with _lock:
        data = _load_unlocked()
        for d in data["devices"]:
            stored = str(d.get("token_hash") or "")
            if stored and hmac.compare_digest(digest, stored):
                dirty = now - float(d.get("last_seen") or 0) > 30
                if dirty:
                    d["last_seen"] = int(now)
                    d["last_ip"] = remote_ip or d.get("last_ip") or ""
                    ua = str(user_agent or "")[:160]
                    if ua:
                        d["ua"] = ua
                    try:
                        _save_unlocked(data)
                    except OSError:
                        pass
                return _public_device(d, now)
    return None


def list_devices() -> list[dict]:
    now = time.time()
    with _lock:
        data = _load_unlocked()
        items = [_public_device(d, now) for d in data["devices"]]
    return sorted(items, key=lambda d: d.get("last_seen") or 0, reverse=True)


def revoke(device_id: str) -> bool:
    device_id = str(device_id or "").strip()
    if not device_id:
        return False
    with _lock:
        data = _load_unlocked()
        before = len(data["devices"])
        data["devices"] = [d for d in data["devices"] if d.get("id") != device_id]
        if len(data["devices"]) == before:
            return False
        _save_unlocked(data)
    return True


def revoke_all() -> int:
    with _lock:
        data = _load_unlocked()
        count = len(data["devices"])
        if count:
            data["devices"] = []
            _save_unlocked(data)
    return count

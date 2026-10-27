# -*- coding: utf-8 -*-
"""自签 HTTPS —— 本地 CA + 服务器证书,让手机到电脑这一段不再明文。

为什么是「本地 CA + 服务器证书」而不是单张自签证书:
    手机只要把这张 CA 装进系统信任库一次,后续换 IP、换端口都不用重新授权,
    浏览器也不会每次弹红色警告。CA 私钥只留在本机数据目录(权限 0600)。

为什么 SAN 要跟着网卡变:
    校园网 DHCP 换址、热点开关、虚拟组网重连都会改 IP。证书里的
    subjectAltName 不覆盖新 IP 时,手机侧就是「证书不匹配」—— 所以每次启动
    对比一次当前地址集合,变了就重签服务器证书(CA 不动,手机无需重装)。

实现:证书由 novel/x509.py 用纯标准库生成,不依赖 openssl
(Git 自带的那份是 MSYS 程序,在受限环境里 fork 会失败;也不能假设用户装了 Git)。
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time

from . import x509
from .paths import APP_DATA_DIR

TLS_DIR = os.path.join(APP_DATA_DIR, "tls")
CA_CERT = os.path.join(TLS_DIR, "ca.crt")
CA_KEY_PEM = os.path.join(TLS_DIR, "ca.key")
SRV_CERT = os.path.join(TLS_DIR, "server.crt")
SRV_KEY_PEM = os.path.join(TLS_DIR, "server.key")
META_PATH = os.path.join(TLS_DIR, "meta.json")

CA_CN = "Novelist Local CA"
SERVER_CN = "Novelist"
ORG = "Novelist"
CA_DAYS = 3650
SRV_DAYS = 730
_RENEW_AHEAD = 30 * 86400

_lock = threading.RLock()


def available() -> bool:
    return True   # 纯标准库生成,永远可用


def _read_meta() -> dict:
    try:
        with open(META_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(path: str, text: str, private: bool = False) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="ascii", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)
    if private:
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass


def _der_of(cert_path: str) -> bytes:
    """从 PEM 证书还原 DER(用于算指纹)。"""
    try:
        with open(cert_path, "r", encoding="ascii", errors="ignore") as f:
            text = f.read()
    except OSError:
        return b""
    body = "".join(line.strip() for line in text.splitlines()
                   if line.strip() and not line.startswith("-----"))
    if not body:
        return b""
    import base64
    try:
        return base64.b64decode(body)
    except (ValueError, TypeError):
        return b""


def fingerprint(cert_path: str = SRV_CERT) -> str:
    """证书 SHA-256 指纹(AA:BB:…)。手机端可与桌面显示值人工核对。"""
    der = _der_of(cert_path)
    if not der:
        return ""
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


def short_fingerprint(cert_path: str = CA_CERT, size: int = 16) -> str:
    """指纹短形式(base64url,默认 128 位),写进配对二维码给手机固定用。

    完整指纹 95 字符(tag=xxx 已接近 1KB)会让二维码密到扫不动;128 位
    离碰撞/伪造的可行范围还差着十几个数量级,做 pin 足够。
    """
    der = _der_of(cert_path)
    if not der:
        return ""
    import base64
    raw = hashlib.sha256(der).digest()[:max(8, min(size, 32))]
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _ensure_ca() -> bool:
    if os.path.isfile(CA_CERT) and os.path.isfile(CA_KEY_PEM):
        return False
    key = x509.generate_key()
    der = x509.build_certificate(CA_CN, CA_CN, ORG, key, key, True, [], CA_DAYS)
    _write(CA_CERT, x509.to_pem(der))
    _write(CA_KEY_PEM, x509.private_key_pem(key), private=True)
    return True


def _ensure_server(hosts: list[str]) -> str:
    """按当前网卡地址重签服务器证书。返回 ''(无需变更)/created/reissued。"""
    meta = _read_meta()
    fresh = os.path.isfile(SRV_CERT) and os.path.isfile(SRV_KEY_PEM)
    same = list(meta.get("hosts") or []) == list(hosts)
    if fresh and same:
        not_after = float(meta.get("not_after") or 0)
        if not_after and not_after - time.time() > _RENEW_AHEAD:
            return ""
    ca_key = _load_private(CA_KEY_PEM)
    if ca_key is None:
        raise RuntimeError("CA 私钥缺失或损坏,请删除 tls 目录后重试")
    key = x509.generate_key()
    der = x509.build_certificate(SERVER_CN, CA_CN, ORG, key, ca_key, False, hosts, SRV_DAYS)
    _write(SRV_CERT, x509.to_pem(der))
    _write(SRV_KEY_PEM, x509.private_key_pem(key), private=True)
    _write(META_PATH, json.dumps({
        "hosts": list(hosts),
        "created": int(time.time()),
        "not_after": int(time.time() + SRV_DAYS * 86400),
    }, ensure_ascii=False, indent=2))
    return "reissued" if fresh else "created"


def _load_private(path: str) -> dict | None:
    """从 PKCS#1 PEM 还原 RSA 参数(仅支持本模块自己写出的格式)。"""
    try:
        with open(path, "r", encoding="ascii", errors="ignore") as f:
            text = f.read()
    except OSError:
        return None
    import base64
    body = "".join(line.strip() for line in text.splitlines()
                   if line.strip() and not line.startswith("-----"))
    if not body:
        return None
    try:
        der = base64.b64decode(body)
    except (ValueError, TypeError):
        return None
    values = _parse_rsa_private(der)
    if not values or len(values) < 6:
        return None
    _, n, e, d, p, q = values[:6]
    return {"n": n, "e": e, "d": d, "p": p, "q": q,
            "dp": d % (p - 1), "dq": d % (q - 1), "qinv": pow(q, -1, p)}


def _parse_rsa_private(der: bytes) -> list[int]:
    """极简 DER 解析:取出 RSAPrivateKey 的全部 INTEGER。"""
    def read_tlv(buf: bytes, pos: int) -> tuple[int, bytes, int]:
        tag = buf[pos]
        pos += 1
        length = buf[pos]
        pos += 1
        if length & 0x80:
            count = length & 0x7F
            length = int.from_bytes(buf[pos:pos + count], "big")
            pos += count
        return tag, buf[pos:pos + length], pos + length

    tag, content, _ = read_tlv(der, 0)
    if tag != 0x30:
        return []
    out: list[int] = []
    pos = 0
    while pos < len(content):
        tag, body, pos = read_tlv(content, pos)
        if tag == 0x02:
            out.append(int.from_bytes(body, "big"))
    return out


def ensure(hosts: list[str] | None = None) -> dict:
    """准备 CA 与服务器证书(幂等)。返回 {ok, cert, key, ca, fingerprint, hosts}。"""
    clean: list[str] = []
    for host in hosts or []:
        host = str(host or "").strip()
        if host and host not in clean and not host.startswith("127."):
            clean.append(host)
    with _lock:
        try:
            os.makedirs(TLS_DIR, exist_ok=True)
            _ensure_ca()
            _ensure_server(clean)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)[:200]}
    return {
        "ok": True,
        "cert": SRV_CERT,
        "key": SRV_KEY_PEM,
        "ca": CA_CERT,
        "fingerprint": fingerprint(SRV_CERT),
        "ca_fingerprint": fingerprint(CA_CERT),
        "pin": short_fingerprint(CA_CERT),
        "hosts": clean,
    }


def status(hosts: list[str] | None = None) -> dict:
    """只报告现状,不生成任何东西(设置页展示用)。"""
    meta = _read_meta()
    cert_exists = os.path.isfile(SRV_CERT)
    return {
        "available": True,
        "provider": "builtin",
        "ca_exists": os.path.isfile(CA_CERT),
        "cert_exists": cert_exists,
        "fingerprint": fingerprint(SRV_CERT) if cert_exists else "",
        "ca_fingerprint": fingerprint(CA_CERT) if os.path.isfile(CA_CERT) else "",
        "pin": short_fingerprint(CA_CERT) if os.path.isfile(CA_CERT) else "",
        "hosts": meta.get("hosts") or [],
        "not_after": int(meta.get("not_after") or 0),
        "dir": TLS_DIR,
    }


def read_ca_pem() -> str:
    try:
        with open(CA_CERT, "r", encoding="ascii", errors="ignore") as f:
            return f.read()
    except OSError:
        return ""


if __name__ == "__main__":  # 自测:python -m novel.tls
    import json as _json
    from . import netinfo
    print("status:", _json.dumps(status(), ensure_ascii=False, indent=2))
    info = ensure(netinfo.local_ips())
    print("ensure:", _json.dumps({k: v for k, v in info.items() if k not in ("cert", "key", "ca")},
                                 ensure_ascii=False, indent=2))
    print("reuse:", ensure(netinfo.local_ips()).get("fingerprint", "")[:23], "(应与上面一致)")

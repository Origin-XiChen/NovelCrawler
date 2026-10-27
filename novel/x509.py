# -*- coding: utf-8 -*-
"""纯标准库的 RSA + X.509 自签证书生成(不依赖 openssl)。

为什么不用 openssl:
    Windows 上没有系统自带的 openssl;Git for Windows 那份是 MSYS 程序,
    在受限环境里 fork 会直接失败。打包分发时也不能假设用户装了 Git。
    自己生成只用到随机数与大整数幂,标准库足够,且生成一次即可长期复用。

实现范围(只做服务端自签链需要的最小子集):
    - RSA-2048 密钥:Miller-Rabin 素性检验 + CRT 签名
    - X.509 v3:Certificate/TBSCertificate/Name/SubjectPublicKeyInfo/Extensions
    - 签名算法:sha256WithRSAEncryption(PKCS#1 v1.5)

正确性由外部 openssl 交叉校验(novel/tls.py 的自测里可跑 `openssl verify`)。
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import time

# 前 200 个素数,先做小素数试除,能砍掉 ~80% 的候选
_SMALL_PRIMES = [
    3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73,
    79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157,
    163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233, 239,
    241, 251, 257, 263, 269, 271, 277, 281, 283, 293, 307, 311, 313, 317, 331,
    337, 347, 349, 353, 359, 367, 373, 379, 383, 389, 397, 401, 409, 419, 421,
    431, 433, 439, 443, 449, 457, 461, 463, 467, 479, 487, 491, 499, 503, 509,
    521, 523, 541, 547, 557, 563, 569, 571, 577, 587, 593, 599, 601, 607, 613,
    617, 619, 631, 641, 643, 647, 653, 659, 661, 673, 677, 683, 691, 701, 709,
    719, 727, 733, 739, 743, 751, 757, 761, 769, 773, 787, 797, 809, 811, 821,
    823, 827, 829, 839, 853, 857, 859, 863, 877, 881, 883, 887, 907, 911, 919,
    929, 937, 941, 947, 953, 967, 971, 977, 983, 991, 997,
]


# ---------------- RSA ----------------

def _miller_rabin(n: int, rounds: int = 8) -> bool:
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d = n - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _gen_prime(bits: int) -> int:
    while True:
        cand = secrets.randbits(bits) | (1 << (bits - 1)) | 1
        if any(cand % p == 0 for p in _SMALL_PRIMES):
            continue
        if _miller_rabin(cand):
            return cand


def generate_key(bits: int = 2048, e: int = 65537) -> dict:
    """生成 RSA 私钥(含 CRT 参数)。2048 位在普通机器上约 0.5~3 秒。"""
    half = bits // 2
    while True:
        p = _gen_prime(half)
        q = _gen_prime(half)
        if p == q:
            continue
        phi = (p - 1) * (q - 1)
        if phi % e == 0:
            continue
        n = p * q
        if n.bit_length() < bits:
            continue
        d = pow(e, -1, phi)
        return {
            "n": n, "e": e, "d": d, "p": p, "q": q,
            "dp": d % (p - 1), "dq": d % (q - 1), "qinv": pow(q, -1, p),
            "bits": bits,
        }


_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


def sign_pkcs1_v15(key: dict, data: bytes) -> bytes:
    """sha256WithRSAEncryption 签名(带 CRT 加速)。"""
    digest = hashlib.sha256(data).digest()
    t = _SHA256_DIGEST_INFO + digest
    n, k = key["n"], (key["n"].bit_length() + 7) // 8
    if k < len(t) + 11:
        raise ValueError("密钥太短")
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    m = int.from_bytes(em, "big")
    m1 = pow(m, key["dp"], key["p"])
    m2 = pow(m, key["dq"], key["q"])
    h = (key["qinv"] * (m1 - m2)) % key["p"]
    s = m2 + h * key["q"]
    return s.to_bytes(k, "big")


# ---------------- DER 编码 ----------------

def _len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def _tlv(tag: int, content: bytes) -> bytes:
    return bytes([tag]) + _len(len(content)) + content


def _seq(*items: bytes) -> bytes:
    return _tlv(0x30, b"".join(items))


def _set(*items: bytes) -> bytes:
    return _tlv(0x31, b"".join(items))


def _int(value: int) -> bytes:
    if value == 0:
        return _tlv(0x02, b"\x00")
    body = value.to_bytes((value.bit_length() + 8) // 8, "big")  # 多留一字节给符号位
    return _tlv(0x02, body)


def _oid(dotted: str) -> bytes:
    parts = [int(x) for x in dotted.split(".")]
    body = bytes([40 * parts[0] + parts[1]])
    for value in parts[2:]:
        chunk = bytearray([value & 0x7F])
        value >>= 7
        while value:
            chunk.insert(0, 0x80 | (value & 0x7F))
            value >>= 7
        body += bytes(chunk)
    return _tlv(0x06, body)


def _utf8(text: str) -> bytes:
    return _tlv(0x0C, text.encode("utf-8"))


def _ia5(text: str) -> bytes:
    return _tlv(0x16, text.encode("ascii"))


def _octets(data: bytes) -> bytes:
    return _tlv(0x04, data)


def _bits(data: bytes, unused: int = 0) -> bytes:
    return _tlv(0x03, bytes([unused]) + data)


def _bool(value: bool) -> bytes:
    return _tlv(0x01, b"\xff" if value else b"\x00")


def _utc_time(stamp: float) -> bytes:
    return _tlv(0x17, time.strftime("%y%m%d%H%M%SZ", time.gmtime(stamp)).encode("ascii"))


def _name(cn: str, org: str) -> bytes:
    rdns = [_set(_seq(_oid("2.5.4.3"), _utf8(cn)))]
    if org:
        rdns.append(_set(_seq(_oid("2.5.4.10"), _utf8(org))))
    return _seq(*rdns)


def _alg_sha256_rsa() -> bytes:
    return _seq(_oid("1.2.840.113549.1.1.11"), _tlv(0x05, b""))


def _spki(key: dict) -> bytes:
    pub = _seq(_int(key["n"]), _int(key["e"]))
    return _seq(_seq(_oid("1.2.840.113549.1.1.1"), _tlv(0x05, b"")), _bits(pub))


def _ext(oid: str, value: bytes, critical: bool = False) -> bytes:
    parts = [_oid(oid)]
    if critical:
        parts.append(_bool(True))
    parts.append(_octets(value))
    return _seq(*parts)


def _key_identifier(key: dict) -> bytes:
    """RFC 5280 方法一:subjectPublicKey 位串内容的 SHA-1(160 位)。"""
    body = _seq(_int(key["n"]), _int(key["e"]))
    return hashlib.sha1(body).digest()


def build_certificate(cn: str, issuer_cn: str, org: str, key: dict,
                      signing_key: dict, is_ca: bool, sans: list[str],
                      days: int, serial: int | None = None) -> bytes:
    """构造并签名一张 X.509 v3 证书,返回 DER 字节。"""
    serial = serial if serial is not None else (secrets.randbits(63) | 1)
    now = time.time()
    not_before = _utc_time(now - 86400)
    not_after = _utc_time(now + days * 86400)

    extensions: list[bytes] = []
    ski = _key_identifier(key)
    if is_ca:
        extensions.append(_ext("2.5.29.19", _seq(_bool(True)), critical=True))
        # keyCertSign | cRLSign
        extensions.append(_ext("2.5.29.15", _tlv(0x03, bytes([0x01, 0x06])), critical=True))
        extensions.append(_ext("2.5.29.14", _octets(ski)))
    else:
        extensions.append(_ext("2.5.29.19", _seq(), critical=True))
        # digitalSignature | keyEncipherment
        extensions.append(_ext("2.5.29.15", _tlv(0x03, bytes([0x05, 0xA0])), critical=True))
        extensions.append(_ext(
            "2.5.29.37",
            _seq(_oid("1.3.6.1.5.5.7.3.1")),      # serverAuth
        ))
        # OpenSSL 的 strict 模式(X509_V_FLAG_X509_STRICT)要求 SKI + AKI,缺了
        # 会直接 CERTIFICATE_VERIFY_FAILED: Missing Authority Key Identifier
        extensions.append(_ext("2.5.29.14", _octets(ski)))
        extensions.append(_ext("2.5.29.35",
                               _seq(_tlv(0x80, _key_identifier(signing_key)))))
        names = [_tlv(0x82, b"localhost")]        # dNSName
        for host in sans:
            if not host:
                continue
            try:
                packed = bytes(int(part) for part in host.split("."))
            except ValueError:
                names.append(_tlv(0x82, host.encode("ascii", "ignore")))
                continue
            if len(packed) == 4:
                names.append(_tlv(0x87, packed))  # iPAddress
        names.append(_tlv(0x87, bytes([127, 0, 0, 1])))
        extensions.append(_ext("2.5.29.17", _seq(*names)))

    tbs = _seq(
        _tlv(0xA0, _int(2)),                       # version v3
        _int(serial),
        _alg_sha256_rsa(),
        _name(issuer_cn, org),
        _seq(not_before, not_after),
        _name(cn, org),
        _spki(key),
        _tlv(0xA3, _seq(*extensions)),             # extensions [3]
    )
    signature = sign_pkcs1_v15(signing_key, tbs)
    return _seq(tbs, _alg_sha256_rsa(), _bits(signature))


def to_pem(der: bytes, label: str = "CERTIFICATE") -> str:
    body = base64.encodebytes(der).decode("ascii").replace("\n", "")
    lines = [body[i:i + 64] for i in range(0, len(body), 64)]
    return f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n"


def private_key_pem(key: dict) -> str:
    """PKCS#1 RSAPrivateKey(CreateSSL 与 ssl.load_cert_chain 都认)。"""
    der = _seq(
        _int(0),
        _int(key["n"]), _int(key["e"]), _int(key["d"]),
        _int(key["p"]), _int(key["q"]),
        _int(key["dp"]), _int(key["dq"]), _int(key["qinv"]),
    )
    return to_pem(der, "RSA PRIVATE KEY")


if __name__ == "__main__":  # 自测:生成一对 CA/叶子证书并打印指纹
    import os
    import sys

    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()
    ca_key = generate_key()
    leaf_key = generate_key()
    print(f"keygen: {time.time() - t0:.1f}s")
    ca_der = build_certificate("Novelist Local CA", "Novelist Local CA", "Novelist",
                               ca_key, ca_key, True, [], 3650)
    leaf_der = build_certificate("Novelist", "Novelist Local CA", "Novelist",
                                 leaf_key, ca_key, False, ["10.144.79.157"], 730)
    for name, der in (("ca.crt", ca_der), ("server.crt", leaf_der)):
        with open(os.path.join(out_dir, name), "w", encoding="ascii") as f:
            f.write(to_pem(der))
    with open(os.path.join(out_dir, "ca.key"), "w", encoding="ascii") as f:
        f.write(private_key_pem(ca_key))
    with open(os.path.join(out_dir, "server.key"), "w", encoding="ascii") as f:
        f.write(private_key_pem(leaf_key))
    print("sha256(server) =", hashlib.sha256(leaf_der).hexdigest()[:32])

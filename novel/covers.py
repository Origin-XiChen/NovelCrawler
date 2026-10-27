# -*- coding: utf-8 -*-
"""书籍封面缓存。

下载小说时把来源封面存到输出目录下的 ``.covers/<md5>.<ext>``：

* EPUB 导出会直接把封面写进书里（cover-image），手机/其他阅读器离线可见；
* TXT 没有容器，靠这份 sidecar 随离线包进手机；
* ``/api/book_cover`` 也按文件名从这里取图。

缓存按文件名（而非书名）索引：同一本书换了文件名不会串封面，
重名不同书也各有一份。老的 EPUB 没有缓存时，会尝试从书内声明的
cover-image 抽出来回填。
"""
from __future__ import annotations

import hashlib
import os
import re
import threading

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
_MAX_BYTES = 8 * 1024 * 1024

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_hint_cache: dict[str, tuple[float, bool]] = {}


def _out_dir() -> str:
    from .config import get_out_dir
    return get_out_dir()


def _cache_dir(create: bool = True) -> str:
    path = os.path.join(_out_dir(), ".covers")
    if create:
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            return ""
    return path


def _key(file_name: str) -> str:
    return hashlib.md5(os.path.basename(file_name).encode("utf-8")).hexdigest()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _locks[key] = lock
        return lock


def _title_of(file_name: str) -> str:
    stem = os.path.splitext(os.path.basename(file_name))[0]
    return re.sub(r"\[[^\]]*\]$", "", stem).strip()


def find_cover(file_name: str) -> str:
    """返回已缓存的封面路径；没有返回空串。"""
    base = _cache_dir(create=False)
    if not base:
        return ""
    key = _key(file_name)
    for ext in _IMAGE_EXTS:
        path = os.path.join(base, key + ext)
        try:
            if os.path.isfile(path) and os.path.getsize(path) > 0:
                return path
        except OSError:
            continue
    return ""


def content_type(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".bmp": "image/bmp",
    }.get(ext, "image/jpeg")


def _ext_for(data: bytes, ctype: str = "") -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data[:2] == b"BM":
        return ".bmp"
    ctype = (ctype or "").split(";")[0].strip().lower()
    return {
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
    }.get(ctype, ".jpg")


def save_cover(file_name: str, data: bytes, ctype: str = "") -> str:
    """写入缓存；同名的其它扩展名旧图会清掉，避免张冠李戴。"""
    if not data or len(data) > _MAX_BYTES:
        return ""
    base = _cache_dir()
    if not base:
        return ""
    key = _key(file_name)
    ext = _ext_for(data, ctype)
    path = os.path.join(base, key + ext)
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        for old in _IMAGE_EXTS:
            if old != ext:
                try:
                    os.remove(os.path.join(base, key + old))
                except OSError:
                    pass
    except OSError:
        return ""
    with _locks_guard:
        _hint_cache.pop(os.path.basename(file_name), None)
    return path


def fetch_cover(url: str, timeout: float = 15) -> tuple[bytes, str]:
    """按浏览器方式抓封面(防盗链 Referer + 验证中心 Cookie 兜底)。"""
    url = (url or "").strip()
    if not url.startswith("http"):
        return b"", ""
    import requests

    headers = {"User-Agent": _UA}
    try:
        parts = url.split("/")
        headers["Referer"] = parts[0] + "//" + parts[2] + "/"
    except IndexError:
        pass
    try:
        r = requests.get(url, headers=headers, timeout=timeout)
        if r.status_code in (401, 403):
            try:
                from .verify import get_cookies
                ret = get_cookies(url)
                if ret is not None:
                    cookies, ua = ret
                    r = requests.get(url, headers={**headers, "User-Agent": ua},
                                     timeout=timeout, cookies=cookies)
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        return b"", ""
    if r.status_code != 200 or not r.content or len(r.content) > _MAX_BYTES:
        return b"", ""
    ctype = r.headers.get("Content-Type", "")
    if ctype and not ctype.lower().startswith("image"):
        return b"", ""
    return r.content, ctype


def _shelf_cover_url(file_name: str) -> str:
    try:
        from .shelf import load_shelf
        title = _title_of(file_name)
        for entry in load_shelf():
            if (entry.get("title") or "").strip() == title:
                return (entry.get("cover") or "").strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def _epub_embedded_cover(src: str) -> str:
    if not src.lower().endswith(".epub") or not os.path.isfile(src):
        return ""
    try:
        from .epub import read_asset
        from .mobile_bundle import _epub_cover
        rel = _epub_cover(src)
        if not rel:
            return ""
        return save_cover(os.path.basename(src), read_asset(src, rel))
    except Exception:  # noqa: BLE001
        return ""


def has_cover(src: str) -> bool:
    """列表页用：不联网，只判断缓存 / EPUB 内嵌 / 书架里是否有封面地址。"""
    name = os.path.basename(src)
    if find_cover(name):
        return True
    try:
        mtime = os.path.getmtime(src)
    except OSError:
        mtime = 0.0
    hit = _hint_cache.get(name)
    if hit and hit[0] == mtime:
        return hit[1]
    ok = bool(_epub_embedded_cover(src)) or bool(_shelf_cover_url(name))
    _hint_cache[name] = (mtime, ok)
    return ok


def ensure_cover(src: str, cover_url: str = "") -> str:
    """确保缓存存在：缓存 → EPUB 内嵌 → 来源地址 → 书架地址。"""
    name = os.path.basename(src)
    cached = find_cover(name)
    if cached:
        return cached
    with _lock_for(_key(name)):
        cached = find_cover(name)
        if cached:
            return cached
        embedded = _epub_embedded_cover(src)
        if embedded:
            return embedded
        url = (cover_url or "").strip() or _shelf_cover_url(name)
        if url:
            data, ctype = fetch_cover(url)
            if data:
                return save_cover(name, data, ctype)
    return ""


def cover_bytes_for(file_name: str, cover_url: str = "") -> bytes:
    """导出 EPUB 时用：拿封面字节（查缓存或现抓，不读 EPUB 自身）。"""
    cached = find_cover(file_name)
    if cached:
        try:
            with open(cached, "rb") as f:
                return f.read()
        except OSError:
            return b""
    url = (cover_url or "").strip()
    if not url:
        return b""
    data, ctype = fetch_cover(url)
    if data:
        save_cover(file_name, data, ctype)
    return data

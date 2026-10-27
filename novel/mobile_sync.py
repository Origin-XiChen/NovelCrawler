# -*- coding: utf-8 -*-
"""手机 → 电脑的书本回传。

手机本地导入的 EPUB/TXT 先流式落到 ``mobile_imports/`` 暂存,电脑端确认后
再移进小说书库(与 /api/files 同一个输出目录),避免半截文件被书库看到。
一次"同步手机本地"只登记一个请求标记,手机端联网后按标记上传并回执。
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from typing import BinaryIO

from novel.paths import APP_DATA_DIR

INBOX_DIR = os.path.join(APP_DATA_DIR, "mobile_imports")
_STATE_PATH = os.path.join(INBOX_DIR, "_state.json")
_TMP_SUFFIX = ".part"
MAX_UPLOAD = 1024 * 1024 * 1024
_CHUNK = 256 * 1024
_BAD_CHARS = '<>:"/\\|?*'

_lock = threading.RLock()


def inbox_dir() -> str:
    os.makedirs(INBOX_DIR, exist_ok=True)
    return INBOX_DIR


def safe_name(raw: str) -> str:
    """只接受纯文件名的小说格式;路径分隔符/控制字符一律剥掉。"""
    name = os.path.basename(str(raw or "").replace("\\", "/")).strip()
    name = "".join(ch for ch in name if ch >= " " and ch not in _BAD_CHARS)
    if not name or name.startswith(".") or not name.lower().endswith((".txt", ".epub")):
        return ""
    stem, ext = os.path.splitext(name)
    if len(stem) > 150:
        name = stem[:150] + ext
    return name


def _load_state() -> dict:
    with _lock:
        try:
            with open(_STATE_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except (OSError, ValueError):
            pass
        return {}


def _save_state(state: dict) -> None:
    with _lock:
        inbox_dir()
        tmp = _STATE_PATH + _TMP_SUFFIX
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
        os.replace(tmp, _STATE_PATH)


def request_sync(sid: str = "") -> dict:
    with _lock:
        state = _load_state()
        state.update({
            "requested": True,
            "requested_at": int(time.time()),
            "done_at": 0,
            "sid": str(sid or ""),
        })
        _save_state(state)
        return public_state(state)


def acknowledge() -> dict:
    with _lock:
        state = _load_state()
        state["requested"] = False
        state["done_at"] = int(time.time())
        _save_state(state)
        return public_state(state)


def public_state(state: dict | None = None) -> dict:
    data = state if state is not None else _load_state()
    return {
        "requested": bool(data.get("requested")),
        "requested_at": int(data.get("requested_at") or 0),
        "done_at": int(data.get("done_at") or 0),
    }


def list_files() -> list[dict]:
    root = inbox_dir()
    out: list[dict] = []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return out
    for name in names:
        if name.startswith("_") or name.endswith(_TMP_SUFFIX):
            continue
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append({
            "name": name,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
        })
    out.sort(key=lambda item: item["mtime"], reverse=True)
    return out


def receive(rfile: BinaryIO, length: int, raw_name: str) -> tuple[str, int]:
    """把请求体流式写进暂存目录,返回 (文件名, 字节数)。"""
    name = safe_name(raw_name)
    if not name:
        raise ValueError("只接受 .txt/.epub 文件")
    if length <= 0:
        raise ValueError("上传内容为空")
    if length > MAX_UPLOAD:
        raise ValueError("文件太大(上限 1GB)")
    target = os.path.join(inbox_dir(), name)
    tmp = target + _TMP_SUFFIX
    received = 0
    try:
        with open(tmp, "wb") as f:
            remaining = length
            while remaining > 0:
                chunk = rfile.read(min(_CHUNK, remaining))
                if not chunk:
                    raise OSError("上传中断")
                f.write(chunk)
                received += len(chunk)
                remaining -= len(chunk)
        os.replace(tmp, target)
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise
    return name, received


def discard(raw_name: str) -> bool:
    name = os.path.basename(str(raw_name or ""))
    if not name or name.startswith("_") or name.endswith(_TMP_SUFFIX):
        return False
    path = os.path.join(inbox_dir(), name)
    if not os.path.isfile(path):
        return False
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def _file_digest(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _same_content(a: str, b: str) -> bool:
    try:
        if os.path.getsize(a) != os.path.getsize(b):
            return False
        return _file_digest(a) == _file_digest(b)
    except OSError:
        return False


def import_to_library(raw_name: str) -> dict:
    """把暂存文件移进小说书库;同名不同内容时另起"（手机）"名字,不覆盖电脑上的书。"""
    from novel.config import get_out_dir

    name = os.path.basename(str(raw_name or ""))
    src = os.path.join(inbox_dir(), name)
    if not name or name.startswith("_") or not os.path.isfile(src):
        raise FileNotFoundError(name or "文件不存在")

    out_dir = get_out_dir()
    os.makedirs(out_dir, exist_ok=True)
    stem, ext = os.path.splitext(name)
    target = os.path.join(out_dir, name)
    existed = False
    if os.path.exists(target):
        if _same_content(src, target):
            os.remove(src)
            return {"name": os.path.basename(target), "existed": True}
        target = ""
        for i in range(1, 100):
            suffix = "（手机）" if i == 1 else f"（手机{i}）"
            candidate = os.path.join(out_dir, f"{stem}{suffix}{ext}")
            if not os.path.exists(candidate):
                target = candidate
                break
        if not target:
            raise OSError("同名文件太多,请先整理书库")

    try:
        os.replace(src, target)
    except OSError:
        import shutil
        shutil.move(src, target)
    return {"name": os.path.basename(target), "existed": existed}

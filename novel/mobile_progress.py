# -*- coding: utf-8 -*-
"""手机 App 阅读进度回传(落盘到数据目录 mobile_progress.json)。

手机离线读书时进度只存在手机本地;联网后按设备回传到这里,于是
换手机、重装 App 都能接着读,电脑端也能看到"这台手机读到第几章"。

结构::

    { "<device_id>": { "<book_id>": {kind, title, chapter, ch, total, scroll, ts} } }

字段口径(手机与电脑共用,写死在文档里免得两边各自解释):
    ch       章节/页序号,从 1 开始
    total    该书总章节数或总页数
    chapter  章节标题原文,只为电脑端展示"读到第 X 章 标题",不参与定位
    scroll   当前章节内的滚动比例,0~1

按设备分片是防串味:同一本书在两台手机上各读各的,后读的不会覆盖前一台。
写入沿用 notes.py 的临时文件 + os.replace 原子替换,避免半截 JSON。
"""
from __future__ import annotations

import json
import os
import threading
import time

from .paths import MOBILE_PROGRESS_PATH

_lock = threading.Lock()
# 每台设备最多留多少本书的进度(手机书架不会无限膨胀,留个兜底防文件变大)
_MAX_PER_DEVICE = 800


def _load() -> dict:
    try:
        with open(MOBILE_PROGRESS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    parent = os.path.dirname(MOBILE_PROGRESS_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = MOBILE_PROGRESS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, MOBILE_PROGRESS_PATH)


def _norm(rec: dict) -> dict:
    try:
        ch = int(rec.get("ch") or 0)
    except (TypeError, ValueError):
        ch = 0
    try:
        total = int(rec.get("total") or 0)
    except (TypeError, ValueError):
        total = 0
    try:
        scroll = min(max(float(rec.get("scroll") or 0), 0.0), 1.0)
    except (TypeError, ValueError):
        scroll = 0.0
    return {
        "kind": str(rec.get("kind") or "novel")[:16],
        "title": str(rec.get("title") or "")[:200],
        "chapter": str(rec.get("chapter") or "")[:200],
        "ch": max(ch, 0),
        "total": max(total, 0),
        "scroll": scroll,
        "ts": int(time.time()),
    }


def save(device_id: str, book_id: str, rec: dict) -> dict:
    """写入一本进度,返回落库后的记录。"""
    device_id = (device_id or "").strip()[:64]
    book_id = (book_id or "").strip()[:200]
    if not device_id or not book_id:
        return {}
    entry = _norm(rec)
    with _lock:
        data = _load()
        books = data.setdefault(device_id, {})
        books[book_id] = entry
        if len(books) > _MAX_PER_DEVICE:
            # 丢最旧的,保持文件规模可控
            for k in sorted(books, key=lambda b: books[b].get("ts", 0))[:-_MAX_PER_DEVICE]:
                books.pop(k, None)
        _save(data)
    return entry


def get(device_id: str, book_id: str) -> dict:
    """单本进度;不存在返回 {}。"""
    data = _load()
    return (data.get((device_id or "").strip()[:64]) or {}).get(
        (book_id or "").strip()[:200]) or {}


def get_many(device_id: str, book_ids: list[str] | None = None) -> dict:
    """某设备的进度表;book_ids 给了就只回这些。"""
    books = _load().get((device_id or "").strip()[:64]) or {}
    if not book_ids:
        return dict(books)
    wanted = {str(b).strip()[:200] for b in book_ids if b}
    return {k: v for k, v in books.items() if k in wanted}


def drop_device(device_id: str) -> int:
    """解绑设备时清掉它的进度,返回删除的条数。"""
    device_id = (device_id or "").strip()[:64]
    with _lock:
        data = _load()
        removed = data.pop(device_id, None) or {}
        _save(data)
    return len(removed)

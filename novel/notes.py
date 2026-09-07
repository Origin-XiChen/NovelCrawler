# -*- coding: utf-8 -*-
"""阅读书签与划词笔记(持久化到数据目录 notes.json)。

结构:
{
  "<book_key>": {
    "bookmarks": [1, 5, 12],              # 章节序号
    "notes": [
      {"id": "<uuid>", "ch": 3, "text": "我的批注", "quote": "原文摘录", "ts": 1700000000}
    ]
  }
}
book_key 用书名(阅读器按文件/书名存取)。
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid

from .paths import NOTES_PATH

_lock = threading.Lock()


def _load() -> dict:
    try:
        with open(NOTES_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(NOTES_PATH), exist_ok=True)
    tmp = NOTES_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, NOTES_PATH)


def get_book(key: str) -> dict:
    """返回某本书的 {bookmarks, notes}。"""
    data = _load()
    rec = data.get(key) or {}
    return {
        "bookmarks": rec.get("bookmarks") or [],
        "notes": rec.get("notes") or [],
    }


def bookmark_toggle(key: str, ch: int) -> dict:
    """切换章节书签,返回最新 {bookmarks, bookmarked}。"""
    with _lock:
        data = _load()
        rec = data.setdefault(key, {"bookmarks": [], "notes": []})
        marks = rec.setdefault("bookmarks", [])
        if ch in marks:
            marks.remove(ch)
            bookmarked = False
        else:
            marks.append(ch)
            marks.sort()
            bookmarked = True
        _save(data)
    return {"bookmarks": marks, "bookmarked": bookmarked}


def note_add(key: str, ch: int, text: str, quote: str = "") -> dict:
    """新增笔记,返回最新笔记列表。"""
    note = {
        "id": uuid.uuid4().hex[:12],
        "ch": int(ch),
        "text": (text or "").strip()[:2000],
        "quote": (quote or "").strip()[:500],
        "ts": int(time.time()),
    }
    with _lock:
        data = _load()
        rec = data.setdefault(key, {"bookmarks": [], "notes": []})
        rec.setdefault("notes", []).append(note)
        _save(data)
    return rec["notes"]


def note_del(key: str, note_id: str) -> dict:
    """删除笔记,返回最新笔记列表。"""
    with _lock:
        data = _load()
        rec = data.setdefault(key, {"bookmarks": [], "notes": []})
        rec["notes"] = [n for n in rec.get("notes", []) if n.get("id") != note_id]
        _save(data)
    return rec["notes"]

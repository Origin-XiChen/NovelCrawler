# -*- coding: utf-8 -*-
"""
书架(收藏)管理
================
把想看的书收藏起来,记录书名/URL/来源,并支持"检查更新"
(重新拉目录对比本地已下载章节数)。

数据保存在项目根目录 bookshelf.json。
"""
from __future__ import annotations

import json
import os
import threading
import time

from novel.paths import SHELF_PATH, COMIC_SHELF_PATH

_lock = threading.Lock()


def _read() -> list[dict]:
    if not os.path.exists(SHELF_PATH):
        return []
    try:
        with open(SHELF_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write(shelf: list[dict]) -> None:
    with open(SHELF_PATH, "w", encoding="utf-8") as f:
        json.dump(shelf, f, ensure_ascii=False, indent=2)


def load_shelf() -> list[dict]:
    """返回书架(按加入时间倒序)。"""
    with _lock:
        shelf = _read()
    return sorted(shelf, key=lambda e: e.get("added", 0), reverse=True)


def add_to_shelf(title: str, url: str, source: str = "", cover: str = "") -> dict:
    """添加收藏;URL 已存在则返回现有条目(不覆盖封面/来源)。"""
    if cover and cover.startswith("//"):
        cover = "https:" + cover  # 协议相对 URL 规范化
    with _lock:
        shelf = _read()
        for e in shelf:
            if e.get("url") == url:
                return e
        entry = {
            "title": title,
            "url": url,
            "source": source,
            "cover": cover or "",     # 封面图 URL(OPDS/搜索结果),书架显示用
            "added": time.time(),
            "checked_chapters": 0,  # 最近一次检查到的章节总数
            "have": 0,              # 最近一次检查时本地已下载章节数
        }
        shelf.append(entry)
        _write(shelf)
    return entry


def remove_from_shelf(url: str) -> bool:
    with _lock:
        shelf = _read()
        rest = [e for e in shelf if e.get("url") != url]
        if len(rest) == len(shelf):
            return False
        _write(rest)
    return True


def find_entry(url: str) -> dict | None:
    with _lock:
        for e in _read():
            if e.get("url") == url:
                return e
    return None


def update_entry(url: str, **fields) -> dict | None:
    with _lock:
        shelf = _read()
        for e in shelf:
            if e.get("url") == url:
                e.update(fields)
                _write(shelf)
                return e
    return None


def merge_shelf(incoming: list[dict]) -> tuple[int, int]:
    """批量导入书架(按 url 去重),返回 (新增数, 总数)。

    供 GUI 的 /api/shelf_import 使用;内部持锁,避免与下载完成自动入架等并发写互相丢更新。
    """
    with _lock:
        shelf = _read()
        urls = {e.get("url") for e in shelf}
        added = 0
        for e in incoming:
            if not e or not e.get("url") or e["url"] in urls:
                continue
            e = dict(e)
            e.setdefault("added", time.time())
            shelf.append(e)
            urls.add(e["url"])
            added += 1
        if added:
            _write(shelf)
        return added, len(shelf)


# ---------------- 漫画收藏(独立于书籍书架) ----------------
def _read_comic() -> list[dict]:
    if not os.path.exists(COMIC_SHELF_PATH):
        return []
    try:
        with open(COMIC_SHELF_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _write_comic(shelf: list[dict]) -> None:
    with open(COMIC_SHELF_PATH, "w", encoding="utf-8") as f:
        json.dump(shelf, f, ensure_ascii=False, indent=2)


def load_comic_shelf() -> list[dict]:
    """漫画收藏(按加入时间倒序)。"""
    with _lock:
        shelf = _read_comic()
    return sorted(shelf, key=lambda e: e.get("added", 0), reverse=True)


def add_comic_shelf(title: str, source: str, comic_id: str, cover: str = "") -> dict:
    """收藏漫画;(source+comic_id) 已存在则返回现有条目。"""
    if cover and cover.startswith("//"):
        cover = "https:" + cover
    with _lock:
        shelf = _read_comic()
        for e in shelf:
            if e.get("source") == source and e.get("comic_id") == comic_id:
                return e
        entry = {
            "title": title, "source": source, "comic_id": comic_id,
            "cover": cover or "", "added": time.time(),
            "checked_chapters": 0,  # 最近一次检查到的总话数
            "have": 0,              # 最近一次检查时本地已下载话数
        }
        shelf.append(entry)
        _write_comic(shelf)
    return entry


def update_comic_entry(source: str, comic_id: str, **fields) -> dict | None:
    """更新漫画收藏条目字段(检查更新回写 checked_chapters/have 用)。"""
    with _lock:
        shelf = _read_comic()
        for e in shelf:
            if e.get("source") == source and e.get("comic_id") == comic_id:
                e.update(fields)
                _write_comic(shelf)
                return e
    return None


def remove_comic_shelf(source: str, comic_id: str) -> bool:
    with _lock:
        shelf = _read_comic()
        rest = [e for e in shelf if not (e.get("source") == source and e.get("comic_id") == comic_id)]
        if len(rest) == len(shelf):
            return False
        _write_comic(rest)
    return True


def merge_comic_shelf(incoming: list[dict]) -> tuple[int, int]:
    """批量导入漫画书架(按 source+comic_id 去重),返回 (新增数, 总数)。

    供 GUI 的 /api/comic_shelf_import 使用;内部持锁,避免与收藏/订阅回写并发丢更新。
    """
    with _lock:
        shelf = _read_comic()
        keys = {(e.get("source"), e.get("comic_id")) for e in shelf}
        added = 0
        for e in incoming:
            if not e or not e.get("comic_id") or (e.get("source"), e["comic_id"]) in keys:
                continue
            e = dict(e)
            e.setdefault("added", time.time())
            e.setdefault("title", "")
            e.setdefault("cover", "")
            e.setdefault("checked_chapters", 0)
            e.setdefault("have", 0)
            shelf.append(e)
            keys.add((e.get("source"), e["comic_id"]))
            added += 1
        if added:
            _write_comic(shelf)
        return added, len(shelf)

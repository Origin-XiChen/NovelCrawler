# -*- coding: utf-8 -*-
"""
TXT 阅读器
============
解析本项目下载的 TXT 文件(【章节】第N章 + == 标题 == 格式),
提供章节列表与单章正文,带内存缓存。

用法:
    meta = read_meta(path)      # {title, chapters: [{idx,title}], total}
    ch = read_chapter(path, n)  # {idx, title, text}
"""
from __future__ import annotations

import os
import re

_CHAPTER_MARK = re.compile(r"^【章节】第(\d+|[一二三四五六七八九十百千零两]+)章$")
_HEAD_RE = re.compile(r"^==\s*(.+?)\s*==$")

# 缓存: {path: (mtime, size, chapters)}
_cache: dict[str, tuple[float, int, list[dict]]] = {}


def parse_txt(path: str) -> list[dict]:
    """解析 TXT 为章节列表 [{idx, title, text}, ...],idx 从 1 开始。"""
    chapters: list[dict] = []
    cur: dict | None = None
    buf: list[str] = []

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n")
            m = _CHAPTER_MARK.match(line.strip())
            if m:
                if cur is not None:
                    cur["text"] = "\n".join(buf).strip()
                    chapters.append(cur)
                cur = {"idx": len(chapters) + 1, "title": "", "text": ""}
                buf = []
                continue
            if cur is None:
                continue  # 文件头(书名/来源)跳过
            hm = _HEAD_RE.match(line.strip())
            if hm and not cur["title"]:
                cur["title"] = hm.group(1).strip()
                continue
            buf.append(line)

    if cur is not None:
        cur["text"] = "\n".join(buf).strip()
        chapters.append(cur)

    # 兼容无【章节】标记的普通 TXT:整文件当一章
    if not chapters:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read().strip()
            if text:
                chapters.append({"idx": 1, "title": os.path.splitext(os.path.basename(path))[0], "text": text})
        except OSError:
            pass
    return chapters


def _load_cached(path: str) -> list[dict]:
    try:
        st = os.stat(path)
        key = (st.st_mtime, st.st_size)
    except OSError:
        return []
    hit = _cache.get(path)
    if hit and hit[0] == key[0] and hit[1] == key[1]:
        return hit[2]
    chapters = parse_txt(path)
    _cache[path] = (key[0], key[1], chapters)
    if len(_cache) > 50:  # 防止缓存膨胀
        oldest = min(_cache, key=lambda k: _cache[k][0])
        _cache.pop(oldest, None)
    return chapters


def read_meta(path: str) -> dict:
    """返回书籍元信息:{title, chapters: [{idx, title}], total}"""
    chapters = _load_cached(path)
    return {
        "title": os.path.splitext(os.path.basename(path))[0],
        "chapters": [{"idx": c["idx"], "title": c["title"]} for c in chapters],
        "total": len(chapters),
    }


def read_chapter(path: str, idx: int) -> dict | None:
    """返回单章 {idx, title, text};章节不存在返回 None。"""
    chapters = _load_cached(path)
    for c in chapters:
        if c["idx"] == idx:
            return c
    return None


def chapter_count(path: str) -> int:
    """章节总数(用于"检查更新"对比)。"""
    return len(_load_cached(path))

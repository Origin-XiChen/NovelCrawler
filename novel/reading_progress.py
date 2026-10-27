# -*- coding: utf-8 -*-
"""电脑与手机共享的逐章阅读进度(落盘到数据目录 reading_progress.json)。

旧做法只记"最远读到第几章",跳到第 100 章总进度就会虚高。这里改存每一章
自己的完成比例,总进度只累计从第 1 章起连续读下来的部分,跳读不算数。

结构::

    { "<book>": {book, kind, title, total, ch, chapterTitle, scroll,
                 chapters: {"1": 1.0, "2": 0.43}, updated} }

book 键与手机书目/离线包一致:
    novel:<文件名>          电脑下载的小说
    url:<在线地址>          在线阅读
    epub:<地址>             在线 EPUB
    comic:<目录>/<文件名>   漫画(按页,ch 即页号)

字段口径(两端共用):
    ch          当前停留的章节/页,从 1 起
    scroll      当前章节内的滚动比例 0~1
    chapters    每章完成比例,>= COMPLETE_AT 记 1;合并只增不减(回滚重读不清进度)
    updated     最后写入时间,毫秒

旧记录(只有 ch + scroll)迁移时按"连续读过来"补章:1..ch-1 记 1、当前章记
scroll,于是旧百分比保持不变;迁移只发生一次,之后的跳读不会再补中间的章。
写入沿用原子替换,避免半截 JSON。
"""
from __future__ import annotations

import json
import math
import os
import threading
import time

from .paths import READING_PROGRESS_PATH

_lock = threading.Lock()
# 比例到 98% 就算读完:手机滚动到底常常差几个像素,桌面留白也未必能精确到 100%
COMPLETE_AT = 0.98
# 文件规模兜底:够放几千本书,超出按最后阅读时间丢最旧的
MAX_BOOKS = 2000
MAX_CHAPTERS = 20000


def _load() -> dict:
    try:
        with open(READING_PROGRESS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    parent = os.path.dirname(READING_PROGRESS_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = READING_PROGRESS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, READING_PROGRESS_PATH)


def _int(value) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(number, 0)


def _ratio(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return round(min(max(number, 0.0), 1.0), 4)


def _frac(value) -> float:
    value = _ratio(value)
    return 1.0 if value >= COMPLETE_AT else value


def _now_ms() -> int:
    return int(time.time() * 1000)


def _stamp(value) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return _now_ms()
    if number <= 0:
        return _now_ms()
    # 手机旧接口用秒,新接口用毫秒,统一成毫秒
    return number * 1000 if number < 100_000_000_000 else number


def _norm_chapters(raw, total: int) -> dict:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {}
    if not isinstance(raw, dict):
        return {}
    chapters = {}
    for key, value in raw.items():
        try:
            idx = int(str(key).strip())
        except (TypeError, ValueError):
            continue
        if idx < 1 or idx > MAX_CHAPTERS:
            continue
        if total and idx > total:
            continue
        frac = _frac(value)
        if frac <= 0:
            continue
        chapters[str(idx)] = frac
    return chapters


def normalize(rec) -> dict:
    rec = rec if isinstance(rec, dict) else {}
    total = _int(rec.get("total"))
    ch = _int(rec.get("ch"))
    if total and ch > total:
        ch = total
    return {
        "book": str(rec.get("book") or "")[:200],
        "kind": str(rec.get("kind") or "novel")[:16],
        "title": str(rec.get("title") or "")[:200],
        "total": total,
        "ch": ch,
        "chapterTitle": str(rec.get("chapterTitle") or rec.get("chapter") or "")[:200],
        "scroll": _ratio(rec.get("scroll")),
        "chapters": _norm_chapters(rec.get("chapters"), total),
        "updated": _stamp(rec.get("updated")),
    }


def _prefix_units(chapters: dict, total: int) -> float:
    """从第 1 章起连续读了多少章(含当前部分章),遇到空缺就停。"""
    if not chapters or total <= 0:
        return 0.0
    units = 0.0
    for idx in range(1, total + 1):
        frac = chapters.get(str(idx))
        if frac is None:
            break
        frac = _frac(frac)
        units += frac
        if frac < 1:
            break
    return units


def _prefix_done(chapters: dict, total: int) -> int:
    """从第 1 章起连续完整读完的章数。"""
    if not chapters or total <= 0:
        return 0
    done = 0
    for idx in range(1, total + 1):
        if chapters.get(str(idx)) != 1.0:
            break
        done = idx
    return done


def continuous_percent(rec) -> int:
    """总进度:只算连续前缀;向后跳读不抬高百分比。"""
    rec = rec if isinstance(rec, dict) else {}
    total = _int(rec.get("total"))
    if total <= 0:
        return 0
    chapters = rec.get("chapters") or {}
    if chapters:
        units = _prefix_units(chapters, total)
    else:
        # 没有任何逐章数据的旧记录:按旧公式,保住升级前的百分比
        units = max(0, _int(rec.get("ch")) - 1) + _ratio(rec.get("scroll"))
    if units >= total:
        return 100
    return max(0, min(99, int(round(units / total * 100))))


def _seed_legacy(rec: dict) -> dict:
    """旧记录只有当前位置:视为从第 1 章连续读过来,补出逐章数据。"""
    if rec["chapters"]:
        return rec
    total = rec["total"]
    ch = rec["ch"]
    if ch <= 0:
        return rec
    if total and ch > total:
        ch = total
    chapters = {str(idx): 1.0 for idx in range(1, ch)}
    if rec["scroll"] >= COMPLETE_AT:
        chapters[str(ch)] = 1.0
    elif rec["scroll"] > 0:
        chapters[str(ch)] = _frac(rec["scroll"])
    rec["chapters"] = chapters
    return rec


def _legacy_advance(current: dict, incoming: dict) -> dict:
    """旧接口(只有 ch + scroll)的增量:只有接着上一章读才记进度。

    旧客户端不知道"每章读到哪",但顺序阅读时 saves 的 ch 总在连续前缀的
    下一章,于是照样能平滑累计;跳读的 ch 远大于前缀,就只更新当前位置。
    """
    total = incoming["total"] or current["total"]
    ch = incoming["ch"]
    if ch <= 0 or total <= 0:
        return {}
    done = _prefix_done(current["chapters"], total)
    if ch > done + 1:
        return {}
    frac = _frac(incoming["scroll"])
    return {str(ch): frac} if frac > 0 else {}


def _merge(current, incoming, legacy: bool) -> dict:
    inc = normalize(incoming)
    if not current:
        return _seed_legacy(inc) if legacy else inc

    cur = normalize(current)
    out = dict(cur)
    if inc["kind"]:
        out["kind"] = inc["kind"]
    if inc["title"]:
        out["title"] = inc["title"]
    if inc["total"]:
        out["total"] = inc["total"]
    # 当前位置只前进不后退:同一本书若已有更靠前的进度(比如电脑读到第 8 章、
    # 手机还停在 3 章),同步时不能把电脑的进度拉回去。
    if inc["ch"]:
        cur_ch, inc_ch = int(cur.get("ch") or 0), int(inc["ch"] or 0)
        if inc_ch > cur_ch or (inc_ch == cur_ch and _frac(inc.get("scroll")) >= _frac(cur.get("scroll"))):
            out["ch"] = inc["ch"]
            out["scroll"] = inc["scroll"]
    if inc["chapterTitle"]:
        out["chapterTitle"] = inc["chapterTitle"]
    out["updated"] = max(inc["updated"], cur["updated"])

    chapters = dict(cur["chapters"])
    additions = _legacy_advance(cur, inc) if legacy else inc["chapters"]
    for key, frac in additions.items():
        chapters[key] = max(chapters.get(key, 0.0), _frac(frac))
    if out["total"]:
        chapters = {k: v for k, v in chapters.items() if int(k) <= out["total"]}
    out["chapters"] = chapters
    return out


def public(rec: dict) -> dict:
    out = dict(rec)
    out["percent"] = continuous_percent(rec)
    return out


def save(book: str, rec, legacy: bool = False) -> dict:
    """写入一本进度并按章合并,返回落库后的记录(带 percent)。"""
    book = (book or "").strip()[:200]
    if not book:
        return {}
    incoming = dict(rec or {})
    incoming["book"] = book
    with _lock:
        data = _load()
        merged = _merge(data.get(book), incoming, legacy)
        data[book] = merged
        if len(data) > MAX_BOOKS:
            stale = sorted(data, key=lambda key: data[key].get("updated", 0))
            for key in stale[: len(data) - MAX_BOOKS]:
                data.pop(key, None)
        _save(data)
    return public(merged)


def get(book: str) -> dict:
    """单本进度;不存在返回 {}。"""
    book = (book or "").strip()[:200]
    rec = _load().get(book)
    if not isinstance(rec, dict):
        return {}
    rec = normalize({**rec, "book": book})
    return public(rec)


def get_many(books: list[str] | None = None) -> dict:
    """整张进度表;books 给了就只回这些。"""
    data = _load()
    wanted = None
    if books:
        wanted = {str(book).strip()[:200] for book in books if book}
    result = {}
    for book, rec in data.items():
        if wanted is not None and book not in wanted:
            continue
        if not isinstance(rec, dict):
            continue
        result[book] = public(normalize({**rec, "book": book}))
    return result


def drop(book: str) -> bool:
    book = (book or "").strip()[:200]
    if not book:
        return False
    with _lock:
        data = _load()
        if book not in data:
            return False
        data.pop(book, None)
        _save(data)
    return True

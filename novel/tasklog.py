# -*- coding: utf-8 -*-
"""任务历史记录:下载/追更/OPDS 等任务的持久化日志。

记录每次任务的最终结果(成功/失败/原因/文件),供"任务记录"面板查看,
避免任务结束无痕、用户不知道发生了什么。
存储:task_history.json(数据目录内),最多保留 200 条。
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Optional

from novel.paths import TASK_HISTORY_PATH

_lock = threading.Lock()
_MAX = 200


def _load() -> list[dict]:
    try:
        with open(TASK_HISTORY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def log_task(kind: str, title: str, state: str, detail: str = "",
             file: str = "", size: int = 0, source: str = "",
             extra: Optional[dict] = None) -> None:
    """追加一条任务记录。

    kind: 任务类型(章节下载/OPDS/追更/批量)
    state: ok / fail
    detail: 补充说明(失败原因等)
    extra: 附加字段(如 OPDS epub URL 用于一键重试)
    """
    rec = {
        "ts": time.time(),
        "kind": kind,
        "title": title,
        "state": state,
        "detail": detail,
        "file": file,
        "size": size,
        "source": source,
    }
    if extra:
        rec.update(extra)
    with _lock:
        try:
            hist = _load()
            hist.insert(0, rec)
            if len(hist) > _MAX:
                hist = hist[: _MAX]
            os.makedirs(os.path.dirname(TASK_HISTORY_PATH), exist_ok=True)
            with open(TASK_HISTORY_PATH, "w", encoding="utf-8") as f:
                json.dump(hist, f, ensure_ascii=False, indent=1)
        except OSError:
            pass


def list_history(limit: int = 100) -> list[dict]:
    return _load()[:limit]


def clear_history() -> None:
    with _lock:
        try:
            with open(TASK_HISTORY_PATH, "w", encoding="utf-8") as f:
                json.dump([], f)
        except OSError:
            pass

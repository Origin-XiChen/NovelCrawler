# -*- coding: utf-8 -*-
"""正文净化规则:正则替换,去除广告行/残留文本(类似阅读 App 净化)。"""
from __future__ import annotations

import re


def clean_text(text: str, rules: list | None) -> str:
    """按规则列表逐条正则替换正文。rules: [{pattern, replace}]。"""
    if not rules or not text:
        return text
    for r in rules:
        if not isinstance(r, dict):
            continue
        pat = r.get("pattern") or ""
        if not pat:
            continue
        rep = r.get("replace", "")
        try:
            text = re.sub(pat, rep, text)
        except re.error:
            continue
    return text


DEFAULT_RULES = [
    {"pattern": r"记住本站网址[^\n]{0,40}", "replace": ""},
    {"pattern": r"笔趣阁[^\n]{0,20}(首发|阅读)[^\n]{0,30}", "replace": ""},
    {"pattern": r"请收藏本站[^\n]{0,40}", "replace": ""},
]

# -*- coding: utf-8 -*-
"""简易 JSONPath 提取器(兼容 legado 的 $. 语法子集)。

支持:
  $.a.b.c           点路径
  $.list[*].name    数组通配符(映射展开)
  $.list[0,1]       索引选择
  $.data[0].title   混合
"""
from __future__ import annotations

import re

_INDEX_RE = re.compile(r"\[([^\]]*)\]")


def _walk(nodes: list, path: str) -> list:
    """沿 path 逐段下钻,返回所有命中的节点列表。"""
    if not path:
        return nodes
    m = _INDEX_RE.match(path)
    if m:
        sel = m.group(1).strip()
        rest = path[m.end():].lstrip(".")
        out: list = []
        if sel == "*":
            for n in nodes:
                if isinstance(n, list):
                    out.extend(n)
                elif isinstance(n, dict):
                    out.extend(n.values())
        else:
            for part in sel.split(","):
                part = part.strip()
                if part.isdigit():
                    i = int(part)
                    for n in nodes:
                        if isinstance(n, list) and i < len(n):
                            out.append(n[i])
                elif part.isalpha():
                    for n in nodes:
                        if isinstance(n, dict) and part in n:
                            out.append(n[part])
        return _walk(out, rest)
    key_m = re.match(r"[^\[.]+", path)
    if not key_m:
        return []
    key = key_m.group(0)
    rest = path[key_m.end():].lstrip(".")
    out = []
    for n in nodes:
        if isinstance(n, dict) and key in n:
            out.append(n[key])
        elif isinstance(n, list):
            for item in n:
                if isinstance(item, dict) and key in item:
                    out.append(item[key])
    return _walk(out, rest)


def extract(data, path: str):
    """按 JSONPath 提取;路径非法或未命中返回 None。

    命中单个节点返回该值;命中多个返回列表。通配符用于取列表。
    """
    if not path:
        return data
    p = path.strip()
    if p.startswith("$"):
        p = p[1:]
    p = p.lstrip(".")
    if not p:
        return data
    hits = _walk([data], p)
    if not hits:
        return None
    if len(hits) == 1:
        return hits[0]
    return hits


def render_template(tpl: str, ctx: dict) -> str:
    """渲染 URL 模板:支持 {kw}/{id}/{cid} 与 legado 风格 {{$.NovelID}}。

    ctx: {kw, id, cid, node} node 为当前 JSON 节点(用于 {{$.xxx}} 提取)。
    """
    def _sub(m: re.Match) -> str:
        token = m.group(1)
        if token.startswith("$."):
            val = extract(ctx.get("node"), token) if ctx.get("node") is not None else None
        else:
            val = ctx.get(token)
        return str(val) if val is not None else ""

    out = re.sub(r"\{\{\s*([^}]+?)\s*\}\}", _sub, tpl)
    out = re.sub(r"\{\s*(kw|key|id|cid|novelid|chapid)\s*\}", lambda m: str(ctx.get(m.group(1)) or ""), out, flags=re.I)
    return out

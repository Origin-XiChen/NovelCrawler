# -*- coding: utf-8 -*-
"""按真实数据目录统计:启用的书源里,有多少能参与搜索。"""
import json, os
cfg = json.load(open(os.path.join("design", "tools", "_work", "data", "config.json"), encoding="utf-8"))
en = cfg.get("enabled_sources") or cfg.get("sources") or []
if isinstance(en, dict):
    en = [k for k, v in en.items() if v]
print("config 中的启用源键:", [k for k in cfg.keys() if "source" in k.lower()])
print("启用数量:", len(en), en[:20])

os.environ["NOVEL_DATA_DIR"] = os.path.abspath(os.path.join("design", "tools", "_work", "data"))
import importlib, novel.paths as P
importlib.reload(P)
from novel.searcher import load_sources
srcs = load_sources()
print("load_sources() 返回:", len(srcs))
def sea(s):
    return bool(s.get("search")) or bool((s.get("api_rules") or {}).get("search"))
s_ok = [s["name"] for s in srcs if sea(s)]
s_no = [s["name"] for s in srcs if not sea(s)]
print("可搜索:", len(s_ok), s_ok)
print("不可搜索(仍计入进度分母):", len(s_no), s_no)


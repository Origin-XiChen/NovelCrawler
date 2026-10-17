# -*- coding: utf-8 -*-
import os
os.environ.setdefault("NOVEL_DATA_DIR", os.getcwd())
from novel.searcher import load_sources
srcs = load_sources()
tot = len(srcs)
def searchable(s):
    return bool(s.get("search")) or bool((s.get("api_rules") or {}).get("search"))
sea = [s for s in srcs if searchable(s)]
print(f"加载到书源: {tot}")
print(f"其中带搜索规则(可参与搜索): {len(sea)}  ->", ", ".join(s["name"] for s in sea))
print(f"无搜索规则(仅下载/正文,计入进度分母): {tot-len(sea)}")
for s in srcs:
    if searchable(s):
        print("   -", s["name"], "| base:", (s.get("base") or "")[:46])

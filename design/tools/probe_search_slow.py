# -*- coding: utf-8 -*-
"""记录每个书源的完成时刻,找出拖慢聚合搜索的源。"""
import json, time, urllib.parse, urllib.request

BASE = "http://127.0.0.1:8899"

def get(p):
    with urllib.request.urlopen(BASE + p, timeout=30) as r:
        return json.loads(r.read().decode())

j = get("/api/search_async?q=" + urllib.parse.quote("魔法"))
tid = j["task_id"]
t0 = time.time()
seen = {}
while True:
    p = get("/api/search_progress?id=" + tid)
    for s in (p.get("sources") or []):
        k = (s.get("name"), s.get("status"))
        if k not in seen:
            seen[k] = time.time() - t0
            print(f"  {seen[k]:7.1f}s  {s.get('name'):16s} {s.get('status')}", flush=True)
    if p.get("state") in ("done", "error"):
        print(f"  {time.time()-t0:7.1f}s  === 整体 {p.get('state')} ===", flush=True)
        break
    if time.time() - t0 > 220:
        print("  超时退出", flush=True); break
    time.sleep(0.7)

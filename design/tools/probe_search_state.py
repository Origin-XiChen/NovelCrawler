# -*- coding: utf-8 -*-
"""验证:聚合搜索完成后,进度接口是否真的切到 done(以及耗时)。"""
import json, time, urllib.parse, urllib.request

BASE = "http://127.0.0.1:8899"

def get(p):
    with urllib.request.urlopen(BASE + p, timeout=30) as r:
        return json.loads(r.read().decode())

j = get("/api/search_async?q=" + urllib.parse.quote("史莱姆"))
tid = j["task_id"]
print("task:", tid, "keys:", list(j))
t0 = time.time()
last = None
for i in range(200):
    p = get("/api/search_progress?id=" + tid)
    cur = (p.get("state"), p.get("done"), p.get("total"), len(p.get("books") or []))
    if cur != last:
        print(f"  {time.time()-t0:5.1f}s  state={cur[0]:8s} done={cur[1]}/{cur[2]}  books={cur[3]}")
        last = cur
    if p.get("state") in ("done", "error"):
        print("  结束:", p.get("state"), p.get("error", ""))
        break
    time.sleep(1)
else:
    print("  !! 200s 内没有进入 done/error:", last)
r = get("/api/search_result?id=" + tid)
print("结果条数:", len(r.get("results") or []), " 源统计:", len(r.get("sources") or []))


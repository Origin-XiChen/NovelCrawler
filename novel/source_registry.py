# -*- coding: utf-8 -*-
"""
书源仓库同步器
================
从社区维护的 legado 书源仓库(tickmao/Novel)拉取全量书源,
自动探测可达性、验证目录与正文,生成可导入的候选规则包。

数据流:
  GitHub 仓库 full.json(1000源)
    → fetch_repository()  提取 {name, base, searchUrl}
    → probe_candidates()  并发探测首页可达性 + 书链接 pattern
    → deep_verify()       抓书页验证目录/正文,生成完整规则
    → source_candidates.json(候选池,可导入)

用法:
    python -m novel.source_registry sync --limit 500   # 同步前500个
    python -m novel.source_registry sync               # 全部
    python -m novel.source_registry list               # 查看候选池
"""
from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

# 不再全局抑制 warnings:仅局部抑制 verify=False 场景的 InsecureRequestWarning
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

import requests

try:
    from .paths import CANDIDATES_PATH, SUBSCRIPTIONS_PATH  # noqa: F401
    from .parser import parse_content, parse_search_results, parse_toc
    from .config import load_all_sources
except ImportError:  # 直接以脚本方式运行时
    from paths import CANDIDATES_PATH, SUBSCRIPTIONS_PATH  # noqa: F401
    from parser import parse_content, parse_search_results, parse_toc
    from config import load_all_sources

REPO_URL = "https://cdn.jsdelivr.net/gh/tickmao/Novel@master/sources/legado/main/full.json"

# 预置订阅(知名 GitHub 书源仓库,首次打开自动写入)
DEFAULT_SUBSCRIPTIONS: list[dict] = [
    {
        "name": "tickmao/Novel",
        "url": "https://github.com/tickmao/Novel",
        "file": "sources/legado/main/full.json",
        "remark": "社区维护 · 1000+ 小说书源",
    },
    {
        "name": "coolxy/legado",
        "url": "https://github.com/coolxy/legado",
        "file": "sources/b778fe6b.json",
        "remark": "阅读App书源(分片),b778fe6b 为全量",
    },
    {
        "name": "XIU2/Yuedu",
        "url": "https://github.com/XIU2/Yuedu",
        "file": "shuyuan",
        "remark": "精品书源 26 个,持续更新",
    },
    {
        "name": "yolo52 小说",
        "url": "https://github.com/yolo52/Yuedu",
        "file": "shuyuan.json",
        "remark": "小说源 18 条",
    },
    {
        "name": "yolo52 轻小说",
        "url": "https://github.com/yolo52/Yuedu",
        "file": "轻小说.json",
        "remark": "轻文分类 18 条(动漫/翻译)",
    },
    {
        "name": "YiJieSS 精品",
        "url": "https://gitee.com/YiJieSS/Yuedu/raw/master/bookSource.json",
        "file": "",
        "remark": "gitee 精品书源 30 条",
    },
    {
        "name": "源仓库大库",
        "url": "https://legado.aoaostar.com/sources/b778fe6b.json",
        "file": "",
        "remark": "3900+ 书源聚合大库",
    },
    {
        "name": "源仓库·破冰",
        "url": "https://legado.aoaostar.com/sources/4dc410d1.json",
        "file": "",
        "remark": "破冰书源 128 条(综合/精品)",
    },
    {
        "name": "源仓库·关耳女频",
        "url": "https://legado.aoaostar.com/sources/e3e5d620.json",
        "file": "",
        "remark": "关耳女频 86 条",
    },
    {
        "name": "源仓库·三舞313",
        "url": "https://legado.aoaostar.com/sources/2a1f129b.json",
        "file": "",
        "remark": "三舞313 大库 1500+ 条",
    },
    {
        "name": "源仓库·开源阅读",
        "url": "https://legado.aoaostar.com/sources/3bb7b751.json",
        "file": "",
        "remark": "开源阅读大库 2100+ 条(含番茄精选)",
    },
    {
        "name": "网络书源大库",
        "url": "https://moonbegonia.github.io/Source/yuedu/full.json",
        "file": "",
        "remark": "moonbegonia 有效书源 1123 条",
    },
    {
        "name": "通用书源",
        "url": "https://moonbegonia.github.io/Source/yuedu/general.json",
        "file": "",
        "remark": "moonbegonia 通用书源 428 条",
    },
]

# GitHub 仓库中常见书源文件路径(自动探测顺序)
_REPO_FILE_CANDIDATES = [
    "sources/legado/main/full.json",
    "sources/legado/full.json",
    "shuyuan.json",
    "full.json",
    "sources/shuyuan.json",
    "legado/bookSource.json",
    "bookSource.json",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
}
TIMEOUT = 6

# 常见书籍/章节 URL pattern(按优先级)
BOOK_PATTERNS = [r"/book/\d+/", r"/book_\d+/", r"/\d+_\d+/", r"/xiaoshuo/\d+/", r"/b/\d+/"]
CHAPTER_PATTERNS = [
    r"/book/\d+/\d+\.html", r"/book_\d+/\d+\.html", r"/\d+_\d+/\d+\.html",
    r"/xiaoshuo/\d+/\d+\.html", r"/b/\d+/\d+\.html",
]

# 常见搜索接口变体(按模板出现频率排序,用于二次修正)
SEARCH_VARIANTS: list[dict] = [
    {"method": "POST", "path": "/s.php", "param": "s", "extra": {"type": "articlename"}},
    {"method": "POST", "path": "/s.php", "param": "s"},
    {"method": "GET", "path": "/s.php", "param": "s"},
    {"method": "GET", "path": "/modules/article/search.php", "param": "searchkey"},
    {"method": "GET", "path": "/modules/article/search.php", "param": "q"},
    {"method": "POST", "path": "/modules/article/search.php", "param": "searchkey"},
    {"method": "GET", "path": "/search.html", "param": "s"},
    {"method": "GET", "path": "/search.html", "param": "key"},
    {"method": "GET", "path": "/search.html", "param": "keyword"},
    {"method": "GET", "path": "/search.php", "param": "keyword"},
    {"method": "GET", "path": "/search.php", "param": "q"},
    {"method": "POST", "path": "/search.php", "param": "searchkey"},
    {"method": "POST", "path": "/search.php", "param": "keyword"},
    {"method": "GET", "path": "/so.php", "param": "keyword"},
    {"method": "GET", "path": "/search", "param": "q"},
    {"method": "GET", "path": "/search/", "param": "keywords"},
    {"method": "GET", "path": "/search/", "param": "keyword"},
    {"method": "POST", "path": "/e/search/index.php", "param": "keyboard",
     "extra": {"tbname": "bookname", "show": "title,writer", "tempid": "1"}},
]

_SEARCH_TEST_Q = "斗破"


# ---------------------------------------------------------------------------
# 1. 拉取仓库
# ---------------------------------------------------------------------------
def fetch_repository(url: str = REPO_URL) -> list[dict]:
    """拉取 legado 书源 JSON(任意直链),返回 [{name, base, searchUrl, enabled}]。"""
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    data = r.json()
    out = []
    for d in data:
        u = (d.get("bookSourceUrl") or "").strip()
        if not u:
            continue
        if not u.startswith("http"):
            u = "https://" + u
        base = u.split("#")[0].rstrip("/")
        out.append({
            "name": (d.get("bookSourceName") or base).strip()[:24],
            "base": base,
            "searchUrl": d.get("searchUrl") or "",
            "enabled": bool(d.get("enabled", True)),
        })
    return out


# ---------------------------------------------------------------------------
# 1.5 订阅管理
# ---------------------------------------------------------------------------
def load_subscriptions() -> list[dict]:
    """读取订阅列表;首次自动写入预置订阅。"""
    if not os.path.exists(SUBSCRIPTIONS_PATH):
        subs = [dict(s) for s in DEFAULT_SUBSCRIPTIONS]
        save_subscriptions(subs)
        return subs
    try:
        with open(SUBSCRIPTIONS_PATH, "r", encoding="utf-8") as f:
            subs = json.load(f)
        if not isinstance(subs, list):
            subs = []
        existing = {(s["url"], s.get("file", "")) for s in subs}
        for s in DEFAULT_SUBSCRIPTIONS:
            key = (s["url"], s.get("file", ""))
            if key not in existing:
                subs.append(dict(s))
        return subs
    except (json.JSONDecodeError, OSError):
        return [dict(s) for s in DEFAULT_SUBSCRIPTIONS]


def save_subscriptions(subs: list[dict]) -> None:
    with open(SUBSCRIPTIONS_PATH, "w", encoding="utf-8") as f:
        json.dump(subs, f, ensure_ascii=False, indent=2)


def add_subscription(name: str, url: str, file: str = "", remark: str = "") -> dict:
    """新增订阅;url 校验并尝试解析书源文件,失败抛 ValueError。"""
    name = name.strip() or url
    url = url.strip()
    if not url.startswith("http"):
        raise ValueError("订阅地址必须是 http(s) 开头")
    resolved = resolve_repo_file(url, file)
    subs = load_subscriptions()
    for s in subs:
        if s["url"] == url or s.get("resolved") == resolved:
            raise ValueError("该订阅已存在")
    sub = {"name": name, "url": url, "file": file, "remark": remark,
           "resolved": resolved, "added": time.time(),
           "last_sync": None, "status": "未同步", "count": 0}
    subs.append(sub)
    save_subscriptions(subs)
    return sub


def remove_subscription(url: str) -> bool:
    subs = load_subscriptions()
    rest = [s for s in subs if s["url"] != url]
    if len(rest) == len(subs):
        return False
    save_subscriptions(rest)
    return True


def resolve_repo_file(url: str, hint: str = "") -> str:
    """GitHub 仓库/文件地址 → 书源 JSON 直链。

    - GitHub blob 链接 → raw 直链
    - 非 GitHub 仓库格式的 http 直链(任意扩展名)→ 原样返回
    - GitHub 仓库 + .json 直链 → 原样返回
    - GitHub 仓库地址 → API 探测真实文件树,再回退常见路径
    """
    url = url.strip()
    if "/blob/" in url:  # github blob 链接 → raw
        return url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")
    if not re.match(r"https?://(?:www\.)?github\.com/[^/]+/[^/]+", url):
        return url  # 非 GitHub 仓库地址:当作直链(刷新时校验内容)
    if url.endswith(".json"):
        return url
    m = re.match(r"https?://(?:www\.)?github\.com/([^/]+)/([^/#?]+)", url)
    if not m:
        return url
    owner, repo = m.group(1), m.group(2)

    def _probe(u: str) -> bool:
        try:
            r = requests.head(u, headers=HEADERS, timeout=8, allow_redirects=True)
            if r.status_code == 200:
                return True
            r2 = requests.get(u, headers=HEADERS, timeout=8, stream=True, allow_redirects=True)
            r2.close()
            return r2.status_code == 200
        except Exception:  # noqa: BLE001
            return False

    # 0) 指定了文件路径 → 先试 master/main 分支
    if hint:
        for branch in ("master", "main"):
            u = f"https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{hint}"
            if _probe(u):
                return u

    # 1) GitHub API 探测真实文件树
    try:
        r = requests.get(f"https://api.github.com/repos/{owner}/{repo}",
                         headers=HEADERS, timeout=15)
        branch = (r.json().get("default_branch") or "master") if r.status_code == 200 else "master"
        r2 = requests.get(f"https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1",
                          headers=HEADERS, timeout=20)
        if r2.status_code == 200:
            blobs = [t["path"] for t in r2.json().get("tree", [])
                     if t["type"] == "blob" and t["path"].lower().endswith(".json")]
            if blobs:
                def _rank(p: str) -> int:
                    low = p.lower()
                    for i, k in enumerate(("legado/main/full", "full.json", "shuyuan",
                                           "booksource", "legado/", "sources/")):
                        if k in low:
                            return i
                    return 9
                blobs.sort(key=_rank)
                for p in (blobs[:6] if hint else blobs[:3]):
                    u = f"https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{p}"
                    if _probe(u):
                        return u
    except Exception:  # noqa: BLE001
        pass

    # 2) 回退:常见路径猜探测
    files = [hint] if hint else _REPO_FILE_CANDIDATES
    for branch in ("master", "main"):
        for f in files:
            if not f:
                continue
            u = f"https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{f}"
            if _probe(u):
                return u
    raise ValueError("仓库中未找到书源 JSON,可填写文件路径或直链")


# ---------------------------------------------------------------------------
# 2. legado 搜索接口 → 我们的 search 配置
# ---------------------------------------------------------------------------
def convert_legado_search(search_url: str) -> dict | None:
    """把 legado searchUrl 转换为我们格式的 search 配置;无法转换返回 None。"""
    s = (search_url or "").strip()
    if not s or s == "null":
        return None
    if s.startswith("@js:") or s.startswith("{{"):
        return None  # JS 代码/模板,无法静态转换

    method = "GET"
    charset = None
    # 格式: URL,{json} 或 {json}(含 method/body/charset)
    url_part = s
    m = re.search(r",(\{.*\})\s*$", s, re.S)
    if m:
        url_part = s[:m.start()].strip()
        try:
            meta = json.loads(m.group(1))
            method = (meta.get("method") or "GET").upper()
            charset = meta.get("charset")
            body = meta.get("body", "")
        except json.JSONDecodeError:
            meta, body = {}, ""
        # 从 POST body 提取参数名
        if method == "POST" and body:
            mm = re.search(r"(\w+)={{key}}", body)
            if mm:
                url_part = url_part
                extra = {}
                for kv in body.split("&"):
                    k, _, v = kv.partition("=")
                    if k and k != mm.group(1) and "{{" not in v:
                        extra[k] = v
                conf = {"method": "POST", "path": url_part, "param": mm.group(1)}
                if extra:
                    conf["extra"] = extra
                if charset:
                    pass  # charset 由 source 级处理
                return conf

    # GET:从 URL 提取参数名,其余查询参数转 extra
    url_part = url_part.replace("{{baseUrl}}", "").replace("{{baseURL}}", "")
    url_part = url_part.replace("{{page}}", "1").replace("{{pageNum}}", "1").replace("{{page_num}}", "1")
    mm = re.search(r"[?&](\w+)={{key}}", url_part)
    if mm:
        param = mm.group(1)
        path, _, qs = url_part.partition("?")
        extra = {}
        for kv in qs.split("&"):
            k, _, v = kv.partition("=")
            if k and k != param and "{{" not in v and v:
                extra[k] = v
        conf = {"method": "GET", "path": path or "/", "param": param}
        if extra:
            conf["extra"] = extra
        return conf
    # 无参数模板(如 /search.html 带 body 的已处理;纯 URL 无法知道参数) → 放弃
    return None


# ---------------------------------------------------------------------------
# 3. 并发探测可达性
# ---------------------------------------------------------------------------
def _quick_get(url: str) -> str | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT, verify=False)
        if r.status_code != 200:
            return None
        enc = r.encoding
        if enc in ("ISO-8859-1", "ascii") or not enc:
            enc = r.apparent_encoding or "utf-8"
        r.encoding = enc
        return r.text
    except Exception:  # noqa: BLE001
        return None


def _find_pattern(html: str, patterns: list[str]) -> str | None:
    for pat in patterns:
        if re.search(r'href="[^"]*' + pat + r'[^"]*"', html):
            return pat
    return None


def probe_candidates(sources: list[dict], limit: int | None = None,
                     max_workers: int = 15) -> list[dict]:
    """并发探测可达性。返回带 book_pattern / title / ms 的列表。"""
    if limit:
        sources = sources[:limit]

    def probe(s):
        t0 = time.time()
        r = {"name": s["name"], "base": s["base"], "searchUrl": s.get("searchUrl", ""),
             "ok": False, "book_pattern": "", "title": "", "ms": 0}
        html = _quick_get(s["base"] + "/")
        if not html:
            return r
        r["ms"] = int((time.time() - t0) * 1000)
        m = re.search(r"<title>([^<]{0,40})</title>", html, re.S)
        r["title"] = m.group(1).strip() if m else ""
        pat = _find_pattern(html, BOOK_PATTERNS)
        if pat:
            r["book_pattern"] = pat
            r["ok"] = True
        return r

    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futs = {pool.submit(probe, s): s for s in sources}
        for fut in as_completed(futs):
            results.append(fut.result())
    results.sort(key=lambda x: (-x["ok"], x["ms"]))
    return results


# ---------------------------------------------------------------------------
# 4. 深度验证(目录 + 正文),生成完整规则
# ---------------------------------------------------------------------------
def deep_verify(item: dict) -> dict:
    """对可达源验证目录与正文,返回完整候选规则。"""
    base = item["base"]
    conf = {
        "name": item["name"],
        "base": base,
        "charset": "utf-8",
        "verify_ssl": False,
        "search": convert_legado_search(item.get("searchUrl", "")),
        "book_href_pattern": item.get("book_pattern", ""),
        "chapter_href_pattern": "",
        "content_selector": "",
        "toc_reverse": False,
        "toc": 0, "content": 0,
        "probed_ms": item.get("ms", 0),
    }
    try:
        home = _quick_get(base + "/")
        if not home:
            return conf
        m = re.search(r'href="([^"]*' + item["book_pattern"] + r'[^"]*)"', home)
        if not m:
            return conf
        bu = m.group(1)
        if bu.startswith("/"):
            bu = base + bu
        bh = _quick_get(bu)
        if not bh:
            return conf
        # 目录
        chs = parse_toc(bh, base_url=base, chapter_href_pattern=None)
        if not chs:
            return conf
        conf["toc"] = len(chs)
        # 章节 pattern 推断
        ch_urls = [c["url"] for c in chs[:30]]
        for pat in CHAPTER_PATTERNS:
            if any(re.search(pat, u) for u in ch_urls):
                conf["chapter_href_pattern"] = pat
                break
        if not conf["chapter_href_pattern"]:
            m2 = re.search(r"(/[^/\s]+\.html)", chs[0]["url"])
            conf["chapter_href_pattern"] = re.escape(m2.group(1)) if m2 else ""
        # 正文
        for ch in chs[:5]:
            try:
                t = parse_content(_quick_get(ch["url"]) or "")
                if len(t) > 200:
                    conf["content"] = len(t)
                    break
            except Exception:  # noqa: BLE001
                continue
        # 目录顺序启发式(与 downloader 一致)
        first = re.sub(r'^[\s“”"\'《》【】〈〉]+|[\s“”"\'《》【】〈〉]+$', "", chs[0]["title"])
        last = re.sub(r'^[\s“”"\'《》【】〈〉]+|[\s“”"\'《》【】〈〉]+$', "", chs[-1]["title"])
        conf["toc_reverse"] = bool(re.match(r"^第\s*1\s*章", last)) and not re.match(r"^第\s*1\s*章", first)
    except Exception:  # noqa: BLE001
        pass
    return conf


def sync(limit: int | None = None, min_content: int = 200, verbose: bool = True,
         on_progress=None, url: str | None = None) -> dict:
    """执行一次完整同步:拉取 → 探测 → 深验证 → 写候选池。

    url: 指定书源 JSON 直链(订阅刷新用);默认拉取 tickmao 仓库。
    on_progress: callable(state: dict), 同步过程中持续回调进度。
    """
    t0 = time.time()

    def _report(**kw):
        st = {"stage": kw.get("stage", ""), "processed": kw.get("processed", 0),
              "ok": kw.get("ok", 0), "candidates": kw.get("candidates", 0),
              "running": kw.get("running", True), "elapsed": int(time.time() - t0)}
        if on_progress:
            on_progress(st)

    _report(stage="fetching")
    repo = fetch_repository(url or REPO_URL)
    if verbose:
        print(f"仓库书源: {len(repo)} 个")

    existing = {s["base"].rstrip("/") for s in load_all_sources()}
    todo = [s for s in repo if s["base"] not in existing]

    _report(stage="probing", processed=0)
    probed = probe_candidates(todo, limit=limit)
    ok = [p for p in probed if p["ok"]]
    _report(stage="verifying", processed=len(probed), ok=len(ok))
    if verbose:
        print(f"可达: {len(ok)}/{len(probed)} (已跳过内置 {len(existing)})")

    cands = []
    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = {pool.submit(deep_verify, p): p for p in ok}
        for fut in as_completed(futs):
            c = fut.result()
            done += 1
            if c["content"] >= min_content:
                cands.append(c)
            if done % 10 == 0 or done == len(ok):
                _report(stage="verifying", processed=len(probed), ok=done,
                        candidates=len(cands))

    cands.sort(key=lambda x: (-x["content"], -x["toc"]))
    save_candidates(cands)
    _report(stage="done", processed=len(probed), ok=len(ok),
            candidates=len(cands), running=False)
    if verbose:
        print(f"通过验证(正文≥{min_content}字): {len(cands)} 个,耗时 {time.time()-t0:.0f}s")
        for c in cands[:15]:
            print(f"  {c['name'][:12]:<14} {c['base'][:36]:<38} 目录{c['toc']:<5} 正文{c['content']:<6} 搜索{'✓' if c['search'] else '✗'}")
    return {"total": len(repo), "probed": len(probed), "ok": len(ok),
            "candidates": len(cands), "elapsed": int(time.time() - t0)}


# ---------------------------------------------------------------------------
# 候选池存取
# ---------------------------------------------------------------------------
def save_candidates(cands: list[dict]) -> None:
    with open(CANDIDATES_PATH, "w", encoding="utf-8") as f:
        json.dump(cands, f, ensure_ascii=False, indent=1)


def load_candidates() -> list[dict]:
    if not os.path.exists(CANDIDATES_PATH):
        return []
    try:
        with open(CANDIDATES_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def candidates_status() -> list[dict]:
    """候选列表 + 是否已在库(供 GUI 展示)。"""
    existing = {s["name"]: s["base"] for s in load_all_sources()}
    out = []
    for c in load_candidates():
        status = "已存在" if c["base"] in existing.values() else "新"
        out.append({**c, "status": status})
    return out


# ---------------------------------------------------------------------------
# 5. 搜索接口二次修正
# ---------------------------------------------------------------------------
def _test_search_conf(base: str, conf: dict, timeout: float = 4.5) -> int:
    """测试某个搜索配置是否可用,返回解析出的相关结果数(0=不可用)。"""
    try:
        from .searcher import _relevant, normalize
        from .fuzzy import build_search_queries
    except ImportError:
        from searcher import _relevant, normalize
        from fuzzy import build_search_queries
    queries = build_search_queries(_SEARCH_TEST_Q)
    norm_qs = [normalize(x) for x in queries if x]
    url = conf["path"] if conf["path"].startswith("http") else base + conf["path"]
    try:
        if conf["method"].upper() == "POST":
            data = {conf["param"]: _SEARCH_TEST_Q}
            data.update(conf.get("extra", {}) or {})
            r = requests.post(url, data=data, headers=HEADERS, timeout=timeout, verify=False)
        else:
            params = {conf["param"]: _SEARCH_TEST_Q}
            params.update(conf.get("extra", {}) or {})
            r = requests.get(url, params=params, headers=HEADERS, timeout=timeout, verify=False)
    except Exception:  # noqa: BLE001
        return 0
    if r.status_code != 200:
        return 0
    enc = r.encoding
    if enc in ("ISO-8859-1", "ascii") or not enc:
        enc = r.apparent_encoding or "utf-8"
    r.encoding = enc
    html = r.text
    try:
        items = parse_search_results(html, base_url=base, book_href_pattern=r"[\w\-]*\d+[\w\-]*")
    except Exception:  # noqa: BLE001
        return 0
    if not items:
        return 0
    hits = sum(1 for it in items if _relevant(it["title"], norm_qs))
    return hits


def fix_search_configs(cands: list[dict], verbose: bool = True,
                       on_progress=None, max_workers: int = 12) -> dict:
    """对候选池逐源尝试常见搜索接口变体(并行),修好可用的配置。

    - 已有配置且可用 → 保留
    - 已有配置不可用 → 依次尝试变体;找到可用的替换
    - 全部失败 → search 置 None(纯直连)
    返回 {"fixed": [...], "none": [...], "kept": [...]}
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def _fix(c):
        base = c["base"]
        cur = c.get("search")
        if cur and _test_search_conf(base, cur) > 0:
            return c["name"], "kept"
        best = None
        for v in SEARCH_VARIANTS:
            if _test_search_conf(base, v) > 0:
                best = v
                break
        if best:
            c["search"] = best
            return c["name"], "fixed"
        c["search"] = None
        return c["name"], "none"

    kept, fixed, none_list = [], [], []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futs = [pool.submit(_fix, c) for c in cands]
        for i, fut in enumerate(as_completed(futs), 1):
            name, status = fut.result()
            if status == "kept":
                kept.append(name)
            elif status == "fixed":
                fixed.append(name)
            else:
                none_list.append(name)
            if on_progress:
                on_progress(i, len(cands))
            if verbose and i % 12 == 0:
                print(f"  进度 {i}/{len(cands)} 已修{len(fixed)} 无搜索{len(none_list)}")
    if verbose:
        print(f"完成: 保留可用 {len(kept)}, 修复 {len(fixed)}, 确认无搜索 {len(none_list)}")
        for n in fixed:
            print(f"  ✓ 修复: {n}")
    return {"fixed": fixed, "none": none_list, "kept": kept}


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="书源仓库同步器")
    ap.add_argument("cmd", choices=["sync", "list", "fix-search"], default="sync", nargs="?")
    ap.add_argument("--limit", type=int, default=None, help="最多探测的源数")
    ap.add_argument("--min-content", type=int, default=200, help="正文最小字数门槛")
    args = ap.parse_args()
    if args.cmd == "sync":
        sync(limit=args.limit, min_content=args.min_content)
    elif args.cmd == "fix-search":
        cands = load_candidates()
        print(f"对 {len(cands)} 个候选执行搜索接口二次修正…")
        fix_search_configs(cands)
        save_candidates(cands)
        print("候选池已更新")
    else:
        for c in candidates_status():
            print(f"  [{c['status']}] {c['name']:<14} {c['base'][:40]:<42} 目录{c['toc']:<5} 正文{c['content']} 搜索{'✓' if c['search'] else '✗'}")

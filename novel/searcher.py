# -*- coding: utf-8 -*-
"""
多源搜索聚合
============
  * 按书源配置执行搜索(支持 GET / POST、不同参数名)
  * 依次尝试多个候选关键词(模糊搜索的中文名/别名)
  * 多源并行/顺序搜索,聚合去重
  * 单个源失败不影响其他源(自动跳过)
"""
from __future__ import annotations

import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from urllib.parse import urlencode, urlparse

from .config import load_sources, match_source, normalize_url
from .fetcher import Fetcher
from .fuzzy import build_search_queries, normalize
from .parser import parse_search_results
from .title_clean import clean_book_title

logger = logging.getLogger("novel.searcher")


@dataclass
class Book:
    """搜索结果条目。"""
    title: str
    author: str = ""
    url: str = ""
    source: str = ""
    chapters: list = field(default_factory=list)
    downloaded: bool = False
    raw_title: str = ""  # 清洗前的原始书名(供前端展示分辨)
    cover: str = ""      # 封面图 URL(尽力提取)
    desc: str = ""       # 简介(尽力提取)

    @property
    def key(self) -> str:
        return f"{self.source}|{self.title}"


def _relevant(title: str, norm_queries: list[str]) -> bool:
    """
    判断结果标题是否与候选词相关。
    归一化后:标题包含任一候选词,或候选词包含标题(极短标题)。
    """
    if not norm_queries:
        return True
    t = normalize(title)
    if not t:
        return False
    for nq in norm_queries:
        if not nq:
            continue
        if nq in t or (len(t) <= 12 and t in nq):
            return True
    return False


def search_source(
    source: dict,
    queries: list[str],
    fetcher: Fetcher,
    status: dict | None = None,
) -> list[Book]:
    """在单个源上尝试搜索,返回结果列表。

    status: 可选 dict,内部会填充 {"status", "count", "error", "throttled"}
            status ∈ no_search / ok / empty / error
    """
    if status is None:
        status = {}
    # API 模式书源(JSON 接口 + JSONPath 规则),优先于 HTML 搜索
    api = source.get("api_rules") or {}
    if api.get("search"):
        status["status"] = "ok"
        status["error"] = ""
        return _search_source_api(source, queries, fetcher, status)
    sconf = source.get("search")
    if not sconf:
        status["status"] = "no_search"
        status["count"] = 0
        status["error"] = ""
        return []
    status["status"] = "ok"
    status["error"] = ""
    base = source["base"].rstrip("/")
    charset = source.get("charset", "utf-8")

    fetcher.cooldown.set_interval(source["name"], source.get("search_interval", 0))

    results: list[Book] = []
    seen_urls: set[str] = set()

    for q in queries:
        if not q:
            continue
        try:
            # 请求(含限流自动等待重试:部分站点有"搜索间隔15秒"限制,
            # 检测到提示后等待相应秒数再重试,避免误判"搜不到")
            # path 可为相对路径或完整 URL(书源规则导入时可能带域名)
            p = sconf["path"]
            if not p.startswith("http") and not p.startswith("/"):
                p = "/" + p  # 规范化:缺头斜杠的路径补上
            search_url = p if p.startswith("http") else f"{base}{p}"
            html = None
            for attempt in range(3):
                if sconf["method"].upper() == "POST":
                    data = {sconf["param"]: q}
                    data.update(sconf.get("extra", {}) or {})
                    html = fetcher.fetch(
                        search_url,
                        source=source["name"],
                        method="POST",
                        data=data,
                        encoding=charset,
                        verify=source.get("verify_ssl", True),
                    )
                else:
                    params = {sconf["param"]: q}
                    params.update(sconf.get("extra", {}) or {})
                    url = f"{search_url}?{urlencode(params)}"
                    html = fetcher.fetch(url, source=source["name"], encoding=charset,
                                         verify=source.get("verify_ssl", True))
                if "搜索间隔" in html or "操作频繁" in html or "请稍后再" in html:
                    m = re.search(r"搜索间隔\s*(\d+)", html)
                    wait = int(m.group(1)) + 2 if m else 17
                    logger.info("[%s] 搜索被限流,等待 %ds 重试", source["name"], wait)
                    status["throttled"] = True
                    time.sleep(wait)
                    continue
                break

            items = parse_search_results(
                html,
                base_url=base,
                book_href_pattern=source.get("book_href_pattern"),
            )
            # 相关性过滤:只保留标题命中任一候选词的结果。
            # 有些站点的搜索接口会无视关键词、固定返回热门推荐,
            # 不过滤会严重污染搜索结果。
            norm_queries = [normalize(x) for x in queries if x]
            for it in items:
                if it["url"] in seen_urls:
                    continue
                title = it["title"]
                if not _relevant(title, norm_queries):
                    continue
                seen_urls.add(it["url"])
                cov = (it.get("cover") or "").strip()
                if cov and cov.startswith("/"):
                    cov = base + cov
                results.append(Book(
                    title=title,
                    author=it.get("author", ""),
                    url=it["url"],
                    source=source["name"],
                    cover=cov,
                    desc=it.get("desc", ""),
                ))
            if results:
                # 有相关结果即返回,不再试更多候选词
                break
        except Exception as exc:  # noqa: BLE001 单源失败不致命
            status["status"] = "error"
            status["error"] = str(exc)[:150]
            logger.warning("[%s] 搜索 %r 失败: %s", source["name"], q, exc)
            break  # 该源网络/频率受限,不再重试
    status["count"] = len(results)
    if results:
        status["status"] = "ok"
    elif status["status"] == "ok":
        status["status"] = "empty"
    return results


def search_all(
    keyword: str,
    fetcher: Fetcher | None = None,
    max_workers: int = 3,
    verbose: bool = True,
    source_names: list[str] | None = None,
    return_meta: bool = False,
    on_progress=None,
    skip_names: set | None = None,
    cancel_check=None,
):
    """
    多源聚合搜索:返回所有源的结果(去重)。
    用户关键词优先映射为中文(如 harry potter → 哈利波特)。
    source_names: 仅在这些书源上搜索(None=全部)。
    return_meta: True 时返回 {"books": [...], "sources": [{name,status,count,error}]}
    on_progress: callable(done, total, name, status, books) 每完成一个源回调一次,books 为该源结果
    skip_names: 跳过的源名集合(如短期连续失败的源)
    cancel_check: callable() → bool,每完成一个源后调用;返回 True 则提前结束(暂停/取消)
    """
    fetcher = fetcher or Fetcher()
    sources = load_sources()
    if source_names:
        sources = [s for s in sources if s["name"] in source_names]
    if skip_names:
        sources = [s for s in sources if s["name"] not in skip_names]
    if not sources:
        # 指定的源不存在/全被禁用
        empty = {"books": [], "sources": []} if return_meta else []
        if verbose:
            print("没有可用的书源(可能全部被禁用或名称不存在)")
        return empty
    queries = build_search_queries(keyword)
    if verbose:
        print(f"搜索词: {keyword}")
        print(f"扩展候选词: {' / '.join(queries)}")
        print(f"启用书源: {', '.join(s['name'] for s in sources)}")

    all_books: dict[str, Book] = {}
    source_meta: list[dict] = []

    def _run(s):
        meta = {"name": s["name"], "status": "no_search", "count": 0, "error": ""}
        if not s.get("search") and not (s.get("api_rules") or {}).get("search"):
            return [], meta
        books = search_source(s, queries, fetcher, status=meta)
        return books, meta

    with ThreadPoolExecutor(max_workers=min(max_workers, len(sources))) as pool:
        futures = {pool.submit(_run, s): s["name"] for s in sources}
        done_count = 0
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                books, meta = fut.result()
            except Exception as exc:  # noqa: BLE001
                meta = {"name": name, "status": "error", "count": 0, "error": str(exc)[:150]}
                source_meta.append(meta)
                logger.warning("[%s] 搜索线程异常: %s", name, exc)
                done_count += 1
                if on_progress:
                    on_progress(done_count, len(sources), name, "error", [])
                continue
            source_meta.append(meta)
            new_books = []
            for b in books:
                # 清洗书名(去掉 .txt全集下载 等噪音),按 源+清洗名 聚合去重
                ct = clean_book_title(b.title)
                if not ct:
                    continue
                key = f"{b.source}|{ct}"
                if key in all_books:
                    continue
                b.raw_title = b.title  # 保留原始书名
                b.title = ct
                all_books[key] = b
                new_books.append(b)
            done_count += 1
            if on_progress:
                on_progress(done_count, len(sources), name, meta["status"], new_books)
            if verbose and books:
                print(f"  ✓ [{name}] 找到 {len(books)} 条")
            if cancel_check and cancel_check():
                logger.info("搜索被暂停/取消,提前结束(已处理 %d/%d)", done_count, len(sources))
                break

    books = list(all_books.values())
    if return_meta:
        return {"books": books, "sources": source_meta}
    return books


def _search_source_api(
    source: dict,
    queries: list[str],
    fetcher: Fetcher,
    status: dict,
) -> list[Book]:
    """API 模式书源:请求 JSON 搜索接口,按 JSONPath 提取结果。"""
    import json
    from .jsonpath import extract, render_template

    conf = source["api_rules"]["search"]
    base = source["base"].rstrip("/")
    charset = source.get("charset", "utf-8")
    headers = source.get("headers") or {}
    out: list[Book] = []
    seen: set[str] = set()
    for q in queries:
        try:
            url = render_template(conf["url"], {"kw": q})
            html = fetcher.fetch(url, source=source["name"], encoding=charset,
                                 headers=headers, verify=source.get("verify_ssl", True))
            data = json.loads(html)
        except Exception:  # noqa: BLE001
            continue
        items = extract(data, conf.get("list", "$")) or []
        if isinstance(items, dict):
            items = [items]
        for it in items:
            try:
                name = str(extract(it, conf["name"]) if conf.get("name") else it or "").strip()
                author = str(extract(it, conf.get("author", "")) or "").strip() if conf.get("author") else ""
                cover = str(extract(it, conf.get("cover", "")) or "").strip() if conf.get("cover") else ""
                desc = str(extract(it, conf.get("intro", "")) or "").strip() if conf.get("intro") else ""
                bid = extract(it, conf.get("id", "")) if conf.get("id") else None
                u = render_template(conf.get("book_url") or conf.get("url_tpl") or "", {"node": it, "id": bid, "kw": q})
                if u and not u.startswith("http"):
                    u = base + u
                if not name or not u:
                    continue
                key = f"{name}|{u}"
                if key in seen:
                    continue
                seen.add(key)
                out.append(Book(title=name, author=author, url=u, source=source["name"],
                                cover=cover, desc=desc))
            except Exception:  # noqa: BLE001
                continue
    status["count"] = len(out)
    status["status"] = "ok" if out else "empty"
    return out


def book_from_url(url: str, fetcher: Fetcher | None = None) -> Book | None:
    """
    用户直接提供书籍详情页/目录页 URL 时,尝试识别书源并构造 Book。
    注意:详情页/目录页本身不含完整章节,章节在下载阶段再拉取。
    """
    fetcher = fetcher or Fetcher()
    source = match_source(url)
    if source is None:
        logger.warning("无法匹配已知书源: %s", url)
        return None

    base = source["base"].rstrip("/")
    charset = source.get("charset", "utf-8")

    # 归一化:详情页 /book/{id}/ 或 目录页 /newbook/{id}/ 或 章节页
    nurl = normalize_url(url, source)
    html = fetcher.fetch(nurl, source=source["name"], encoding=charset, verify=source.get("verify_ssl", True))

    # 提取书名:优先 <h1>,其次 <title>
    title = ""
    m = re.search(r"<h1[^>]*>\s*([^<]{1,60})", html)
    if m:
        title = m.group(1).strip()
    if not title:
        m = re.search(r"<title>([^<]{1,60})</title>", html)
        if m:
            title = m.group(1).strip()
    title = title.split("_")[0].strip()  # 去掉"_xxx小说_"之类后缀

    # 提取封面:优先 og:image,其次详情页首个封面图(img 宽高比像封面 / 常见 class)
    cover = ""
    m = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', html, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', html, re.I)
    if m:
        cover = m.group(1).strip()
    if not cover:
        mm = re.search(r'<img[^>]+src=["\']([^"\']+)["\'][^>]*?(?:class=["\'][^"\']*(?:cover|pic|bookcover|img)[^"\']*["\']|style=["\'][^"\']*(?:width|height))', html, re.I)
        if mm:
            cover = mm.group(1).strip()
    if cover and cover.startswith("/"):
        cover = base + cover

    # 提取简介:meta description → 常见简介容器
    desc = ""
    m = re.search(r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)', html, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']description["\']', html, re.I)
    if m:
        desc = m.group(1).strip()
    if not desc:
        m = re.search(r'<div[^>]+class=["\'][^"\']*(?:intro|desc|简介|summary)[^"\']*["\'][^>]*>([\s\S]{0,400}?)</div>', html, re.I)
        if m:
            desc = re.sub(r"<[^>]+>", "", m.group(1)).strip()
    if len(desc) > 300:
        desc = desc[:300] + "…"

    return Book(
        title=title or urlparse(url).path.strip("/").split("/")[-1],
        url=nurl,
        source=source["name"],
        cover=cover,
        desc=desc,
    )

# -*- coding: utf-8 -*-
"""
Cimoc 规则引擎(通用漫画源)
==========================
将 Cimoc 的 Java 源抽象为 **JSON 规则** + 统一解释器,运行时加载任意源,
避免每个源手写 Python 适配器(与小说 shareable_sources.json 同构的思路)。

规则字段(每个源一个 dict):
    key      源标识(唯一,用于 MANGA_SOURCES 注册与 API 分发)
    name     显示名
    base     https 基础 URL(可含 {base} 模板)
    headers  可选:全局请求头(Referer/UA 等)
    search   {method, url, params?, headers?, parse}
    toc      {url, parse}
    pages    {url, parse, lazy?}
    referer  图片防盗链 Referer

parse 支持三种形态(字段名区分):
  - "selector":  CSS 选择器(bs4),返回元素列表,每元素取 attrs/text
       fields: {title: "text", href: "attr:href", cover: "attr:src|attr:data-original", id: "split_href:1"}
  - "regex":    正则提取,返回匹配文本列表
       fields: {title: "group:1"} 或直接 "list_group": 2(整组提取)
  - "json":     从 HTML 内嵌 JSON 提取(正则取块 → json.loads → 按路径)
       json_regex: 提取内嵌 JSON 块的正则
       json_path:  提取字段的路径(如 "data.0.comic_py" 或 "$.comic_py")
  - "js":       内嵌 JS 混淆加密(如 DM5 的 eval) — 引擎不解释,标记不可用

模板:url 中的 {kw}/{cid}/{ep} 会被替换;fields 值支持 {name} 引用其他字段。

用法(comic.py 侧):
    from .comic_cimoc import CimocSource
    s = CimocSource(RULES["dmzj"])
    s.search("转生史莱姆") -> [{id,title,cover,lang,desc}]
    s.chapters(cid)        -> [{id,title,volume,chapter,lang}]
    s.pages(cid, ep)       -> [url]
"""
from __future__ import annotations

import json
import re

import requests

from .comic import HEADERS, _get, _proxies

# 已转换的 Cimoc 源规则(从 haleydu/cimoc release-tci 的 Java 源逐一手工转换)
# 2026-09 实测状态:manhuadb(已更名漫画牛,重写规则)/baozimh/mangagg/mangapill 可用;
# dmzj/ccmh 站点死亡、dm5 图片页 JS 混淆 —— 三者默认停用,保留规则待站点恢复
RULES: dict = {
    "dmzj": {
        # 2026-09 实测:m.dmzj.com / www.dmzj.com / api 域名全部连接重置(站点死亡或屏蔽)。
        # 订阅地址修正表也无可用镜像。保留规则,站点恢复后可在设置中重新启用。
        "key": "dmzj",
        "name": "动漫之家",
        "enabled": False,
        "base": "https://m.dmzj.com",
        "referer": "http://images.dmzj.com/",
        "search": {
            "method": "GET",
            "url": "{base}/search/{kw}.html",
            "parse": {
                "type": "json",
                "json_regex": r"var\s+serchArry=(\[.*?\])\s*;?",
                "json_path": "$.comic_py",
                "list": True,
                "fields": {
                    "id": "$.comic_py",
                    "title": "$.name",
                    "cover": "$.cover",
                    "cover_prefix": "https://images.dmzj.com/",
                    "desc": "$.authors",
                },
            },
        },
        "toc": {
            "url": "{base}/info/{cid}.html",
            "parse": {
                "type": "json",
                "json_regex": r"initIntroData\((.*)\);",
                "list_path": "$.data",
                "tag_path": "$.title",
                "fields": {
                    "id": "$.comic_id/$",
                    "title": "{tag} {chapter_name}",
                    "chapter": "$.chapter_name",
                },
            },
        },
        "pages": {
            "url": "{base}/view/{ep}.html",
            "parse": {
                "type": "json",
                "json_regex": r'"page_url":(\[.*?\]),',
                "list": True,
            },
        },
    },
    "manhuadb": {
        # 2026-09 实测:原 manhuadb.com 已关闭,站点迁至 manhua666.cc 并更名「漫画牛」,
        # 结构全面改版 —— 真搜索 /search/?searchkey=,目录 a[rel=chapter],
        # 图片在章节页 var imgs 数组内(转义引号包裹,img.25mh.net CDN)。
        "key": "manhuadb",
        "name": "漫画牛",
        "base": "https://www.manhua666.cc",
        "referer": "https://www.manhua666.cc",
        "search": {
            "method": "GET",
            "url": "{base}/search/?searchkey={kw}",
            "parse": {
                "type": "selector",
                "selector": ".item",
                "fields": {
                    "id": "a split_href:0",
                    "title": "a attr:title|img attr:alt|text",
                    "cover": "img attr:data-original|img attr:src",
                },
            },
        },
        "toc": {
            "url": "{base}/{cid}/",
            "parse": {
                "type": "selector",
                "selector": "a[rel=chapter]",
                "fields": {
                    "id": "split_href:1",
                    "title": "attr:title|text",
                    "chapter": "text",
                },
            },
        },
        "pages": {
            "url": "{base}/{cid}/{ep}.html",
            "parse": {
                "type": "regex",
                "url_regex": r'https?://[^"\\\s()<>\']+?\.(?:webp|jpe?g|png|gif)[^"\\\s()<>\']*',
                # 站点自托管的是封面缩略图(详情页 JS 里引用),真章节图在 img.25mh.net CDN
                "url_exclude": ["/static/", ".cc/images/"],
            },
        },
    },
    "weebcentral": {
        # 2026-09 实测全链路可用:MangaSee 继承者,ULID 寻址、平台级稳定。
        # 搜索为 HTMX 简搜(POST 表单);图片在 /chapters/{ep}/images 静态页。
        "key": "weebcentral",
        "name": "WeebCentral",
        "base": "https://weebcentral.com",
        "referer": "https://weebcentral.com",
        "search": {
            "method": "POST",
            "url": "{base}/search/simple?location=main",
            "params": {
                "text": "{kw}",
                "sort": "Best Match",
                "order": "Descending",
                "official": "Any",
                "adult": "Any",
            },
            "parse": {
                "type": "selector",
                "selector": "#quick-search-result a.btn",
                "fields": {
                    "id": "split_href:3",
                    "title": "text",
                    "cover": "img attr:src",
                },
            },
        },
        "toc": {
            "url": "{base}/series/{cid}/full-chapter-list",
            "parse": {
                "type": "selector",
                "selector": "a[href*='chapters/']",
                "fields": {
                    "id": "split_href:1",
                    "title": "text",
                    "chapter": "text",
                },
                # 页内携带「Last Read N」已读标记,从标题里去掉
                "title_replace": [["\\s*Last Read.*", ""]],
            },
        },
        "pages": {
            "url": "{base}/chapters/{ep}/images",
            "parse": {
                "type": "regex",
                "url_regex": r"""https?://[^"\\\s()<>]+?\.(?:webp|jpe?g|png|gif|avif)[^"\\\s()<>]*""",
                "url_exclude": ["compsci88"],
            },
        },
    },
    "ccmh": {
        # 2026-09 实测:ccmh6.com 域名已挂牌出售(返回域名停放页);修正表给出的
        # ccmh16.com 域名 DNS 不存在。站点死亡,保留规则。
        "key": "ccmh",
        "name": "CC漫画",
        "enabled": False,
        "base": "http://m.ccmh6.com",
        "referer": "http://m.ccmh6.com/",
        "headers": {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) "
                          "AppleWebKit/604.1.38 (KHTML, like Gecko) Version/12.0 Mobile/15A372 Safari/604.1",
        },
        "search": {
            "method": "POST",
            "url": "{base}/Search",
            "params": {"Key": "{kw}"},
            "headers": {"Referer": "{base}/Search", "Origin": "{base}"},
            "parse": {
                "type": "selector",
                "selector": ".list > div",
                "fields": {
                    "id": "a split_href:1",
                    "title": "attr:title|text",
                    "cover": "img attr:src|img attr:data-original",
                },
            },
        },
        "toc": {
            "url": "{base}/manhua/{cid}",
            "parse": {
                "type": "selector",
                "selector": ".list > a",
                "fields": {
                    "id": "split_href:2",
                    "title": "attr:title|text",
                    "chapter": "text",
                },
                "reverse": True,
            },
        },
        "pages": {
            "url": "{base}/manhua/{cid}/{ep}.html",
            "lazy_pager": r'<a href="\?p=(\d+)">\d+</a>',
            "max_pages": 120,
            "page_selector": ".img > img|img",
            "page_attr": "src|data-src",
            "parse": {"type": "lazy"},
        },
    },
    "baozimh": {
        "key": "baozimh",
        "name": "包子漫画",
        "base": "https://www.baozimh.com",
        "base_candidates": ["https://cn.bzmgcn.com", "https://m.baozimh.one"],
        "referer": "https://cn.cnbzmg.com/",
        "search": {
            "method": "GET",
            "url": "{base}/search?q={kw}",
            "parse": {
                "type": "selector",
                "selector": "div.comics-card a.comics-card__poster",
                "fields": {
                    "id": "split_href:1",
                    "title": "attr:title",
                    "cover": "amp-img attr:src",
                },
            },
        },
        "toc": {
            "url": "{base}/comic/{cid}",
            "parse": {
                "type": "selector",
                "selector": "a.comics-chapters__item",
                "fields": {
                    "id": "regex:chapter_slot=(\\d+)",
                    "title": "span text",
                    "chapter": "span text",
                },
                "sort_by": "id",
            },
        },
        "pages": {
            "url": "{base}/user/page_direct?comic_id={cid}&section_slot=0&chapter_slot={ep}",
            "parse": {
                "type": "url_regex",
                "url_regex": "'https://[^']+\\.(?:jpg|png|webp)[^']*'",
                "url_replace": ["s1.bzcdn.net", "static-tw.bzmgcn.com"],
            },
        },
    },
    "mangagg": {
        "key": "mangagg",
        "name": "MangaGG",
        "base": "https://mangagg.com",
        "referer": "https://mangagg.com/",
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        "search": {
            "method": "GET",
            "url": "{base}/?s={kw}&post_type=wp-manga",
            "parse": {
                "type": "selector",
                "selector": ".c-tabs-item__content h3 a",
                "fields": {
                    "id": "regex:comic/([^/\"']+)",
                    "title": "text",
                },
            },
        },
        "toc": {
            "url": "{base}/comic/{cid}",
            "pager": {
                "url": "{base}/comic/{cid}/ajax/chapters/?t={page}",
                "max_pages": 100,
                "parse": {
                    "type": "selector",
                    "selector": "a[href*=\"/chapter-\"]",
                    "fields": {
                        "id": "regex:chapter-([\\d\\-]+)",
                        "title": "text",
                        "chapter": "text",
                    },
                },
                "reverse": True,
            },
        },
        "pages": {
            "url": "{base}/comic/{cid}/chapter-{ep}/",
            "parse": {
                "type": "url_regex",
                "url_regex": "src=\"([^\"]*\\.(?:jpg|png|webp)[^\"]*)\"",
                "url_exclude": ["wp-content", "logo", "favicon", "avatar"],
            },
        },
    },
    "mangapill": {
        "key": "mangapill",
        "name": "MangaPill",
        "base": "https://mangapill.com",
        "referer": "https://mangapill.com/",
        "search": {
            "method": "GET",
            "url": "{base}/search?q={kw}",
            "parse": {
                "type": "selector",
                "selector": "a[href*=\"/manga/\"]",
                "fields": {
                    "id": "regex:manga/(\\d+/[^\"']+)",
                    "title": "img attr:alt",
                    "cover": "img attr:data-src",
                },
            },
        },
        "toc": {
            "url": "{base}/manga/{cid}",
            "parse": {
                "type": "selector",
                "selector": "a[href*=\"/chapters/\"]",
                "fields": {
                    "id": "regex:chapters/([\\d\\-]+/[^\"']+)",
                    "title": "text",
                    "chapter": "text",
                },
                "reverse": True,
            },
        },
        "pages": {
            "url": "{base}/chapters/{ep}",
            "parse": {
                "type": "url_regex",
                "url_regex": "src=\"([^\"]*\\.(?:jpg|png|webp)[^\"]*)\"",
                "url_exclude": ["favicon", "data:image"],
            },
        },
    },
    "dm5": {
        # 2026-09 实测:搜索在 https 域名下已恢复(修正表 base 已应用),但图片页仍是
        # JS eval 混淆(下方 pages type=js,引擎无法解析)→ 无法阅读/下载,默认停用。
        "key": "dm5",
        "name": "动漫屋",
        "enabled": False,
        "base": "https://m.dm5.com",
        "referer": "https://m.dm5.com",
        "search": {
            "method": "POST",
            "url": "{base}/pagerdata.ashx",
            "params": {"t": "7", "pageindex": "1", "title": "{kw}"},
            "headers": {"Referer": "http://m.dm5.com"},
            "parse": {
                "type": "json",
                "json_direct": True,
                "list": True,
                "fields": {
                    "id": "$.Url",
                    "id_regex": r"/([\w\-]+)/?$",
                    "title": "$.Title",
                    "cover": "$.Pic",
                    "desc": "$.Author",
                },
            },
        },
        "toc": {
            "url": "http://www.dm5.com/{cid}",
            "parse": {
                "type": "selector",
                "selector": "#chapterlistload li > a",
                "fields": {
                    "id": "split_href:0",
                    "title": "text",
                    "chapter": "text",
                },
                "reverse": True,
            },
        },
        "pages": {
            "url": "{base}/{ep}",
            "note": "图片地址经 JS eval 混淆,需浏览器/JS 引擎,引擎不支持自动降级为不可用",
            "parse": {"type": "js"},
        },
    },
}


def _abs(href: str, base: str) -> str:
    """相对路径转绝对 URL。"""
    if not href:
        return ""
    if href.startswith("http"):
        return href
    if href.startswith("//"):
        return "https:" + href
    return base.rstrip("/") + ("/" + href.lstrip("/") if href else "")


def _json_path(obj, path: str):
    """极简 JSONPath:$.a.b[0].c | $.a.0.b;支持 $. 原样与 $. 取整。"""
    if not path:
        return obj
    p = path.strip()
    if p == "$":
        return obj
    if not p.startswith("$."):
        p = "$." + p
    cur = obj
    for part in p[2:].split("."):
        if cur is None:
            return None
        if isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def _fmt(tpl: str, ctx: dict) -> str:
    """{name} 模板替换(含 {host}/{pre} 等动态字段)。"""
    def _sub(m):
        key = m.group(1)
        v = ctx.get(key)
        return "" if v is None else str(v)
    return re.sub(r"\{([a-zA-Z0-9_]+)\}", _sub, tpl)


class CimocSource:
    """单个 Cimoc 源规则的解释器。"""

    def __init__(self, rule: dict):
        self.rule = rule
        self.base = rule.get("base", "")
        # 多域名候选:请求网络失败时自动切换(域名迁移不再依赖修正表)
        cands = [self.base] + [b for b in (rule.get("base_candidates") or []) if b and b != self.base]
        self._candidates = cands
        self._cand_idx = 0

    def _rotate_base(self) -> bool:
        """切换到下一个域名候选;没有更多则 False。"""
        if self._cand_idx + 1 < len(self._candidates):
            self._cand_idx += 1
            self.base = self._candidates[self._cand_idx]
            return True
        return False

    def _req(self, conf: dict, ctx: dict) -> requests.Response:
        headers = dict(HEADERS)
        headers.update(self.rule.get("headers", {}) or {})
        headers.update({_fmt(k, ctx): _fmt(v, ctx)
                        for k, v in (conf.get("headers") or {}).items()})
        params = {k: _fmt(v, {**ctx, "base": self.base})
                  for k, v in (conf.get("params") or {}).items()}
        method = conf.get("method", "GET")
        kw = {"headers": headers, "timeout": 20}
        if params:
            if method == "POST":
                kw["data"] = params
            else:
                kw["params"] = params
        last_exc: Exception | None = None
        for _ in range(len(self._candidates)):
            url = _fmt(conf.get("url", ""), {**ctx, "base": self.base})
            try:
                r = _get(url, method=method, **kw)
                if r.status_code != 200:
                    raise RuntimeError(f"{self.name} 请求失败 HTTP {r.status_code}")
                return r
            except requests.RequestException as exc:
                # 网络层失败(超时/DNS/拒连):切换下一个域名候选重试;
                # HTTP 4xx/5xx 属站点响应,不轮换
                last_exc = exc
                if self._rotate_base():
                    continue
                raise
        raise last_exc or RuntimeError(f"{self.name} 请求失败")

    # ---------------- 解析器 ----------------
    def _parse_json_list(self, html: str, conf: dict) -> list[dict]:
        """内嵌 JSON 提取(搜索/目录共用)。"""
        direct = conf.get("json_direct")
        if direct:
            block = html
        else:
            m = re.search(conf.get("json_regex", ""), html, re.S)
            if not m:
                return []
            block = m.group(1)
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            return []
        list_path = conf.get("list_path") or (conf.get("list") and "$")
        items = _json_path(data, list_path) if list_path else data
        if not isinstance(items, list):
            return []
        out = []
        for it in items:
            rec = {}
            for fk, fp in (conf.get("fields") or {}).items():
                if fk in ("cover_prefix",):
                    continue
                v = _json_path(it, fp)
                if v is not None:
                    rec[fk] = str(v)
            # cover 前缀
            if "cover_prefix" in (conf.get("fields") or {}) and rec.get("cover"):
                rec["cover"] = conf["fields"]["cover_prefix"] + rec["cover"]
            # 章节 tag 前缀(title = "{tag} {chapter_name}")
            tag = None
            if conf.get("tag_path"):
                tag = _json_path(it, conf["tag_path"])
            if tag is not None:
                rec["tag"] = str(tag)
            for fk in list(rec):
                if re.search(r"\{", rec[fk]):
                    rec[fk] = _fmt(rec[fk], rec)
            if rec.get("id"):
                out.append(rec)
        return out

    def _parse_selector_list(self, html: str, conf: dict) -> list[dict]:
        """CSS 选择器提取(bs4)。fields 值格式:
        text | attr:name | attr:a|attr:b(取第一个非空) | split_href:N |
        "a split_href:1"(子元素 a 的 href 分割) | "img attr:src" 等。"""
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        items = []
        for el in soup.select(conf.get("selector", "")):
            rec = {}
            for fk, spec in (conf.get("fields") or {}).items():
                rec[fk] = self._sel_field(el, spec)
            if rec.get("id"):
                items.append(rec)
        for pat_rep in conf.get("title_replace") or []:
            try:
                pat, rep = pat_rep[0], pat_rep[1]
            except (TypeError, IndexError):
                continue
            for rec in items:
                if rec.get("title"):
                    rec["title"] = re.sub(pat, rep, rec["title"]).strip()
        if conf.get("sort_by"):
            key = conf["sort_by"]
            items.sort(key=lambda r: (int(r.get(key) or 0) if str(r.get(key) or "").lstrip("-").isdigit() else 0))
        if conf.get("reverse"):
            items.reverse()
        return items

    def _sel_field(self, el, spec: str) -> str:
        """单字段提取:支持 '子选择器 操作' 链。
        例: 'text' | 'attr:href' | 'attr:a|attr:b'(取第一个非空)
            'img attr:src' | 'img attr:data-original|attr:src' | 'a split_href:1' | 'split_href:1'
        """
        spec = spec.strip()
        # 若首词是子选择器(如 img/a/.x),先取子元素
        head, _, rest = spec.partition(" ")
        if rest and head not in ("attr:", "text", "split_href"):
            sub = el.select_one(head) if head else None
            if sub is not None:
                el = sub
            spec = rest
        # attr:a|attr:b 取第一个非空
        if spec.startswith("attr:"):
            for at in spec[5:].split("|"):
                at = at.strip()
                if not at or at.startswith("attr:"):
                    continue
                v = el.get(at) or ""
                if v:
                    return v
            return ""
        if spec == "text":
            return re.sub(r"\s+", " ", el.get_text(" ")).strip()
        if spec.startswith("split_href:"):
            try:
                idx = int(spec.split(":", 1)[1])
            except ValueError:
                idx = 0
            href = el.get("href") or ""
            parts = [p for p in href.split("/") if p]
            if idx >= len(parts):
                return ""
            return parts[idx].replace(".html", "")
        if spec.startswith("regex:"):
            # 对元素整体 HTML(含 href)取首个匹配组
            m = re.search(spec[6:], str(el))
            if m:
                return m.group(1) if m.lastindex else m.group(0)
            return ""
        return ""

    def _parse_base64_json(self, html: str, parse: dict) -> list[str]:
        """漫画DB 页图:data-host + data-img_pre + base64(img_data JSON) → [url]。"""
        import base64
        host = re.search(parse.get("host_re", ""), html)
        imgd = re.search(parse.get("img_re", ""), html, re.S)
        if not (host and imgd):
            return []
        try:
            arr = json.loads(base64.b64decode(imgd.group(1)).decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return []
        pre = re.search(parse.get("pre_re", ""), html)
        pre_s = pre.group(1) if pre else ""
        return [str(host.group(1)) + pre_s + str(it.get("img") or "")
                for it in arr if it.get("img")]

    # ---------------- 对外接口 ----------------
    def search(self, keyword: str, limit: int = 20) -> list[dict]:
        conf = self.rule["search"]
        r = self._req(conf, {"kw": keyword})
        parse = conf.get("parse", {})
        ptype = parse.get("type", "selector")
        if ptype == "selector":
            items = self._parse_selector_list(r.text, parse)
        elif ptype == "json":
            items = self._parse_json_list(r.text, parse)
        else:
            return []
        # id 二次清洗(如 DM5 Url="/manga/xxx/" → id_regex)
        id_re = (parse.get("fields") or {}).get("id_regex")
        out = []
        for it in items[:limit]:
            if id_re:
                m = re.search(id_re, it.get("id", ""))
                if m:
                    it["id"] = m.group(1)
            out.append({
                "id": it.get("id", ""), "title": it.get("title", ""),
                "cover": _abs(it.get("cover", ""), self.base),
                "lang": "zh", "desc": it.get("desc", ""),
            })
        return out

    def chapters(self, comic_id: str) -> list[dict]:
        conf = self.rule["toc"]
        # pager 多页章节(Madara 系):POST {base}/comic/{cid}/ajax/chapters/?t={page}
        pager = conf.get("pager")
        if pager:
            items: list = []
            p = 1
            max_p = int(pager.get("max_pages", 100))
            while p <= max_p:
                r = self._req(
                    {"url": pager["url"], "method": "POST",
                     "headers": pager.get("headers") or {}},
                    {"cid": comic_id, "page": p})
                parse = pager.get("parse", {})
                page_items = self._parse_selector_list(r.text, parse)
                if not page_items:
                    break
                items.extend(page_items)
                p += 1
            if pager.get("reverse"):
                items.reverse()
            return [{
                "id": it.get("id", ""), "title": it.get("title", ""),
                "volume": it.get("tag", ""), "chapter": it.get("chapter", ""),
                "lang": "zh",
            } for it in items]
        r = self._req(conf, {"cid": comic_id})
        parse = conf.get("parse", {})
        ptype = parse.get("type", "selector")
        if ptype == "selector":
            items = self._parse_selector_list(r.text, parse)
        elif ptype == "json":
            items = self._parse_json_list(r.text, parse)
        else:
            return []
        # 过滤导航类条目(如「点击查看全部章节目录」:无标题的非章节链接)
        items = [it for it in items if (it.get("title") or "").strip()]
        return [{
            "id": it.get("id", ""),
            "title": it.get("title", ""),
            "volume": it.get("tag", ""),
            "chapter": it.get("chapter", ""),
            "lang": "zh",
        } for it in items]

    def pages(self, comic_id: str, ep_id: str) -> list[str]:
        conf = self.rule["pages"]
        parse = conf.get("parse", {})
        if parse.get("type") == "js":
            raise RuntimeError(f"{self.name} 图片地址经 JS 混淆,此源暂不可用")
        if parse.get("type") == "lazy":
            return self._pages_lazy(comic_id, ep_id, conf)
        r = self._req(conf, {"cid": comic_id, "ep": ep_id})
        html = r.text
        # base64_json(漫画DB):抠 host/pre/img_data(base64 JSON)
        if parse.get("type") == "base64_json":
            return self._parse_base64_json(html, parse)
        # json(动漫之家):"page_url":[...]
        jre = parse.get("json_regex", "")
        m = re.search(jre, html, re.S) if jre else None
        if m:
            try:
                urls = json.loads(m.group(1))
                return [str(u) for u in urls if str(u).startswith("http")]
            except json.JSONDecodeError:
                return []
        # url_regex(包子漫画):单引号 URL 数组 + 可选域名替换
        if parse.get("type") == "url_regex":
            urls = [u.strip(" '\"").replace("&amp;", "&")
                    for u in re.findall(parse.get("url_regex", ""), html)
                    if u.strip(" '\"").startswith("http")]
            ex = parse.get("url_exclude") or []
            if ex:
                urls = [u for u in urls if not any(x in u for x in ex)]
            rep = parse.get("url_replace")
            if rep:
                old, new = rep[:2]
                urls = [u.replace(old, new) for u in urls]
            return urls
        # regex(漫画牛):通用正则提取。url_regex 匹配转义引号包裹的 URL 时,
        # 用 [^"\\] 跳过反斜杠即可,无需在模式里匹配 \" 字面量。
        if parse.get("type") == "regex":
            urls = []
            for m in re.findall(parse.get("url_regex", ""), html):
                u = m if isinstance(m, str) else (
                    m[parse.get("list_group", 0)] if len(m) > parse.get("list_group", 0) else "")
                u = u.strip(" '\"").replace("\\/", "/").replace("&amp;", "&")
                if u.startswith("http"):
                    urls.append(u)
            ex = parse.get("url_exclude") or []
            if ex:
                urls = [u for u in urls if not any(x in u for x in ex)]
            rep = parse.get("url_replace")
            if rep:
                old, new = rep[:2]
                urls = [u.replace(old, new) for u in urls]
            return urls
        return []

    def _pages_lazy(self, comic_id: str, ep_id: str, conf: dict) -> list[str]:
        """lazy 分页(CC漫画):先取总页数,再逐页请求提取图片 src。"""
        base_url = _fmt(conf.get("url", ""), {"cid": comic_id, "ep": ep_id, "base": self.base})
        first = _req_plain(base_url, self.rule.get("headers", {}))
        if first is None:
            return []
        html = first.text
        max_p = 1
        for m in re.finditer(conf.get("lazy_pager", ""), html):
            max_p = max(max_p, int(m.group(1)))
        max_p = min(max_p, int(conf.get("max_pages", 120)))
        out = []
        for i in range(1, max_p + 1):
            h = html if i == 1 else None
            if h is None:
                r = _req_plain(f"{base_url}?p={i}", self.rule.get("headers", {}))
                if r is None:
                    continue
                h = r.text
            sel = conf.get("page_selector", "").split("|")
            attr = conf.get("page_attr", "src").split("|")
            src = ""
            for _ in sel:
                m3 = re.search(r'<img[^>]*\b(?:' + "|".join(attr) + r')\s*=\s*["\']([^"\']+)["\']', h, re.I)
                if m3:
                    src = m3.group(1)
                    break
            if src:
                if src.startswith("//"):
                    src = "https:" + src
                out.append(src)
        return out


def _req_plain(url: str, headers: dict):
    """无 _get 封装的裸请求(lazy 分页用,避免每页走验证逻辑)。"""
    try:
        h = dict(HEADERS)
        h.update(headers or {})
        return requests.get(url, headers=h, timeout=20, proxies=_proxies())
    except requests.RequestException:
        return None

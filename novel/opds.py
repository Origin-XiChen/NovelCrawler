# -*- coding: utf-8 -*-
"""OPDS 目录解析与下载(轻小说文库 wenku8 等)。

OPDS 是开放出版分发系统:
  - OPDS 1.x:基于 Atom XML(根目录 → 分类/最近更新/排行 子目录 → 书目条目)
  - OPDS 2.x:基于 JSON(顶层 publications/groups,facets 分类,同导航结构)
本模块两种格式都支持,统一输出 [{title, type, href, epub, cover, desc, is_nav}]。
"""
from __future__ import annotations

import html as _html
import json as _json
import logging
import os
import re
import requests

logger = logging.getLogger("novel.opds")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
}


def _load_cookies(path: str | None) -> list[dict]:
    if not path or not os.path.isfile(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            data = _json.load(f)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


def fetch(url: str, timeout: int = 25, cookie_path: str | None = None) -> str:
    """请求 OPDS 目录/搜索,返回正文文本(XML 或 JSON)。
    cookie_path: 若提供且直接请求被 403,带上已保存的浏览器 cookies 重试(Cloudflare 通过后)。"""
    r = requests.get(url, headers=HEADERS, timeout=timeout)
    if r.status_code == 403 and cookie_path:
        cj = requests.utils.cookiejar_from_dict(
            {c["name"]: c["value"] for c in _load_cookies(cookie_path)})
        r = requests.get(url, headers=HEADERS, timeout=timeout, cookies=cj)
    r.raise_for_status()
    # 服务端可能返回 gbk 等非 utf-8 编码
    if r.encoding and r.encoding.lower() not in ("utf-8", "utf8"):
        try:
            return r.content.decode(r.encoding, errors="replace")
        except Exception:  # noqa: BLE001
            pass
    return r.text


def _unescape(s: str) -> str:
    return _html.unescape(s or "").strip()


def parse_catalog(content: str) -> list[dict]:
    """解析 OPDS 目录(自动识别 1.x XML / 2.x JSON),返回 [{title, type, href, epub, cover, desc, is_nav}]。"""
    content = (content or "").strip()
    if not content:
        return []
    if content.startswith("{") or content.startswith("["):
        return _parse_opds2(content)
    return _parse_opds1(content)


# ---------------- OPDS 1.x:Atom XML ----------------
def _parse_opds1(xml: str) -> list[dict]:
    """解析 OPDS/Atom 目录,返回 [{title, type, href, epub, cover, desc, is_nav}]。

    type: 链接的 MIME;href: 子目录/书页链接;epub: EPUB 直链(若有);
    cover: 封面图 URL(opds-spec.org/image 链接,若有);desc: 简介(summary/content)。
    """
    out: list[dict] = []
    for e in re.findall(r"<entry>[\s\S]*?</entry>", xml):
        title_m = re.search(r"<title[^>]*>([^<]+)</title>", e)
        title = _unescape(title_m.group(1)) if title_m else ""
        links = re.findall(r'<link[^>]*href="([^"]+)"[^>]*type="([^"]*)"', e)
        if not links:
            links = re.findall(r"<link[^>]*href='([^']+)'[^>]*type=\"([^\"]*)\"", e)
        epub = next((u for u, t in links if "epub" in t.lower()), "")
        nav = next((u for u, t in links if "opds" in t.lower() or "atom" in t.lower() or u.endswith((".xml", ".opds"))), "")
        # 封面:rel 含 image/cover/thumbnail 的 link(opds-spec.org/image 标准)
        cover = ""
        for lm in re.finditer(r'<link[^>]*rel=["\']([^"\']+)["\'][^>]*href=["\']([^"\']+)["\']', e):
            rel, href = lm.group(1).lower(), lm.group(2)
            if "image" in rel or "cover" in rel or "thumb" in rel:
                cover = href
                break
        if not cover:
            for lm in re.finditer(r'<link[^>]*href=["\']([^"\']+)["\'][^>]*rel=["\']([^"\']+)["\']', e):
                href, rel = lm.group(1), lm.group(2).lower()
                if "image" in rel or "cover" in rel or "thumb" in rel:
                    cover = href
                    break
        # 简介:summary 或 content(去标签)
        desc = ""
        dm = re.search(r"<summary[^>]*>([\s\S]*?)</summary>", e, re.I)
        if dm is None:
            dm = re.search(r"<content[^>]*>([\s\S]*?)</content>", e, re.I)
        if dm:
            desc = re.sub(r"<[^>]+>", "", dm.group(1))
            desc = _unescape(desc)
        if len(desc) > 400:
            desc = desc[:400] + "…"
        item = {
            "title": title,
            "href": nav or epub,
            "epub": epub,
            "cover": cover,
            "desc": desc,
            "is_nav": bool(nav) and not epub,
            "types": [t for _, t in links[:2]],
        }
        if item["href"] or item["epub"]:
            out.append(item)
    return out


# ---------------- OPDS 2.x:JSON ----------------
def _opds2_publication(pub: dict) -> dict:
    """把 OPDS 2.x 的一个 publication 转成统一 item 结构。"""
    meta = pub.get("metadata") or {}
    title = (meta.get("title") or "").strip()
    desc = re.sub(r"<[^>]+>", "", meta.get("description") or "")
    desc = _unescape(desc)
    if len(desc) > 400:
        desc = desc[:400] + "…"
    epub, nav = "", ""
    types: list[str] = []
    for link in pub.get("links") or []:
        href = (link.get("href") or "").strip()
        typ = (link.get("type") or "").lower()
        rel = (link.get("rel") or "").lower()
        if href:
            types.append(typ)
            if "epub" in typ:
                epub = epub or href
            elif "opds" in typ or "navigation" in rel or "subsection" in rel:
                nav = nav or href
    cover = ""
    for img in pub.get("images") or []:
        href = (img.get("href") or "").strip()
        if href:
            cover = cover or href
            if cover:
                break
    href = nav or epub
    return {
        "title": title,
        "href": href,
        "epub": epub,
        "cover": cover,
        "desc": desc,
        "is_nav": bool(nav) and not epub,
        "types": types,
    }


def _parse_opds2(content: str) -> list[dict]:
    """解析 OPDS 2.x JSON 目录(顶层 publications/groups/facets)。"""
    try:
        data = _json.loads(content)
    except Exception:  # noqa: BLE001
        return []
    if isinstance(data, list):
        data = {"publications": data}
    if not isinstance(data, dict):
        return []

    out: list[dict] = []
    seen: set[tuple] = set()

    def _push(item: dict) -> None:
        if not item:
            return
        key = (item.get("href") or "", item.get("epub") or "")
        if not item["href"] and not item["epub"]:
            return
        if key in seen:
            return
        seen.add(key)
        out.append(item)

    # 1) 顶层 publications:书目条目
    for pub in data.get("publications") or []:
        if isinstance(pub, dict):
            _push(_opds2_publication(pub))

    # 2) groups:导航目录/分类(每个 group 有 links 子目录 + publications 条目)
    for grp in data.get("groups") or []:
        if not isinstance(grp, dict):
            continue
        gmeta = grp.get("metadata") or {}
        gtitle = (gmeta.get("title") or "").strip()
        for link in grp.get("links") or []:
            href = (link.get("href") or "").strip()
            typ = (link.get("type") or "").lower()
            rel = (link.get("rel") or "").lower()
            if href and ("opds" in typ or "subsection" in rel or "navigation" in rel or typ.endswith("+json")):
                _push({"title": gtitle or rel, "href": href, "epub": "", "cover": "",
                       "desc": "", "is_nav": True, "types": [typ]})
        for pub in grp.get("publications") or []:
            if isinstance(pub, dict):
                _push(_opds2_publication(pub))

    # 3) 顶层 links 中非自指/搜索/翻页的导航链接
    skip_rels = {"self", "start", "search", "next", "previous", "last", "first"}
    for link in data.get("links") or []:
        href = (link.get("href") or "").strip()
        typ = (link.get("type") or "").lower()
        rel = (link.get("rel") or "").lower()
        if href and "opds" in typ and rel not in skip_rels:
            _push({"title": rel, "href": href, "epub": "", "cover": "",
                   "desc": "", "is_nav": True, "types": [typ]})

    # 4) facets:分面筛选(分类)链接,作为导航项
    for facet in data.get("facets") or []:
        if not isinstance(facet, dict):
            continue
        fmeta = facet.get("metadata") or {}
        ftitle = (fmeta.get("title") or "").strip()
        for link in facet.get("links") or []:
            href = (link.get("href") or "").strip()
            if href and "opds" in (link.get("type") or "").lower():
                _push({"title": ftitle or "筛选", "href": href, "epub": "", "cover": "",
                       "desc": "", "is_nav": True, "types": [(link.get("type") or "")]})
    return out


def resolve_absolute(href: str, base_url: str) -> str:
    """把相对链接拼成绝对 URL。支持 // 协议相对 URL(补 base 的 scheme)。"""
    href = (href or "").strip()
    if not href:
        return ""
    if href.startswith(("http://", "https://")):
        return href
    if href.startswith("//"):
        scheme = (base_url.split(":", 1)[0] or "https") if ":" in base_url else "https"
        return f"{scheme}:{href}"
    base = base_url.split("?", 1)[0]
    if base.endswith(".xml") or base.endswith(".opds") or base.endswith(".json"):
        base = base.rsplit("/", 1)[0] + "/"
    elif not base.endswith("/"):
        base += "/"
    return base + href.lstrip("/")

# -*- coding: utf-8 -*-
"""EPUB 解析:解包 zip,按 spine 顺序提取章节标题、正文文本与图片资源地址。"""
from __future__ import annotations

import os
import posixpath
import re
import zipfile
from urllib.parse import quote
from xml.etree import ElementTree as ET

_CONTAINER_NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
_OPF_NS = {"o": "http://www.idpf.org/2007/opf"}
_NCX_NS = {"n": "http://www.daisy.org/z3986/2005/ncx/"}


def _parse_ncx_volumes(zipf: zipfile.ZipFile, opf_dir: str) -> dict[str, str]:
    """解析 toc.ncx 的 navMap 层级,返回 {章节src(norm 绝对路径): 卷标题}。

    分卷 EPUB 的 NCX 常为两级:顶层 navPoint=卷(有子 navPoint),子级=章节。
    扁平 NCX(顶层全是章节)不产生任何卷分组,volume 为空,与旧行为一致。
    """
    try:
        ncx = ET.fromstring(zipf.read(posixpath.join(opf_dir, "toc.ncx")))
    except (KeyError, ET.ParseError):
        return {}
    navmap = ncx.find(".//n:navMap", _NCX_NS)
    if navmap is None:
        return {}
    out: dict[str, str] = {}

    def _handle(np: ET.Element, volume: str = "") -> None:
        """处理单个 navPoint:分组节点下发卷名并递归子节点;叶子节点登记卷名。"""
        label = (np.findtext("n:navLabel/n:text", default="", namespaces=_NCX_NS) or "").strip()
        content = np.find("n:content", _NCX_NS)
        src = (content.get("src", "") if content is not None else "").strip()
        children = np.findall("n:navPoint", _NCX_NS)
        if children:
            # 分组/卷节点:标题下发给所有子章节;自身若带 src 也登记
            if src:
                full = posixpath.normpath(posixpath.join(opf_dir, src.split("#")[0]))
                out[full] = volume or ""
            for c in children:
                _handle(c, label or volume)
        else:
            # 叶子章节:登记当前卷名
            if src:
                full = posixpath.normpath(posixpath.join(opf_dir, src.split("#")[0]))
                out[full] = volume or ""

    for np in navmap.findall("n:navPoint", _NCX_NS):
        _handle(np)
    return out


def _strip_html(html: str) -> str:
    """HTML → 纯文本(保留段落换行,去除脚本/样式/导航)。"""
    html = re.sub(r"<(script|style|head|nav)[\s\S]*?</\1>", "", html, flags=re.I)
    html = re.sub(r"<br[^>]*>", "\n", html, flags=re.I)
    html = re.sub(r"</(p|div|h[1-6]|li)>", "\n", html, flags=re.I)
    text = re.sub(r"<[^>]+>", "", html)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 清理残留空白
    lines = [ln.strip() for ln in text.split("\n")]
    return "\n".join(l for l in lines if l).strip()


_FONT_DECL_RE = re.compile(r"\bfont-family\s*:\s*[^;}]+;?", flags=re.I)
_FONT_SHORTHAND_RE = re.compile(r"(?<![\w-])\bfont\s*:\s*[^;}]+;?", flags=re.I)


def _strip_font_decls(css: str) -> str:
    """移除 CSS 中的 font-family 与 font 简写声明。

    阅读器统一用自身字体设置(--reader-font + !important)渲染,
    避免 EPUB 内嵌样式表里的字体规则覆盖用户选择的字体。
    """
    css = _FONT_DECL_RE.sub("", css)
    css = _FONT_SHORTHAND_RE.sub("", css)
    return css


def _rewrite_media(attrs: str, ch_path: str, epub_file: str, tag: str) -> str:
    """把 <audio>/<video>/<source> 的 src 重写为 EPUB 资源接口地址。"""
    m = re.search(r"src\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))", attrs)
    if not m:
        return "<" + tag + attrs + ">"
    src = (m.group(2) or m.group(3) or m.group(4) or "").strip()
    if not src or src.startswith("data:") or src.startswith("http"):
        return "<" + tag + attrs + ">"
    base = posixpath.dirname(ch_path)
    full = posixpath.normpath(posixpath.join(base, src))
    api = f"/api/epub_asset?file={quote(epub_file)}&path={quote(full)}"
    return '<' + tag + ' src="' + api + '"' + attrs[m.end():] + '>'


def _rewrite_svg(attrs: str, ch_path: str, epub_file: str) -> str:
    """重写 <image href=...> / <image xlink:href=...>(SVG 内嵌图片)。"""
    m = re.search(r"(?:href|xlink:href)\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))", attrs)
    if not m:
        return "<image" + attrs + ">"
    src = (m.group(2) or m.group(3) or m.group(4) or "").strip()
    if not src or src.startswith("data:") or src.startswith("http"):
        return "<image" + attrs + ">"
    base = posixpath.dirname(ch_path)
    full = posixpath.normpath(posixpath.join(base, src))
    api = f"/api/epub_asset?file={quote(epub_file)}&path={quote(full)}"
    return '<image xlink:href="' + api + '"' + attrs[m.end():] + '>'


def _rewrite_css_urls(css: str, css_path: str, epub_file: str) -> str:
    """重写 CSS 内的 url(...) 相对路径为 EPUB 资源接口地址。
    @font-face 字体 / background-image 背景图等全部可用。"""
    css_base = posixpath.dirname(css_path)

    def _rep(m: re.Match) -> str:
        q = m.group(1) or ""
        inner = (m.group(2) or "").strip()
        if not inner or inner.startswith(("data:", "http:", "https:", "/")):
            return m.group(0)
        full = posixpath.normpath(posixpath.join(css_base, inner))
        api = f"/api/epub_asset?file={quote(epub_file)}&path={quote(full)}"
        return f"url({q}{api}{q})"

    # url("...") / url('...') / url(...)
    css = re.sub(r"url\(\s*(['\"]?)([^'\")\s]*)\1\s*\)", _rep, css)
    return css


def _rewrite_xhtml_links(html: str, ch_path: str, epub_file: str) -> str:
    """跨章节链接 href="chap2.xhtml" / "chap2.xhtml#fn1":
    保留原 href 供 JS 识别跳转,同时加 data-epub-chap 标记(target 章节文件路径)。
    仅标记跨章节链接(指向 .xhtml/.html 且不是本文件);纯锚点(#fn1)不动。"""
    base = posixpath.dirname(ch_path)
    own_name = posixpath.basename(ch_path).lower()

    def _rep(m: re.Match) -> str:
        full_href = (m.group(2) or m.group(3) or m.group(4) or "").strip()
        if not full_href or full_href.startswith(("http:", "https:", "data:", "mailto:", "#")):
            return m.group(0)
        href_no_hash = full_href.split("#")[0]
        if not re.search(r"\.x?html$", href_no_hash, re.I):
            return m.group(0)  # 非章节链接(如 pdf/图片)不动
        if posixpath.basename(href_no_hash).lower() == own_name:
            return m.group(0)  # 本文件内的链接,交给锚点逻辑
        full = posixpath.normpath(posixpath.join(base, href_no_hash))
        marker = f' data-epub-chap="{quote(full)}"'
        return '<a' + marker + m.group(0)[2:]

    return re.sub(r"<a\b[^>]*\shref\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))[^>]*>", _rep, html, flags=re.I)


def extract_html(html: str, ch_path: str, epub_file: str = "", zipf: zipfile.ZipFile | None = None) -> str:
    """HTML → 结构化文本(保留 p/表格/列表/多媒体等),资源 src 重写为 EPUB 资源接口。

    ch_path: 章节在 zip 内的路径(用于解析相对图片路径)。
    epub_file: EPUB 文件名(资源接口的 file 参数)。
    zipf: 可选 zip 对象,用于内联外部 <link rel=stylesheet> 与字体(@font-face url 重写)。
    """
    # 先取出 <style> 块(EPUB 排版依赖),再删 head(避免 style 被 head 整体吃掉)
    style_blocks = re.findall(r"<style[^>]*>([\s\S]*?)</style>", html, flags=re.I)
    # 外部 <link rel="stylesheet" href="style.css"> → 读取内容内联(重写 url 相对路径)
    if zipf is not None:
        for lm in re.finditer(r"<link[^>]*rel\s*=\s*[\"']stylesheet[\"'][^>]*href\s*=\s*[\"']([^\"']+)[\"'][^>]*/?>", html, flags=re.I):
            href = lm.group(1)
            if href.startswith(("http:", "https:", "data:")):
                continue
            css_path = posixpath.normpath(posixpath.join(posixpath.dirname(ch_path), href))
            try:
                css_raw = zipf.read(css_path).decode("utf-8", "replace")
                css_safe = re.sub(r"@import[^;]*;?", "", css_raw, flags=re.I)
                css_safe = _rewrite_css_urls(css_safe, css_path, epub_file)
                style_blocks.append(css_safe)
            except KeyError:
                pass
    html = re.sub(r"<(script|head|nav)[\s\S]*?</\1>", "", html, flags=re.I)
    # 内嵌 <style> 保留,但剥掉 @import(外部资源加载)与字体声明(字体交给阅读器统一设置)
    if style_blocks:
        safe = re.sub(r"@import[^;]*;?", "", "\n".join(style_blocks), flags=re.I)
        safe = _rewrite_css_urls(safe, ch_path, epub_file)
        safe = _strip_font_decls(safe)
        html = "<style>" + safe + "</style>\n" + html
    html = re.sub(r"</?(html|body)[^>]*>", "", html, flags=re.I)
    html = re.sub(r"<img([^>]*)>", lambda m: _rewrite_img(m.group(1), ch_path, epub_file), html, flags=re.I)
    # 老式 <font face="..."> 标签:剥掉 face 属性,字体交给阅读器统一设置
    html = re.sub(r"<font\b[^>]*\bface\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "<font", html, flags=re.I)
    html = re.sub(r"<audio([^>]*)>", lambda m: _rewrite_media(m.group(1), ch_path, epub_file, "audio"), html, flags=re.I)
    html = re.sub(r"<video([^>]*)>", lambda m: _rewrite_media(m.group(1), ch_path, epub_file, "video"), html, flags=re.I)
    html = re.sub(r"<source([^>]*)>", lambda m: _rewrite_media(m.group(1), ch_path, epub_file, "source"), html, flags=re.I)
    # SVG 内嵌图片(<image href>/<image xlink:href>)
    html = re.sub(r"<image([^>]*)>", lambda m: _rewrite_svg(m.group(1), ch_path, epub_file), html, flags=re.I)
    # 跨章节链接标记(data-epub-chap)
    html = _rewrite_xhtml_links(html, ch_path, epub_file)
    # 剥掉事件属性,防 XSS
    html = re.sub(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", html, flags=re.I)
    # 剥掉可执行链接(单双引号/无引号三种形态都剥,防 XSS)
    def _strip_bad_href(m: re.Match) -> str:
        val = (m.group(2) or m.group(3) or m.group(4) or "").strip()
        low = val.lower()
        if low.startswith("javascript:") or low.startswith("vbscript:"):
            return ""
        return m.group(0)

    html = re.sub(r"href\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))", _strip_bad_href, html, flags=re.I)
    return html


def _rewrite_img(attrs: str, ch_path: str, epub_file: str) -> str:
    """把 <img src=...> 的 src 重写为 /api/epub_asset?file=..&path=.."""
    m = re.search(r"src\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s>]+))", attrs)
    if not m:
        return "<img>"
    src = (m.group(2) or m.group(3) or m.group(4) or "").strip()
    if not src or src.startswith("data:") or src.startswith("http"):
        return "<img" + attrs + ">"
    base = posixpath.dirname(ch_path)
    full = posixpath.normpath(posixpath.join(base, src))
    api = f"/api/epub_asset?file={quote(epub_file)}&path={quote(full)}"
    return '<img src="' + api + '"' + attrs[m.end():] + '>'


def parse_epub(path: str) -> list[dict]:
    """解包 EPUB,返回 [{idx, title, text, html, path}] 按 spine 顺序。"""
    with zipfile.ZipFile(path) as z:
        try:
            container = ET.fromstring(z.read("META-INF/container.xml"))
        except KeyError:
            raise ValueError("不是有效的 EPUB(缺少 META-INF/container.xml)")
        rootfile = container.find(".//c:rootfile", _CONTAINER_NS)
        if rootfile is None:
            raise ValueError("EPUB 缺少 rootfile")
        opf_path = rootfile.get("full-path")
        opf = ET.fromstring(z.read(opf_path))
        base = posixpath.dirname(opf_path)
        # manifest
        manifest = {}
        m = opf.find("o:manifest", _OPF_NS)
        if m is not None:
            for item in m.findall("o:item", _OPF_NS):
                manifest[item.get("id")] = item.get("href", "")
        # spine
        spine_refs: list[str] = []
        sp = opf.find("o:spine", _OPF_NS)
        if sp is not None:
            for ir in sp.findall("o:itemref", _OPF_NS):
                ref = ir.get("idref")
                if ref:
                    spine_refs.append(ref)
        # 分卷:解析 NCX 层级 → {章节文件: 卷标题}
        vol_map = _parse_ncx_volumes(z, base)
        chapters: list[dict] = []
        for idref in spine_refs:
            href = manifest.get(idref)
            if not href:
                continue
            p = posixpath.normpath(posixpath.join(base, href))
            try:
                raw = z.read(p)
            except KeyError:
                continue
            try:
                html = raw.decode("utf-8")
            except UnicodeDecodeError:
                html = raw.decode("gbk", errors="replace")
            title_m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
            title = title_m.group(1).strip() if title_m else f"第{len(chapters) + 1}章"
            chapters.append({
                "idx": len(chapters) + 1,
                "title": title,
                "text": _strip_html(html),
                "html": extract_html(html, p, os.path.basename(path.replace("\\", "/")), z),
                "path": p,
                "volume": vol_map.get(p, "") or "",
            })
    # 兼容:单文件 EPUB(旧版导出用 <h2 id="cN"> 锚点分章,spine 只有 1 项)
    # 正文含多个章节锚点时,按锚点拆成多章,阅读器才能正确分章
    if len(chapters) == 1:
        single = chapters[0]
        with zipfile.ZipFile(path) as z2:
            try:
                raw = z2.read(single["path"])
            except KeyError:
                raw = b""
        raw_html = raw.decode("utf-8", "replace")
        anchors = list(re.finditer(r"<h2[^>]*id=[\"']c(\d+)[\"'][^>]*>(.*?)</h2>",
                                   raw_html, flags=re.I | re.S))
        if len(anchors) > 1:
            chapters = []
            positions = [a.start() for a in anchors] + [len(raw_html)]
            epub_fname = os.path.basename(path.replace("\\", "/"))
            for k, a in enumerate(anchors):
                seg = raw_html[a.start():positions[k + 1]]
                title = re.sub(r"<[^>]+>", "", a.group(2)).strip() or f"第{k + 1}章"
                chapters.append({
                    "idx": k + 1,
                    "title": title,
                    "text": _strip_html(seg),
                    "html": extract_html(seg, single["path"], epub_fname, z2),
                    "path": single["path"],
                })
    return chapters


def read_chapter(path: str, idx: int) -> dict:
    """按章节序号读取某章文本与 html(避免全部加载)。"""
    chs = parse_epub(path)
    if idx < 1 or idx > len(chs):
        raise ValueError(f"章节序号越界: {idx}")
    c = chs[idx - 1]
    return {"title": c["title"], "text": c["text"], "html": c.get("html", "")}


def read_asset(path: str, asset_path: str) -> bytes:
    """按 zip 内路径读取资源(图片/字体/css),防路径穿越。"""
    asset_path = asset_path.replace("\\", "/").lstrip("/")
    if ".." in asset_path.split("/"):
        raise ValueError("非法资源路径")
    with zipfile.ZipFile(path) as z:
        try:
            return z.read(asset_path)
        except KeyError:
            raise FileNotFoundError(f"资源不存在: {asset_path}")

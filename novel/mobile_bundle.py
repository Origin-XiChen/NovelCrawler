# -*- coding: utf-8 -*-
"""手机离线包:把电脑上已下载的一本书导出成 ZIP,手机存进本地后断网可读。

包内只有四类条目:
    manifest.json        书名、章节目录、资源映射(手机的本地"数据库")
    chapters/00001.json  单章正文(TXT 给 text,EPUB 给 html + text)
    assets/0001.jpeg     EPUB 内嵌图片/字体
    pages/0001.jpg       漫画逐页 JPEG

章节切分、正文清洗、漫画抽图全部复用电脑端现成实现(Reader/EPUB/comic),
所以手机与电脑的目录、正文、图片天然一致。EPUB html 里的
``/api/epub_asset?file=..&path=X`` 原样保留,手机按 manifest.assets 把 X
换成本地 blob —— 不在 JS 里重写一遍 EPUB/PDF 解析。
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import time
import zipfile
from urllib.parse import unquote

BUNDLE_VERSION = 1

# extract_html() 重写出来的资源地址(path 参数已 URL 编码)
_ASSET_RE = re.compile(r"""/api/epub_asset\?[^"'()\s]*?[&?]path=([^"'()\s]+)""")
_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg")


def _chapter_name(idx: int) -> str:
    return f"chapters/{int(idx):05d}.json"


def _asset_name(seq: int, asset_path: str) -> str:
    ext = os.path.splitext(asset_path)[1].lower()
    ext = ext if 1 <= len(ext) <= 6 else ".bin"
    return f"assets/{seq:04d}{ext}"


def _stat(src: str) -> tuple[int, float]:
    try:
        st = os.stat(src)
        return st.st_size, st.st_mtime
    except OSError:
        return 0, 0.0


def _report(on_stage, done: int, total: int) -> None:
    """每 20 章/页上报一次打包进度,避免回调把日志刷爆。"""
    if on_stage and (done % 20 == 0 or done >= total):
        try:
            on_stage(done, total)
        except Exception:  # noqa: BLE001
            pass


def _epub_cover(src: str) -> str:
    """按 OPF 声明取封面在 zip 内的路径;没声明返回空。

    EPUB3 用 item[properties~=cover-image],EPUB2 用 meta[name=cover]→manifest id。
    只靠文件名含 "cover" 会漏掉规范命名的书,离线书架就会出现无封面的情况。
    """
    from xml.etree import ElementTree as ET
    ns = {"c": "urn:oasis:names:tc:opendocument:xmlns:container",
          "o": "http://www.idpf.org/2007/opf"}
    try:
        with zipfile.ZipFile(src) as z:
            rootfile = ET.fromstring(z.read("META-INF/container.xml")).find(".//c:rootfile", ns)
            if rootfile is None:
                return ""
            opf_path = rootfile.get("full-path")
            opf = ET.fromstring(z.read(opf_path))
            base = posixpath.dirname(opf_path)
            items = opf.findall(".//o:manifest/o:item", ns)
            by_id = {it.get("id"): it.get("href", "") for it in items}
            for it in items:
                if "cover-image" in (it.get("properties") or "").split():
                    return posixpath.normpath(posixpath.join(base, it.get("href", "")))
            # EPUB2:命名空间各家写得不一致,按 local name 找 meta[name=cover]
            for el in opf.iter():
                if el.tag.rsplit("}", 1)[-1] == "meta" and el.get("name") == "cover":
                    href = by_id.get((el.get("content") or "").strip())
                    if href:
                        return posixpath.normpath(posixpath.join(base, href))
                    break
    except Exception:  # noqa: BLE001
        return ""
    return ""


def _add_sidecar_cover(zf: zipfile.ZipFile, fname: str, assets: dict[str, str]) -> str:
    """把下载时缓存的封面放进离线包(EPUB 没内嵌封面时的兜底 / TXT 唯一来源)。"""
    try:
        # ensure_cover 会依次尝试「缓存 → EPUB 内嵌 → 来源地址 → 现场生成」,
        # 所以纯 TXT 也能在这里拿到一张像样的封面(手机书架不再只有首字)。
        from .covers import ensure_cover
        path = ensure_cover(fname)
        if not path:
            return ""
        with open(path, "rb") as f:
            data = f.read()
        if not data:
            return ""
        arc = _asset_name(len(assets) + 1, path)
        zf.writestr(arc, data, compress_type=zipfile.ZIP_STORED)
        assets[os.path.basename(path)] = arc
        return arc
    except Exception:  # noqa: BLE001
        return ""


def novel_bundle(src: str, out_path: str, clean_rules: list | None = None,
                 on_stage=None) -> dict:
    """导出整本(TXT 或 EPUB),返回写入 manifest.json 的内容。

    clean_rules 与网页阅读器同源:TXT 正文按电脑端设置清洗后才进包,
    否则手机离线读到的内容会比电脑上多广告行。
    """
    fname = os.path.basename(src)
    stem = os.path.splitext(fname)[0]
    is_epub = fname.lower().endswith(".epub")
    toc: list[dict] = []
    assets: dict[str, str] = {}
    cover = ""

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        if is_epub:
            from .epub import parse_epub, read_asset
            chapters = parse_epub(src)
            total = len(chapters)
            for c in chapters:
                idx = int(c["idx"])
                html = c.get("html") or ""
                zf.writestr(_chapter_name(idx), json.dumps(
                    {"idx": idx, "title": c.get("title", ""),
                     "html": html, "text": c.get("text", "")},
                    ensure_ascii=False))
                toc.append({"idx": idx, "title": c.get("title", ""),
                            "volume": c.get("volume", "") or "",
                            "path": c.get("path", "")})
                for m in _ASSET_RE.finditer(html):
                    p = unquote(m.group(1))
                    if p in assets:
                        continue
                    try:
                        data = read_asset(src, p)
                    except Exception:  # noqa: BLE001
                        continue  # 资源缺失:留空映射,手机按坏图处理不影响正文
                    arc = _asset_name(len(assets) + 1, p)
                    assets[p] = arc
                    zf.writestr(arc, data, compress_type=zipfile.ZIP_STORED)
                    if not cover and p.lower().endswith(_IMAGE_EXT) \
                            and "cover" in os.path.basename(p).lower():
                        cover = arc
                _report(on_stage, idx, total)
            # 封面常只被 OPF 声明、不被章节引用,不主动收就会在离线书架上缺图
            cover_path = _epub_cover(src)
            if cover_path and cover_path not in assets:
                try:
                    arc = _asset_name(len(assets) + 1, cover_path)
                    zf.writestr(arc, read_asset(src, cover_path),
                                compress_type=zipfile.ZIP_STORED)
                    assets[cover_path] = arc
                except Exception:  # noqa: BLE001
                    pass
            if not cover:
                cover = assets.get(cover_path, "")
                if not cover:
                    cover = _add_sidecar_cover(zf, fname, assets)
        else:
            from .clean import clean_text
            from .reader import parse_txt
            chapters = parse_txt(src)
            total = len(chapters)
            for c in chapters:
                idx = int(c["idx"])
                text = c.get("text", "")
                if clean_rules:
                    text = clean_text(text, clean_rules)
                zf.writestr(_chapter_name(idx), json.dumps(
                    {"idx": idx, "title": c.get("title", ""), "text": text},
                    ensure_ascii=False))
                toc.append({"idx": idx, "title": c.get("title", "")})
                _report(on_stage, idx, total)
            # TXT 没有内嵌资源,封面在下载时单独缓存在 .covers/
            cover = _add_sidecar_cover(zf, fname, assets)
        size, mtime = _stat(src)
        manifest = {
            "bundle_version": BUNDLE_VERSION,
            "kind": "epub" if is_epub else "txt",
            "id": f"novel:{fname}",
            "title": stem,
            "file": fname,
            "chapters": toc,
            "total": len(toc),
            "assets": assets,
            "cover": cover,
            "src_size": size,
            "src_mtime": mtime,
            "generated": int(time.time()),
        }
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
    return manifest


def comic_bundle(src: str, out_path: str, meta: dict | None = None,
                 title: str = "", on_stage=None) -> dict:
    """导出一本漫画 PDF 为逐页 JPEG 包(与 /api/comic_page_image 同源出图)。"""
    from .comic import page_image
    fname = os.path.basename(src)
    size, mtime = _stat(src)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        from pypdf import PdfReader
        reader = PdfReader(src)
        pages = list(reader.pages)
        total = len(pages)
        for i, page in enumerate(pages, start=1):
            zf.writestr(f"pages/{i:04d}.jpg", page_image(page),
                        compress_type=zipfile.ZIP_STORED)
            _report(on_stage, i, total)
        manifest = {
            "bundle_version": BUNDLE_VERSION,
            "kind": "comic",
            "id": f"comic:{title}/{fname}" if title else f"comic:{fname}",
            "title": title or os.path.splitext(fname)[0],
            "file": fname,
            "chapters": [],
            "total": total,
            "num_pages": total,
            "meta": meta or None,
            "assets": {},
            "cover": "pages/0001.jpg" if total else "",
            "src_size": size,
            "src_mtime": mtime,
            "generated": int(time.time()),
        }
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
    return manifest


def read_manifest(zip_path: str) -> dict:
    """读取已生成包里的 manifest.json(用于打包完成后回填大小/校验)。"""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            return json.loads(zf.read("manifest.json").decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def epub_chapter_count(path: str) -> int:
    """EPUB 章节数:只读 OPF 的 spine,不解正文(书目列表用)。

    spine 只有 1 项时按旧版导出格式回退:数正文里的 ``<h2 id="cN">`` 锚点,
    与 parse_epub() 的兼容分支同一判据,否则单文件 EPUB 会被报成 1 章。
    """
    from xml.etree import ElementTree as ET
    _NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container",
           "o": "http://www.idpf.org/2007/opf"}
    try:
        with zipfile.ZipFile(path) as z:
            container = ET.fromstring(z.read("META-INF/container.xml"))
            rootfile = container.find(".//c:rootfile", _NS)
            if rootfile is None:
                return 0
            opf_path = rootfile.get("full-path")
            opf = ET.fromstring(z.read(opf_path))
            base = posixpath.dirname(opf_path)
            manifest = {i.get("id"): i.get("href", "")
                        for i in (opf.find("o:manifest", _NS) or []).findall("o:item", _NS)}
            refs = [ir.get("idref") for ir in (opf.find("o:spine", _NS) or []).findall("o:itemref", _NS)]
            hrefs = [posixpath.normpath(posixpath.join(base, manifest[r]))
                     for r in refs if r in manifest]
            if len(hrefs) != 1:
                return len(hrefs)
            raw = z.read(hrefs[0]).decode("utf-8", "replace")
            return len(re.findall(r"<h2[^>]*id=[\"']c\d+[\"']", raw, flags=re.I)) or 1
    except Exception:  # noqa: BLE001
        return 0


def pdf_page_count(path: str) -> int:
    """漫画 PDF 页数:pypdf 只解析页树,百兆级也是毫秒级(与网页端同一读法)。"""
    try:
        from pypdf import PdfReader
        with open(path, "rb") as f:
            return len(PdfReader(f).pages)
    except Exception:  # noqa: BLE001
        return 0


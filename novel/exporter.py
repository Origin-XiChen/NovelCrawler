# -*- coding: utf-8 -*-
"""
EPUB 导出器
============
使用标准库 zipfile 生成 EPUB 文件,零第三方依赖。
结构:每章一个 XHTML 文件(spine 多项,阅读器/其他 App 均能正确分章) + EPUB2 版 NCX 目录。

用法:
    write_epub(book_title, source_name, chapters, out_path)
    chapters: [{title, text}, ...] 按阅读顺序
"""
from __future__ import annotations

from datetime import datetime, timezone

import html
import os
import zipfile
from hashlib import md5


def _esc(s: str) -> str:
    return html.escape(s or "", quote=True)


def _img_media_type(data: bytes) -> str:
    """按文件头探测图片 MIME(默认 jpeg,兼容 png/gif/webp/bmp)。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:2] == b"BM":
        return "image/bmp"
    return "image/jpeg"


def _xhtml(title: str, body: str) -> str:
    """单章 XHTML 文档(带 epub 命名空间,图片/音视频可后续扩展)。"""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>{title}</title></head>
<body>
{body}
</body>
</html>
"""


def write_epub(
    book_title: str,
    source_name: str,
    chapters: list[dict],
    out_path: str,
    images: dict[str, bytes] | None = None,
) -> str:
    """生成 EPUB 文件到 out_path,返回路径。chapters: [{title, text, images?}]。

    每章生成独立 chapN.xhtml(spine 多项)——阅读器按 spine 正确分章,
    外部阅读 App(掌阅/微信读书/Calibre)也能正常识别章节。
    images: {文件名: 字节} 额外嵌入的图片(如封面/彩插),章节内用
            ch.get("images") = [文件名...] 引用,会渲染成 <img>。
    """
    uid = md5((book_title or "novel").encode("utf-8")).hexdigest()[:16]
    safe_title = _esc(book_title or "小说")

    # ---------- 每章一个 XHTML(spine 多项) ----------
    chap_files: list[tuple[str, str]] = []   # (fname, content)
    nav_points: list[str] = []
    manifest_items: list[str] = []
    spine_items: list[str] = []
    img_manifest: list[str] = []
    for i, ch in enumerate(chapters, 1):
        fname = f"chap{i}.xhtml"
        title = _esc(ch["title"] or f"第{i}章")
        paras = "".join(
            f"<p>{_esc(p)}</p>"
            for p in (ch.get("text") or "").split("\n")
            if p.strip()
        ) or "<p></p>"
        # 章节内嵌图片(彩插等)
        imgs_html = ""
        for img_name in ch.get("images") or []:
            imgs_html += f'<p><img src="images/{_esc(img_name)}" alt="" style="max-width:100%; display:block; margin:8px auto"/></p>'
        chap_files.append((fname, _xhtml(title, f"<h2>{title}</h2>{imgs_html}{paras}")))
        nav_points.append(
            f'<navPoint id="c{i}" playOrder="{i}">'
            f'<navLabel><text>{title}</text></navLabel>'
            f'<content src="{fname}"/>'
            f"</navPoint>"
        )
        manifest_items.append(
            f'<item id="c{i}" href="{fname}" media-type="application/xhtml+xml"/>'
        )
        spine_items.append(f'<itemref idref="c{i}"/>')
        for img_name in ch.get("images") or []:
            img_manifest.append(
                f'<item id="img_{i}_{_esc(img_name)}" href="images/{_esc(img_name)}" '
                f'media-type="{_img_media_type((images or {}).get(img_name) or b"")}"/>'
            )

    # ---------- 容器 / OPF / NCX ----------
    container_xml = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

    content_opf = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:{uid}</dc:identifier>
    <dc:title>{safe_title}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>网络小说</dc:creator>
    <dc:source>{_esc(source_name)}</dc:source>
    <meta property="dcterms:modified">{datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}</meta>
  </metadata>
  <manifest>
{chr(10).join('    ' + it for it in manifest_items)}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
{chr(10).join('    ' + it for it in img_manifest)}
  </manifest>
  <spine toc="ncx">
{chr(10).join('    ' + it for it in spine_items)}
  </spine>
</package>
"""

    toc_ncx = f"""<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:{uid}"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>{safe_title}</text></docTitle>
  <docAuthor><text>网络小说</text></docAuthor>
  <navMap>
{chr(10).join(nav_points)}
  </navMap>
</ncx>
"""

    # ---------- 打包 ----------
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with zipfile.ZipFile(out_path, "w") as zf:
        # mimetype 必须第一个写入且不压缩
        zi = zipfile.ZipInfo("mimetype")
        zi.compress_type = zipfile.ZIP_STORED
        zf.writestr(zi, "application/epub+zip")
        zf.writestr("META-INF/container.xml", container_xml)
        zf.writestr("OEBPS/content.opf", content_opf)
        zf.writestr("OEBPS/toc.ncx", toc_ncx)
        for fname, content in chap_files:
            zf.writestr("OEBPS/" + fname, content)
        for img_name, img_bytes in (images or {}).items():
            zf.writestr("OEBPS/images/" + img_name, img_bytes)
    return out_path

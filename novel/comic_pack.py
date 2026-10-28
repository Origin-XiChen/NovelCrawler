# -*- coding: utf-8 -*-
"""漫画离线包页图来源。

为什么需要这一层:
    comic.py 在融合/打包后会 `rmtree(.raw)` 删掉图片缓存,磁盘上只剩 PDF。
    所以"直接拷 img*.jpg"这条路在真实环境下几乎总是空的,必须能从 PDF 反抽页图。

两种来源,按优先级:
    1. `<book_dir>/.raw/<话>/img*.jpg` —— 缓存还在时最快,零解码;
    2. PDF 内嵌图 —— 用 pypdf 逐页取最大那张;img2pdf 生成的 PDF 一页就是一图,
       抽出来就是原始 JPEG 字节,不重新编码。

对外只暴露 `pack_into_zip()`,App 端只认 `pages/NNNN.jpg` 这一种布局。
"""
from __future__ import annotations

import json
import os

from .paths import COMIC_OUT_DIR


def book_dir_of(title: str) -> str:
    return os.path.join(COMIC_OUT_DIR, title)


def read_meta(book_dir: str) -> dict:
    path = os.path.join(book_dir, "meta.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def chapter_plan(book_dir: str) -> list[dict]:
    """按话序返回 [{label, pdf, pages}]。

    meta.json 里 chapters 已按用户选择的顺序排好;merged 模式下所有话共用
    同一个 PDF,靠 pages 累加切页。
    """
    meta = read_meta(book_dir)
    raw_chapters = meta.get("chapters") or []
    plan: list[dict] = []
    for item in raw_chapters:
        if not isinstance(item, dict):
            continue
        label = (item.get("label") or item.get("title") or "").strip() or f"第{len(plan) + 1}话"
        plan.append({
            "label": label,
            "pdf": (item.get("pdf") or "").strip(),
            "pages": int(item.get("pages") or 0),
        })
    # 没有 meta.json(老目录):退化成"目录里的 PDF 按名字排序,每本一话"
    if not plan:
        try:
            names = sorted(n for n in os.listdir(book_dir) if n.lower().endswith(".pdf"))
        except OSError:
            names = []
        plan = [{"label": os.path.splitext(n)[0], "pdf": n, "pages": 0} for n in names]
    return plan


def _raw_pages(book_dir: str, label: str) -> list[str]:
    """原始缓存里的页图(没有就返回空)。"""
    cache = os.path.join(book_dir, ".raw")
    if not os.path.isdir(cache):
        return []
    for entry in (label, _safe(label)):
        d = os.path.join(cache, entry)
        if not os.path.isdir(d):
            continue
        imgs = sorted(n for n in os.listdir(d)
                      if n.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
        return [os.path.join(d, n) for n in imgs]
    return []


def _safe(name: str) -> str:
    from .comic import safe_filename as _sf  # 复用同一套文件名规则
    return _sf(name)


def _pdf_pages(pdf_path: str):
    """逐页产出 (页码, 图片字节)。取该页最大的一张图。"""
    from pypdf import PdfReader
    reader = PdfReader(pdf_path)
    for index, page in enumerate(reader.pages):
        try:
            images = list(page.images)
        except Exception:  # noqa: BLE001
            images = []
        if not images:
            continue
        best = max(images, key=lambda im: len(getattr(im, "data", b"") or b""))
        data = getattr(best, "data", b"") or b""
        if data:
            yield index, data


def iter_pages(book_dir: str, plan: list[dict] | None = None):
    """逐页产出 (话序号, 话标题, 页内序号, 字节)。"""
    plan = plan if plan is not None else chapter_plan(book_dir)
    pdf_cache: dict[str, object] = {}
    for ci, chapter in enumerate(plan):
        label = chapter["label"]
        raw = _raw_pages(book_dir, label)
        if raw:
            for pi, path in enumerate(raw, 1):
                try:
                    with open(path, "rb") as f:
                        yield ci, label, pi, f.read()
                except OSError:
                    continue
            continue
        pdf_name = chapter["pdf"]
        if not pdf_name:
            continue
        pdf_path = os.path.join(book_dir, pdf_name)
        if not os.path.isfile(pdf_path):
            continue
        try:
            if pdf_name not in pdf_cache:
                pdf_cache[pdf_name] = list(_pdf_pages(pdf_path))
            pages = pdf_cache[pdf_name]  # type: ignore[assignment]
        except Exception:  # noqa: BLE001
            continue
        # per_chapter:一本 PDF 只有这一话;merged:一本书里按 pages 切片
        start = 0
        taken = chapter["pages"] or len(pages)  # type: ignore[arg-type]
        for offset, (_idx, data) in enumerate(pages[start:start + taken], 1):  # type: ignore[index]
            yield ci, label, offset, data
        continue


def pack_into_zip(zf, title: str, arc_dir: str, on_bytes=None) -> dict:
    """把一本漫画的页图写进 zip,返回 {pages, chapters}。

    chapters 里带每话的页范围,供 App 画目录/按话跳转。
    """
    book_dir = book_dir_of(title)
    plan = chapter_plan(book_dir)
    total = 0
    chapters: list[dict] = []
    current = None
    for ci, label, pi, data in iter_pages(book_dir, plan):
        total += 1
        if current is None or current["label"] != label:
            current = {"label": label, "from": total, "pages": 0}
            chapters.append(current)
        current["pages"] += 1
        try:
            # 页图本身是 JPEG,再 DEFLATE 只费 CPU 不省体积
            import zipfile as _zipf
            zf.writestr(f"{arc_dir}/pages/{total:04d}.jpg", data,
                        compress_type=_zipf.ZIP_STORED)
        except Exception:  # noqa: BLE001
            continue
        if on_bytes:
            on_bytes(len(data))
    return {"pages": total, "chapters": chapters}

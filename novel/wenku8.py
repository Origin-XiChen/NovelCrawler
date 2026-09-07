# -*- coding: utf-8 -*-
"""
wenku8 本地直抓
==============
绕过 opds.wol.moe 慢速服务端生成,直接从 wenku8 主站抓取目录+正文,
本地生成 EPUB。进度真实(第 N/330 章),单章 ~258ms,330 章约 1-2 分钟。
"""
from __future__ import annotations

import json
import logging
import os
import re
import time

import requests

logger = logging.getLogger("novel.wenku8")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.wenku8.net/",
}
MAIN_SITE = "https://www.wenku8.net"
# opds.wol.moe 的 EPUB 直链 → 书 ID: /zh_CN/epub/1787.epub → 1787
_EPUB_ID_RE = re.compile(r"/epub/(\d+)\.epub")
# 章节链接:绝对(/novel/1/1787/61148.htm)或相对(61148.htm)
_CHAPTER_LINK_RE = re.compile(r'href="([^"]*?(?:\d{4,}|/\d+/)\.htm)"[^>]*>([^<]{2,60})<', re.I)
# 完整正文目录链接(从书籍页解析): /novel/1/1787/index.htm
_TOC_LINK_RE = re.compile(r'href="(/novel/\d+/\d+/index\.htm)"')
# 正文容器
_CONTENT_RE = re.compile(r'<div\s+id="content"[^>]*>([\s\S]*?)</div>')
# 页脚噪声(本文来自轻小说文库等)
_FOOTER_NOISE = ("本文来自", "轻小说文库", "http://www.wenku8.com", "www.wenku8.com",
                 "扫图", "录入", "修图", "校对", "转载", "轻之国度")
# 正文头部噪声(书页信息栏)
_HEADER_NOISE = ("推一下!", "举报/报错", "文库分类", "小说作者", "文章状态", "最后更新",
                 "全文长度", "加入文库", "Telegram", "查看全部吐槽")


class Wenku8Error(Exception):
    """wenku8 主站抓取失败。"""


def extract_book_id(epub_url: str) -> str | None:
    """从 opds EPUB 直链提取书 ID。/zh_CN/epub/1787.epub → '1787'"""
    m = _EPUB_ID_RE.search(epub_url)
    return m.group(1) if m else None


def _fetch(url: str, timeout: int = 30, retries: int = 3) -> str:
    """抓取页面;网络错误/5xx 指数退避重试,最后失败抛异常。"""
    last: Exception | None = None
    for i in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            if r.status_code >= 500:
                last = RuntimeError(f"HTTP {r.status_code}: {url}")
                if i < retries - 1:
                    time.sleep(1.5 * (i + 1))
                continue
            r.raise_for_status()
            r.encoding = "gbk"
            return r.text
        except requests.RequestException as exc:
            last = exc
            if i < retries - 1:
                time.sleep(1.5 * (i + 1))
    raise last or RuntimeError(f"请求失败: {url}")


def find_toc_url(book_id: str) -> str:
    """通过书籍页 /book/{id}.htm 解析完整目录页 URL。
    返回如 https://www.wenku8.net/novel/1/1787/index.htm
    """
    html = _fetch(f"{MAIN_SITE}/book/{book_id}.htm")
    m = _TOC_LINK_RE.search(html)
    if m:
        return MAIN_SITE + m.group(1)
    # 兜底:标准路径
    return f"{MAIN_SITE}/novel/1/{book_id}/index.htm"


def fetch_toc(book_id: str) -> list[dict]:
    """拉取完整章节列表 [{title, url}, ...](阅读顺序)。"""
    toc_url = find_toc_url(book_id)
    html = _fetch(toc_url)
    links = _CHAPTER_LINK_RE.findall(html)
    if not links:
        raise Wenku8Error(f"目录页未解析到章节链接: {toc_url}")
    base = toc_url.rsplit("/", 1)[0]  # https://www.wenku8.net/novel/1/1787
    chapters = []
    seen: set[str] = set()
    for href, title in links:
        title = title.strip()
        if not title:
            continue
        url = href if href.startswith("http") else (href if href.startswith("/") else base + "/" + href)
        if not url.startswith("http"):
            url = MAIN_SITE + url
        # 跳过书页链接(不是章节): /book/{id}.htm 或标题含"推一下/举报"
        if "/book/" in url or any(n in title for n in ("推一下", "举报")):
            continue
        if url in seen:
            continue
        seen.add(url)
        chapters.append({"title": title, "url": url})
    return chapters


def fetch_chapter_text(url: str, allow_empty: bool = False) -> str:
    """抓取单章正文,清洗页脚噪声。失败抛异常。

    allow_empty: 插图等纯图章节正文去标签后可为空(0 字),此时不抛
    "正文过短"异常而返回空串——否则插图章节会被当作失败整章跳过,
    导致图片抓取逻辑永远执行不到(插图全部丢失)。

    短正文:连续 3 次抓取结果一致(<20 字)视为真实短章节接受;
    结果不稳定则抛异常(防反爬空壳页混入)。
    """
    texts: list[str] = []
    for i in range(3):
        html = _fetch(url)
        m = _CONTENT_RE.search(html)
        if not m:
            if i < 2:
                time.sleep(1.5 * (i + 1))
                continue
            raise Wenku8Error(f"正文容器未找到: {url}")
        body = re.sub(r"<[^>]+>", "", m.group(1))
        body = body.replace("\u3000", " ").replace("&nbsp;", " ").replace("&amp;", "&")
        lines = []
        for ln in body.splitlines():
            s = ln.strip()
            if not s:
                continue
            if any(noise in s for noise in _HEADER_NOISE):
                continue  # 头部信息栏
            if _FOOTER_NOISE and any(noise in s for noise in _FOOTER_NOISE) and len(s) < 60:
                continue  # 页脚噪声行
            lines.append(s)
        text = "\n".join(lines).strip()
        if len(text) >= 20 or allow_empty:
            return text
        texts.append(text)
        if i < 2:
            time.sleep(1.5 * (i + 1))
    if texts and all(t == texts[0] for t in texts):
        return texts[0]  # 3 次相同:真实短章节
    raise Wenku8Error(f"正文过短({len(texts[0]) if texts else 0} 字)且不稳定: {url}")


# 插图 <img> 的 src:兼容双引号/单引号/无引号
_IMG_SRC_RE = re.compile(r"<img[^>]*\bsrc\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))", re.I)


def fetch_chapter_images(url: str) -> list[str]:
    """抓取章节页内嵌插图 URL(彩插页:标题为"插图"的章节,每卷 4~23 张)。"""
    html = _fetch(url)
    imgs: list[str] = []
    for m in _IMG_SRC_RE.finditer(html):
        src = (m.group(1) or m.group(2) or m.group(3) or "").strip()
        if not src or src.startswith("data:"):
            continue
        # 协议相对 URL(//pic.xxx.com/...) → 补 https
        if src.startswith("//"):
            src = "https:" + src
        # 图片扩展名判定:容忍 query/fragment(如 .jpg?v=123)
        if not re.search(r"\.(jpe?g|png|gif|webp)(?:[?#]|$)", src, re.I):
            continue
        # 只要外链 CDN 图(http 开头,含补全后的协议相对 URL)
        if not src.startswith("http"):
            continue
        if src not in imgs:
            imgs.append(src)
    return imgs


def _download_image(url: str, timeout: int = 30, retries: int = 2) -> bytes:
    """下载图片;失败重试 retries 次,仍失败则抛出最后一次异常。"""
    last: Exception | None = None
    for i in range(retries + 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=timeout)
            r.raise_for_status()
            return r.content
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i < retries:
                time.sleep(1 + i)
    raise last  # type: ignore[misc]


def download_local_epub(
    book_id: str,
    title: str,
    out_dir: str,
    *,
    on_log=None,
    on_progress=None,
    cancel_check=None,
    delay: float = 0.1,
    with_images: bool = True,
    workers: int = 4,
    img_workers: int = 4,
) -> str:
    """本地直抓整本书 → 生成 EPUB,返回输出路径。

    on_progress(idx, total, chap_title): 每章完成回调(idx=已完成章数,单调递增)。
    cancel_check(): 每章前检查,返回 True/抛异常则取消(DownloadCancelled)。
    with_images: 抓取"插图"章节的彩插并嵌入 EPUB(会增加体积与耗时)。
    workers: 正文章节并发抓取线程数(默认 4;串行传 1)。
    img_workers: 单插图章内图片并发下载线程数(默认 4)。

    并发策略:滑动窗口按章节顺序提交,始终先收集最小的未完成章节,
    保证 collected 顺序与目录一致;图片 CDN 对单连接限速,并发下载显著提速。
    """
    from concurrent.futures import ThreadPoolExecutor

    from .exporter import write_epub
    from .downloader import safe_filename

    def _log(msg: str) -> None:
        if on_log:
            on_log(msg)

    _log("▶ 本地直抓:解析 wenku8 目录…")
    if cancel_check:
        cancel_check()
    chapters = fetch_toc(book_id)
    if not chapters:
        raise Wenku8Error(f"未能解析到任何章节(书 ID {book_id})")
    total = len(chapters)
    workers = max(1, int(workers))
    _log(f"  共 {total} 章,开始抓取(并发 {workers})…")

    # ---- 断点续传:恢复已收集章节(正文缓存于 partial,插图章重跑时重抓图片) ----
    partial_path = os.path.join(
        out_dir, f"{safe_filename(title or 'novel')}[wenku8本地].partial.json")
    collected: list[dict] = []
    if os.path.isfile(partial_path):
        try:
            with open(partial_path, "r", encoding="utf-8") as f:
                _d = json.load(f)
            if isinstance(_d, dict) and isinstance(_d.get("chapters"), list):
                collected = [c for c in _d["chapters"] if isinstance(c, dict)]
        except Exception:  # noqa: BLE001
            collected = []
    # 已完成正文的章节集合;插图章不进集合,重跑时重新抓图
    done_idx = {
        c["idx"] for c in collected
        if isinstance(c.get("idx"), int) and 1 <= c["idx"] <= total
        and "插图" not in chapters[c["idx"] - 1]["title"]
    }
    if done_idx:
        _log(f"  ↻ 断点续传:跳过 {len(done_idx)} 章正文(插图章将重抓图片)")

    def _save_partial() -> None:
        try:
            with open(partial_path, "w", encoding="utf-8") as f:
                json.dump({"chapters": collected}, f, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            pass

    failed: list[int] = []
    image_store: dict[str, bytes] = {}  # 文件名 -> 字节

    def _fetch_one(idx: int, ch: dict):
        """抓单章正文+插图,返回 (entry|None, img_fail_count|None, err_str|None)。"""
        if cancel_check:
            cancel_check()
        # 插图章节:正文可为空(纯图页),"正文过短"不再判失败,
        # 否则整章被跳过,后续抓图逻辑永远执行不到(插图全部丢失)
        is_ill = bool(with_images and "插图" in ch["title"])
        try:
            text = fetch_chapter_text(ch["url"], allow_empty=is_ill)
        except Exception as exc:  # noqa: BLE001
            return None, None, f"{type(exc).__name__}"
        # 标题:自带"第N章"则直接用,否则补
        ch_title = ch["title"]
        if not re.match(r"^第\s*(\d+|[一二三四五六七八九十百千零两]+)\s*章", ch_title):
            ch_title = f"第{idx}章 {ch_title}"
        entry: dict = {"idx": idx, "title": ch_title, "text": text}
        if not is_ill:
            return entry, None, None
        # 插图章节:抓取彩插嵌入(章内图片并发下载)
        img_fail = 0
        try:
            img_urls = fetch_chapter_images(ch["url"])
        except Exception:  # noqa: BLE001
            return entry, -1, None  # 插图页解析失败(不算章节失败)
        if not img_urls:
            return entry, 0, None

        def _dl(iu: str) -> bytes | None:
            try:
                data = _download_image(iu)
                return data if len(data) > 5000 else None  # 跳过过小(可能防盗链图)
            except Exception as exc:  # noqa: BLE001
                logger.warning("插图下载失败 %s: %s", iu[:80], exc)
                return None

        if len(img_urls) > 1 and img_workers > 1:
            with ThreadPoolExecutor(max_workers=min(int(img_workers), len(img_urls))) as ip:
                datas = list(ip.map(_dl, img_urls))
        else:
            datas = [_dl(u) for u in img_urls]
        imgs = []
        for j, d in enumerate(datas, start=1):
            if d:
                fname = f"img{idx:04d}_{j:03d}.jpg"  # 章号+章内序号,天然唯一且保序
                image_store[fname] = d
                imgs.append(fname)
            else:
                img_fail += 1
        if imgs:
            entry["images"] = imgs
        return entry, img_fail, None

    done_cnt = len(done_idx)

    def _run_window() -> None:
        """滑动窗口并发抓取:始终先取最小 idx,保证 collected 顺序。"""
        nonlocal done_cnt
        with ThreadPoolExecutor(max_workers=workers) as pool:
            it = iter(i for i in range(1, total + 1) if i not in done_idx)
            window: dict = {}
            for _ in range(workers):  # 填满窗口
                try:
                    idx = next(it)
                except StopIteration:
                    break
                window[pool.submit(_fetch_one, idx, chapters[idx - 1])] = idx
            while window:
                if cancel_check:
                    cancel_check()
                fut = min(window, key=lambda f: window[f])  # 始终先取最小 idx,保证顺序
                idx = window.pop(fut)
                entry, img_fail, err = fut.result()
                ch = chapters[idx - 1]
                done_cnt += 1
                if err:
                    failed.append(idx)
                    _log(f"  ✗ 第 {idx} 章失败: {ch['title'][:20]}({err})")
                    if on_progress:
                        on_progress(done_cnt, total, ch["title"], err=True)
                else:
                    # 续传重抓(插图章)替换原条目;补抓失败章按 idx 升序插入,保证顺序
                    pos = next((k for k, e in enumerate(collected) if e.get("idx") == idx), None)
                    if pos is not None:
                        collected[pos] = entry
                    else:
                        ins = 0
                        while ins < len(collected) and int(collected[ins].get("idx", 0) or 0) < idx:
                            ins += 1
                        collected.insert(ins, entry)
                    if entry.get("images"):
                        _log(f"  🖼 第 {idx} 章插图 {len(entry['images'])} 张")
                    elif img_fail:
                        _log(f"  ⚠️ 第 {idx} 章插图 {img_fail} 张抓取失败")
                    _log(f"  ✓ {idx}/{total} {ch['title'][:24]}")
                    if on_progress:
                        on_progress(done_cnt, total, ch["title"])
                if len(collected) % 10 == 0:
                    _save_partial()  # 每 10 章落盘,中断可续传
                # 补充窗口
                try:
                    nidx = next(it)
                    window[pool.submit(_fetch_one, nidx, chapters[nidx - 1])] = nidx
                except StopIteration:
                    pass
                if delay > 0:
                    time.sleep(delay)  # 防封禁限速

    try:
        _run_window()
        _save_partial()  # 有失败章时正常结束也落盘,重跑无需重抓末尾几章
    except BaseException:  # noqa: BLE001
        _save_partial()  # 取消/异常前落盘,保证断点续传可用
        raise

    if not collected:
        raise Wenku8Error("全部章节抓取失败,无法生成 EPUB")

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{safe_filename(title or 'novel')}[wenku8本地].epub")
    write_epub(title or "小说", "wenku8本地直抓", collected, out_path,
               images=image_store or None)
    _log(f"✓ 本地直抓完成: {len(collected)}/{total} 章"
         + (f", 插图 {len(image_store)} 张" if image_store else "")
         + f" → {os.path.basename(out_path)}"
         + (f"(失败 {len(failed)} 章: {failed[:10]}{'...' if len(failed) > 10 else ''})" if failed else ""))
    if not failed:
        try:
            os.remove(partial_path)  # 全部成功:清理进度文件
        except OSError:
            pass
    return out_path

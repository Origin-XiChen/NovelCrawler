# -*- coding: utf-8 -*-
"""
下载器
======
  * 从书籍详情页/目录页拉取完整章节列表(自动处理倒序、去重)
  * 逐章抓取正文(带限速与重试)
  * 导出为 TXT(UTF-8),支持断点续传与章节范围
"""
from __future__ import annotations

import logging
import json
import os
import re
import time

from .config import load_sources, match_source
from .fetcher import Fetcher
from .parser import parse_content, parse_toc
from .searcher import Book

logger = logging.getLogger("novel.downloader")

_ILLEGAL = re.compile(r'[\\/:*?"<>|\r\n\t]+')
_CHAPTER_MARK = re.compile(r"^【章节】第(\d+|[一二三四五六七八九十百千零两]+)章$")  # 断点续传统计
_BOOK_ID_RE = re.compile(r"/book/(\d+)/")
_CHAPTER_ID_RE = re.compile(r"/chapter/(\d+)/")
_NEXT_PAGE_RE = re.compile(r"/book/\d+/ls\d+\.html")
_NEXT_PAGE_TEXT = ("下一页", "下页", ">", "»")


def safe_filename(name: str) -> str:
    return _ILLEGAL.sub("_", name).strip(" .") or "novel"


def _find_source(book: Book):
    for s in load_sources():
        if s["name"] == book.source:
            return s
    s = match_source(book.url)
    if s:
        return s
    # 通用源兜底:未收录的站点,只要 URL 形如 /book/{id}/ 或 /book/{id}/{n}.html 就尝试
    if _BOOK_ID_RE.search(book.url):
        from urllib.parse import urlparse
        p = urlparse(book.url)
        return {
            "name": book.source or "通用源",
            "base": f"{p.scheme}://{p.netloc}",
            "charset": "",  # 留空:优先用服务器声明的编码
            "chapter_href_pattern": r"/book/\d+/\d+\.html",
            "verify_ssl": False,  # 未知站点证书可能有问题,容忍
            "toc_reverse": False,
        }
    return None


def _api_id_from_url(url: str, pattern: str | None = None) -> str:
    """从书籍 URL 提取 API id:优先 api 规则的正则,缺省取 URL 末段数字。"""
    if pattern:
        m = re.search(pattern, url)
        if m:
            return m.group(1) or m.group(0)
    m = re.search(r"(\d+)(?!.*\d)", url.split("?")[0])
    return m.group(1) if m else ""


def _fetch_toc_api(book: Book, source: dict, fetcher: Fetcher) -> list[dict]:
    """API 模式书源:请求 JSON 接口提取章节列表(章节 url 直接为正文请求链接)。"""
    from .jsonpath import extract, render_template

    toc = source["api_rules"]["toc"]
    charset = source.get("charset", "utf-8")
    headers = source.get("headers") or {}
    base = source["base"].rstrip("/")
    bid = _api_id_from_url(book.url, toc.get("id_from_url"))
    url = render_template(toc["url"], {"id": bid})
    html = fetcher.fetch(url, source=source["name"], encoding=charset,
                         headers=headers, verify=source.get("verify_ssl", True))
    data = json.loads(html)
    items = extract(data, toc.get("list", "$")) or []
    if isinstance(items, dict):
        items = [items]
    content_cfg = (source.get("api_rules") or {}).get("content") or {}
    chs: list[dict] = []
    for it in items:
        name = str(extract(it, toc["name"]) if toc.get("name") else it or "").strip()
        cid = extract(it, toc.get("id", "")) if toc.get("id") else None
        cu = render_template(toc.get("chapter_url", ""), {"node": it, "id": bid, "cid": cid})
        if not cu and content_cfg.get("url"):
            cu = render_template(content_cfg["url"], {"node": it, "id": bid, "cid": cid})
        if cu and not cu.startswith("http"):
            cu = base + cu
        chs.append({"title": name or f"第{len(chs) + 1}章", "url": cu})
    return chs


def _resolve_toc_url(book: Book, source: dict) -> str:
    """
    定位目录页 URL。优先级:
      1. 书源规则的 toc.url_template(含 {bid} 占位符时自动替换)
      2. 按站点模板类型推断:
         * /chapter/{bid}/{cid}.html 型站点 → 完整目录通常在 /newbook/{bid}/
         * /book/{bid}/{n}.html    型站点 → 详情页 /book/{bid}/ 即完整目录
    """
    url = book.url
    base = source["base"].rstrip("/")
    pattern = source.get("chapter_href_pattern", "")

    # 书源规则指定目录模板
    tmpl = source.get("toc_url_template", "")
    if tmpl:
        bid = None
        m = _BOOK_ID_RE.search(url)
        if m:
            bid = m.group(1)
        m = _CHAPTER_ID_RE.search(url)
        if m:
            bid = m.group(1)
        if bid:
            return tmpl.replace("{bid}", bid) if tmpl.startswith("http") else base + tmpl.replace("{bid}", bid)

    m = _CHAPTER_ID_RE.search(url)
    if m:  # 章节页 → 回详情页
        return f"{base}/book/{m.group(1)}/"

    m = _BOOK_ID_RE.search(url)
    if m:
        bid = m.group(1)
        if "/chapter/" in pattern:
            return f"{base}/newbook/{bid}/"
        return f"{base}/book/{bid}/"
    return url


def fetch_toc(book: Book, fetcher: Fetcher) -> list[dict]:
    """
    拉取章节列表,返回阅读顺序的 [{title, url}, ...]。

    策略:依次尝试多个候选目录页(配置模板 / 详情页本身),
    取章节数最多的结果,再按"第1章"位置启发式校正顺序。
    """
    source = _find_source(book)
    if source is None:
        raise RuntimeError(f"找不到书源: {book.source or book.url}")

    api = source.get("api_rules") or {}
    if api.get("toc"):
        return _fetch_toc_api(book, source, fetcher)

    charset = source.get("charset", "utf-8")

    candidates: list[str] = []
    # 候选1:详情页/用户给的页面本身(很多站点详情页即完整目录)
    candidates.append(book.url)
    # 候选2:解析出的专用目录页(_resolve_toc_url 会针对 /book/{id}/ 推导 newbook 等)
    toc_url = _resolve_toc_url(book, source)
    if toc_url not in candidates:
        candidates.append(toc_url)

    best: list[dict] = []
    for url in candidates:
        try:
            chs = _fetch_toc_page_chain(url, source, charset, fetcher)
            if len(chs) > len(best):
                best = chs
        except Exception:  # noqa: BLE001 单个候选失败不影响其他
            continue

    if not best:
        raise RuntimeError("未能解析到任何章节,请检查 URL 是否为小说详情页/目录页")

    # 启发式判断目录顺序:首章为"第1章/第一章/序章" → 已正序;末章为"第1章" → 需反转
    def _strip_quotes(s: str) -> str:
        return re.sub(r'^[\s“”"\'《》【】〈〉]+|[\s“”"\'《》【】〈〉]+$', "", s)

    first = _strip_quotes(best[0]["title"]) if best else ""
    last = _strip_quotes(best[-1]["title"]) if best else ""
    starts_at_1 = bool(re.match(r"^第\s*(1|[一二三四五六七八九十百千零两]+)\s*章", first) or "序章" in first)
    ends_at_1 = bool(re.match(r"^第\s*(1|[一二三四五六七八九十百千零两]+)\s*章", last) or "序章" in last)
    if ends_at_1 and not starts_at_1:
        best.reverse()
    elif not starts_at_1 and not ends_at_1 and source.get("toc_reverse"):
        best.reverse()
    return best


def _fetch_toc_page_chain(
    start_url: str, source: dict, charset: str, fetcher: Fetcher
) -> list[dict]:
    """
    抓取目录页,并沿"下一页"链接(ls{n}.html)自动翻页拼接完整目录。
    """
    from bs4 import BeautifulSoup

    base = source["base"].rstrip("/")
    pattern = source.get("chapter_href_pattern")
    container_words = source.get("toc_container")
    collected: list[dict] = []
    seen_url: set[str] = set()
    current = start_url
    guard = 0

    while current and guard < 60:
        guard += 1
        if source.get("render"):
            from .browser import render_html
            html = render_html(current, headers=source.get("headers") or {}, wait_ms=1500, scroll=True)
        else:
            html = fetcher.fetch(current, source=source["name"], encoding=charset, verify=source.get("verify_ssl", True))
        chs = parse_toc(html, base_url=base, chapter_href_pattern=pattern,
                        container_words=container_words)

        # 追加未见过的新章节
        new = 0
        for ch in chs:
            if ch["url"] in seen_url:
                continue
            seen_url.add(ch["url"])
            collected.append(ch)
            new += 1
        if new == 0 and guard > 1:
            break

        # 找"下一页"链接
        soup = BeautifulSoup(html, "lxml")
        next_url = None
        for a in soup.find_all("a", href=True):
            text = a.get_text(strip=True)
            href = a["href"].strip()
            if any(t in text for t in _NEXT_PAGE_TEXT) and _NEXT_PAGE_RE.search(href):
                next_url = href if href.startswith("http") else base + href
                break
        if next_url is None or next_url == current:
            break
        current = next_url
    return collected


def _done_idx_set(out_path: str) -> set[int]:
    """解析已写入章节的序号集合(断点续传按精确序号跳过)。

    旧实现按文件内标记行数推断完成集合,任一章节失败(跳过)后,
    后续章节全部错位 → 续传时正确的章节被误跳、失败章节永久漏章。
    """
    if not os.path.exists(out_path):
        return set()
    done: set[int] = set()
    try:
        with open(out_path, "r", encoding="utf-8") as f:
            for line in f:
                m = _CHAPTER_MARK.match(line)
                if m and m.group(1).isdigit():
                    done.add(int(m.group(1)))
    except OSError:
        return set()
    return done


def _count_done(out_path: str) -> int:
    """统计已写入的章节数(仅用于日志展示)。"""
    return len(_done_idx_set(out_path))


class DownloadCancelled(Exception):
    """下载被用户取消/暂停。"""


def download_book(
    book: Book,
    *,
    out_dir: str = "downloads",
    start: int = 1,
    end: int | None = None,
    delay: float = 1.2,
    fetcher: Fetcher | None = None,
    quiet: bool = False,
    format: str = "txt",
    workers: int = 1,
    on_log=None,
    on_progress=None,
    cancel_check=None,
) -> str:
    """下载整本书,返回输出文件路径。start/end 为 1-based 章节范围。

    format: "txt"(默认,支持断点续传) 或 "epub"(电子书,整本生成)。
    workers: 并发抓取线程数(默认1=串行;2~5 可提速,注意加大封禁风险)。
    on_log:       callable(msg) 收到日志行(GUI 展示用)
    on_progress:  callable(idx, total, title, err) 每章完成时回调
    cancel_check: callable() -> bool|None;返回 True 表示取消(抛 DownloadCancelled),
                  抛 DownloadCancelled 异常也可;用于支持"停止/暂停"。
    """
    fetcher = fetcher or Fetcher()
    source = _find_source(book)
    if source is None:
        raise RuntimeError(f"找不到书源: {book.source or book.url}")

    # 默认/旧值 "downloads" 归一化为实际小说目录(downloads/novel 或用户自定义),
    # 避免前端提交默认值后文件落进旧的 downloads/ 根目录导致书架识别不到
    if not out_dir or out_dir == "downloads":
        from novel.config import get_out_dir
        out_dir = get_out_dir()

    def _log(msg: str) -> None:
        if on_log:
            on_log(msg)
        elif not quiet:
            print(msg)

    def _check() -> None:
        if cancel_check:
            cancel_check()

    charset = source.get("charset", "utf-8")
    os.makedirs(out_dir, exist_ok=True)

    _log(f"▶ 拉取《{book.title or book.url}》目录 ...")
    _check()
    chapters = fetch_toc(book, fetcher)
    if not chapters:
        raise RuntimeError("未能解析到任何章节,请检查 URL 是否为小说详情页/目录页")

    total = len(chapters)
    end = min(end or total, total)
    start = max(1, start)
    workers = max(1, int(workers))
    _log(f"  共 {total} 章,本次下载 {start}~{end} 章" +
         (f"(并发 {workers})" if workers > 1 else ""))

    if format.lower() == "epub":
        return _download_epub(
            book, source, chapters, start, end, charset, fetcher,
            delay, out_dir, _log, on_progress, workers, _check,
        )
    return _download_txt(
        book, source, chapters, start, end, charset, fetcher,
        delay, out_dir, _log, on_progress, workers, _check,
    )


def _download_epub(book, source, chapters, start, end, charset, fetcher,
                   delay, out_dir, log, on_progress, workers=1, check=None) -> str:
    """EPUB 导出:并发抓取章节后整本打包。

    断点续传:已下载章节保存到 `<书名>.partial.json`,中途失败下次启动从该文件恢复,
    避免大书(>500 章)前功尽弃。
    """
    from .exporter import write_epub
    partial_path = os.path.join(out_dir, f"{safe_filename(book.title or 'novel')}.partial.json")

    # 加载已有进度(断点续传)
    collected: list[dict] = []
    if os.path.isfile(partial_path):
        try:
            with open(partial_path, "r", encoding="utf-8") as f:
                collected = json.load(f)
            if isinstance(collected, list):
                log(f"  断点续传:恢复 {len(collected)} 章已下载进度")
        except Exception:  # noqa: BLE001
            collected = []
    # 已下载章节序号集合:新格式每条带 idx;旧格式(无 idx)按收集顺序推断,
    # 与旧行为一致(视为从头连续收集)
    done_idx = {c.get("idx") or i + 1 for i, c in enumerate(collected)}

    # 继续下载剩余章节(按精确序号跳过,失败章节下次会重试补齐)
    for idx, text in _iter_chapters(chapters, start, end, done_idx=done_idx,
                                    source=source, charset=charset, fetcher=fetcher,
                                    delay=delay, workers=workers, log=log,
                                    on_progress=on_progress, check=check):
        ch = chapters[idx - 1]
        collected.append({"idx": idx, "title": _title_line(ch, idx), "text": text})
        # 每 10 章落盘一次 partial,防止中途失败全丢
        if len(collected) % 10 == 0:
            try:
                with open(partial_path, "w", encoding="utf-8") as f:
                    json.dump(collected, f, ensure_ascii=False)
            except Exception:  # noqa: BLE001
                pass  # 落盘失败不阻塞下载

    # 所有章节收集完,生成 EPUB
    out_path = os.path.join(
        out_dir, f"{safe_filename(book.title or 'novel')}[{safe_filename(str(source['name']))}].epub"
    )
    write_epub(book.title or "小说", source["name"], collected, out_path)
    # 完成后清理 partial
    try:
        os.remove(partial_path)
    except Exception:  # noqa: BLE001
        pass
    log(f"完成!已导出 {len(collected)} 章 → {os.path.abspath(out_path)}")
    return out_path


def _download_txt(book, source, chapters, start, end, charset, fetcher,
                  delay, out_dir, log, on_progress, workers=1, check=None) -> str:
    """TXT 下载:按序写入,支持断点续传与并发抓取。

    加固:每章写入后 fsync(进程被杀不丢数据);权限检查;失败章节列表收集。
    """
    out_path = os.path.join(
        out_dir, f"{safe_filename(book.title or 'novel')}[{safe_filename(str(source['name']))}].txt"
    )
    # 权限检查:先确认目录可写
    try:
        os.makedirs(out_dir, exist_ok=True)
        if not os.access(out_dir, os.W_OK):
            raise PermissionError(f"下载目录无写权限: {out_dir}")
    except PermissionError as e:
        raise RuntimeError(f"下载目录权限错误: {e}") from e

    done_idx = _done_idx_set(out_path)
    if done_idx:
        log(f"  断点续传:已下载 {len(done_idx)} 章,按序号补齐缺失章节")

    # 新文件(不存在或空)才写头部:与下载范围无关,避免"先下 101-200 再下 1-100"丢头部
    is_new = not os.path.isfile(out_path) or os.path.getsize(out_path) == 0

    # 收集失败章节(结束时统一告知)
    failed_chapters: list[int] = []

    try:
        with open(out_path, "a", encoding="utf-8") as f:
            if is_new:
                f.write(f"《{book.title}》\n来源: {source['name']} | {book.url}\n\n")
                f.flush()
                os.fsync(f.fileno())  # 头部立即落盘

            for idx, text in _iter_chapters(chapters, start, end, done_idx,
                                            source=source, charset=charset, fetcher=fetcher,
                                            delay=delay, workers=workers, log=log,
                                            on_progress=on_progress, check=check):
                if text is None:
                    failed_chapters.append(idx)
                    continue
                ch = chapters[idx - 1]
                f.write(f"【章节】第{idx}章\n")
                f.write(f"== {_title_line(ch, idx)} ==\n")
                f.write(text)
                f.write("\n\n")
                f.flush()
                os.fsync(f.fileno())  # 每章落盘,进程被杀不丢
    except OSError as e:
        raise RuntimeError(f"文件写入失败({out_path}): {e}") from e

    written = _count_done(out_path)
    if failed_chapters:
        log(f"⚠️  下载完成但有 {len(failed_chapters)} 章失败: {failed_chapters[:10]}{'...' if len(failed_chapters) > 10 else ''}")
    log(f"完成!已保存 {written} 章 → {os.path.abspath(out_path)}")
    return out_path


def _iter_chapters(chapters, start, end, done_idx, source, charset, fetcher,
                   delay, workers, log, on_progress, check=None):
    """按顺序产出 (idx, text);workers>1 时用滑动窗口并发抓取并保持写入顺序。

    done_idx: 已下载章节的序号集合(断点续传精确跳过)。
    """
    total = len(chapters)
    if workers <= 1:
        for idx in range(start, end + 1):
            if check:
                check()  # 停止/暂停检查
            if idx in done_idx:
                continue  # 断点续传:已写过的章节跳过
            ch = chapters[idx - 1]
            text = _fetch_chapter(ch, source, charset, fetcher)
            if text is None:
                log(f"  ✗ 第 {idx} 章下载失败: {ch['title']}")
                if on_progress:
                    on_progress(idx, total, ch["title"], err=True)
                continue
            log(f"  ✓ {idx}/{total} {ch['title']}")
            if on_progress:
                on_progress(idx, total, ch["title"])
            time.sleep(delay)  # 防封禁:章节间限速
            yield idx, text
        return

    # ---- 并发模式:滑动窗口,按 idx 顺序落盘 ----
    from concurrent.futures import ThreadPoolExecutor

    remaining = [i for i in range(start, end + 1) if i not in done_idx]

    def _fetch(i: int):
        ch = chapters[i - 1]
        try:
            return i, _fetch_chapter(ch, source, charset, fetcher)
        except Exception as exc:  # noqa: BLE001
            log(f"  ✗ 第 {i} 章抓取异常: {exc}")
            return i, None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        window: dict[int, object] = {}
        it = iter(remaining)
        # 填满窗口
        for _ in range(workers):
            i = next(it, None)
            if i is None:
                break
            window[i] = pool.submit(_fetch, i)
        while window:
            if check:
                check()  # 停止/暂停检查
            i = min(window)  # 始终先取最小的 idx,保证写入顺序
            fut = window.pop(i)
            _i, text = fut.result()
            ch = chapters[i - 1]
            if text is None:
                if on_progress:
                    on_progress(i, total, ch["title"], err=True)
                continue
            log(f"  ✓ {i}/{total} {ch['title']}")
            if on_progress:
                on_progress(i, total, ch["title"])
            time.sleep(delay)
            yield i, text
            nxt = next(it, None)
            if nxt is not None:
                window[nxt] = pool.submit(_fetch, nxt)


def _title_line(ch: dict, idx: int) -> str:
    """章节标题自带"第N章"前缀时不重复加(容忍前后引号/空白)。"""
    title = ch["title"]
    probe = re.sub(r'^[\s“”"\'《》【】〈〉]+|[\s“”"\'《》【】〈〉]+$', "", title)
    if not re.match(r"^第\s*(\d+|[一二三四五六七八九十百千零两]+)\s*章", probe):
        title = f"第{idx}章 {title}"
    return title


def _fetch_chapter(ch: dict, source: dict, charset: str, fetcher: Fetcher) -> str | None:
    """抓取并清洗单章正文;失败返回 None。支持 API 模式书源。"""
    api = (source.get("api_rules") or {}).get("content")
    if api:
        from .jsonpath import extract
        try:
            html = fetcher.fetch(ch["url"], source=source["name"], encoding=charset,
                                 headers=source.get("headers") or {},
                                 verify=source.get("verify_ssl", True))
            data = json.loads(html)
            text = extract(data, api.get("rule", "$"))
            if isinstance(text, list) and text:
                text = text[0]
            if text is None:
                return None
            from .clean import clean_text
            from .config import load_settings
            return clean_text(str(text).strip(), load_settings().get("clean_rules"))
        except Exception as exc:  # noqa: BLE001
            logger.warning("API章节 %s 失败: %s", ch["title"], exc)
            return None
    selector = source.get("content_selector")
    short_texts: list[str] = []
    for attempt in range(3):
        try:
            if source.get("render"):
                from .browser import render_html
                html = render_html(ch["url"], headers=source.get("headers") or {}, wait_ms=1500)
            else:
                html = fetcher.fetch(ch["url"], source=source["name"], encoding=charset, verify=source.get("verify_ssl", True))
            text = parse_content(html, selector=selector)
            if len(text) >= 20:
                from .clean import clean_text
                from .config import load_settings
                return clean_text(text, load_settings().get("clean_rules"))
            # 短正文:记下内容继续重试,3 次完全相同则视为真实短章节接受
            short_texts.append(text)
            time.sleep(1.5 * (attempt + 1))
        except Exception as exc:  # noqa: BLE001
            logger.warning("章节 %s 失败(第%d次): %s", ch["title"], attempt + 1, exc)
            time.sleep(2 * (attempt + 1))
    if short_texts and all(t == short_texts[0] for t in short_texts):
        from .clean import clean_text
        from .config import load_settings
        return clean_text(short_texts[0], load_settings().get("clean_rules"))
    return None

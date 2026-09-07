# -*- coding: utf-8 -*-
"""
页面解析器
==========
依据书源配置(JSON)中的选择器规则,把 HTML 解析为:
  * 搜索结果(书名 / 作者 / 详情页 URL)
  * 章节目录(章节名 / 正文 URL,保持阅读顺序)
  * 章节正文(清洗广告与噪声行)
"""
from __future__ import annotations

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

# 常见的"正文容器"选择器,按优先级尝试
_CONTENT_SELECTORS = [
    "div#content",
    "div.content",
    "div.txt",
    "div#booktext",
    "div.chaptercontent",
    "div.articlecon",
    "div#chaptercontent",
    "div.read-content",
    "div#BookText",
    "div.showtxt",
    "div#nr1",
    "article",
]

# 正文中应剔除的噪声行(站点插入的广告/提示)
_NOISE_PATTERNS = [
    r"一秒记住.*",
    r"本章未完.*",
    r"请收藏本站.*",
    r"最新网址.*",
    r"记住本站网址.*",
    r"手机用户请浏览.*",
    r"章节报错.*",
    r"加入书签.*",
    r"返回目录.*",
    r"天才一秒记住.*",
    r"最快更新.*",
    r"新笔趣阁.*",
    r"笔趣阁.*无弹窗",
    r"www\.\S+",
    r"http\S+",
]

_CHAPTER_HREF_RE = re.compile(r"(chapter|read|book)/", re.I)


def _first_soup_match(soup: BeautifulSoup, selectors: list[str]):
    for sel in selectors:
        el = soup.select_one(sel)
        if el is not None:
            return el
    return None


def _item_cover(el) -> str:
    """从结果容器里找封面图 URL(结果容器 → 父级 li/div → 首个 img)。"""
    parent = el.find_parent("li") or el.find_parent("div")
    if parent is not None:
        img = parent.find("img")
        if img and img.get("src"):
            return img["src"].strip()
    return ""


def _item_desc(el) -> str:
    """从结果容器里提取简介片段(排除书名,截取 120 字)。"""
    parent = el.find_parent("li") or el.find_parent("div")
    if parent is None:
        return ""
    txt = re.sub(r"\s+", " ", parent.get_text(" ", strip=True) or "")
    return txt[:120]


def parse_search_results(
    html: str,
    *,
    base_url: str,
    book_href_pattern: str | None = None,
    max_results: int = 20,
) -> list[dict]:
    """
    从搜索页 HTML 提取结果。
    优先识别 class 含 "name" 的书名容器(如 <span class="name"><a href=..>书名</a></span>),
    回退到通用链接解析。
    """
    soup = BeautifulSoup(html, "lxml")
    results: list[dict] = []
    seen: set[str] = set()

    # 1) 精确模式:span.name / div.name / li 内的书名链接
    for name_box in soup.select("span.name, div.name, .bookname, .result-item .name"):
        a = name_box.find("a", href=True)
        if a is None:
            continue
        href = a["href"].strip()
        title = (a.get("title") or a.get_text(strip=True) or "").strip()
        title = re.sub(r"文章列表|最新章节|最新章节列表|免费阅读", "", title).strip()
        title = re.sub(r"笔趣阁$", "", title).strip()  # 部分站点书名带站点后缀
        if not title or len(title) < 1:
            continue
        url = _abs(href, base_url)
        if url in seen:
            continue
        seen.add(url)
        results.append({
            "title": title,
            "author": "",
            "url": url,
            "cover": _item_cover(name_box),
            "desc": _item_desc(name_box),
        })
        if len(results) >= max_results:
            return results

    # 2) 回退:通用链接解析
    if not results and book_href_pattern:
        pattern = re.compile(book_href_pattern)
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if not pattern.search(href):
                continue
            url = _abs(href, base_url)
            if url is None or url in seen:
                continue
            title = (a.get("title") or a.get_text(strip=True) or "").strip()
            title = re.sub(r"文章列表|最新章节|最新章节列表|免费阅读", "", title).strip()
            title = re.sub(r"笔趣阁$", "", title).strip()
            if not title or len(title) < 2:
                continue
            seen.add(url)
            results.append({
                "title": title,
                "author": "",
                "url": url,
                "cover": _item_cover(a),
                "desc": _item_desc(a),
            })
            if len(results) >= max_results:
                break
    return results


def _abs(href: str, base_url: str) -> str | None:
    """相对/协议相对地址 → 绝对地址;非站内链接返回 None。"""
    href = href.strip()
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return base_url.rstrip("/") + href
    if href.startswith("http"):
        return href
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:", "?")):
        return None
    # 无前导斜杠的相对链接(如 book/123/456.html):静默丢弃会导致缺章,
    # 按目录页基准 urljoin 补全(基准强制以 / 结尾,避免目录页无尾斜杠时拼错层级)
    return urljoin(base_url.rstrip("/") + "/", href)


def parse_toc(
    html: str,
    *,
    base_url: str,
    chapter_href_pattern: str | None = None,
    container_words: str | None = None,
) -> list[dict]:
    """
    从目录页提取章节列表,保持阅读顺序并去重。

    许多站点目录页顶部有"最新章节列表"(倒序) + 下方"全部章节"(正序),
    因此优先定位标题含"全部章节/正文/章节列表"的容器,只解析其中的章节。
    container_words: 书源规则指定的容器标题关键词(多个用 / 或 | 分隔),优先使用。
    找不到时才回退全页解析。
    """
    soup = BeautifulSoup(html, "lxml")
    chapters: list[dict] = []
    seen: set[str] = set()

    # 0) 书源规则指定的容器关键词(如 "全部章节/正文卷")
    if container_words:
        words = [w.strip() for w in re.split(r"[/|]", container_words) if w.strip()]
        container = _find_container_by_words(soup, words)
        if container is not None and _has_chapter_link(container, chapter_href_pattern):
            for a in container.find_all("a", href=True):
                _collect_chapter(a, chapters, seen, base_url, chapter_href_pattern)
            if chapters:
                return chapters

    # 1) 精确模式:定位"全部章节"等容器(强信号词优先,校验容器内确有章节链接)
    container = None
    strong_words = ("全部章节", "章节列表", "正文卷")
    for tag in ("h2", "h3", "h1"):
        for heading in soup.find_all(tag):
            text = heading.get_text(strip=True)
            if not any(k in text for k in strong_words):
                continue
            cand = _sibling_container(heading)
            if cand is not None and _has_chapter_link(cand, chapter_href_pattern):
                container = cand
                break
        if container is not None:
            break

    if container is None:
        # 次选:div/dt/p 标题(需标题较短,避免命中面包屑等大区块)
        for heading in soup.find_all(["div", "dt", "p"]):
            text = heading.get_text(strip=True)
            if not any(k in text for k in strong_words) or len(text) > 40:
                continue
            cand = _sibling_container(heading)
            if cand is not None and _has_chapter_link(cand, chapter_href_pattern):
                container = cand
                break

    if container is not None:
        for a in container.find_all("a", href=True):
            _collect_chapter(a, chapters, seen, base_url, chapter_href_pattern)
        if chapters:
            return chapters

    # 2) 兜底:全页解析(无 pattern 时收集含 .html 的链接,供候选源探测用)
    if chapter_href_pattern:
        pattern = re.compile(chapter_href_pattern)
        for a in soup.find_all("a", href=True):
            _collect_chapter(a, chapters, seen, base_url, pattern)
    elif not chapters:
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if ".html" not in href or not re.search(r"\d", href):
                continue
            _collect_chapter(a, chapters, seen, base_url, None)
    return chapters


def _find_container_by_words(soup, words: list[str]):
    """按关键词列表寻找目录容器:标题文本含任一关键词,取其后的兄弟 ul/dl/ol/div。"""
    for tag in ("h2", "h3", "h1", "dt", "div", "p"):
        for heading in soup.find_all(tag):
            text = heading.get_text(strip=True)
            if not any(w in text for w in words) or len(text) > 40:
                continue
            cand = _sibling_container(heading)
            if cand is not None:
                return cand
    return None


def _sibling_container(heading):
    """找标题之后的 ul / dl / ol / div 容器。"""
    node = heading
    for _ in range(4):
        nxt = node.find_next_sibling()
        if nxt is None:
            return None
        if nxt.name in ("ul", "dl", "ol", "div"):
            return nxt
        node = nxt
    return None


def _has_chapter_link(container, chapter_href_pattern) -> bool:
    if chapter_href_pattern is None:
        return len(container.find_all("a", href=True)) > 5
    pattern = re.compile(chapter_href_pattern)
    for a in container.find_all("a", href=True):
        if pattern.search(a["href"]):
            return True
    return False


def _collect_chapter(a, chapters: list, seen: set, base_url: str, pattern) -> None:
    """收集单个章节链接;pattern 可为已编译正则、字符串或 None。"""
    href = a["href"].strip()
    if pattern is not None:
        if isinstance(pattern, str):
            pattern = re.compile(pattern)
        if not pattern.search(href):
            return
    if href.startswith("//"):
        href = "https:" + href
    elif href.startswith("/"):
        href = base_url.rstrip("/") + href
    elif href.startswith("http"):
        pass
    elif not href or href.startswith(("#", "javascript:", "mailto:", "tel:", "?")):
        return
    else:
        # 无前导斜杠的相对链接(如 book/123/456.html)也补全,避免缺章
        href = urljoin(base_url.rstrip("/") + "/", href)
    title = a.get_text(strip=True)
    if not title or title in ("开始阅读", "上一章", "下一章", "目录"):
        return
    if href in seen:
        return
    seen.add(href)
    chapters.append({"title": title, "url": href})


def parse_content(html: str, *, strip_ads: bool = True, selector: str | None = None) -> str:
    """
    从正文页提取正文文本。优先使用书源规则指定的选择器,否则自动尝试常见容器。
    """
    soup = BeautifulSoup(html, "lxml")
    box = None
    if selector:
        box = soup.select_one(selector)

    if box is None:
        box = _first_soup_match(soup, _CONTENT_SELECTORS)

    if box is None:
        # 兜底:取页面最大文本块
        candidates = []
        for div in soup.find_all(["div", "article"]):
            text = div.get_text("\n", strip=True)
            if len(text) > 100:
                candidates.append((len(text), div))
        if candidates:
            candidates.sort(key=lambda x: x[0], reverse=True)
            box = candidates[0][1]

    if box is None:
        return ""

    text = box.get_text("\n", strip=True)

    if strip_ads:
        lines = []
        skip_block = False  # 推荐/标签块清理:遇到"最新标签"等标题后,丢弃后续短行直至首个长段落
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            if re.match(r"^(最新标签|热门标签|大家都在看|相关推荐|猜你喜欢|推荐阅读)", line):
                skip_block = True
                continue
            if skip_block:
                # 正文段落特征:较长且含中文标点;标签行一般无标点
                if len(line) >= 20 and re.search(r"[。，！？；、…：:]", line):
                    skip_block = False  # 正文段落开始,恢复保留
                else:
                    continue
            if any(re.match(p, line) for p in _NOISE_PATTERNS):
                continue
            lines.append(line)
        text = "\n".join(lines)

    return text


def normalize_chapter_href(href: str, base_url: str) -> str:
    """把站内相对链接归一化为绝对 URL。"""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return base_url.rstrip("/") + href
    if href.startswith("http"):
        return href
    if not href or href.startswith(("#", "javascript:", "mailto:", "tel:", "?")):
        return href
    return urljoin(base_url.rstrip("/") + "/", href)

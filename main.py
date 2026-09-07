# -*- coding: utf-8 -*-
"""
多源小说爬虫 —— 命令行入口
============================
用法示例:
  python main.py                      # 交互模式(推荐)
  python main.py search "harry potter"   # 多源搜索(支持英文名→中文)
  python main.py download <书籍URL>      # 直接填入详情页/目录页 URL 下载
  python main.py sources               # 列出已启用的书源
  python main.py download <URL> --start 1 --end 20 --out downloads --delay 1.0
  python main.py search "斗破苍穹" --source "笔趣阁365"
"""
from __future__ import annotations

import argparse
import logging
import sys

from novel.downloader import download_book, safe_filename
from novel.fetcher import Fetcher
from novel.searcher import Book, book_from_url, search_all

logging.basicConfig(
    level=logging.WARNING,
    format="[%(levelname)s] %(message)s",
)


def interactive() -> None:
    """推荐使用的交互流程:搜索 → 选择 → 下载。"""
    from novel.config import load_sources

    sources = load_sources()
    print("=" * 56)
    print("  多源小说爬虫 v1.0  |  请合法使用,尊重版权")
    print("=" * 56)
    print(f"已启用书源: {', '.join(s['name'] for s in sources)}")
    print("输入 exit / quit 退出\n")

    while True:
        try:
            keyword = input("🔍 搜索书名(支持英文,如 harry potter)> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见!")
            break
        if keyword.lower() in ("exit", "quit", "q"):
            print("再见!")
            break
        if not keyword:
            continue

        books = search_all(keyword)
        if not books:
            print("  未找到结果,换个关键词试试\n")
            continue

        print(f"\n共 {len(books)} 条结果:")
        for i, b in enumerate(books, 1):
            print(f"  [{i}] {b.title}  ({b.source}){(' 作者:' + b.author) if b.author else ''}")
        print("  [0] 返回重新搜索")

        try:
            choice = input("\n选择序号下载(回车=返回)> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见!")
            break
        if not choice:
            continue
        try:
            n = int(choice)
        except ValueError:
            continue
        if n == 0:
            continue
        if not (1 <= n <= len(books)):
            print("序号无效")
            continue

        book = books[n - 1]
        print(f"开始下载《{book.title}》...")
        try:
            # 询问章节范围(回车=全部)
            try:
                rng = input("下载范围(如 1-50,回车=全部)> ").strip()
            except (EOFError, KeyboardInterrupt):
                rng = ""
            start, end = 1, None
            if rng:
                m = __import__("re").match(r"^\s*(\d+)\s*[-–~至]?\s*(\d*)\s*$", rng)
                if m:
                    start = int(m.group(1))
                    if m.group(2):
                        end = int(m.group(2))
            download_book(book, start=start, end=end, quiet=False)
        except Exception as exc:  # noqa: BLE001
            print(f"下载失败: {exc}")
        print()


def cmd_search(args) -> None:
    books = search_all(args.keyword, max_workers=args.workers)
    if not books:
        print("未找到结果")
        sys.exit(1)
    print(f"\n共 {len(books)} 条结果:")
    for i, b in enumerate(books, 1):
        print(f"  [{i}] {b.title}  ({b.source}){(' 作者:' + b.author) if b.author else ''}")
        print(f"      {b.url}")
    if args.download is None:
        return
    # --download N 自动下载第 N 条
    try:
        n = int(args.download)
        book = books[n - 1]
        print(f"\n下载《{book.title}》...")
        download_book(book, out_dir=args.out, start=args.start, end=args.end,
                      delay=args.delay, format=args.format)
    except (ValueError, IndexError) as exc:
        print(f"自动下载失败: {exc}")


def cmd_download(args) -> None:
    fetcher = Fetcher(proxy=args.proxy)
    book = book_from_url(args.url, fetcher)
    if book is None:
        # 自定义源:尽力而为
        book = Book(title=safe_filename(args.url.rstrip("/").split("/")[-1] or "novel"),
                    url=args.url, source="自定义")
    try:
        download_book(book, out_dir=args.out, start=args.start, end=args.end,
                      delay=args.delay, format=args.format, workers=args.workers,
                      fetcher=fetcher)
    except Exception as exc:  # noqa: BLE001
        print(f"下载失败: {exc}")
        sys.exit(1)


def cmd_sources(_args) -> None:
    from novel.config import load_sources
    for s in load_sources():
        print(f"  {s['name']:<10} {s['base']}")
    print("\n自定义源请编辑 config.json 的 sources 字段(格式见 novel/config.py 注释)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="多源小说爬虫(仅供学习研究,请尊重版权)")
    sub = p.add_subparsers(dest="cmd")

    ps = sub.add_parser("search", help="多源搜索")
    ps.add_argument("keyword", help="书名关键词,支持英文如 harry potter")
    ps.add_argument("--download", metavar="N", help="自动下载第 N 条结果")
    ps.add_argument("--workers", type=int, default=3, help="并发书源数(默认3)")
    ps.add_argument("--proxy", help="代理地址,如 http://127.0.0.1:7890")
    ps.add_argument("--out", default="downloads", help="输出目录")
    ps.add_argument("--start", type=int, default=1, help="起始章节(1-based)")
    ps.add_argument("--end", type=int, default=None, help="结束章节")
    ps.add_argument("--delay", type=float, default=1.2, help="章节间延迟秒(防封禁)")
    ps.add_argument("--format", choices=["txt", "epub"], default="txt", help="导出格式")
    ps.set_defaults(func=cmd_search)

    pd = sub.add_parser("download", help="直接填入书籍URL下载")
    pd.add_argument("url", help="小说详情页/目录页 URL")
    pd.add_argument("--proxy", help="代理地址")
    pd.add_argument("--out", default="downloads", help="输出目录")
    pd.add_argument("--start", type=int, default=1)
    pd.add_argument("--end", type=int, default=None)
    pd.add_argument("--delay", type=float, default=1.2)
    pd.add_argument("--workers", type=int, default=1, help="并发抓取数")
    pd.add_argument("--format", choices=["txt", "epub"], default="txt", help="导出格式")
    pd.set_defaults(func=cmd_download)

    pl = sub.add_parser("sources", help="列出书源")
    pl.set_defaults(func=cmd_sources)

    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.cmd is None:
        interactive()
    else:
        args.func(args)


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""统一数据目录:所有用户数据(配置/书架/订阅/验证 cookies/下载)落盘位置的唯一来源。

优先级:
  1. 环境变量 NOVEL_DATA_DIR(显式指定,便于便携版/多实例)
  2. 默认:exe 同目录(打包后)/ 项目根目录(源码运行)
  3. exe 目录不可写(如装在 Program Files)→ 自动回退到系统用户数据目录
     Windows: %APPDATA%/NovelCrawler   macOS: ~/Library/Application Support/NovelCrawler
"""
from __future__ import annotations

import os
import sys


def _detect_data_dir() -> str:
    env = os.environ.get("NOVEL_DATA_DIR", "").strip()
    if env:
        return os.path.abspath(env)

    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    # exe 目录可写性探测:能创建文件才算可写,否则回退用户数据目录
    # (删除测试文件失败不算不可写——只以创建能力为准)
    try:
        probe = os.path.join(base, ".writetest")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
    except OSError:
        pass
    else:
        try:
            os.remove(probe)
        except OSError:  # 删除被拦截/占用不影响:能写即用
            pass
        return base

    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
        fallback = os.path.join(appdata, "NovelCrawler")
    elif sys.platform == "darwin":
        fallback = os.path.join(os.path.expanduser("~/Library/Application Support"),
                                "NovelCrawler")
    else:
        fallback = os.path.join(os.path.expanduser("~/.local/share"), "NovelCrawler")
    os.makedirs(fallback, exist_ok=True)
    return fallback


APP_DATA_DIR = _detect_data_dir()
# 下载目录:绝对化(相对路径基于数据目录解析)
_DEFAULT_OUT = os.path.join(APP_DATA_DIR, "downloads")
# 小说统一落 downloads/novel,与漫画(downloads/comic)对称隔离
NOVEL_OUT_DIR = os.path.join(_DEFAULT_OUT, "novel")
# 漫画下载统一落独立子目录,与小说(txt/epub)彻底隔离,避免列表互相污染
COMIC_OUT_DIR = os.path.join(_DEFAULT_OUT, "comic")
# 旧版小说目录(downloads/ 根):升级后残留的旧文件兼容读取位置
LEGACY_NOVEL_DIR = _DEFAULT_OUT

# 各数据文件路径
CONFIG_PATH = os.path.join(APP_DATA_DIR, "config.json")
SHELF_PATH = os.path.join(APP_DATA_DIR, "bookshelf.json")
COMIC_SHELF_PATH = os.path.join(APP_DATA_DIR, "comic_shelf.json")
SUBSCRIPTIONS_PATH = os.path.join(APP_DATA_DIR, "subscriptions.json")
COMIC_SUBSCRIPTIONS_PATH = os.path.join(APP_DATA_DIR, "comic_subs.json")
COMIC_CUSTOM_SOURCES_PATH = os.path.join(APP_DATA_DIR, "comic_sources_custom.json")
COMIC_BASE_OVERRIDES_PATH = os.path.join(APP_DATA_DIR, "comic_base_overrides.json")
CANDIDATES_PATH = os.path.join(APP_DATA_DIR, "source_candidates.json")
VERIFY_PATH = os.path.join(APP_DATA_DIR, "verify_cookies.json")
VERIFY_PENDING_PATH = os.path.join(APP_DATA_DIR, "verify_pending.json")
OPDS_COOKIES_PATH = os.path.join(APP_DATA_DIR, "opds_cookies.json")
TASK_HISTORY_PATH = os.path.join(APP_DATA_DIR, "task_history.json")
NOTES_PATH = os.path.join(APP_DATA_DIR, "notes.json")


def resolve_out_dir(configured: str) -> str:
    """把设置里的 out_dir(可能相对)解析为绝对路径,基于数据目录。"""
    if not configured:
        return _DEFAULT_OUT
    p = os.path.abspath(configured)
    if not os.path.isabs(configured):
        p = os.path.join(APP_DATA_DIR, configured)
    os.makedirs(p, exist_ok=True)
    return p

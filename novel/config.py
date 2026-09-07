# -*- coding: utf-8 -*-
"""
书源配置管理
============
内置若干小说源 + 用户 config.json 中的自定义源与全局设置。

config.json 结构:
{
  "sources": [ ...自定义源... ],
  "source_states": { "书源名": true/false },   # 覆盖内置源的启用状态
  "settings": { "proxy": "", "delay": 1.2, "out_dir": "downloads", "verify_ssl": true }
}

每个源字段说明:
  name                 显示名称(唯一标识)
  base                 站点根地址
  charset              站点编码(utf-8 / gbk / gb18030)
  search               {method, path, param, extra} 或 None(不支持搜索)
  search_interval      搜索冷却秒数
  book_href_pattern    搜索结果中书籍详情页链接正则
  chapter_href_pattern 目录页章节链接正则
  toc_reverse          True=目录倒序需反转(启发式也会自动判断)
  verify_ssl           False=忽略证书错误(站点证书过期时)
  enabled              是否启用
  custom               是否为用户自定义源
"""
from __future__ import annotations

import json
import os
import threading
from urllib.parse import urlparse

DEFAULT_SOURCES: list[dict] = [
    {
        "name": "笔趣阁365",
        "base": "https://www.biquge365.net",
        "charset": "gbk",
        "search": {"method": "POST", "path": "/s.php", "param": "s",
                   "extra": {"type": "articlename"}},
        "search_interval": 20,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/chapter/\d+/",
        "toc_order": "desc",
        "toc_reverse": True,
        "verify_ssl": True,
        "enabled": True,
        "custom": False,
    },
    {
        "name": "笔趣阁345",
        "base": "https://www.biquge345.com",
        "charset": "gbk",
        "search": {"method": "POST", "path": "/s.php", "param": "s",
                   "extra": {"type": "articlename"}},
        "search_interval": 20,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/chapter/\d+/",
        "toc_order": "desc",
        "toc_reverse": True,
        "verify_ssl": True,
        "enabled": True,
        "custom": False,
    },
    {
        "name": "笔趣阁7",
        "base": "https://www.biquge7.com",
        "charset": "utf-8",
        "search": None,  # 搜索接口需登录态;直连目录可用
        "search_interval": 0,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/book/\d+/\d+\.html",
        "toc_order": "asc",
        "toc_reverse": False,
        "verify_ssl": True,
        "enabled": False,  # 2026-08 实测正文为 JS 反爬页(章节页仅1227字节无内容),不可下载
        "custom": False,
    },
    {
        "name": "随梦文学",
        "base": "https://www.suimeng.cc",
        "charset": "utf-8",
        "search": None,  # 未发现可用搜索接口
        "search_interval": 0,
        "book_href_pattern": r"/\d+_\d+/",
        "chapter_href_pattern": r"/\d+_\d+/\d+\.html",
        "toc_order": "asc",
        "toc_reverse": False,
        "verify_ssl": False,
        "enabled": False,  # 2026-08-09 实测页面内容不稳定(同一URL多次请求结构不同),候选
        "custom": False,
    },
    {
        "name": "经典书库",
        "base": "https://www.jingdianbook.com",
        "charset": "utf-8",
        "search": None,  # 搜索为 JS 渲染,静态不可抓;直连可用
        "search_interval": 0,
        "book_href_pattern": r"/book_\d+/",
        "chapter_href_pattern": r"/book_\d+/\d+\.html",
        "toc_order": "asc",
        "toc_reverse": False,
        "content_selector": "div#content",
        "verify_ssl": True,
        "enabled": True,  # 2026-08-09 实测(GitHub书源):目录61章+正文2505字
        "custom": False,
    },
    {
        "name": "神话之后",
        "base": "https://www.shenhuazhihou.com",
        "charset": "utf-8",
        "search": {"method": "POST", "path": "/e/search/index.php", "param": "keyboard",
                   "extra": {"tbname": "bookname", "show": "title,writer", "tempid": "1"}},
        "search_interval": 0,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/book/\d+/\d+\.html",
        "toc_order": "desc",
        "toc_reverse": True,
        "verify_ssl": True,
        "enabled": True,  # 2026-08-09 实测:目录115章+正文1807字,搜索已配
        "custom": False,
    },
    {
        "name": "斗破小说网",
        "base": "https://www.doupoall.com",
        "charset": "utf-8",
        "search": None,  # 搜索接口为JS重定向+POST,暂不支持;直连可用
        "search_interval": 0,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/book/\d+/\d+\.html",
        "toc_order": "desc",
        "toc_reverse": True,
        "verify_ssl": True,
        "enabled": True,  # 2026-08-09 实测:目录772章+正文2301字
        "custom": False,
    },
    {
        "name": "新笔趣阁",
        "base": "https://www.xbiquge.bz",
        "charset": "gbk",
        "search": {"method": "GET", "path": "/search.html", "param": "s"},
        "search_interval": 3,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/book/\d+/\d+\.html",
        "toc_order": "asc",
        "toc_reverse": False,
        "verify_ssl": True,
        "enabled": False,  # 搜索返回推荐不按关键词,正文 JS 加载,默认关
        "custom": False,
    },
    {
        "name": "顶点小说",
        "base": "https://www.biqiuge.com",
        "charset": "utf-8",
        "search": None,  # 搜索为 JS 渲染
        "search_interval": 0,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/book/\d+/\d+\.html",
        "toc_order": "asc",
        "toc_reverse": False,
        "verify_ssl": True,
        "enabled": False,
        "custom": False,
    },
    {
        "name": "香书小说",
        "base": "https://www.xbiquge.la",
        "charset": "utf-8",
        "search": None,
        "search_interval": 0,
        "book_href_pattern": r"/book/\d+/",
        "chapter_href_pattern": r"/book/\d+/\d+\.html",
        "toc_order": "asc",
        "toc_reverse": False,
        "verify_ssl": False,  # 证书过期
        "enabled": False,
        "custom": False,
    },
]

from novel.paths import CONFIG_PATH, resolve_out_dir

DEFAULT_SETTINGS: dict = {
    "proxy": "",
    "delay": 1.2,
    "out_dir": "downloads",
    "verify_ssl": True,
    "lan_access": False,   # 允许局域网访问(手机/其他设备),需重启生效
    "clean_rules": [],     # 正文净化规则(正则替换),保存时随 settings 落盘
    # ---- 内网穿透(校园网/外出时手机经公网隧道访问) ----
    "tunnel_cmd": "",          # 隧道客户端可执行文件路径(natapp/cpolar/frpc)
    "tunnel_args": "",         # 附加参数,如 -authtoken=xxx
    "tunnel_url_regex": "",    # 解析公网 URL 的正则(留空用内置默认)
    "tunnel_autostart": False, # 程序启动时自动拉起隧道
    "comic_sources": {},   # 漫画源启停状态 {源key: bool}(缺失视为启用)
    "pdf_quality": "hq",   # 漫画 PDF 图片质量 original(原图)/hq(高清,默认)/eco(省流)
    # ---- 全局任务气泡设置(前端 #taskFab + 任务面板) ----
    "task_fab_pos": "br",          # 气泡位置 br/bl/tr/custom(右下/左下/右上/自定义)
    "task_fab_pos_x": 6,           # custom 距右 % (0-100)
    "task_fab_pos_y": 6,           # custom 距下 % (0-100)
    "task_fab_mode": "always",     # 显隐 always(常驻)/task(仅任务时)/never(始终隐藏)
    "task_fab_auto_collapse": True,  # 全部任务结束自动恢复矩形
    "task_fab_finish_hold": 0,     # 完成提示保留秒数(0-60, auto_collapse 开启时生效)
    "task_notify_success": True,   # 下载完成右上角通知
    "task_notify_fail": True,      # 下载失败右上角通知
    "task_panel_max": 50,          # 任务面板最多展示条数(10-200)
    "task_dl_concurrency": 3,      # 批量下载并发本数(1-8)
    "task_fab_poll_ms": 3000,      # 气泡形态轮询间隔 ms(1000-10000)
}


_cfg_lock = threading.Lock()


def get_out_dir() -> str:
    """返回绝对化的小说下载目录(与漫画 downloads/comic 对称 → downloads/novel)。

    用户未自定义 out_dir(仍是默认值)时走 NOVEL_OUT_DIR;
    已自定义绝对路径/相对路径则保持原行为。自动创建目录。"""
    from novel.paths import NOVEL_OUT_DIR
    s = load_settings()
    cfg = s.get("out_dir", "")
    if not cfg or cfg == "downloads":
        os.makedirs(NOVEL_OUT_DIR, exist_ok=True)
        return NOVEL_OUT_DIR
    return resolve_out_dir(cfg)


def _read_cfg() -> dict:
    """读取 config.json,不存在或损坏返回空结构。

    调用方需自行持 _cfg_lock(纯读场景可并发)。
    """
    if not os.path.exists(CONFIG_PATH):
        return {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _write_cfg(cfg: dict) -> None:
    """原子写 config.json:先写临时文件再替换。

    ThreadingHTTPServer 每请求一线程,直接覆写会在崩溃/并发时留下
    截断的损坏文件;损坏后 _read_cfg 返回 {} → 后续保存把配置清空。
    调用方需自行持 _cfg_lock。
    """
    os.makedirs(os.path.dirname(CONFIG_PATH) or ".", exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, CONFIG_PATH)


# ---------------------------------------------------------------------------
# 书源
# ---------------------------------------------------------------------------
def load_all_sources() -> list[dict]:
    """加载全部书源(内置 + 自定义,含禁用),并应用 config.json 的启停覆盖。"""
    with _cfg_lock:
        cfg = _read_cfg()
        states = cfg.get("source_states", {})

        sources = []
        for s in DEFAULT_SOURCES:
            s = dict(s)
            name = s["name"]
            if name in states:  # 用户覆盖过内置源状态
                s["enabled"] = bool(states[name])
            sources.append(s)

        for s in cfg.get("sources", []):  # 自定义源
            s = dict(s)
            s.setdefault("custom", True)
            sources.append(s)

    # 新启用状态的源可能被禁用后未记录 —— 幂等处理
    return sources


def load_sources() -> list[dict]:
    """加载已启用的书源(用于搜索/下载)。"""
    return [s for s in load_all_sources() if s.get("enabled", True)]


def save_sources_state(states: dict[str, bool]) -> None:
    """保存内置源的启用状态覆盖。"""
    with _cfg_lock:
        cfg = _read_cfg()
        cfg["source_states"] = states
        _write_cfg(cfg)


def set_source_state(name: str, enabled: bool) -> None:
    """精准设置单个内置源的启用状态,不影响其他源。"""
    with _cfg_lock:
        cfg = _read_cfg()
        states = cfg.get("source_states", {})
        states[name] = bool(enabled)
        cfg["source_states"] = states
        _write_cfg(cfg)


def add_custom_source(source: dict) -> dict:
    """添加自定义源;名称重复抛 ValueError。"""
    source = {k: v for k, v in source.items() if v not in (None, "")}
    source["custom"] = True
    source.setdefault("enabled", True)
    with _cfg_lock:
        cfg = _read_cfg()
        custom = cfg.get("sources", [])
        for s in custom:
            if s.get("name") == source.get("name"):
                raise ValueError(f"书源名称已存在: {source['name']}")
        custom.append(source)
        cfg["sources"] = custom
        _write_cfg(cfg)
    return source


def update_custom_source(name: str, fields: dict) -> dict | None:
    """按名称更新自定义源字段(含 enabled)。返回更新后的源。"""
    with _cfg_lock:
        cfg = _read_cfg()
        custom = cfg.get("sources", [])
        for s in custom:
            if s.get("name") == name:
                for k, v in fields.items():
                    if v is not None and v != "":
                        s[k] = v
                s["custom"] = True
                cfg["sources"] = custom
                _write_cfg(cfg)
                return s
    return None


def delete_custom_source(name: str) -> bool:
    """删除自定义源。"""
    with _cfg_lock:
        cfg = _read_cfg()
        custom = cfg.get("sources", [])
        rest = [s for s in custom if s.get("name") != name]
        if len(rest) == len(custom):
            return False
        cfg["sources"] = rest
        _write_cfg(cfg)
    return True


def match_source(url: str, sources: list[dict] | None = None) -> dict | None:
    """根据 URL 匹配书源(用于用户直接填入详情页/目录页 URL)。"""
    sources = sources or load_sources()
    host = urlparse(url).netloc.lower()
    for s in sources:
        base_host = urlparse(s["base"]).netloc.lower()
        if host == base_host or host.endswith("." + base_host):
            return s
    return None


def normalize_url(url: str, source: dict) -> str:
    """相对/协议相对地址转绝对地址。"""
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return source["base"].rstrip("/") + url
    return url


# ---------------------------------------------------------------------------
# 全局设置
# ---------------------------------------------------------------------------
def _load_settings_locked() -> dict:
    """读取设置(调用方需已持 _cfg_lock)。"""
    cfg = _read_cfg()
    s = dict(DEFAULT_SETTINGS)
    s.update(cfg.get("settings", {}))
    return s


def load_settings() -> dict:
    with _cfg_lock:
        return _load_settings_locked()


def _save_settings_locked(settings: dict) -> None:
    """保存设置(调用方需已持 _cfg_lock)。"""
    cfg = _read_cfg()
    # 基底先铺 DEFAULT_SETTINGS 再叠旧值/新值:保证 settings 区键完整,
    # 避免旧配置文件缺字段(如 lan_access/clean_rules)导致前端/后端行为不一致
    merged = dict(DEFAULT_SETTINGS)
    merged.update(cfg.get("settings", {}))
    merged.update({k: v for k, v in settings.items() if v is not None})
    cfg["settings"] = merged
    _write_cfg(cfg)


def save_settings(settings: dict) -> None:
    with _cfg_lock:
        _save_settings_locked(settings)


# ---------------------------------------------------------------------------
# 漫画源启停状态(复用 settings 持久化;与 novel.comic.MANGA_SOURCES 对齐)
# ---------------------------------------------------------------------------
def load_comic_source_states() -> dict:
    """返回 {源key: enabled},内置源用元数据默认值,自定义源默认启用;
    未记录的源一律默认启用。"""
    s = load_settings()
    saved = s.get("comic_sources") or {}
    from .comic import MANGA_SOURCES, load_custom_sources  # 延迟导入避免循环依赖
    out: dict = {}
    for k, meta in MANGA_SOURCES.items():
        out[k] = bool(saved.get(k, meta.get("enabled", True)))
    for r in load_custom_sources():  # 自定义源(订阅/导入)状态
        k = r.get("key")
        if k:
            out[k] = bool(saved.get(k, True))
    return out


def save_comic_source_state(name: str, enabled: bool) -> None:
    """持久化单个漫画源的启停状态。"""
    with _cfg_lock:
        s = _load_settings_locked()
        states = dict(s.get("comic_sources") or {})
        states[name] = bool(enabled)
        _save_settings_locked({**s, "comic_sources": states})


# ---------------------------------------------------------------------------
# 书源规则(可分享格式)
# ---------------------------------------------------------------------------
# 分享用书源 JSON 格式(自包含、可复制粘贴传播):
# {
#   "name": "书源名",
#   "base": "https://xxx.com",
#   "charset": "gbk",                 # utf-8 / gbk / gb18030
#   "verify_ssl": true,               # false=忽略证书错误
#   "search_interval": 15,            # 搜索冷却秒数(0=不限)
#   "search": {                       # null=不支持搜索
#     "method": "POST", "path": "/s.php", "param": "s",
#     "extra": {"type": "articlename"}
#   },
#   "book": {"href_pattern": "/book/\\d+/"},        # 搜索结果书籍链接正则
#   "toc": {
#     "url_template": "/newbook/{bid}/",            # 目录页模板,{bid}自动替换
#     "chapter_pattern": "/chapter/\\d+/",          # 章节链接正则
#     "container": "全部章节",                       # 目录容器标题关键词(可选)
#     "reverse": true                               # 目录倒序需反转(可选)
#   },
#   "content": {"selector": "div#content"}          # 正文CSS选择器(可选,留空自动探测)
# }
def export_source_rule(source: dict) -> dict:
    """内部书源 dict → 分享用规则(精简:去除空字段)。"""
    toc = {
        "url_template": source.get("toc_url_template", ""),
        "chapter_pattern": source.get("chapter_href_pattern", ""),
        "container": source.get("toc_container", ""),
        "reverse": bool(source.get("toc_reverse", False)),
    }
    rule = {
        "name": source.get("name", ""),
        "base": source.get("base", ""),
        "charset": source.get("charset", "utf-8"),
        "verify_ssl": bool(source.get("verify_ssl", True)),
        "search_interval": source.get("search_interval", 0),
        "search": source.get("search"),
        "book": {"href_pattern": source.get("book_href_pattern", "")},
        "toc": {k: v for k, v in toc.items() if v not in ("", None, False)},
        "content": {"selector": source.get("content_selector", "")},
    }
    # 去除空字段,保持导出 JSON 简洁
    out = {}
    for k, v in rule.items():
        if v in (None, "", [], {}):
            continue
        if isinstance(v, dict):
            v = {kk: vv for kk, vv in v.items() if vv not in ("", None, [], {})}
            if not v:
                continue
        out[k] = v
    return out


def import_source_rule(rule: dict) -> dict:
    """分享规则 → 内部书源 dict。校验失败抛 ValueError。"""
    if not isinstance(rule, dict):
        raise ValueError("书源必须是 JSON 对象")
    name = str(rule.get("name", "")).strip()
    base = str(rule.get("base", "")).strip()
    if not name:
        raise ValueError("缺少书源名称(name)")
    if not base.startswith("http"):
        raise ValueError("base 必须是 http(s) 开头的地址")
    toc = rule.get("toc") or {}
    book = rule.get("book") or {}
    content = rule.get("content") or {}
    source = {
        "name": name,
        "base": base,
        "charset": rule.get("charset", "utf-8"),
        "verify_ssl": bool(rule.get("verify_ssl", True)),
        "search_interval": int(rule.get("search_interval", 0) or 0),
        "search": rule.get("search"),  # None 或 dict
        "book_href_pattern": book.get("href_pattern", ""),
        "chapter_href_pattern": toc.get("chapter_pattern", ""),
        "toc_url_template": toc.get("url_template", ""),
        "toc_container": toc.get("container", ""),
        "toc_reverse": bool(toc.get("reverse", False)),
        "content_selector": content.get("selector", ""),
        "enabled": True,
        "custom": True,
    }
    return source


def parse_source_rule_text(text: str) -> dict:
    """解析书源 JSON 文本(容错:允许末尾逗号等),失败抛 ValueError。"""
    import re as _re
    try:
        rule = json.loads(text)
    except json.JSONDecodeError:
        # 容错:去掉注释行与末尾逗号后重试
        cleaned = _re.sub(r"(?m)^\s*//.*$", "", text)
        cleaned = _re.sub(r",(\s*[}\]])", r"\1", cleaned)
        try:
            rule = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            raise ValueError(f"JSON 解析失败: {exc}") from exc
    return rule

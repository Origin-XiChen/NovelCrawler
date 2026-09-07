# -*- coding: utf-8 -*-
"""
多源小说爬虫 —— 本地 Web GUI 后端
====================================
使用 Python 标准库 http.server 提供 JSON API,配合 static/index.html 前端。

启动:
    python gui_server.py [--port 8765] [--open]

API:
    GET  /                    → 前端页面
    GET  /api/sources         → 书源列表
    GET  /api/search?q=&src=  → 搜索(src 逗号分隔,可省略)
    GET  /api/book?url=       → 书籍信息 + 章节数
    POST /api/download        → {url,start,end,delay,out_dir} 启动下载
    GET  /api/status?id=      → 下载任务进度
    GET  /api/files           → 已下载文件列表
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import tempfile
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote as _url_quote, urlparse

# ---------------- 桌面窗口控制(HTTP 桥,不依赖 WebView2 JS 桥) ----------------
# window2.py 启动后调用 set_main_hwnd 注册主窗口句柄;前端按钮/拖动/缩放
# 通过 /api/window/* 走 HTTP,即使 WebView2 postMessage 桥不可用也能工作。
import ctypes as _ct
_WIN_HWND = 0
# window2.py 自定义消息(wParam=命中测试码):投递后由 UI 线程发起系统原生
# 移动/缩放循环(必须与 _WM_APP_MOVERESIZE 定义一致)
_WM_APP_MOVERESIZE = 0x8001

# 通用请求头(书源健康体检等模块级复用)
_UA_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0.0.0 Safari/537.36"),
}

if os.name == "nt":
    # 窗口句柄是 64 位指针:不声明 argtypes/restype 会被按 32 位截断,
    # 导致 ShowWindow/SendMessage 静默失败(项目已在 TerminateProcess 上踩过同款坑)
    _u32 = _ct.windll.user32
    _u32.ShowWindow.argtypes = [_ct.c_void_p, _ct.c_int]
    _u32.ShowWindow.restype = _ct.c_int
    _u32.IsZoomed.argtypes = [_ct.c_void_p]
    _u32.IsZoomed.restype = _ct.c_int
    _u32.IsIconic.argtypes = [_ct.c_void_p]
    _u32.IsIconic.restype = _ct.c_int
    _u32.PostMessageW.argtypes = [_ct.c_void_p, _ct.c_uint, _ct.c_void_p, _ct.c_void_p]
    _u32.PostMessageW.restype = _ct.c_int
    _u32.SendMessageW.argtypes = [_ct.c_void_p, _ct.c_uint, _ct.c_void_p, _ct.c_void_p]
    _u32.SendMessageW.restype = _ct.c_long
    _u32.ReleaseCapture.argtypes = []
    _u32.ReleaseCapture.restype = _ct.c_int

def set_main_hwnd(hwnd: int, cache_dir: str = "") -> None:
    global _WIN_HWND, _WV2_CACHE_DIR
    _WIN_HWND = hwnd or 0
    if cache_dir:  # 记录本实例 WebView2 缓存目录,退出时据此识别本子进程
        _WV2_CACHE_DIR = os.path.abspath(cache_dir)

def _get_hwnd() -> int:
    return _WIN_HWND


# 多窗口:阅读器窗口的创建与控制钩子(window2.py 启动时注册)
_WINDOW_CTL_HOOK = None
_OPEN_READER_HOOK = None


def set_window_ctl_hook(fn) -> None:
    """注册阅读器窗口控制回调: fn(action, win, edge) -> dict。"""
    global _WINDOW_CTL_HOOK
    _WINDOW_CTL_HOOK = fn


def set_open_reader_hook(fn) -> None:
    """注册阅读器窗口创建回调: fn(url) -> dict。"""
    global _OPEN_READER_HOOK
    _OPEN_READER_HOOK = fn

_WV2_CACHE_DIR = ""

# ---------------- 远程连接基础设施(热点检测 / 内网穿透 / WebRTC 扫码) ----------------
_REMOTE_LOCK = threading.Lock()


def _get_tunnel():
    """隧道守护单例。"""
    from novel.tunnel import get_manager
    return get_manager()


def _get_wrtc():
    """WebRTC 桥接单例。"""
    from novel.webrtc import get_manager
    return get_manager()


def _get_cam():
    """PC 摄像头扫码单例。"""
    from novel.camscan import get_scanner
    return get_scanner()


def _get_signal():
    """云端信令总线单例(MQTT over WSS,应答码自动回传)。"""
    from novel.signal_mqtt import get_bus
    return get_bus()


def _cam_note(msg: str) -> None:
    """把摄像头扫码过程中的提示写进 WebRTC 事件日志(前端 2s 轮询可见)。"""
    try:
        from novel.webrtc import note as _wrtc_note
        _wrtc_note(msg)
    except Exception:  # noqa: BLE001
        pass


def start_remote_services(srv) -> None:
    """服务启动后初始化远程连接:注册 WebRTC 目标端口 + 按配置自动拉起隧道。

    由 main() / window2.py / desktop.py 在 HTTPServer 创建后调用。
    """
    try:
        port = int(srv.server_address[1])
        _get_wrtc().set_port(port)
    except Exception:  # noqa: BLE001
        pass
    try:
        from novel.config import load_settings as _ls4
        cfg = _ls4()
        if cfg.get("tunnel_autostart") and cfg.get("tunnel_cmd"):
            from novel.tunnel import parse_args
            _get_tunnel().start(cfg["tunnel_cmd"], parse_args(cfg.get("tunnel_args", "")),
                                cfg.get("tunnel_url_regex", ""))
    except Exception:  # noqa: BLE001
        pass


def _kill_webview_children() -> None:
    """退出前清理本实例的 WebView2 子进程。

    实测(原"子进程检测到父进程退出自动清理"的结论有误):宿主被
    TerminateProcess 强杀后,msedgewebview2 浏览器进程(browser + crashpad)
    会成为父进程已死的孤儿,每次开关机都残留一组。
    故退出前按命令行中的 user-data-dir 匹配本实例子进程先行杀掉;
    严格匹配本实例缓存目录,不会误杀系统/其他应用的 WebView2。"""
    if os.name != "nt" or not _WV2_CACHE_DIR:
        return
    try:
        import subprocess as _sp
        ps_cmd = (
            "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" |"
            f" Where-Object {{ $_.CommandLine -like '*{_WV2_CACHE_DIR}*' }} |"
            " ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
        )
        _sp.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_cmd],
                capture_output=True, timeout=8,
                creationflags=0x08000000)  # CREATE_NO_WINDOW:--noconsole 版下 console 子进程会弹新终端窗口,必须抑制
    except Exception:  # noqa: BLE001 清理失败不阻断退出流程
        pass

def _win_state():
    if not _WIN_HWND:
        return {"available": False}
    u32 = _ct.windll.user32
    return {
        "available": True,
        "maximized": bool(u32.IsZoomed(_WIN_HWND)),
        "minimized": bool(u32.IsIconic(_WIN_HWND)),
    }

def _win_minimize() -> None:
    if _WIN_HWND:
        _ct.windll.user32.ShowWindow(_WIN_HWND, 6)  # SW_MINIMIZE

def _win_maximize_toggle() -> None:
    if not _WIN_HWND:
        return
    u32 = _ct.windll.user32
    u32.ShowWindow(_WIN_HWND, 9 if u32.IsZoomed(_WIN_HWND) else 3)  # RESTORE/MAXIMIZE

def _win_close() -> None:
    """关闭窗口并退出进程。

    实测打包版:窗口消息循环被 WebView2 卡住时 WndProc 收不到 WM_CLOSE,
    优雅退出流程最长要等 50+ 秒;threading.Timer 兜底在打包版也未触发。
    故先发 WM_CLOSE(给正常退出一点机会),1.5 秒后兜底 TerminateProcess 强杀。
    兜底放 daemon 线程执行:HTTP 响应立即返回,前端点击关闭不卡顿
    (原同步实现:sleep 1.5s + powershell 清理,前端感知 3s+ 冻结)。

    浏览器模式(无桌面窗口,hwnd 未注册)下不执行强杀,避免误杀纯 Web 服务。
    """
    if not _WIN_HWND:
        return
    _ct.windll.user32.PostMessageW(_WIN_HWND, 0x0010, 0, 0)  # WM_CLOSE
    threading.Thread(target=lambda: (time.sleep(1.5), _force_exit()),
                     daemon=True).start()

def _force_exit() -> None:
    """底层强杀:os._exit 在 PyInstaller onefile 下可能被 bootloader 卡住,
    TerminateProcess 直接终止进程,必然生效(须声明 argtypes,否则静默失败)。
    强杀前先清理本实例 WebView2 子进程(否则成为孤儿残留)。"""
    try:
        _kill_webview_children()
    except Exception:  # noqa: BLE001
        pass
    try:
        _k32 = _ct.windll.kernel32
        _k32.GetCurrentProcess.restype = _ct.c_void_p
        _k32.TerminateProcess.restype = _ct.c_int
        _k32.TerminateProcess.argtypes = [_ct.c_void_p, _ct.c_uint]
        _k32.TerminateProcess(_k32.GetCurrentProcess(), 0)
    except Exception:  # noqa: BLE001
        try:
            os._exit(0)
        except Exception:  # noqa: BLE001
            pass

def _win_drag() -> None:
    """标题栏按下 → 投递自定义消息给主窗口,由 UI 线程发起系统原生拖动循环。

    旧实现直接在 HTTP 线程调 ReleaseCapture+SendMessageW(WM_NCLBUTTONDOWN):
    ① ReleaseCapture 只对持有捕获的当前线程生效(WebView2 子窗口的捕获在
    UI 线程),跨线程调用静默失败;② lParam=0 使拖动起始点变成屏幕 (0,0);
    ③ 窗口缺 WS_THICKFRAME 时 DefWindowProc 不进入移动循环。
    现改为 PostMessage(跨线程投递可靠,关闭按钮已验证),window2.py 在窗口
    所属线程用真实光标坐标发起循环。
    """
    if not _WIN_HWND:
        return
    _ct.windll.user32.PostMessageW(_WIN_HWND, _WM_APP_MOVERESIZE, 2, 0)  # 2=HTCAPTION

_HT_EDGE = {
    "left": 10, "right": 11, "top": 12, "bottom": 15,
    "top-left": 13, "top-right": 14, "bottom-left": 16, "bottom-right": 17,
}

def _win_resize(edge: str = "") -> None:
    """窗口边缘按下 → 投递自定义消息,UI 线程发起系统原生缩放循环。"""
    ht = _HT_EDGE.get(edge or "")
    if not ht or not _WIN_HWND:
        return
    _ct.windll.user32.PostMessageW(_WIN_HWND, _WM_APP_MOVERESIZE, ht, 0)

from novel.config import (
    add_custom_source,
    delete_custom_source,
    export_source_rule,
    import_source_rule,
    load_all_sources,
    get_out_dir,
    load_settings,
    parse_source_rule_text,
    save_settings,
    set_source_state,
    update_custom_source,
)
from novel.downloader import download_book, fetch_toc, safe_filename
from novel.fetcher import Fetcher
from novel.paths import APP_DATA_DIR, COMIC_OUT_DIR
from novel.parser import parse_content, parse_toc
from novel.reader import chapter_count, read_chapter, read_meta
from novel.searcher import Book, book_from_url, search_all
from novel.shelf import add_to_shelf, find_entry, load_shelf, remove_from_shelf, update_entry
from novel.source_registry import (candidates_status, load_candidates, save_candidates,
                                   sync as sync_sources, add_subscription,
                                   load_subscriptions, remove_subscription,
                                   resolve_repo_file, save_subscriptions)

if getattr(sys, "frozen", False):  # 打包为 exe:数据落在 exe 同目录,static 在临时解压目录
    ROOT = os.path.dirname(sys.executable)
    STATIC_DIR = os.path.join(sys._MEIPASS, "static")
    ICON_DIR_FROZEN = os.path.join(sys._MEIPASS, "icon")  # 打包内嵌的默认图标(用于首次启动释放)
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
    STATIC_DIR = os.path.join(ROOT, "static")
    ICON_DIR_FROZEN = os.path.join(ROOT, "icon")

# 图标目录:exe 同目录的 icon/(用户可自定义/替换)
ICON_DIR = os.path.join(ROOT, "icon")

# 单 exe 首次启动:自动从打包内嵌释放默认图标到 exe 同目录,以后用户可以自由替换
if getattr(sys, "frozen", False):
    try:
        os.makedirs(ICON_DIR, exist_ok=True)
        if os.path.isdir(ICON_DIR_FROZEN):
            import shutil as _sh
            for _f in os.listdir(ICON_DIR_FROZEN):
                _src = os.path.join(ICON_DIR_FROZEN, _f)
                _dst = os.path.join(ICON_DIR, _f)
                if not os.path.exists(_dst):
                    _sh.copy2(_src, _dst)
    except Exception:  # noqa: BLE001
        pass

# 共享请求器(代理/SSL 随全局设置动态调整)
_settings = load_settings()
_fetcher = Fetcher()
_fetcher.proxy = _settings.get("proxy") or None
_fetcher.verify = bool(_settings.get("verify_ssl", True))


def _sync_fetcher() -> None:
    """把全局设置同步到共享请求器。"""
    s = load_settings()
    _fetcher.proxy = s.get("proxy") or None
    _fetcher.verify = bool(s.get("verify_ssl", True))

# 下载任务注册表: {task_id: {...}}
_tasks: dict[str, dict] = {}
_tasks_lock = threading.Lock()
_task_seq = 0

# 目录缓存(避免重复拉取目录导致界面长时间卡顿): {url: (time, info_dict)}
_toc_cache: dict[str, tuple[float, dict]] = {}
_TOC_TTL = 600  # 10 分钟

# 书源仓库同步状态
_sync_state: dict = {"running": False}

# 异步搜索任务: {task_id: {"q","state","done","total","sources":[],"result","error"}}
_search_tasks: dict[str, dict] = {}

# 异步漫画搜索任务: {task_id: {"q","state","done","total","sources":[],"batches":[],"errors","result"}}
_comic_search_tasks: dict[str, dict] = {}

# 书源体检状态
_health_state: dict = {"running": False, "dead": [], "total": 0}
import uuid as _uuid


def _next_task_id() -> str:
    global _task_seq
    with _tasks_lock:
        _task_seq += 1
        return f"t{_task_seq}"


# ---- auto delay:按 host 智能选择最小安全间隔 ----
# _host_stats[host] = {'samples': [最近响应ms, ...](最多20), 'last_429_at': ts, 'last_403_at': ts}
_host_stats: dict[str, dict] = {}
_auto_lock = threading.Lock()


def _compute_auto_delay(url: str) -> float:
    """根据 host 最近响应/风控样本智能选择最小安全章节间隔(秒)。

    策略:
      - 60s 内出现 429/403 风控 → 3.0s 保守(防封禁)
      - 最近 5 个样本平均响应 < 500ms 且无错误 → 0.2s 极速
      - 平均响应 500-1500ms → 0.5s 快速
      - 平均响应 > 1500ms → 1.0s 标准
      - 样本 < 3 → 0.5s 保守起步
    """
    from urllib.parse import urlparse
    import time as _time
    try: host = urlparse(url).hostname or ''
    except Exception: host = ''
    if not host: return 0.5
    now = _time.time()
    with _auto_lock:
        st = _host_stats.get(host)
    if not st or len(st.get('samples', [])) < 3: return 0.5
    if (now - (st.get('last_429_at') or 0) < 60) or (now - (st.get('last_403_at') or 0) < 60):
        return 3.0
    recent = st['samples'][-5:]
    avg_ms = sum(recent) / len(recent)
    if avg_ms < 500: return 0.2
    if avg_ms < 1500: return 0.5
    return 1.0


def _record_host_perf(url: str, resp_ms: float, status: int | None = None) -> None:
    """记录某 host 的一次请求性能(响应毫秒)和风控状态,供 auto delay 评估。"""
    from urllib.parse import urlparse
    import time as _time
    try: host = urlparse(url).hostname or ''
    except Exception: host = ''
    if not host: return
    now = _time.time()
    with _auto_lock:
        st = _host_stats.setdefault(host, {'samples': [], 'last_429_at': 0.0, 'last_403_at': 0.0})
        st['samples'].append(resp_ms)
        if len(st['samples']) > 20: st['samples'] = st['samples'][-20:]
        if status == 429: st['last_429_at'] = now
        elif status == 403: st['last_403_at'] = now


def _prune_tasks() -> None:
    """修剪已完成且前端已读走终态的任务,防止 _tasks 注册表无限增长。

    前端每 900ms 轮询 /api/status,读到终态(done/error/cancelled)后
    即停止轮询并移除本地记录 → _last_read 不再更新。
    注意:前端任务面板只显示活跃任务,已完成/失败入历史任务面板。
    延迟清理 30s(前端轮询间隔 900ms,确认终态+写入历史够用)。"""
    now = time.time()
    with _tasks_lock:
        for tid in [k for k, v in _tasks.items()
                    if v.get("state") in ("done", "error", "cancelled")
                    and now - v.get("_last_read", 0) > 30]:
            _tasks.pop(tid, None)


# 支持暂停的任务类型(worker 循环内实现了 _pause_wait 等待恢复)
_PAUSABLE_KINDS = ("chapter_download", "comic_download")

# 暂停最长等待时长(秒)。超时不能再"静默继续下载"——前端仍显示已暂停、
# 后台却在跑,属于状态不一致;这里统一落到"已停止"终态。
_PAUSE_TIMEOUT = 3600


# 搜索任务最长保留时长(秒):正常由 /api/search_result 取走后 pop,
# 但搜索页被关闭/放弃时没人来取,结果会常驻内存 → 兜底回收。
_SEARCH_TTL = 900


def _prune_search_tasks() -> None:
    """回收已结束/已暂停且长时间无人取结果的搜索任务,防止 _search_tasks 泄漏。"""
    now = time.time()
    with _tasks_lock:
        for tid in [k for k, v in _search_tasks.items()
                    if v.get("state") in ("done", "error", "paused", "cancelled")
                    and now - v.get("added", 0) > _SEARCH_TTL]:
            _search_tasks.pop(tid, None)


def _pause_wait(t: dict) -> None:
    """暂停阻塞:等到恢复 / 被取消 / 超时,任一发生即返回或抛 DownloadCancelled。

    供所有支持暂停的 worker 复用(章节下载 / 漫画下载),避免各写一份
    且行为不一致(此前两处实现超时后都会静默恢复下载)。
    """
    from novel.downloader import DownloadCancelled
    waited = 0.0
    while t.get("state") == "paused" and waited < _PAUSE_TIMEOUT:
        time.sleep(0.5)
        waited += 0.5
    if t.get("state") == "cancelled":
        raise DownloadCancelled("用户已停止任务")
    if t.get("state") == "paused":
        # 超时:明确置为已停止,释放 worker 线程
        t["state"] = "cancelled"
        t["current"] = f"暂停超过 {int(_PAUSE_TIMEOUT // 3600)} 小时,已自动停止"
        raise DownloadCancelled("暂停超时,任务已自动停止")


def _run_download(task_id: str, book: Book, opts: dict) -> None:
    """后台线程执行下载。"""
    t = _tasks[task_id]

    def log(msg: str) -> None:
        t["logs"].append(msg)
        if len(t["logs"]) > 300:
            t["logs"] = t["logs"][-300:]

    def progress(idx: int, total: int, title: str, err: bool = False) -> None:
        t["done"] = idx
        t["total"] = total
        t["current"] = title
        t["last_err"] = err

    try:
        log("▶ 开始下载任务")
        fmt = (opts.get("format") or "txt").lower()

        from novel.downloader import DownloadCancelled

        def cancel_check() -> None:
            """停止/暂停检查:被 worker 循环周期调用。"""
            state = t.get("state")
            if state == "cancelled":
                raise DownloadCancelled("用户已停止任务")
            if state == "paused":
                # 暂停:阻塞等待恢复(期间仍可取消;超时按停止处理)
                _pause_wait(t)

        # auto:基于源最近的响应/风控样本智能选择最小安全间隔(起步 0.5s,效率更高)
        delay_raw = opts.get("delay", 1.2)
        if isinstance(delay_raw, str) and delay_raw == "auto":
            delay = _compute_auto_delay(book.url if hasattr(book, 'url') else '')
        else:
            try: delay = float(delay_raw)
            except (TypeError, ValueError): delay = 1.2
        if not math.isfinite(delay) or delay < 0: delay = 0.5
        out = download_book(
            book,
            out_dir=opts.get("out_dir", "downloads"),
            start=int(opts.get("start", 1)),
            end=int(opts.get("end") or 0) or None,
            delay=delay,
            fetcher=_fetcher,
            quiet=True,
            format=fmt,
            workers=int(opts.get("workers", 1)),
            on_log=log,
            on_progress=progress,
            cancel_check=cancel_check,
        )
        t["state"] = "done"
        t["out_path"] = out
        log(f"任务完成 → {out}")
        try:
            from novel.tasklog import log_task
            log_task("章节下载", book.title, "ok", f"共 {t.get('total', 0)} 章",
                     file=os.path.basename(out) if out else "",
                     size=os.path.getsize(out) if out and os.path.isfile(out) else 0,
                     source=book.source)
        except Exception:  # noqa: BLE001
            pass
        # 下载完成 → 默认加入书架(本地文件收藏)
        try:
            from novel.shelf import add_to_shelf as _add_shelf
            _add_shelf(book.title, book.url, book.source)
        except Exception:  # noqa: BLE001
            pass
    except DownloadCancelled as exc:  # 用户停止/暂停后被取消
        t["state"] = "cancelled"
        t["error"] = str(exc)
        # 不改 done,保留真实已下载进度(避免进度条显示 100%)
        log(f"⏹ {exc}")
        try:
            from novel.tasklog import log_task
            log_task("章节下载", book.title, "fail", f"已停止(下载到第 {t.get('done', 0)} 章)",
                     source=book.source)
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        t["state"] = "error"
        t["error"] = str(exc)
        log(f"任务失败: {exc}")
        try:
            from novel.tasklog import log_task
            log_task("章节下载", book.title, "fail", str(exc)[:200], source=book.source)
        except Exception:  # noqa: BLE001
            pass


def _run_opds_download(task_id: str, url: str, title: str, mode: str = "server") -> None:
    """OPDS EPUB 后台下载。

    mode="server":等待 opds.wol.moe 服务端生成(无限轮询,无进度,5+ 分钟)。
                  轮询超过 5 次(约 2.5 分钟)后置 slow_warn=True,前端气泡闪红提醒,
                  用户可点进详情切换为本地直抓。
    mode="local":从 wenku8 主站本地直抓,真实进度(第 N/330 章),约 1-2 分钟。
    """
    import requests as _rq
    from novel.downloader import safe_filename
    from novel.tasklog import log_task

    t = _tasks.get(task_id)
    if t is None:
        return

    def log(msg: str) -> None:
        if "logs" not in t:
            t["logs"] = []
        t["logs"].append(msg)
        if len(t["logs"]) > 200:
            t["logs"] = t["logs"][-200:]
        t["current"] = msg

    def cancel_check() -> None:
        state = t.get("state")
        if state == "cancelled":
            from novel.downloader import DownloadCancelled
            raise DownloadCancelled("用户已停止任务")

    def finalize_success(path: str, size: int, source_name: str = "OPDS") -> None:
        t["out_path"] = path
        t["done"] = 100
        t["total"] = 100
        t["indeterminate"] = False
        t["state"] = "done"
        fname = os.path.basename(path)
        log(f"✓ 已保存: {fname} ({size // 1024} KB)")
        log_task("OPDS下载", title, "ok", "EPUB 下载完成",
                 file=fname, size=size, source=source_name,
                 extra={"url": url, "task_id": task_id, "mode": mode})
        # 下载完成 → 默认加入书架(携带封面,书架显示真实封面)
        try:
            from novel.shelf import add_to_shelf as _add_shelf
            _add_shelf(title, url, "OPDS", t.get("cover", ""))
        except Exception:  # noqa: BLE001
            pass

    # ============ 本地直抓模式 ============
    if mode == "local":
        from novel import wenku8
        book_id = wenku8.extract_book_id(url)
        if not book_id:
            t["error"] = "无法从链接解析书 ID,本地直抓不可用(请改用服务端模式)"
            t["state"] = "error"
            return
        log("▶ 本地直抓模式:直接从 wenku8 主站抓取,进度真实")
        try:
            out_dir = get_out_dir()
            os.makedirs(out_dir, exist_ok=True)

            def progress(idx: int, total: int, chap_title: str, err: bool = False) -> None:
                t["done"] = idx
                t["total"] = total
                t["indeterminate"] = False
                t["current"] = f"第 {idx}/{total} 章 {chap_title[:20]}"

            path = wenku8.download_local_epub(
                book_id, title, out_dir,
                on_log=log,
                on_progress=progress,
                cancel_check=cancel_check,
                delay=0.1,
                workers=4,
                img_workers=4,
            )
            size = os.path.getsize(path) if os.path.isfile(path) else 0
            finalize_success(path, size, source_name="wenku8本地")
        except Exception as exc:  # noqa: BLE001
            from novel.downloader import DownloadCancelled
            if isinstance(exc, DownloadCancelled):
                t["state"] = "cancelled"
                t["error"] = str(exc)
                log(f"⏹ {exc}")
                return
            t["error"] = f"本地直抓失败: {exc}"
            t["state"] = "error"
            log("✗ " + t["error"])
        return

    # ============ 服务端轮询模式 ============
    # 加载 cookies(若用户验证过)
    ck = None
    try:
        from novel.paths import OPDS_COOKIES_PATH
        if os.path.isfile(OPDS_COOKIES_PATH):
            with open(OPDS_COOKIES_PATH, encoding="utf-8") as f:
                cks = json.load(f)
            if isinstance(cks, list):
                ck = _rq.utils.cookiejar_from_dict(
                    {c["name"]: c["value"] for c in cks if c.get("name")})
    except Exception:  # noqa: BLE001
        ck = None

    poll_interval = 30
    MAX_WAIT = 1200  # 服务端生成超时上限(秒):WoL.moe 标称 5-15 分钟,留余量
    start_ts = time.time()
    poll_count = 0
    SLOW_WARN_AFTER = 5  # 轮询超过 5 次(约 2.5 分钟)提醒可切本地直抓
    while t.get("state") != "cancelled":
        # 服务端生成超时上限:超时置错退出,避免无限占线程(只能靠用户取消)
        if time.time() - start_ts > MAX_WAIT:
            err = (f"服务端生成超时(已等 {int(time.time()-start_ts)}s),"
                   f"请改用【本地直抓】模式重试(更快,约 1-2 分钟)")
            t["error"] = err
            t["state"] = "error"
            t["indeterminate"] = False
            log_task("OPDS下载", title, "fail", err, source="OPDS",
                     extra={"url": url, "task_id": task_id, "mode": mode})
            log("✗ " + err)
            return
        # 若用户中途切换为 local,跳转到本地直抓
        if t.get("mode") == "local":
            log("⏩ 用户已切换为本地直抓模式,重新开始…")
            t["mode"] = "server"  # 避免死循环
            return _run_opds_download(task_id, url, title, "local")
        poll_count += 1
        # 模糊进度:不假装有百分比,前端用 total=0 识别为 indeterminate
        t["done"] = 0
        t["total"] = 0
        t["indeterminate"] = True
        t["poll_count"] = poll_count
        t["elapsed"] = int(time.time() - start_ts)
        # 超过阈值:置 slow_warn,前端气泡闪红 + 可切换本地直抓
        if poll_count >= SLOW_WARN_AFTER:
            t["slow_warn"] = True
            log(f"⏳ 已等待 {int(time.time()-start_ts)}s,服务端仍未生成完毕;可点进任务详情切换「本地直抓」(更快,约 1-2 分钟)")
        else:
            log(f"⏳ 第 {poll_count} 次检查(已等 {int(time.time()-start_ts)}s,服务端可能仍需 1-5 分钟)…")
        r = None
        try:
            r = _rq.get(url, headers={"User-Agent": "Mozilla/5.0"},
                        cookies=ck, timeout=180)
            t["http_status"] = r.status_code
            if r.status_code == 200 and len(r.content) > 100 and r.content[:2] == b"PK":
                out_dir = get_out_dir()
                os.makedirs(out_dir, exist_ok=True)
                fname = safe_filename(title) + ".epub"
                path = os.path.join(out_dir, fname)
                with open(path, "wb") as f:
                    f.write(r.content)
                finalize_success(path, len(r.content))
                return
            if r.status_code in (401, 403):
                try:
                    from novel.verify import add_pending
                    add_pending(url, "OPDS " + title[:20])
                except Exception:  # noqa: BLE001
                    pass
                t["error"] = "被反爬拦截(403),请到验证中心手动验证该站点后再试"
                t["state"] = "error"
                t["indeterminate"] = False
                log_task("OPDS下载", title, "fail", t["error"], source="OPDS",
                         extra={"url": url, "task_id": task_id, "mode": mode})
                log("✗ " + t["error"])
                return
            if r.status_code == 202:
                log("  服务端生成中(202),继续等待…")
            elif 200 <= r.status_code < 300:
                log(f"  HTTP {r.status_code},但内容非 EPUB 格式({len(r.content)} 字节),继续检查")
            elif 400 <= r.status_code < 600:
                err_msg = f"服务端异常 HTTP {r.status_code}(已检查 {poll_count} 次,已等 {int(time.time()-start_ts)}s),请稍后重试"
                t["error"] = err_msg
                t["state"] = "error"
                t["indeterminate"] = False
                log_task("OPDS下载", title, "fail", err_msg, source="OPDS",
                         extra={"url": url, "task_id": task_id, "mode": mode})
                log("✗ " + err_msg)
                return
            else:
                log(f"  HTTP {r.status_code},继续检查")
        except Exception as exc:  # noqa: BLE001
            log(f"  请求异常: {type(exc).__name__}: {str(exc)[:80]},继续检查")
        if t.get("state") == "cancelled":
            log("已取消")
            return
        # 等待间隔(可取消;期间若用户切换本地直抓则立即跳转)
        for _ in range(poll_interval):
            if t.get("state") == "cancelled":
                log("已取消")
                return
            if t.get("mode") == "local":
                log("⏩ 用户已切换为本地直抓模式,重新开始…")
                return _run_opds_download(task_id, url, title, "local")
            time.sleep(1)


def _run_comic_download(task_id: str, title: str, chapters: list[dict],
                        source: str = "mangadex", comic_id: str = "",
                        mode: str = "per_chapter") -> None:
    """漫画后台下载:按 mode 打包(每话 PDF / 融合 PDF / ZIP)。"""
    from novel import comic as _comic
    from novel.downloader import DownloadCancelled
    from novel.tasklog import log_task

    t = _tasks.get(task_id)
    if t is None:
        return

    def log(msg: str) -> None:
        if "logs" not in t:
            t["logs"] = []
        t["logs"].append(msg)
        if len(t["logs"]) > 200:
            t["logs"] = t["logs"][-200:]
        t["current"] = msg

    def cancel_check() -> None:
        if t.get("state") == "cancelled":
            raise DownloadCancelled("用户已停止任务")
        if t.get("state") == "paused":
            # 暂停:轮询等待恢复,期间响应取消;超时按停止处理
            _pause_wait(t)

    def progress(done: int, total: int, label: str, err: bool = False) -> None:
        t["done"] = done
        t["total"] = total or len(chapters)
        t["current"] = f"第 {done}/{total} 话 {label[:24]}"
        if done >= total:
            t["done"] = total
            t["indeterminate"] = False

    src_name = "MangaDex" if source != "copymanga" else "拷贝漫画"
    try:
        made = _comic.download_comic(
            title, chapters, COMIC_OUT_DIR,
            on_log=log, on_progress=progress, cancel_check=cancel_check,
            img_workers=6, source=source, manga_id=comic_id, mode=mode,
            pdf_quality=load_settings().get("pdf_quality") or "hq",
        )
        if not made:
            t["error"] = "全部话下载失败,未生成 PDF"
            t["state"] = "error"
            t["indeterminate"] = False
            log_task("漫画下载", title, "fail", t["error"])
            return
        t["state"] = "done"
        t["done"] = len(chapters)
        t["total"] = len(chapters)
        t["out_path"] = os.path.dirname(made[0])
        t["indeterminate"] = False
        total_size = sum(os.path.getsize(f) for f in made)
        log(f"✓ 漫画下载完成: {len(made)} 个 PDF → {os.path.dirname(made[0])}")
        log_task("漫画下载", title, "ok", f"{len(made)} 个 PDF",
                 file=os.path.basename(os.path.dirname(made[0])), size=total_size,
                 source=src_name, extra={"task_id": task_id})
        # 下载完成静默导入漫画收藏(去重)
        try:
            from novel.shelf import add_comic_shelf
            add_comic_shelf(title, source or "mangadex", comic_id or "")
        except Exception:  # noqa: BLE001
            pass
    except DownloadCancelled:
        t["state"] = "cancelled"
        log("已取消")
    except Exception as exc:  # noqa: BLE001
        t["error"] = f"漫画下载失败: {exc}"
        t["state"] = "error"
        t["indeterminate"] = False
        log("✗ " + t["error"])
        log_task("漫画下载", title, "fail", t["error"])


class Handler(BaseHTTPRequestHandler):
    server_version = "NovelGUI/1.0"

    # ---------------- 基础 ----------------
    def _send_json(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, data: bytes, content_type: str, cache: bool = False) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: str, content_type: str, as_attachment: bool = False, filename: str = "", progress=None) -> None:
        """发送文件(流式,64KB 分块)。progress(sent, total) 可选:下载进度回调(手机同步追踪用)。

        内联 PDF(桌面端 pdf.js 阅读)支持 HTTP Range:pdf.js 检测到 Accept-Ranges +
        Content-Length 后按 256KB 分段按需拉取,避免整本(48~150MB)一次性读入内存。
        附件下载(?dl=1)与其他类型文件不受影响,保持 200 全量。"""
        total = os.path.getsize(path)
        # ---- 解析 Range 头(仅内联 PDF;只支持单区间,多区间/非法格式回退 200 全量) ----
        is_pdf = content_type.startswith("application/pdf")
        rng_start = rng_end = -1
        if not as_attachment and is_pdf:
            m = re.fullmatch(r"\s*bytes=(\d*)-(\d*)\s*", self.headers.get("Range") or "")
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    rng_start = int(m.group(1))
                    rng_end = int(m.group(2)) if m.group(2) else total - 1
                    if rng_end >= total:
                        rng_end = total - 1
                elif int(m.group(2)) > 0:
                    # 后缀区间 bytes=-N:最后 N 字节
                    rng_start = max(0, total - int(m.group(2)))
                    rng_end = total - 1
        range_ok = 0 <= rng_start <= rng_end < total
        if not range_ok and rng_start >= total:
            # 起点越界 → 416
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{total}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start = rng_start if range_ok else 0
        length = (rng_end - start + 1) if range_ok else total
        self.send_response(206 if range_ok else 200)
        self.send_header("Content-Type", content_type)
        if range_ok:
            self.send_header("Content-Range", f"bytes {start}-{rng_end}/{total}")
        elif is_pdf:
            # pdf.js 依据该头 + Content-Length 判定是否走分段请求
            self.send_header("Accept-Ranges", "bytes")
        if as_attachment:
            # 手机/浏览器直接下载(如 mobile 页"下载 EPUB"):RFC 5987 编码中文文件名
            fn = filename or os.path.basename(path)
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{_url_quote(fn)}")
        # HTML 不缓存,保证前端改动即时生效(避免旧 JS 导致功能"失效"假象)
        if path.endswith(".html"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(path, "rb") as f:
            if start:
                f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionError, BrokenPipeError, TimeoutError):
                    # 客户端中断(pdf.js 启用 disableStream 时会取消首个全量请求、
                    # 用户关窗/刷新也会中止下载)——正常现象,静默结束本次响应
                    return
                remaining -= len(chunk)
                if progress:
                    progress(length - remaining, length)

    # ---------------- 手机同步会话追踪 ----------------
    # 手机页打开时生成 sid,下载请求带 ?sid= 登记;电脑端设置页轮询 /api/sync_status
    # 显示每台手机的连接状态与每个文件的同步进度(双端实时)。
    _sync_sessions: dict = {}
    _sync_lock = threading.RLock()

    def _sync_touch(self, sid: str, task: str = "", size: int = 0, sent: int = -1, status: str = "") -> None:
        """登记/更新手机会话与单个文件的同步进度(线程安全)。"""
        if not sid or len(sid) > 64:
            return
        now = time.time()
        with self._sync_lock:
            s = self._sync_sessions.get(sid)
            if s is None:
                s = {"ip": "", "ua": "", "first_seen": now, "last_seen": now, "tasks": {}}
                self._sync_sessions[sid] = s
                try:
                    s["ip"] = self.client_address[0] if self.client_address else ""
                except Exception:  # noqa: BLE001
                    pass
                s["ua"] = (self.headers.get("User-Agent") or "")[:120]
            s["last_seen"] = now
            if task:
                t = s["tasks"].get(task)
                if t is None:
                    t = {"name": task, "size": 0, "sent": 0, "status": "waiting", "t0": now, "t1": 0}
                    s["tasks"][task] = t
                if size:
                    t["size"] = size
                if sent >= 0:
                    t["sent"] = sent
                if status:
                    t["status"] = status
                    if status == "done":
                        t["t1"] = now

    def _api_sync_status(self, qs: dict):
        """GET /api/sync_status  → 手机同步会话与任务进度。

        电脑端(无 sid):返回全部会话(IP/UA/在线状态/任务进度条数据);
        手机端(?sid=&hello=1):登记会话并返回自己的任务状态(同步面板轮询)。
        """
        sid = (qs.get("sid") or [""])[0].strip()
        now = time.time()
        with self._sync_lock:
            # 清理 24h 无活动的僵尸会话
            for k in [k for k, v in self._sync_sessions.items() if now - v["last_seen"] > 86400]:
                del self._sync_sessions[k]
            if sid:
                if qs.get("hello"):
                    self._sync_touch(sid)
                s = self._sync_sessions.get(sid)
                if s is not None:
                    # 与电脑端格式一致:tasks 为排序后的任务列表
                    s2 = dict(s)
                    s2["tasks"] = sorted(s["tasks"].values(), key=lambda t: t["t0"])
                    return self._send_json({"sid": sid, "session": s2})
                return self._send_json({"sid": sid, "session": None})
            items = []
            for k, v in self._sync_sessions.items():
                items.append({
                    "sid": k, "ip": v["ip"], "ua": v["ua"],
                    "first_seen": v["first_seen"], "last_seen": v["last_seen"],
                    "online": now - v["last_seen"] < 300,
                    "tasks": sorted(v["tasks"].values(), key=lambda t: t["t0"]),
                })
        # 兼容旧字段(书源仓库同步状态),旧前端 pollSync 仍读 stage/processed/ok
        return self._send_json({**dict(_sync_state), "sessions": items})

    def log_message(self, fmt, *args):  # 静默访问日志
        pass

    # ---------------- 路由 ----------------
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            return self._send_file(os.path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8")
        if path == "/mobile":
            # 手机阅读窗口:轻量移动端页面(局域网扫码后阅读本地书)
            return self._send_file(os.path.join(STATIC_DIR, "mobile.html"), "text/html; charset=utf-8")
        if path == "/reader.html":
            # 独立阅读器窗口:桌面模式第二窗口 / 浏览器弹窗加载的阅读器页面
            return self._send_file(os.path.join(STATIC_DIR, "reader.html"), "text/html; charset=utf-8")
        if path == "/direct":
            # 「远程直连」独立连接页:隧道扫码/本地文件打开均可完成 P2P 直连;
            # ?dl=1 → 作为附件下载(电脑端「下载连接文件」发给手机用)
            return self._send_file(os.path.join(STATIC_DIR, "direct.html"),
                                   "text/html; charset=utf-8",
                                   as_attachment=bool(qs.get("dl")),
                                   filename="漫画+小说-远程直连.html")
        if path == "/offline-mobile":
            # 离线手机页:单文件内嵌书架+阅读内容,保存后电脑关闭也能离线打开
            return self._build_offline_page(qs)
        if path == "/api/sources":
            return self._send_json({"sources": load_all_sources()})
        if path == "/api/settings":
            return self._api_settings()
        if path == "/api/search":
            return self._api_search(qs)
        if path == "/api/search_async":
            return self._api_search_async(qs)
        if path == "/api/search_progress":
            return self._api_search_progress(qs)
        if path == "/api/search_result":
            return self._api_search_result(qs)
        if path == "/api/search_pause":
            return self._api_search_pause(qs)
        if path == "/api/book":
            return self._api_book(qs)
        if path == "/api/status":
            return self._api_status(qs)
        if path == "/api/tasks_active":
            return self._api_tasks_active()
        if path == "/api/tasks_all":
            return self._api_tasks_all()
        if path == "/api/files":
            return self._api_files()
        if path == "/api/test_source":
            return self._api_test_source(qs)
        if path == "/api/read_meta":
            return self._api_read_meta(qs)
        if path == "/api/read":
            return self._api_read(qs)
        if path == "/api/online_read":
            return self._api_online_read(qs)
        if path == "/api/shelf":
            return self._api_shelf_list()
        if path == "/api/source_rule":
            return self._api_source_rule(qs)
        if path == "/api/sync_status":
            return self._api_sync_status(qs)
        if path == "/api/source_candidates":
            return self._api_source_candidates()
        if path == "/api/subscriptions":
            return self._api_subscriptions_list()
        if path == "/api/opds":
            return self._api_opds(qs)
        if path == "/api/comic_search":
            return self._api_comic_search(qs)
        if path == "/api/comic_search_async":
            return self._api_comic_search_async(qs)
        if path == "/api/comic_search_progress":
            return self._api_comic_search_progress(qs)
        if path == "/api/comic_search_result":
            return self._api_comic_search_result(qs)
        if path == "/api/comic_sources":
            return self._api_comic_sources()
        if path == "/api/comic_subscriptions":
            return self._api_comic_subscriptions_list()
        if path == "/api/comic_subscriptions/pending":
            return self._api_comic_subscriptions_pending(qs)
        if path == "/api/comic_toc":
            return self._api_comic_toc(qs)
        if path == "/api/comic_files":
            return self._api_comic_files(qs)
        if path == "/api/comic_pages":
            return self._api_comic_pages(qs)
        if path == "/api/comic_img":
            return self._api_comic_img(qs)
        if path == "/api/comic_cover":
            return self._api_comic_cover(qs)
        if path == "/api/comic_pdf_meta":
            return self._api_comic_pdf_meta(qs)
        if path == "/api/comic_page_meta":
            return self._api_comic_page_meta(qs)
        if path == "/api/comic_page_image":
            return self._api_comic_page_image(qs)
        if path == "/api/comic_pack":
            return self._api_comic_pack(qs)
        if path == "/api/comic_shelf":
            return self._api_comic_shelf(qs)
        if path == "/api/comic_shelf_backup":
            return self._api_comic_shelf_backup()
        if path == "/api/verify_status":
            return self._api_verify_status()
        if path == "/api/verify_pending":
            return self._api_verify_pending()
        if path == "/api/source_health":
            return self._api_source_health()
        if path == "/api/source_health_status":
            return self._api_source_health_status()
        if path == "/api/epub_meta":
            return self._api_epub_meta(qs)
        if path == "/api/notes":
            return self._api_notes(qs)
        if path == "/api/network":
            return self._api_network(qs)
        if path == "/api/hotspot":
            return self._api_hotspot(qs)
        if path == "/api/tunnel":
            return self._api_tunnel()
        if path == "/api/webrtc/offer":
            return self._api_webrtc_offer()
        if path == "/api/webrtc/status":
            return self._api_webrtc_status()
        if path == "/api/qr":
            return self._api_qr(qs)
        if path == "/api/ping":
            return self._send_json({"ok": 1, "t": int(time.time())})
        if path == "/api/snapshot_status":
            return self._api_snapshot_status(qs)
        if path == "/api/snapshot_download":
            return self._api_snapshot_download(qs)
        if path == "/api/source_candidates":
            return self._api_source_candidates()
            return self._api_shelf_backup()
        if path == "/api/epub_read":
            return self._api_epub_read(qs)
        if path == "/api/epub_asset":
            return self._api_epub_asset(qs)
        if path == "/api/epub_online":
            return self._api_epub_online(qs)
        if path == "/api/epub_online_read":
            return self._api_epub_online_read(qs)
        if path == "/api/epub_online_asset":
            return self._api_epub_online_asset(qs)
        if path == "/api/cover":
            return self._api_cover(qs)
        if path == "/api/task_history":
            return self._api_task_history()
        if path == "/api/window/state":
            return self._send_json(_win_state())
        if path.startswith("/static/"):
            fp = os.path.normpath(os.path.join(STATIC_DIR, path[len("/static/"):]))
            base = os.path.abspath(STATIC_DIR)
            if (fp == base or fp.startswith(base + os.sep)) and os.path.isfile(fp):
                ext = os.path.splitext(fp)[1].lower()
                ctype = {
                    ".css": "text/css", ".js": "application/javascript",
                    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
                    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                    ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
                    ".webmanifest": "application/manifest+json",
                    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
                }.get(ext, "application/octet-stream")
                return self._send_file(fp, ctype)
        if path.startswith("/icon/"):
            # 用户可替换的图标目录(优先 exe 同目录 icon/,保证单 exe 部署时也能用)
            rel = path[len("/icon/"):]
            fp = os.path.normpath(os.path.join(ICON_DIR, rel))
            base = os.path.abspath(ICON_DIR)
            if (fp == base or fp.startswith(base + os.sep)) and os.path.isfile(fp):
                if fp.endswith(".png"):
                    ctype = "image/png"
                elif fp.endswith(".ico"):
                    ctype = "image/x-icon"
                elif fp.endswith(".svg"):
                    ctype = "image/svg+xml"
                else:
                    ctype = "application/octet-stream"
                return self._send_file(fp, ctype)
        if path.startswith("/downloads/"):
            # 已下载文件(小说 TXT/EPUB + 漫画 PDF)供打开/阅读
            # 基准为数据目录(get_out_dir),兼容 exe 目录与 AppData 回退两种部署;
            # 小说已迁移到 downloads/novel,旧 downloads/ 根目录残留文件仍可读取(回退)
            from urllib.parse import unquote
            real = unquote(path)
            rel = real[len("/downloads/"):]
            if rel.startswith("comic/"):
                # 漫画固定目录(downloads/comic),不受 out_dir 设置影响
                base = os.path.abspath(os.path.dirname(COMIC_OUT_DIR))
            else:
                base = os.path.abspath(get_out_dir())
                if not os.path.isfile(os.path.join(base, rel)):
                    legacy = os.path.join(APP_DATA_DIR, "downloads")
                    if os.path.isfile(os.path.join(legacy, rel)):
                        base = legacy
            fp = os.path.normpath(os.path.join(base, rel))
            base_abs = os.path.abspath(base)
            if (fp == base_abs or fp.startswith(base_abs + os.sep)) and os.path.isfile(fp):
                if fp.endswith(".epub"):
                    ctype = "application/epub+zip"
                elif fp.endswith(".pdf"):
                    ctype = "application/pdf"
                else:
                    ctype = "text/plain; charset=utf-8"
                # ?dl=1 → 附件下载(手机页"下载 EPUB/同步全部"用);
                # 不带参数仍是内联读取,桌面端 pdf.js 漫画阅读等不受影响
                sid = (qs.get("sid") or [""])[0]
                if sid and qs.get("dl"):
                    # 手机同步:登记任务并实时上报字节进度(电脑端/手机端双端可见)
                    fname = os.path.basename(fp)
                    self._sync_touch(sid, task=fname, size=os.path.getsize(fp), status="downloading")
                    return self._send_file(fp, ctype, as_attachment=True, filename=fname,
                                           progress=lambda snt, tot: self._sync_touch(
                                               sid, task=fname, sent=snt,
                                               status="done" if snt >= tot else "downloading"))
                return self._send_file(fp, ctype, as_attachment=bool(qs.get("dl")),
                                       filename=os.path.basename(fp))
        self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/download":
            return self._api_download()
        if parsed.path == "/api/snapshot_start":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:  # noqa: BLE001
                return self._send_json({"error": "请求体非法"}, 400)
            return self._api_snapshot_start(payload)
        if parsed.path == "/api/opds_download":
            return self._api_opds_download()
        if parsed.path == "/api/comic_download":
            return self._api_comic_download()
        if parsed.path == "/api/comic_compress":
            return self._api_comic_compress()
        if parsed.path == "/api/comic_split":
            return self._api_comic_split()
        if parsed.path == "/api/comic_shelf":
            return self._api_comic_shelf_add()
        if parsed.path == "/api/comic_shelf/del":
            return self._api_comic_shelf_del()
        if parsed.path == "/api/comic_shelf_import":
            return self._api_comic_shelf_import()
        if parsed.path == "/api/comic_source_toggle":
            return self._api_comic_source_toggle()
        if parsed.path == "/api/comic_source_test":
            return self._api_comic_source_test()
        if parsed.path == "/api/comic_subscriptions":
            return self._api_comic_subscriptions_add()
        if parsed.path == "/api/comic_subscriptions/pending":
            return self._api_comic_subscriptions_pending(parsed.query)
        if parsed.path == "/api/comic_base_apply":
            return self._api_comic_base_apply()
        if parsed.path == "/api/comic_subscriptions/refresh":
            return self._api_comic_subscriptions_refresh()
        if parsed.path == "/api/comic_source_import":
            return self._api_comic_source_import()
        if parsed.path == "/api/comic_shelf/refresh":
            return self._api_comic_shelf_refresh()
        if parsed.path == "/api/source_export":
            return self._api_source_export()
        if parsed.path == "/api/convert":
            return self._api_convert()
        if parsed.path == "/api/shelf_import":
            return self._api_shelf_import()
        if parsed.path == "/api/notes":
            return self._api_notes_post()
        if parsed.path == "/api/sources":
            return self._api_add_source()
        if parsed.path == "/api/settings":
            return self._api_save_settings()
        if parsed.path == "/api/source_toggle":
            return self._api_toggle_source()
        if parsed.path == "/api/shelf":
            return self._api_shelf_add()
        if parsed.path == "/api/shelf/update":
            return self._api_shelf_update()
        if parsed.path == "/api/shelf/refresh":
            return self._api_shelf_refresh()
        if parsed.path == "/api/source_import":
            return self._api_source_import()
        if parsed.path == "/api/source_sync":
            return self._api_source_sync()
        if parsed.path == "/api/sync_status":
            return self._api_sync_status({})
        if parsed.path == "/api/source_candidates":
            return self._api_source_candidates()
        if parsed.path == "/api/source_candidates_import":
            return self._api_source_candidates_import()
        if parsed.path == "/api/source_fix_search":
            return self._api_source_fix_search()
        if parsed.path == "/api/subscriptions":
            return self._api_subscriptions_add()
        if parsed.path == "/api/subscriptions/refresh":
            return self._api_subscriptions_refresh()
        if parsed.path == "/api/open_dir":
            return self._api_open_dir()
        if parsed.path == "/api/tunnel":
            return self._api_tunnel_ctrl()
        if parsed.path == "/api/webrtc/answer":
            return self._api_webrtc_answer()
        if parsed.path == "/api/webrtc/stop":
            return self._api_webrtc_stop()
        if parsed.path == "/api/webrtc/cam":
            return self._api_webrtc_cam()
        if parsed.path == "/api/hotspot/open":
            return self._api_hotspot_open()
        if parsed.path.startswith("/api/window/"):
            # 统一窗口控制:minimize/maximize/close/drag/resize + open_reader。
            # body.win 指定目标窗口(main=主窗口;readerN=阅读器窗口,走多窗口钩子)。
            action = parsed.path[len("/api/window/"):]
            try:
                body = self._body()
            except Exception:  # noqa: BLE001
                body = {}
            win = str(body.get("win") or "main")
            edge = str(body.get("edge") or "")
            if action == "open_reader":
                url = str(body.get("url") or "")
                from urllib.parse import urlparse as _up
                pu = _up(url)
                if not url or pu.path != "/reader.html":
                    return self._send_json({"ok": False, "error": "仅允许打开 reader.html 阅读器窗口"}, 400)
                if not _OPEN_READER_HOOK:
                    return self._send_json({"ok": False, "error": "非桌面模式"}, 400)
                return self._send_json(_OPEN_READER_HOOK(url))
            if win != "main" and _WINDOW_CTL_HOOK:
                return self._send_json(_WINDOW_CTL_HOOK(action, win, edge))
            if action == "minimize":
                _win_minimize()
            elif action == "maximize":
                _win_maximize_toggle()
            elif action == "close":
                if not _WIN_HWND:  # 浏览器模式:无桌面窗口可关,不能强杀服务
                    return self._send_json({"ok": False, "error": "非桌面模式"})
                _win_close()
            elif action == "drag":
                _win_drag()
            elif action == "resize":
                _win_resize(edge)
            else:
                return self._send_json({"ok": False, "error": f"未知 action: {action}"}, 400)
            return self._send_json({"ok": True})
        if parsed.path == "/api/upload":
            return self._api_upload()
        if parsed.path == "/api/source_cleanup":
            return self._api_source_cleanup()
        if parsed.path == "/api/verify":
            return self._api_verify()
        if parsed.path == "/api/opds_challenge":
            return self._api_opds_challenge()
        if parsed.path == "/api/source_health":
            return self._api_source_health()
        if parsed.path == "/api/task_control":
            return self._api_task_control()
        self._send_json({"error": "not found"}, 404)

    def do_PUT(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/sources":
            return self._api_update_source()
        self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/sources":
            qs = parse_qs(parsed.query)
            name = (qs.get("name") or [""])[0].strip()
            ok = delete_custom_source(name)
            return self._send_json({"ok": ok, "error": None if ok else "未找到该书源"})
        if parsed.path == "/api/shelf":
            qs = parse_qs(parsed.query)
            url = (qs.get("url") or [""])[0].strip()
            ok = remove_from_shelf(url)
            return self._send_json({"ok": ok, "error": None if ok else "未找到该收藏"})
        if parsed.path == "/api/subscriptions":
            qs = parse_qs(parsed.query)
            url = (qs.get("url") or [""])[0].strip()
            ok = remove_subscription(url)
            return self._send_json({"ok": ok, "error": None if ok else "未找到该订阅"})
        if parsed.path == "/api/verify":
            qs = parse_qs(parsed.query)
            host = (qs.get("host") or [""])[0].strip()
            from novel.verify import remove as vremove
            ok = vremove(host)
            return self._send_json({"ok": ok, "error": None if ok else "未找到该验证记录"})
        if parsed.path == "/api/verify_pending":
            qs = parse_qs(parsed.query)
            host = (qs.get("host") or [""])[0].strip()
            from novel.verify import clear_pending
            ok = clear_pending(host)
            return self._send_json({"ok": ok, "error": None if ok else "未找到该待验证条目"})
        if parsed.path == "/api/comic_subscriptions":
            qs = parse_qs(parsed.query)
            url = (qs.get("url") or [""])[0].strip()
            from novel import comic as _comic
            ok = _comic.remove_comic_sub(url)
            return self._send_json({"ok": ok, "error": None if ok else "未找到该订阅"})
        if parsed.path == "/api/comic_source":
            qs = parse_qs(parsed.query)
            key = (qs.get("key") or [""])[0].strip()
            from novel import comic as _comic
            ok = _comic.remove_custom_source(key)
            return self._send_json({"ok": ok, "error": None if ok else "未找到该源"})
        if parsed.path == "/api/task_history":
            from novel.tasklog import clear_history
            clear_history()
            return self._send_json({"ok": True})
        if parsed.path == "/api/file":
            qs = parse_qs(parsed.query)
            fname = (qs.get("name") or [""])[0].strip()
            out_dir = get_out_dir()
            fp = os.path.join(out_dir, os.path.basename(fname))
            if not os.path.isfile(fp) or os.path.basename(fname) != fname:
                return self._send_json({"ok": False, "error": "文件不存在"})
            try:
                os.remove(fp)
            except OSError:
                # 沙箱/回收站不可用环境回退系统删除命令
                import subprocess
                r = subprocess.run(["cmd", "/c", "del", "/f", "/q", os.path.normpath(fp)],
                                   capture_output=True, text=True)
                if r.returncode != 0:
                    return self._send_json({"ok": False, "error": r.stderr or "删除失败"})
            return self._send_json({"ok": True})
        self._send_json({"error": "not found"}, 404)

    # ---------------- API 实现 ----------------
    # ---- 设置 / 书源管理 ----
    def _api_settings(self):
        """返回全部书源(含禁用)与全局设置。"""
        _sync_fetcher()
        all_src = load_all_sources()
        # 精简字段,避免把 search 配置细节暴露过多
        for s in all_src:
            s.setdefault("custom", False)
            s["search_ok"] = s.get("search") is not None
        from novel.paths import APP_DATA_DIR, _DEFAULT_OUT
        return self._send_json({
            "sources": all_src,
            "settings": load_settings(),
            "data_dir": APP_DATA_DIR,
            "default_out": _DEFAULT_OUT,
        })

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _api_add_source(self):
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        try:
            src = add_custom_source(data)
            return self._send_json({"ok": True, "source": src})
        except ValueError as exc:
            return self._send_json({"error": str(exc)}, 400)
        except OSError as exc:
            return self._send_json({"error": f"保存失败: {exc}"}, 500)

    def _api_update_source(self):
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        name = (data.get("name") or "").strip()
        fields = {k: v for k, v in data.items() if k != "name"}
        updated = update_custom_source(name, fields)
        if updated is None:
            return self._send_json({"error": "未找到该书源"}, 404)
        return self._send_json({"ok": True, "source": updated})

    def _api_toggle_source(self):
        """切换书源启用状态(内置与自定义均支持,内置状态持久化到 config.json)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        name = (data.get("name") or "").strip()
        enabled = bool(data.get("enabled"))
        all_src = load_all_sources()
        src = next((s for s in all_src if s["name"] == name), None)
        if src is None:
            return self._send_json({"error": "未找到该书源"}, 404)
        if src.get("custom"):
            update_custom_source(name, {"enabled": enabled})
        else:
            # 内置源:精准持久化单个源的启停,避免覆盖其他源状态
            set_source_state(name, enabled)
        return self._send_json({"ok": True})

    def _api_save_settings(self):
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        # 局部保存兼容:未携带的字段一律保留现有值(CDN 列表等子模块单独保存时不误伤其他设置)
        cur = load_settings()
        # delay:支持 'auto'(字符串) 或 数字;非法/负值回退到 auto
        raw = data.get("delay", cur.get("delay", "auto"))
        if isinstance(raw, str) and raw == "auto":
            delay = "auto"
        else:
            try:
                delay = float(raw)
            except (TypeError, ValueError):
                delay = None
            if delay is None or not math.isfinite(delay) or delay < 0:
                delay = "auto"  # 非法值也兜底为 auto
        old_lan = bool(cur.get("lan_access", False))
        new_lan = bool(data.get("lan_access", cur.get("lan_access", False)))
        # 净化规则:请求未携带时保留现有规则(新设置页不管理该字段,
        # 若直接 or [] 会在每次保存时清空用户规则);显式传 [] 仍表示清空
        clean_rules = data.get("clean_rules")
        if clean_rules is None:
            clean_rules = cur.get("clean_rules") or []
        # ---- 全局任务气泡设置(task_*):未携带保留现有值,枚举非法回现有,数字 clamp ----

        def _task_num(key, default, lo, hi):
            try:
                v = int(float(data[key]))
            except (TypeError, ValueError, KeyError):
                return cur.get(key, default)
            if not math.isfinite(v):
                return cur.get(key, default)
            return max(lo, min(hi, v))

        def _task_enum(key, default, allowed):
            v = data.get(key, cur.get(key, default))
            return v if v in allowed else cur.get(key, default)

        def _task_bool(key, default):
            v = data.get(key, cur.get(key, default))
            return v if isinstance(v, bool) else cur.get(key, default)

        # ---- MangaDex 图片自定义 CDN:规范化域名,未携带保留现有,最多 8 个 ----
        from novel.comic import normalize_cdn as _norm_cdn
        raw_cdns = data.get("manga_cdn_custom")
        if raw_cdns is None:
            manga_cdn_custom = cur.get("manga_cdn_custom") or []
        else:
            manga_cdn_custom = []
            for x in (raw_cdns if isinstance(raw_cdns, list) else []):
                d = _norm_cdn(x)
                if d and d not in manga_cdn_custom and len(manga_cdn_custom) < 8:
                    manga_cdn_custom.append(d)
        # 漫画 PDF 图片质量:枚举校验,未携带/非法保留现有值
        pdf_quality = data.get("pdf_quality", cur.get("pdf_quality", "hq"))
        if pdf_quality not in ("original", "hq", "eco"):
            pdf_quality = cur.get("pdf_quality", "hq")
        task_payload = {
            "task_fab_pos": _task_enum("task_fab_pos", "br", ("br", "bl", "tr", "custom")),
            "task_fab_mode": _task_enum("task_fab_mode", "always", ("always", "task", "never")),
            "task_fab_pos_x": _task_num("task_fab_pos_x", 6, 0, 100),
            "task_fab_pos_y": _task_num("task_fab_pos_y", 6, 0, 100),
            "task_fab_auto_collapse": _task_bool("task_fab_auto_collapse", True),
            "task_fab_finish_hold": _task_num("task_fab_finish_hold", 0, 0, 60),
            "task_notify_success": _task_bool("task_notify_success", True),
            "task_notify_fail": _task_bool("task_notify_fail", True),
            "task_panel_max": _task_num("task_panel_max", 50, 10, 200),
            "task_dl_concurrency": _task_num("task_dl_concurrency", 3, 1, 8),
            "task_fab_poll_ms": _task_num("task_fab_poll_ms", 3000, 1000, 10000),
        }
        try:
            save_settings({
                "proxy": data.get("proxy", cur.get("proxy", "")),
                "delay": delay,
                "out_dir": data.get("out_dir", cur.get("out_dir", "downloads")),
                "verify_ssl": bool(data.get("verify_ssl", cur.get("verify_ssl", True))),
                "lan_access": new_lan,
                "clean_rules": clean_rules,
                "manga_cdn_custom": manga_cdn_custom,
                "pdf_quality": pdf_quality,
                # 内网穿透配置(透传;未携带保留现有值)
                "tunnel_cmd": data.get("tunnel_cmd", cur.get("tunnel_cmd", "")),
                "tunnel_args": data.get("tunnel_args", cur.get("tunnel_args", "")),
                "tunnel_url_regex": data.get("tunnel_url_regex", cur.get("tunnel_url_regex", "")),
                "tunnel_autostart": bool(data.get("tunnel_autostart", cur.get("tunnel_autostart", False))),
                # WebRTC TURN 中继兜底(校园网对称 NAT 时用;可留空)
                "webrtc_turn_url": data.get("webrtc_turn_url", cur.get("webrtc_turn_url", "")),
                "webrtc_turn_user": data.get("webrtc_turn_user", cur.get("webrtc_turn_user", "")),
                "webrtc_turn_pass": data.get("webrtc_turn_pass", cur.get("webrtc_turn_pass", "")),
                **task_payload,
            })
            _sync_fetcher()
            # 监听地址(127.0.0.1/0.0.0.0)在启动时绑定,运行中无法切换 → 提示重启
            return self._send_json({"ok": True, "restart_required": old_lan != new_lan})
        except (ValueError, OSError) as exc:
            return self._send_json({"error": str(exc)}, 500)

    def _api_test_source(self, qs: dict):
        """测试书源连通性:抓首页 → 验证搜索 → 抓一本书的正文。
        使用独立请求器,避免占用生产环境的搜索冷却。"""
        name = (qs.get("name") or [""])[0].strip()
        all_src = load_all_sources()
        src = next((s for s in all_src if s["name"] == name), None)
        if src is None:
            return self._send_json({"error": "未找到该书源"}, 404)

        base = src["base"].rstrip("/")
        charset = src.get("charset", "utf-8")
        verify = bool(src.get("verify_ssl", True))
        tf = Fetcher(min_delay=0.3, max_delay=0.5)  # 独立请求器,不占生产冷却
        report: list[str] = []
        ok = True
        try:
            # 1. 首页
            try:
                home = tf.fetch(base + "/", encoding=charset, verify=verify)
                has_book = bool(re.search(r"/book/\d+/", home))
                report.append(f"✅ 首页可达({len(home)}字节)" + ("、含书籍链接" if has_book else ""))
            except Exception as exc:  # noqa: BLE001
                report.append(f"❌ 首页访问失败: {exc.__class__.__name__}")
                return self._send_json({"ok": False, "report": report})
            # 2. 搜索接口
            sconf = src.get("search")
            if sconf:
                try:
                    from urllib.parse import urlencode
                    q = "大梦主"
                    if sconf["method"].upper() == "POST":
                        data = {sconf["param"]: q}
                        data.update(sconf.get("extra", {}) or {})
                        r = tf.fetch(base + sconf["path"], method="POST", data=data,
                                     encoding=charset, verify=verify)
                    else:
                        params = {sconf["param"]: q}
                        params.update(sconf.get("extra", {}) or {})
                        r = tf.fetch(base + sconf["path"] + "?" + urlencode(params),
                                     encoding=charset, verify=verify)
                    hits = r.count("大梦主")
                    if "间隔" in r and hits == 0:
                        report.append("⚠️ 搜索接口存在但被频率限制(稍后重试)")
                    else:
                        report.append(f"✅ 搜索接口可用(命中{hits}处)")
                except Exception:  # noqa: BLE001
                    report.append("⚠️ 搜索接口异常(不影响直连下载)")
            else:
                report.append("ℹ️ 该源未配置搜索接口")
            # 3. 正文:首页找一本书,遍历前几章找有效正文
            try:
                m = re.search(r'href="(/book/\d+/)"', home)
                if m:
                    book_html = tf.fetch(base + m.group(1), encoding=charset, verify=verify)
                    chs = parse_toc(book_html, base_url=base,
                                    chapter_href_pattern=src.get("chapter_href_pattern"))
                    if chs:
                        got = 0
                        for ch in chs[:5]:
                            try:
                                ch_html = tf.fetch(ch["url"], encoding=charset, verify=verify)
                                text = parse_content(ch_html)
                                if len(text) > 100:
                                    got = 1
                                    report.append(f"✅ 正文可抓({len(text)}字,共{len(chs)}章)")
                                    break
                            except Exception:  # noqa: BLE001
                                continue
                        if not got:
                            ok = False
                            report.append("❌ 正文疑似 JS 加载或解析失败")
                    else:
                        report.append("ℹ️ 未能解析出章节(页面结构特殊)")
                else:
                    report.append("ℹ️ 首页未发现书籍链接")
            except Exception as exc:  # noqa: BLE001
                report.append(f"⚠️ 正文验证失败: {exc.__class__.__name__}")
        except Exception:  # noqa: BLE001
            pass
        return self._send_json({"ok": ok, "report": report})

    def _api_search(self, qs: dict):
        keyword = (qs.get("q") or [""])[0].strip()
        srcs = [s for s in (qs.get("src") or [""])[0].split(",") if s]
        if not keyword:
            return self._send_json({"error": "缺少关键词 q"})
        _prune_search_tasks()  # 新搜索前回收没人取结果的旧任务
        try:
            res = search_all(keyword, fetcher=_fetcher, verbose=False,
                             source_names=srcs or None, return_meta=True)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 500)
        books = res["books"]
        items = [
            {"title": b.title, "author": b.author, "url": b.url, "source": b.source}
            for b in books
        ]
        return self._send_json({
            "keyword": keyword,
            "results": items,
            "sources": res["sources"],
        })

    # ---- 异步搜索(带进度条) ----
    # 连续失败源缓存: {name: [fail_ts]} — 30 分钟内失败 3 次以上则跳过搜索
    _FAIL_WINDOW = 1800
    _FAIL_MAX = 3
    _src_fail_cache: dict[str, list[float]] = {}

    def _api_search_async(self, qs: dict):
        keyword = (qs.get("q") or [""])[0].strip()
        srcs = [s for s in (qs.get("src") or [""])[0].split(",") if s]
        if not keyword:
            return self._send_json({"error": "缺少关键词 q"})
        tid = _uuid.uuid4().hex[:12]
        # 过滤近期连续失败的源
        now = time.time()
        bad: set[str] = set()
        for nm, ts_list in list(Handler._src_fail_cache.items()):
            keep = [t for t in ts_list if now - t < self._FAIL_WINDOW]
            Handler._src_fail_cache[nm] = keep
            if len(keep) >= self._FAIL_MAX:
                bad.add(nm)
        task = {"tid": tid, "q": keyword, "src": srcs, "state": "running", "done": 0,
                "total": 0, "sources": [], "result": None, "error": "",
                "skipped": len(bad), "new_books": [], "paused": False,
                "added": time.time(), "started": time.time()}
        _search_tasks[tid] = task

        def _progress(done, total, name, status, books=None):
            task["done"] = done
            task["total"] = total
            task["sources"].append({"name": name, "status": status})
            for b in (books or []):
                task["new_books"].append(
                    {"title": b.title, "author": b.author, "url": b.url,
                     "source": b.source, "raw_title": getattr(b, "raw_title", ""),
                     "cover": getattr(b, "cover", ""), "desc": getattr(b, "desc", "")})
            if status == "error":
                Handler._src_fail_cache.setdefault(name, []).append(time.time())

        def _cancel_check() -> bool:
            return task.get("paused", False)

        def _run():
            try:
                res = search_all(keyword, fetcher=_fetcher, verbose=False,
                                 source_names=srcs or None, return_meta=True,
                                 on_progress=_progress, skip_names=bad or None,
                                 cancel_check=_cancel_check, max_workers=6)
                task["result"] = res
                task["state"] = "paused" if task.get("paused") else "done"
            except Exception as exc:  # noqa: BLE001
                task["state"] = "error"
                task["error"] = str(exc)

        threading.Thread(target=_run, daemon=True).start()
        return self._send_json({"task_id": tid})

    def _api_search_pause(self, qs: dict):
        tid = (qs.get("id") or [""])[0].strip()
        pause = (qs.get("pause") or ["true"])[0].strip().lower() in ("1", "true", "yes")
        task = _search_tasks.get(tid)
        if task is None:
            return self._send_json({"error": "任务不存在"}, 404)
        task["paused"] = pause
        return self._send_json({"ok": True, "paused": pause})

    def _api_search_progress(self, qs: dict):
        tid = (qs.get("id") or [""])[0].strip()
        task = _search_tasks.get(tid)
        if task is None:
            return self._send_json({"error": "任务不存在"}, 404)
        books = task["new_books"]
        task["new_books"] = []
        return self._send_json({
            "state": task["state"], "done": task["done"], "total": task["total"],
            "sources": task["sources"], "error": task["error"],
            "paused": task.get("paused", False), "books": books,
        })

    def _api_search_result(self, qs: dict):
        tid = (qs.get("id") or [""])[0].strip()
        task = _search_tasks.get(tid)
        if task is None:
            return self._send_json({"error": "任务不存在"}, 404)
        if task["state"] != "done":
            return self._send_json({"pending": True})
        books = task["result"]["books"]
        items = [
            {"title": b.title, "author": b.author, "url": b.url, "source": b.source,
             "raw_title": getattr(b, "raw_title", ""),
             "cover": getattr(b, "cover", ""), "desc": getattr(b, "desc", "")}
            for b in books
        ]
        resp = {"keyword": task["q"], "results": items,
                "sources": task["result"]["sources"]}
        _search_tasks.pop(tid, None)  # 一次性取走,清理
        return self._send_json(resp)

    def _api_book(self, qs: dict):
        url = (qs.get("url") or [""])[0].strip()
        if not url:
            return self._send_json({"error": "缺少 url"})
        # 缓存命中直接返回
        hit = _toc_cache.get(url)
        if hit and time.time() - hit[0] < _TOC_TTL:
            return self._send_json(hit[1])
        try:
            book = book_from_url(url, _fetcher)
            if book is None:
                return self._send_json({"error": "无法识别该 URL 的书源"})
            # 拉取完整章节列表(供在线阅读使用;失败不影响 cover/desc 返回)
            chapters = []
            try:
                chapters = fetch_toc(book, _fetcher) or []
            except Exception:  # noqa: BLE001
                pass
            info = {
                "title": book.title,
                "source": book.source,
                "url": book.url,
                "chapters": len(chapters),
                "first": chapters[0]["title"] if chapters else "",
                "last": chapters[-1]["title"] if chapters else "",
                "cover": getattr(book, "cover", ""),
                "desc": getattr(book, "desc", ""),
                "toc": [{"title": c.get("title", ""), "url": c.get("url", "")} for c in chapters],
            }
            _toc_cache[url] = (time.time(), info)
            if len(_toc_cache) > 200:  # 防止缓存无限增长
                oldest = min(_toc_cache, key=lambda k: _toc_cache[k][0])
                _toc_cache.pop(oldest, None)
            return self._send_json(info)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 500)

    def _api_online_read(self, qs: dict):
        """GET /api/online_read?url=...&ch=N → 在线抓取第 N 章正文(净化后)
        供未下载的书在书架上直接在线浏览(临时流式,不落盘)。"""
        from novel.clean import clean_text
        url = (qs.get("url") or [""])[0].strip()
        try:
            ch_idx = int((qs.get("ch") or ["1"])[0] or 1)
        except (TypeError, ValueError):
            ch_idx = 1
        if not url:
            return self._send_json({"error": "缺少 url"}, 400)
        try:
            book = book_from_url(url, _fetcher)
            if book is None:
                return self._send_json({"error": "无法识别该 URL 的书源"}, 404)
            from novel.downloader import _find_source, _fetch_chapter
            source = _find_source(book)
            if source is None:
                return self._send_json({"error": "找不到书源"}, 404)
            chapters = fetch_toc(book, _fetcher) or []
            if ch_idx < 1 or ch_idx > len(chapters):
                return self._send_json({"error": f"章节范围 1-{len(chapters)}"}, 400)
            ch = chapters[ch_idx - 1]
            charset = source.get("charset", "utf-8")
            text = _fetch_chapter(ch, source, charset, _fetcher)
            if not text:
                return self._send_json({"error": "在线章节抓取失败"}, 502)
            text = clean_text(text, load_settings().get("clean_rules"))
            return self._send_json({
                "title": ch.get("title", ""),
                "idx": ch_idx,
                "total": len(chapters),
                "text": text,
                "mode": "online",
            })
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 500)

    def _api_download(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)

        url = (payload.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "缺少 url"})
        try:
            book = book_from_url(url, _fetcher)
            if book is None:
                return self._send_json({"error": "无法识别该 URL 的书源"})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 500)

        task_id = _next_task_id()
        _prune_tasks()  # 新任务创建前清理历史终态任务
        # kind/added/title 必须带上:全局任务面板(/api/tasks_all)按 added 倒序取最近 N 条,
        # 缺 added 会让下载任务永远排在最末、被 limit 截掉(面板里看不到正在下载的小说);
        # 缺 kind 则 /api/tasks_active 的 kinds 统计会把它误归为 search。
        task = {
            "id": task_id,
            "kind": "chapter_download",
            "title": book.title,
            "state": "running",
            "done": 0,
            "total": 0,
            "current": "",
            "logs": [],
            "out_path": "",
            "error": "",
            "started": time.time(),
            "added": time.time(),
            "book": book.title,
        }
        with _tasks_lock:
            _tasks[task_id] = task
        th = threading.Thread(target=_run_download, args=(task_id, book, payload), daemon=True)
        th.start()
        return self._send_json({"task_id": task_id})

    def _api_status(self, qs: dict):
        tid = (qs.get("id") or [""])[0].strip()
        t = _tasks.get(tid)
        if t is None:
            return self._send_json({"error": "task not found"}, 404)
        t["_last_read"] = time.time()  # 供 _prune_tasks 判断前端已读走终态
        return self._send_json(t)

    def _api_tasks_active(self):
        """GET /api/tasks_active → 后端当前活跃任务数(下载/搜索/同步/订阅刷新等),
        供全局任务按钮形态切换使用。"""
        with _tasks_lock:
            act = [v for v in _tasks.values()
                   if v.get("state") in ("running", "downloading", "paused")]
            # 搜索任务在独立容器里,一并计入(与 _tasks 同一把锁,避免遍历时被改动)
            act += [v for v in _search_tasks.values() if v.get("state") == "running"]
        kinds = {}
        for v in act:
            k = v.get("kind", "search")
            kinds[k] = kinds.get(k, 0) + 1
        return self._send_json({"count": len(act), "kinds": kinds})

    def _api_tasks_all(self):
        """GET /api/tasks_all → 后端所有任务详情(下载/搜索/同步/订阅刷新等,
        活跃+已结束最近),供全局任务面板统合展示(替代原 #bubbleStack 任务气泡列表)。"""
        limit = int(load_settings().get("task_panel_max", 50) or 50)
        limit = max(10, min(limit, 200))
        _prune_tasks()          # 顺带回收前端已读走的终态任务
        _prune_search_tasks()   # 回收无人取结果的搜索任务
        with _tasks_lock:
            items = list(_tasks.values())
            # 合并异步搜索任务(独立容器,转面板同构格式)
            for t in _search_tasks.values():
                items.append({
                    "id": t.get("tid", ""),
                    "kind": "search",
                    "title": t.get("q", "搜索"),
                    "state": "done" if t.get("state") == "done" else
                             ("error" if t.get("state") == "error" else
                              ("cancelled" if t.get("state") == "cancelled" else
                               ("paused" if t.get("state") == "paused" else "running"))),
                    "done": t.get("done", 0), "total": t.get("total", 0),
                    "current": f"已完成 {t.get('done', 0)}/{t.get('total', 0)} 个源",
                    "added": t.get("added", 0), "started": t.get("started", 0),
                })
        # 先合并再排序截断:此前先截断 _tasks 再加搜索任务,一旦历史任务超过 limit,
        # 刚启动的活跃任务会被挤掉(面板里看不到)。
        items.sort(key=lambda x: x.get("added", 0), reverse=True)
        return self._send_json({"tasks": items[:limit]})

    # ---- 阅读器 ----
    def _resolve_book_file(self, fname: str) -> str | None:
        """把文件名解析为 out_dir 内的绝对路径(防路径遍历)。"""
        if not fname or ".." in fname or "/" in fname or "\\" in fname:
            return None
        out_dir = os.path.abspath(get_out_dir())
        fp = os.path.abspath(os.path.join(out_dir, fname))
        if not fp.startswith(out_dir) or not os.path.isfile(fp):
            return None
        return fp

    def _api_read_meta(self, qs: dict):
        fname = (qs.get("file") or [""])[0].strip()
        fp = self._resolve_book_file(fname)
        if fp is None:
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            return self._send_json(read_meta(fp))
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 500)

    def _api_read(self, qs: dict):
        fname = (qs.get("file") or [""])[0].strip()
        idx = int((qs.get("ch") or ["1"])[0] or 1)
        fp = self._resolve_book_file(fname)
        if fp is None:
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            ch = read_chapter(fp, idx)
            if ch is None:
                return self._send_json({"error": "章节不存在"}, 404)
            from novel.clean import clean_text
            ch = dict(ch)
            ch["text"] = clean_text(ch.get("text", ""), load_settings().get("clean_rules"))
            return self._send_json(ch)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 500)

    # ---- 书架 / 检查更新 ----
    def _local_chapters(self, title: str, source: str) -> int:
        """本地已下载章节数:按书名前缀扫描 out_dir(文件名格式
        <书名>[<源名>].txt/.epub,书架条目的 source 可能与下载时源名不一致,
        故不能精确匹配 [source],改为前缀匹配任意源标记)。
        兼容旧版 downloads/ 根目录残留文件。"""
        roots = [get_out_dir()]
        legacy = os.path.join(APP_DATA_DIR, "downloads")
        if os.path.abspath(legacy) != os.path.abspath(roots[0]) and os.path.isdir(legacy):
            roots.append(legacy)
        base = safe_filename(title or 'novel') + "["
        for out_dir in roots:
            try:
                for fn in os.listdir(out_dir):
                    if not fn.startswith(base):
                        continue
                    fp = os.path.join(out_dir, fn)
                    if fn.endswith(".txt"):
                        n = chapter_count(fp)
                        if n:
                            return n
                    elif fn.endswith(".epub"):
                        try:
                            from novel.epub import parse_epub
                            n = len(parse_epub(fp))
                            if n:
                                return n
                        except Exception:  # noqa: BLE001
                            pass
            except OSError:
                pass
        return 0

    def _local_file(self, title: str) -> str:
        """本地实际下载文件(<书名>[<源名>].txt/.epub 前缀匹配),返回文件名或空。"""
        roots = [get_out_dir()]
        legacy = os.path.join(APP_DATA_DIR, "downloads")
        if os.path.abspath(legacy) != os.path.abspath(roots[0]) and os.path.isdir(legacy):
            roots.append(legacy)
        base = safe_filename(title or 'novel') + "["
        for out_dir in roots:
            try:
                for fn in sorted(os.listdir(out_dir)):
                    if fn.startswith(base) and (fn.endswith(".txt") or fn.endswith(".epub")):
                        return fn
            except OSError:
                pass
        return ""

    def _api_shelf_list(self):
        shelf = load_shelf()
        out_dir = get_out_dir()
        for e in shelf:
            e["local_chapters"] = self._local_chapters(e.get("title", ""), e.get("source", ""))
            e["local_file"] = self._local_file(e.get("title", ""))
            e["local_epub"] = bool(e["local_file"] and e["local_file"].endswith(".epub"))
        return self._send_json({"shelf": shelf, "out_dir": out_dir})

    def _api_shelf_add(self):
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        title = (data.get("title") or "").strip()
        url = (data.get("url") or "").strip()
        if not title or not url:
            return self._send_json({"error": "缺少书名或链接"}, 400)
        entry = add_to_shelf(title, url, data.get("source", ""), data.get("cover", ""))
        return self._send_json({"ok": True, "entry": entry})

    def _api_shelf_update(self):
        """POST /api/shelf/update {url, tags?, category?, rating?}"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "缺少 url"}, 400)
        from novel.shelf import update_entry
        entry = update_entry(url, **{k: data[k] for k in ("tags", "category", "rating") if k in data})
        if entry is None:
            return self._send_json({"error": "书架中未找到该书"}, 404)
        return self._send_json({"ok": True, "entry": entry})

    def _api_shelf_refresh(self):
        """检查更新:重拉目录,对比本地已下载章节数。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        entry = find_entry(url)
        if entry is None:
            return self._send_json({"error": "不在书架中"}, 404)
        # OPDS 书架条目:URL 为 EPUB 直链(/epub/{id}.epub)或 wenku8 书页链接,
        # 通用书源识别不到,改用 wenku8 主站拉目录对比
        if (entry.get("source") == "OPDS" or "/epub/" in url or "wenku8" in url or "wol.moe" in url):
            try:
                from novel import wenku8 as _w8
                import re as _re
                book_id = _w8.extract_book_id(url)
                if not book_id:
                    m = _re.search(r"/book/(\d+)\.htm", url) or _re.search(r"/novel/\d+/(\d+)/", url)
                    if m:
                        book_id = m.group(1)
                if not book_id:
                    return self._send_json({"error": "无法从该 OPDS 链接解析书 ID,请用 wenku8 书页链接收藏"}, 400)
                toc = _w8.fetch_toc(book_id)
                total = len(toc)
                have = self._local_chapters(entry.get("title", ""), entry.get("source", ""))
                update_entry(url, checked_chapters=total, have=have)
                return self._send_json({
                    "ok": True, "title": entry.get("title", ""),
                    "total": total, "have": have, "new": max(0, total - have),
                })
            except Exception as exc:  # noqa: BLE001
                return self._send_json({"error": f"检查失败: {exc}"}, 500)
        try:
            book = book_from_url(url, _fetcher)
            if book is None:
                return self._send_json({"error": "无法识别该 URL 的书源"}, 400)
            toc = fetch_toc(book, _fetcher)
            total = len(toc)
            have = self._local_chapters(book.title, book.source)
            update_entry(url, checked_chapters=total, have=have)
            return self._send_json({
                "ok": True, "title": book.title,
                "total": total, "have": have, "new": max(0, total - have),
            })
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"检查失败: {exc}"}, 500)

    # ---- 书源规则(导出/导入) ----
    def _api_source_rule(self, qs: dict):
        """导出单个书源为可分享 JSON 文本。"""
        name = (qs.get("name") or [""])[0].strip()
        src = next((s for s in load_all_sources() if s["name"] == name), None)
        if src is None:
            return self._send_json({"error": "未找到该书源"}, 404)
        rule = export_source_rule(src)
        return self._send_json({
            "ok": True, "name": name,
            "text": json.dumps(rule, ensure_ascii=False, indent=2),
        })

    def _api_source_import(self):
        """导入书源:支持单个 JSON 对象或数组,返回导入结果。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        text = (data.get("text") or "").strip()
        if not text:
            return self._send_json({"error": "缺少书源 JSON 文本"}, 400)
        try:
            parsed = parse_source_rule_text(text)
        except ValueError as exc:
            return self._send_json({"error": f"解析失败: {exc}"}, 400)
        rules = parsed if isinstance(parsed, list) else [parsed]
        imported: list[str] = []
        errors: list[str] = []
        for rule in rules:
            try:
                source = import_source_rule(rule)
                add_custom_source(source)
                imported.append(source["name"])
            except ValueError as exc:
                errors.append(f"{rule.get('name', '?')}: {exc}")
        return self._send_json({"ok": True, "imported": imported, "errors": errors})

    # ---- 书源仓库同步 ----
    def _api_source_sync(self):
        """启动后台同步任务(拉取仓库→探测→验证→候选池)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        if _sync_state.get("running"):
            return self._send_json({"error": "同步正在进行中,请稍候"}, 409)

        def _progress(st: dict) -> None:
            _sync_state.update(st)

        def _run() -> None:
            try:
                sync_sources(limit=data.get("limit") or None,
                             min_content=int(data.get("min_content", 100)),
                             verbose=False, on_progress=_progress)
            except Exception as exc:  # noqa: BLE001
                _sync_state["running"] = False
                _sync_state["error"] = str(exc)

        _sync_state.clear()
        _sync_state.update({"running": True, "stage": "fetching", "processed": 0,
                            "ok": 0, "candidates": 0})
        threading.Thread(target=_run, daemon=True).start()
        return self._send_json({"ok": True, "status": dict(_sync_state)})

    def _api_source_candidates(self):
        """候选池列表(带 新/已存在 标记)。"""
        return self._send_json({"candidates": candidates_status()})

    def _api_source_candidates_import(self):
        """批量导入候选池中的书源(按名称;同名自动加序号)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        names = data.get("names") or []
        cands = load_candidates()
        existing_names = {s["name"] for s in load_all_sources()}
        imported: list[str] = []
        errors: list[str] = []
        for c in cands:
            if c["name"] not in names:
                continue
            try:
                name = c["name"]
                base_name = name
                i = 2
                while name in existing_names:
                    name = f"{base_name}{i}"
                    i += 1
                src = {
                    "name": name, "base": c["base"],
                    "charset": c.get("charset", "utf-8"),
                    "verify_ssl": bool(c.get("verify_ssl", False)),
                    "search": c.get("search"),
                    "book_href_pattern": c.get("book_href_pattern", ""),
                    "chapter_href_pattern": c.get("chapter_href_pattern", ""),
                    "toc_reverse": bool(c.get("toc_reverse", False)),
                    "enabled": True,
                }
                add_custom_source(src)
                existing_names.add(name)
                imported.append(name)
            except ValueError as exc:
                errors.append(f"{c['name']}: {exc}")
        return self._send_json({"ok": True, "imported": imported, "errors": errors})

    def _api_source_fix_search(self):
        """对候选池二次修正搜索接口(后台线程,进度走 sync_status)。"""
        if _sync_state.get("running"):
            return self._send_json({"error": "有任务正在进行中,请稍候"}, 409)
        from novel.source_registry import fix_search_configs

        def _progress(i: int, total: int) -> None:
            _sync_state.update({"stage": "fixing", "processed": i, "ok": total})

        def _run() -> None:
            try:
                cands = load_candidates()
                fix_search_configs(cands, verbose=False, on_progress=_progress)
                save_candidates(cands)
                _sync_state.update({"stage": "done", "running": False,
                                    "message": "搜索接口修正完成"})
            except Exception as exc:  # noqa: BLE001
                _sync_state.update({"running": False, "error": str(exc)})

        _sync_state.clear()
        _sync_state.update({"running": True, "stage": "fixing", "processed": 0, "ok": 0})
        threading.Thread(target=_run, daemon=True).start()
        return self._send_json({"ok": True, "status": dict(_sync_state)})

    # ---- 订阅管理 ----
    def _api_subscriptions_list(self):
        return self._send_json({"subscriptions": load_subscriptions()})

    def _api_subscriptions_add(self):
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "缺少 GitHub 仓库地址或书源直链"}, 400)
        try:
            sub = add_subscription(
                name=data.get("name", ""), url=url,
                file=(data.get("file") or "").strip(),
                remark=data.get("remark", ""),
            )
            return self._send_json({"ok": True, "subscription": sub})
        except ValueError as exc:
            return self._send_json({"error": str(exc)}, 400)

    def _api_subscriptions_refresh(self):
        """刷新订阅:按该订阅的书源直链执行同步(后台,进度走 sync_status)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        sub = next((s for s in load_subscriptions() if s["url"] == url), None)
        if sub is None:
            return self._send_json({"error": "未找到该订阅"}, 404)
        if _sync_state.get("running"):
            return self._send_json({"error": "有任务正在进行中,请稍候"}, 409)
        resolved = sub.get("resolved") or resolve_repo_file(sub["url"], sub.get("file", ""))

        def _progress(st: dict) -> None:
            _sync_state.update(st)

        def _run() -> None:
            try:
                sync_sources(min_content=100, verbose=False, on_progress=_progress,
                             url=resolved)
            except Exception as exc:  # noqa: BLE001
                _sync_state.update({"running": False, "error": str(exc), "fail": True})
            # 刷新动作结束即视为已同步(即使 0 候选或失败),更新订阅状态
            try:
                subs = load_subscriptions()
                for s in subs:
                    if s["url"] == url:
                        s["last_sync"] = time.time()
                        s["count"] = _sync_state.get("ok", 0)
                        if _sync_state.get("fail"):
                            s["status"] = "已同步(失败,0 候选)"
                        else:
                            s["status"] = f"已同步({_sync_state.get('candidates', 0)} 候选)"
                        save_subscriptions(subs)
                        break
            except Exception:  # noqa: BLE001
                pass
            _sync_state.update({"stage": "done", "running": False})

        _sync_state.clear()
        _sync_state.update({"running": True, "stage": "fetching", "processed": 0, "ok": 0,
                            "candidates": 0, "sub_name": sub["name"]})
        threading.Thread(target=_run, daemon=True).start()
        return self._send_json({"ok": True, "status": dict(_sync_state)})

    def _api_source_cleanup(self):
        """一键清理:停用近期连续搜索失败的源(30分钟窗口内失败≥3次)。"""
        now = time.time()
        disabled: list[str] = []
        all_src = load_all_sources()
        by_name = {s["name"]: s for s in all_src}
        for nm, ts_list in list(Handler._src_fail_cache.items()):
            keep = [t for t in ts_list if now - t < self._FAIL_WINDOW]
            Handler._src_fail_cache[nm] = keep
            if len(keep) >= self._FAIL_MAX:
                src = by_name.get(nm)
                if src is None or not src.get("enabled"):
                    continue
                if src.get("custom"):
                    update_custom_source(nm, {"enabled": False})
                else:
                    set_source_state(nm, False)
                disabled.append(nm)
        return self._send_json({"ok": True, "disabled": disabled,
                                "note": "停用后可随时在书源管理重新启用"})

    # ---- OPDS 目录 ----
    def _api_verify_status(self):
        from novel.verify import list_verified
        return self._send_json({"verified": list_verified()})

    def _api_verify_pending(self):
        from novel.verify import list_pending
        return self._send_json({"pending": list_pending()})

    def _api_verify(self):
        """通用验证中心:有头浏览器打开 URL,用户手动完成验证,保存 cookies。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        name = (data.get("name") or "").strip()
        if not url:
            return self._send_json({"error": "缺少 url"}, 400)
        try:
            from novel.browser import solve_cloudflare
            from novel.verify import save_cookies, clear_pending
            from novel.config import load_settings
            proxy = (load_settings().get("proxy") or "").strip() or None  # 与抓取侧同一出口 IP
            result = {}
            def _run():
                try:
                    ck, ua = solve_cloudflare(url, timeout=300, proxy=proxy)
                    if ck:  # 验证通过才落盘;未通过保留待验证条目,可再次点验证
                        host = save_cookies(url, ck, name, ua=ua)
                        if host:
                            clear_pending(host)
                        result["ok"] = True
                        result["host"] = host
                        result["n"] = len(ck)
                    else:
                        result["ok"] = False
                except Exception as exc:
                    result["ok"] = False
                    result["error"] = str(exc)
            t = threading.Thread(target=_run, daemon=True)
            t.start()
            t.join(timeout=320)
            if "ok" in result and result["ok"]:
                return self._send_json({"ok": True, "host": result["host"], "cookies": result["n"]})
            err = result.get("error", "")
            msg = err or "未检测到验证通过:请在浏览器窗口完成验证(页面可正常读取)后再点重试"
            return self._send_json({"ok": False, "error": msg}, 504)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"ok": False, "error": f"无法打开浏览器窗口: {exc}"}, 500)

    def _api_opds_challenge(self):
        """有头浏览器打开 OPDS 地址,让用户手动完成 Cloudflare 验证,保存 cookies。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "缺少 url"}, 400)
        try:
            from novel.browser import solve_cloudflare
            from novel.config import load_settings
            cookie_path = os.path.join(ROOT, "opds_cookies.json")
            proxy = (load_settings().get("proxy") or "").strip() or None
            # 后台线程执行(有头窗口),这里等待完成
            result = {}
            def _run():
                try:
                    ck, _ua = solve_cloudflare(url, cookie_path=cookie_path, timeout=240, proxy=proxy)
                    result["ok"] = bool(ck)
                    result["n"] = len(ck)
                except Exception as exc:
                    result["ok"] = False
                    result["error"] = str(exc)
            t = threading.Thread(target=_run, daemon=True)
            t.start()
            t.join(timeout=260)
            if "ok" in result and result["ok"]:
                return self._send_json({"ok": True, "cookies": result.get("n", 0)})
            return self._send_json({"ok": False, "error": result.get("error") or "未检测到验证通过:请在浏览器窗口完成验证(页面可正常读取)后再点重试"}, 504)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"ok": False, "error": f"无法打开浏览器窗口: {exc}"}, 500)

    def _api_opds(self, qs: dict):
        from novel.opds import fetch, parse_catalog, resolve_absolute
        url = (qs.get("url") or [""])[0].strip()
        if not url:
            url = "https://opds.wol.moe/zh_CN"
        is_search = "search" in url.lower() or "?q=" in url
        try:
            # 搜索接口:wenku8 对无结果关键词会读取超时(120s+),这里收紧到 35s 快速失败
            xml = fetch(url, timeout=35 if is_search else 20,
                        cookie_path=os.path.join(ROOT, "opds_cookies.json"))
            items = parse_catalog(xml)
            out = []
            for it in items:
                href = resolve_absolute(it["href"], url)
                out.append({
                    "title": it["title"],
                    "href": href,
                    "epub": resolve_absolute(it["epub"], url) if it["epub"] else "",
                    "cover": resolve_absolute(it["cover"], url) if it.get("cover") else "",
                    "desc": it.get("desc", ""),
                    "is_nav": it["is_nav"],
                })
            return self._send_json({"ok": True, "url": url, "items": out})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"OPDS 解析失败: {exc}"}, 502)

    def _api_opds_download(self):
        """POST /api/opds_download {url, title, mode} → 异步任务,立即返回 task_id。

        mode:
          "server"(默认):等待 opds.wol.moe 服务端生成(慢,无进度)
          "local":本地直抓 wenku8 主站生成(快,真实进度)
        """
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        title = (data.get("title") or "").strip() or "OPDS_book"
        cover = (data.get("cover") or "").strip()
        mode = (data.get("mode") or "server").strip().lower()
        if mode not in ("server", "local"):
            mode = "server"
        if not url:
            return self._send_json({"error": "缺少 url"}, 400)
        tid = _next_task_id()
        with _tasks_lock:
            _tasks[tid] = {
                "id": tid, "kind": "opds_download",
                "url": url, "title": title, "mode": mode, "cover": cover,
                "state": "running",
                "done": 0, "total": 100, "current": "已加入下载队列…", "logs": [],
                "error": "", "out_path": "", "http_status": 0,
                "poll_count": 0, "slow_warn": False,
                "added": time.time(),
            }
        threading.Thread(target=_run_opds_download, args=(tid, url, title, mode), daemon=True).start()
        return self._send_json({"ok": True, "task_id": tid, "mode": mode})

    # ---- 漫画(MangaDex 等源适配器) ----
    def _api_comic_sources(self):
        """GET /api/comic_sources → 漫画源列表(含启停状态)。"""
        from novel import comic as _comic
        return self._send_json({"ok": True, "sources": _comic.get_sources()})

    def _api_comic_source_toggle(self):
        """POST /api/comic_source_toggle {name, enabled} → 持久化启停状态。"""
        from novel import comic as _comic
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            data = {}
        name = (data.get("name") or "").strip()
        if not name:
            return self._send_json({"error": "缺少源名"}, 400)
        try:
            return self._send_json(_comic.set_source_state(name, bool(data.get("enabled", False))))
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 400)

    def _api_comic_source_test(self):
        """POST /api/comic_source_test {name} → 测速(实际执行一次搜索计时)。"""
        from novel import comic as _comic
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            data = {}
        name = (data.get("name") or "").strip()
        if not name:
            return self._send_json({"error": "缺少源名"}, 400)
        try:
            return self._send_json({"ok": True, "result": _comic.test_source(name)})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 400)

    # ---- 漫画自定义源与订阅(订阅中心 / 漫画源管理) ----
    def _api_comic_subscriptions_list(self):
        """GET /api/comic_subscriptions → 漫画订阅列表。"""
        from novel import comic as _comic
        return self._send_json({"ok": True, "subscriptions": _comic.load_comic_subs()})

    def _api_comic_subscriptions_add(self):
        """POST /api/comic_subscriptions {name,url,file,remark} → 新增漫画订阅。"""
        from novel import comic as _comic
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "缺少订阅地址(GitHub 仓库或规则直链)"}, 400)
        try:
            sub = _comic.add_comic_sub(
                name=data.get("name", ""), url=url,
                file=(data.get("file") or "").strip(),
                remark=data.get("remark", ""),
            )
            return self._send_json({"ok": True, "subscription": sub})
        except ValueError as exc:
            return self._send_json({"error": str(exc)}, 400)

    def _api_comic_base_apply(self):
        """POST /api/comic_base_apply {url, keys} → 应用地址修正表勾选项。"""
        from novel import comic as _comic
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "缺少订阅地址"}, 400)
        try:
            res = _comic.apply_comic_base(url, data.get("keys") or [])
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 400)
        if not res.get("ok"):
            return self._send_json({"error": res.get("error", "应用失败")}, 400)
        return self._send_json({"ok": True, "count": res.get("count", 0)})

    def _api_comic_subscriptions_refresh(self):
        """POST /api/comic_subscriptions/refresh {url} → 异步后台任务同步订阅,
        返回 task_id;完成后由 /api/comic_subscriptions/pending 取匹配结果。"""
        from novel import comic as _comic
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        url = (data.get("url") or "").strip()
        if not url:
            return self._send_json({"error": "缺少订阅地址"}, 400)
        if not any(s["url"] == url for s in _comic.load_comic_subs()):
            return self._send_json({"error": "未找到该订阅"}, 400)
        tid = _next_task_id()
        _prune_tasks()
        sub_name = next((s["name"] for s in _comic.load_comic_subs() if s["url"] == url), "订阅")
        with _tasks_lock:
            _tasks[tid] = {
                "id": tid, "kind": "comic_refresh", "title": f"漫画订阅刷新 · {sub_name}",
                "state": "running", "done": 0, "total": 3, "current": "拉取订阅内容…",
                "logs": [], "error": "", "out_path": "",
                "added": time.time(), "started": time.time(),
            }

        def _run():
            t = _tasks[tid]
            try:
                res = _comic.refresh_comic_sub(url)
                with _tasks_lock:
                    # 同步是单个阻塞调用,中途无法打断;至少在收尾时尊重"已停止",
                    # 否则会把用户的 cancelled 覆盖成 done(点了停止却显示成功)。
                    if t.get("state") == "cancelled":
                        t["logs"].append("⏹ 已停止")
                        return
                    t["done"] = 3
                    t["current"] = "同步完成"
                    if not res.get("ok"):
                        t["state"] = "error"
                        t["error"] = res.get("error", "同步失败")
                        t["logs"].append("✗ " + t["error"])
                    else:
                        t["state"] = "done"
                        if res.get("pending"):
                            t["logs"].append(f"扫描完成: {res['count']} 个可修正,{res.get('unmatched', 0)} 个未收录,等待勾选应用")
                        else:
                            t["logs"].append(f"同步完成: {res.get('count', 0)} 个规则")
            except Exception as exc:  # noqa: BLE001
                with _tasks_lock:
                    if t.get("state") == "cancelled":
                        t["logs"].append("⏹ 已停止")
                        return
                    t["state"] = "error"
                    t["error"] = str(exc)
                    t["logs"].append("✗ " + str(exc))

        threading.Thread(target=_run, daemon=True).start()
        return self._send_json({"ok": True, "task_id": tid})

    def _api_comic_subscriptions_pending(self, qs: dict):
        """GET /api/comic_subscriptions/pending?url= → 修正表刷新后的待应用匹配列表。"""
        from novel import comic as _comic
        url = (qs.get("url") or [""])[0].strip()
        sub = next((s for s in _comic.load_comic_subs() if s["url"] == url), None)
        if sub is None:
            return self._send_json({"error": "未找到该订阅"}, 404)
        pend = sub.get("pending")
        return self._send_json({"ok": True, "pending": pend,
                                "unmatched": sub.get("unmatched", 0),
                                "status": sub.get("status", "")})

    def _api_comic_source_import(self):
        """POST /api/comic_source_import {json} → 粘贴导入自定义漫画源规则(单条或数组)。"""
        from novel import comic as _comic
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        text = (data.get("json") or "").strip()
        if not text:
            return self._send_json({"error": "缺少规则 JSON"}, 400)
        try:
            res = _comic.import_custom_sources(text)
            return self._send_json({"ok": True, **res})
        except ValueError as exc:
            return self._send_json({"error": str(exc)}, 400)

    def _api_comic_search(self, qs):
        """GET /api/comic_search?q=关键词&source=源[,源...] → 漫画列表。

        source 支持逗号分隔多源,并发搜索后合并(每源结果前标 source_key,
        前端用于区分来源);单个源失败不影响其他源。
        """
        from novel import comic as _comic
        q = (qs.get("q") or [""])[0].strip()
        if not q:
            return self._send_json({"error": "缺少关键词"}, 400)
        srcs = [s.strip() for s in (qs.get("source") or ["mangadex"])[0].split(",") if s.strip()]
        if not srcs:
            srcs = ["mangadex"]
        # 过滤已停用的源
        try:
            states = {s["key"]: s.get("enabled", True) for s in _comic.get_sources()}
            srcs = [s for s in srcs if states.get(s, True)]
        except Exception:  # noqa: BLE001
            pass
        if not srcs:
            return self._send_json({"error": "所选漫画源均已停用"}, 502)

        def _search(src: str) -> tuple[str, list | None, str]:
            try:
                return src, _comic.search(q, source=src), ""
            except Exception as exc:  # noqa: BLE001
                return src, None, f"{type(exc).__name__}: {exc}"

        items: list = []
        errors: list = []
        if len(srcs) == 1:
            src, res, err = _search(srcs[0])
            if err:
                return self._send_json({"error": f"漫画搜索失败: {err}"}, 502)
            items = res or []
        else:
            with ThreadPoolExecutor(max_workers=len(srcs)) as pool:
                for src, res, err in pool.map(_search, srcs):
                    if err:
                        errors.append(f"{src}: {err}")
                    elif res:
                        for it in res:
                            it = dict(it)
                            it.setdefault("source_key", src)
                            items.append(it)
        return self._send_json({"ok": True, "items": items, "errors": errors})

    def _api_comic_search_async(self, qs):
        """GET /api/comic_search_async?q=关键词&source=源[,源...] → 立即返回 task_id。

        后台并发搜索各源,每源完成后把结果批次 push 进增量队列,
        前端通过 /api/comic_search_progress 轮询取增量,实现流式展示;
        全部完成后用 /api/comic_search_result 取最终结果(一次性清理)。
        """
        from novel import comic as _comic
        q = (qs.get("q") or [""])[0].strip()
        if not q:
            return self._send_json({"error": "缺少关键词"}, 400)
        srcs = [s.strip() for s in (qs.get("source") or ["mangadex"])[0].split(",") if s.strip()]
        if not srcs:
            srcs = ["mangadex"]
        try:
            states = {s["key"]: s.get("enabled", True) for s in _comic.get_sources()}
            srcs = [s for s in srcs if states.get(s, True)]
        except Exception:  # noqa: BLE001
            pass
        if not srcs:
            return self._send_json({"error": "所选漫画源均已停用"}, 502)
        tid = _uuid.uuid4().hex[:12]
        task = {"tid": tid, "q": q, "src": srcs, "state": "running", "done": 0,
                "total": len(srcs), "sources": [], "batches": [], "errors": [],
                "result_items": [], "added": time.time(), "started": time.time()}
        _comic_search_tasks[tid] = task

        def _run():
            def _search(src: str):
                try:
                    return src, _comic.search(q, source=src), ""
                except Exception as exc:  # noqa: BLE001
                    return src, None, f"{type(exc).__name__}: {exc}"
            try:
                with ThreadPoolExecutor(max_workers=len(srcs)) as pool:
                    for src, res, err in pool.map(_search, srcs):
                        task["done"] += 1
                        if err:
                            task["errors"].append(f"{src}: {err}")
                            task["sources"].append({"name": src, "status": "error"})
                            task["batches"].append({"source_key": src, "items": []})
                        else:
                            task["sources"].append({"name": src, "status": "done"})
                            items = []
                            for it in (res or []):
                                it = dict(it)
                                it.setdefault("source_key", src)
                                items.append(it)
                            task["batches"].append({"source_key": src, "items": items})
                            task["result_items"].extend(items)
                task["state"] = "done"
            except Exception as exc:  # noqa: BLE001
                task["state"] = "error"
                task["errors"].append(str(exc))

        threading.Thread(target=_run, daemon=True).start()
        return self._send_json({"task_id": tid})

    def _api_comic_search_progress(self, qs):
        """GET /api/comic_search_progress?id= → 取走增量批次(取后清空)。"""
        tid = (qs.get("id") or [""])[0].strip()
        task = _comic_search_tasks.get(tid)
        if task is None:
            return self._send_json({"error": "任务不存在"}, 404)
        batches = task["batches"]
        task["batches"] = []
        return self._send_json({
            "state": task["state"], "done": task["done"], "total": task["total"],
            "sources": task["sources"], "errors": task["errors"], "batches": batches,
        })

    def _api_comic_search_result(self, qs):
        """GET /api/comic_search_result?id= → 最终合并结果,一次性取走清理。"""
        tid = (qs.get("id") or [""])[0].strip()
        task = _comic_search_tasks.get(tid)
        if task is None:
            return self._send_json({"error": "任务不存在"}, 404)
        if task["state"] != "done":
            return self._send_json({"pending": True})
        items: list = task["result_items"]
        resp = {"ok": True, "items": items, "errors": task["errors"],
                "keyword": task["q"]}
        _comic_search_tasks.pop(tid, None)
        return self._send_json(resp)

    def _api_comic_toc(self, qs):
        """GET /api/comic_toc?id=漫画ID&source=源 → 话列表。"""
        from novel import comic as _comic
        mid = (qs.get("id") or [""])[0].strip()
        if not mid:
            return self._send_json({"error": "缺少漫画 ID"}, 400)
        src = (qs.get("source") or ["mangadex"])[0].strip()
        # 服务端退避重试:风控(210 访问过频/429/403)等 5s 重试一次,前后端双保险
        last_err = None
        for attempt in range(2):
            try:
                chs = _comic.chapters(mid, source=src)
                return self._send_json({"ok": True, "chapters": chs})
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                if attempt == 0 and ("210" in str(exc) or "429" in str(exc) or "过频" in str(exc) or "拦截" in str(exc)):
                    time.sleep(5)
                    continue
                break
        return self._send_json({"error": f"话列表获取失败: {last_err}"}, 502)

    def _api_comic_shelf(self, qs):
        """GET /api/comic_shelf → 漫画收藏列表。"""
        from novel.shelf import load_comic_shelf
        return self._send_json({"ok": True, "shelf": load_comic_shelf()})

    def _api_comic_shelf_backup(self):
        """GET /api/comic_shelf_backup → 漫画书架数据(前端触发下载)。"""
        from novel.shelf import load_comic_shelf
        return self._send_json({"shelf": load_comic_shelf(), "exported": True})

    def _api_comic_shelf_import(self):
        """POST /api/comic_shelf_import {shelf: [...]} → 合并导入(按 source+comic_id 去重)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        incoming = data.get("shelf") or []
        if not isinstance(incoming, list):
            return self._send_json({"error": "数据格式错误"}, 400)
        try:
            from novel.shelf import merge_comic_shelf
            added, total = merge_comic_shelf(incoming)
            return self._send_json({"ok": True, "added": added, "total": total})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"导入失败: {exc}"}, 500)

    def _api_comic_shelf_add(self):
        """POST /api/comic_shelf {title, source, comic_id, cover} → 收藏漫画。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        title = (data.get("title") or "").strip()
        source = (data.get("source") or "mangadex").strip()
        comic_id = (data.get("comic_id") or "").strip()
        if not title or not comic_id:
            return self._send_json({"error": "缺少书名或漫画 ID"}, 400)
        from novel.shelf import add_comic_shelf
        entry = add_comic_shelf(title, source, comic_id, data.get("cover", ""))
        return self._send_json({"ok": True, "entry": entry})

    def _api_comic_shelf_del(self):
        """POST /api/comic_shelf/del {source, comic_id} → 取消收藏。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        from novel.shelf import remove_comic_shelf
        ok = remove_comic_shelf((data.get("source") or "mangadex").strip(), (data.get("comic_id") or "").strip())
        return self._send_json({"ok": ok})

    def _api_comic_shelf_refresh(self):
        """POST /api/comic_shelf/refresh → 批量检查漫画书架更新。

        逐部拉最新目录对比本地已下载 PDF 数,回写 checked_chapters/have,
        返回每部的新话数(供前端提示"有更新")。源停用/网络失败单部容错。
        """
        from novel import comic as _comic
        from novel.shelf import load_comic_shelf, update_comic_entry
        shelf = load_comic_shelf()

        def _check(e: dict) -> dict:
            title = e.get("title", "")
            r = _comic.check_updates(
                e.get("comic_id", ""), source=e.get("source", "mangadex"), title=title)
            update_comic_entry(e.get("source", ""), e.get("comic_id", ""),
                               checked_chapters=r.get("total", 0), have=r.get("have", 0))
            return {"title": title, "ok": r.get("ok", False),
                    "total": r.get("total", 0), "have": r.get("have", 0),
                    "new": r.get("new", 0), "error": r.get("error", "")}

        results = []
        if shelf:
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(_check, shelf))
        updated = sum(1 for r in results if r.get("new", 0) > 0)
        return self._send_json({"ok": True, "results": results, "updated": updated})

    def _api_comic_download(self):
        """POST /api/comic_download {title, chapters, mode} → 异步任务。

        mode: per_chapter(每话一个PDF,默认) | merged(全部融合一个PDF) | zip(图片ZIP)
        """
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        title = (data.get("title") or "").strip()
        chs = data.get("chapters") or []
        src = (data.get("source") or "mangadex").strip()
        comic_id = (data.get("comic_id") or "").strip()
        mode = (data.get("mode") or "per_chapter").strip()
        if mode not in ("per_chapter", "merged", "zip"):
            mode = "per_chapter"
        if not title or not chs:
            return self._send_json({"error": "缺少书名或章节"}, 400)
        if not isinstance(chs, list):
            return self._send_json({"error": "章节格式错误"}, 400)
        tid = _next_task_id()
        with _tasks_lock:
            _tasks[tid] = {
                "id": tid, "kind": "comic_download",
                "title": title, "chapters": len(chs), "source": src, "comic_id": comic_id,
                "mode": mode,
                "state": "running", "done": 0, "total": len(chs),
                "current": "已加入下载队列…", "logs": [],
                "error": "", "out_path": "", "added": time.time(),
            }
        threading.Thread(target=_run_comic_download,
                         args=(tid, title, chs, src, comic_id, mode), daemon=True).start()
        return self._send_json({"ok": True, "task_id": tid, "total": len(chs)})

    def _api_comic_files(self, qs):
        """GET /api/comic_files → 已下载漫画 PDF 列表(按书名分组)。

        只扫描漫画专属目录 COMIC_OUT_DIR(downloads/comic/),与小说
        (downloads/ 下的 txt/epub)彻底隔离,避免互相污染。
        """
        out_dir = COMIC_OUT_DIR
        items = []
        try:
            if os.path.isdir(out_dir):
                for name in sorted(os.listdir(out_dir)):
                    d = os.path.join(out_dir, name)
                    if not os.path.isdir(d):
                        continue
                    pdfs = sorted(f for f in os.listdir(d) if f.lower().endswith(".pdf"))
                    if not pdfs:
                        continue
                    total_size = sum(os.path.getsize(os.path.join(d, f)) for f in pdfs)
                    meta = None
                    try:
                        with open(os.path.join(d, "meta.json"), "r", encoding="utf-8") as f:
                            meta = json.load(f)
                    except (OSError, json.JSONDecodeError):
                        meta = None
                    items.append({
                        "title": name, "dir": name,
                        "files": len(pdfs),
                        "size": total_size,
                        "pdfs": pdfs[:200],
                        "cover_url": "/api/comic_cover?title=" + _url_quote(name) +
                                      "&file=" + _url_quote(pdfs[0]),
                        "meta": meta,
                    })
        except OSError:
            pass
        return self._send_json({"ok": True, "items": items, "out_dir": out_dir})

    def _api_comic_pack(self, qs: dict):
        """GET /api/comic_pack?title=xxx → 整本漫画所有 PDF 打包为一个 zip 附件下载。

        手机端“下载整本”用:漫画图多体积大,单文件 zip 比逐个 PDF 更友好。
        ZIP_STORED 不压缩(PDF 已压缩,再压徒耗 CPU),临时文件写完即发、发完即删。
        """
        import zipfile as _zp
        import tempfile as _tf
        title = (qs.get("title") or [""])[0].strip()
        if not title or ".." in title or "/" in title or "\\" in title:
            return self._send_json({"error": "invalid title"}, 400)
        book_dir = os.path.join(COMIC_OUT_DIR, title)
        if not os.path.isdir(book_dir):
            return self._send_json({"error": "not found"}, 404)
        pdfs = sorted(f for f in os.listdir(book_dir) if f.lower().endswith(".pdf"))
        if not pdfs:
            return self._send_json({"error": "no pdf"}, 404)
        fd, tmp = _tf.mkstemp(suffix=".zip")
        os.close(fd)
        try:
            with _zp.ZipFile(tmp, "w", _zp.ZIP_STORED) as z:
                for f in pdfs:
                    z.write(os.path.join(book_dir, f), arcname=f)
            # 手机同步:登记整本 zip 任务并实时上报进度
            sid = (qs.get("sid") or [""])[0]
            if sid:
                task = title + ".zip"
                self._sync_touch(sid, task=task, size=os.path.getsize(tmp), status="downloading")
                return self._send_file(tmp, "application/zip", as_attachment=True,
                                       filename=task,
                                       progress=lambda snt, tot, t=task: self._sync_touch(
                                           sid, task=t, sent=snt,
                                           status="done" if snt >= tot else "downloading"))
            return self._send_file(tmp, "application/zip", as_attachment=True,
                                   filename=title + ".zip")
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

    def _api_comic_cover(self, qs):
        """GET /api/comic_cover?title=&file= → 该 PDF 首面图像(JPEG/PNG,带缓存)。"""
        from novel.pdfcover import extract_first_image
        title = (qs.get("title") or [""])[0].strip()
        fname = (qs.get("file") or [""])[0].strip()
        if not title or not fname:
            return self._send_json({"error": "缺少参数"}, 400)
        if not fname.lower().endswith(".pdf"):
            return self._send_json({"error": "非法文件"}, 400)
        path = os.path.join(COMIC_OUT_DIR, os.path.basename(title), os.path.basename(fname))
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return self._send_json({"error": "文件不存在"}, 404)
        img = extract_first_image(data)
        if not img:
            return self._send_json({"error": "提取失败"}, 404)
        img_bytes, fmt = img
        return self._send_binary(
            img_bytes,
            "image/jpeg" if fmt == "jpeg" else "image/png",
            cache=True,
        )

    def _api_comic_pdf_meta(self, qs):
        """GET /api/comic_pdf_meta?title=&file= → 匹配该书 meta.json(按书名/PDF 名)。

        按章节拆分产物存在 meta_split.json:正在看拆分出的「{话名}.pdf」时
        优先返回它,目录按章节呈现;看原合集时仍用原 meta.json 页区间。"""
        title = (qs.get("title") or [""])[0].strip()
        fname = (qs.get("file") or [""])[0].strip()
        if not title:
            return self._send_json({"error": "缺少书名"}, 400)
        d = os.path.join(COMIC_OUT_DIR, os.path.basename(title))

        def _load(name):
            try:
                with open(os.path.join(d, name), "r", encoding="utf-8") as f:
                    return json.load(f)
            except (OSError, json.JSONDecodeError):
                return None

        meta = _load("meta.json")
        split = _load("meta_split.json")
        if fname and split and split.get("mode") == "per_chapter":
            if any(c.get("pdf") == fname for c in split.get("chapters") or []):
                meta = split  # 正在看拆分产物 → 用拆分清单当目录
        pdfs = []
        try:
            pdfs = sorted(x for x in os.listdir(d) if x.lower().endswith(".pdf"))
        except OSError:
            pass
        if not meta:
            return self._send_json({"ok": True, "meta": None, "pdfs": pdfs})
        if fname and meta.get("mode") == "per_chapter":
            for v in meta.get("volumes") or []:
                for c in v.get("chapters") or []:
                    if c.get("pdf") == fname:
                        return self._send_json({"ok": True, "meta": meta, "pdfs": pdfs, "current": c})
        return self._send_json({"ok": True, "meta": meta, "pdfs": pdfs})

    def _resolve_comic_pdf(self, qs):
        """校验 title/file 参数并解析为漫画 PDF 绝对路径;非法或不存在返回 None。

        basename 双重剥离防路径遍历(与 _api_comic_cover 同套路)。"""
        title = (qs.get("title") or [""])[0].strip()
        fname = (qs.get("file") or [""])[0].strip()
        if not title or not fname or not fname.lower().endswith(".pdf"):
            return None
        path = os.path.join(COMIC_OUT_DIR, os.path.basename(title), os.path.basename(fname))
        return path if os.path.isfile(path) else None

    def _api_comic_page_meta(self, qs):
        """GET /api/comic_page_meta?title=&file= → PDF 页数(图片直读模式用)。

        pypdf 只解析页树不解码图片,百兆级 PDF 也毫秒级返回。"""
        from pypdf import PdfReader
        path = self._resolve_comic_pdf(qs)
        if not path:
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            with open(path, "rb") as f:
                n = len(PdfReader(f).pages)
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "解析失败"}, 500)
        return self._send_json({"ok": True, "num_pages": n})

    def _api_comic_page_image(self, qs):
        """GET /api/comic_page_image?title=&file=&page= → 单页最大内嵌图(JPEG)。

        图片直读模式核心:绕过 pdf.js 直接抽取 PDF 内嵌位图流,客户端零解码
        内存占用最小。JPEG 原样透传零重编码;其他格式用 PIL 兜底转 JPEG;
        无图/损坏页返回白页占位,保持页序可见。"""
        import io as _io
        from pypdf import PdfReader
        from novel.comic import white_page_jpeg
        path = self._resolve_comic_pdf(qs)
        if not path:
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            page_no = int((qs.get("page") or ["1"])[0])
        except ValueError:
            page_no = 1
        data = b""
        if page_no >= 1:
            try:
                with open(path, "rb") as f:
                    pages = PdfReader(f).pages
                    if page_no <= len(pages):
                        best = b""
                        for im in pages[page_no - 1].images:
                            if len(im.data) > len(best):
                                best = im.data
                        data = best
            except Exception:  # noqa: BLE001
                data = b""
        if data and data[:2] != b"\xff\xd8":
            # 非 JPEG 内嵌图(JBIG2/Flate/PNG 等):PIL 兜底转 JPEG
            try:
                from PIL import Image
                im = Image.open(_io.BytesIO(data))
                im.seek(0)  # 动图取首帧
                if im.mode not in ("RGB", "L"):
                    im = im.convert("RGB")
                out = _io.BytesIO()
                im.save(out, "JPEG", quality=85, optimize=True)
                data = out.getvalue()
            except Exception:  # noqa: BLE001
                data = b""
        if not data:
            data = white_page_jpeg()
        self._send_binary(data, "image/jpeg", cache=True)

    def _api_comic_compress(self):
        """POST /api/comic_compress {title} → 存量漫画 PDF 一键压缩。

        功能上线前下载的 PDF 不受生成端压缩影响;此接口按当前 pdf_quality
        档位逐页抽取内嵌最大图重编码后 img2pdf 重建,输出「原名_压缩.pdf」,
        原文件保留;已是压缩版(_压缩.pdf)自动跳过。quality 为 original
        时拒绝(无压缩意义),提示先到设置选择档位。"""
        from novel.comic import compress_comic_pdf
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        title = (body.get("title") or "").strip()
        if not title:
            return self._send_json({"error": "缺少书名"}, 400)
        quality = load_settings().get("pdf_quality") or "hq"
        if quality not in ("hq", "eco"):
            return self._send_json({"error": "请先在设置中把「PDF 图片质量」改为 高清 或 省流"}, 400)
        book_dir = os.path.join(COMIC_OUT_DIR, os.path.basename(title))
        if not os.path.isdir(book_dir):
            return self._send_json({"error": "目录不存在"}, 404)
        names = sorted(f for f in os.listdir(book_dir)
                       if f.lower().endswith(".pdf") and "_压缩" not in f)
        if not names:
            return self._send_json({"error": "没有可压缩的 PDF(可能均已压缩过)"}, 404)
        before = after = 0
        try:
            for name in names:
                path = os.path.join(book_dir, name)
                dst = path[:-4] + "_压缩.pdf"
                compress_comic_pdf(path, dst, quality)
                before += os.path.getsize(path)
                after += os.path.getsize(dst)
        except Exception as e:  # noqa: BLE001
            return self._send_json({"error": "压缩失败: " + str(e)[:200]}, 500)
        return self._send_json({"ok": True, "files": len(names), "before": before, "after": after})

    def _api_comic_split(self):
        """POST /api/comic_split {title, pages_per_part?} → 大 PDF 拆分为多卷。

        优先按章节拆:merged 合集 meta.json 的 volumes 各话页区间
        (first_page/last_page)按话切为「{话名}.pdf」(与按话下载命名一致),
        并写 meta_split.json 供阅读器目录按章节呈现;无章节元数据时回退
        按固定页数(pages_per_part,默认 50)切为「原名_拆N.pdf」。
        pypdf 原样复制页面流不重编码不损画质,原文件与原 meta.json 均保留;
        目标文件已存在则跳过,绝不覆盖。"""
        from novel.comic import split_comic_pdf, split_comic_pdf_chapters, build_split_meta
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        title = (body.get("title") or "").strip()
        if not title:
            return self._send_json({"error": "缺少书名"}, 400)
        book_dir = os.path.join(COMIC_OUT_DIR, os.path.basename(title))
        if not os.path.isdir(book_dir):
            return self._send_json({"error": "目录不存在"}, 404)

        # ---- 章节拆分:merged 合集 + volumes 带有效页区间 ----
        meta = None
        try:
            with open(os.path.join(book_dir, "meta.json"), "r", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, json.JSONDecodeError):
            meta = None
        if meta and meta.get("mode") == "merged":
            chapters = [c for v in meta.get("volumes") or []
                        for c in v.get("chapters") or []]

            def _valid(c):
                try:
                    fp = int(c.get("first_page") or 0)
                    lp = int(c.get("last_page") or 0)
                except (TypeError, ValueError):
                    return False
                return fp >= 1 and lp >= fp

            valid = [c for c in chapters if _valid(c)]
            src_name = str(meta.get("pdf") or "").strip()
            src = os.path.join(book_dir, os.path.basename(src_name)) if src_name else ""
            if src_name and os.path.isfile(src) and valid:
                try:
                    made, skipped = split_comic_pdf_chapters(src, valid, book_dir)
                except Exception as e:  # noqa: BLE001
                    return self._send_json({"error": "拆分失败: " + str(e)[:200]}, 500)
                if made:
                    try:
                        with open(os.path.join(book_dir, "meta_split.json"), "w",
                                  encoding="utf-8") as f:
                            json.dump(build_split_meta(meta, made), f,
                                      ensure_ascii=False, indent=1)
                    except OSError:
                        pass  # 拆分清单写失败不影响已拆出的文件
                return self._send_json({"ok": True, "mode": "chapter",
                                        "files": len(made), "skipped": skipped,
                                        "total": len(chapters)})

        # ---- 回退:按固定页数拆 ----
        try:
            per = int(body.get("pages_per_part") or 50)
        except (TypeError, ValueError):
            per = 50
        if not 5 <= per <= 500:
            return self._send_json({"error": "每卷页数需在 5~500 之间"}, 400)
        names = sorted(f for f in os.listdir(book_dir)
                       if f.lower().endswith(".pdf") and "_拆" not in f)
        if not names:
            return self._send_json({"error": "目录下没有 PDF"}, 404)
        parts = 0
        done = 0
        try:
            from pypdf import PdfReader
            for name in names:
                path = os.path.join(book_dir, name)
                try:
                    with open(path, "rb") as f:
                        n = len(PdfReader(f).pages)
                except Exception:  # noqa: BLE001
                    continue  # 损坏文件跳过,不阻断其余拆分
                if n <= per:
                    continue
                parts += len(split_comic_pdf(path, per))
                done += 1
        except Exception as e:  # noqa: BLE001
            return self._send_json({"error": "拆分失败: " + str(e)[:200]}, 500)
        if not done:
            return self._send_json({"error": f"没有超过 {per} 页的大 PDF,无需拆分"}, 404)
        return self._send_json({"ok": True, "mode": "pages", "files": done,
                                "parts": parts, "pages": per})

    def _api_comic_pages(self, qs):
        """GET /api/comic_pages?source=&comic_id=&ep_id= → 某话图片 URL 列表(在线阅读)。"""
        from novel import comic as _comic
        src = (qs.get("source") or ["mangadex"])[0].strip()
        cid = (qs.get("comic_id") or [""])[0].strip()
        ep = (qs.get("ep_id") or [""])[0].strip()
        if not ep:
            return self._send_json({"error": "缺少话 ID"}, 400)
        try:
            urls = _comic.pages(ep, source=src, comic_id=cid)
            return self._send_json({"ok": True, "urls": urls, "source": src})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"图片列表获取失败: {exc}"}, 502)

    def _api_comic_img(self, qs):
        """GET /api/comic_img?url=&source= → 代理加载漫画图片(带源 Referer,解决防盗链)。"""
        import requests as _rq
        url = (qs.get("url") or [""])[0].strip()
        if not url.startswith("http"):
            return self._send_json({"error": "非法图片地址"}, 400)
        src = (qs.get("source") or ["mangadex"])[0].strip()
        from novel import comic as _comic
        referer = _comic.img_referer(src)
        hdrs = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "Referer": referer,
        }
        try:
            r = None
            for attempt in range(2):  # 单次网络抖动即空缺一页(页数不连续观感),自动重试一次
                try:
                    r = _rq.get(url, headers=hdrs, timeout=30)
                    if r.status_code == 200:
                        break
                except _rq.RequestException:
                    if attempt:
                        raise
                    time.sleep(0.6)
            if r is not None and r.status_code == 200:
                ctype = r.headers.get("Content-Type", "image/jpeg")
                return self._send_binary(r.content, ctype)
            raise RuntimeError(f"HTTP {r.status_code if r is not None else '?'}")
        except Exception as exc:  # noqa: BLE001
            # 自定义 CDN 失败 → 换官方节点 uploads.mangadex.org 重试一次(路径结构 /data/<hash>/<file>)
            if src == "mangadex":
                try:
                    from urllib.parse import urlparse
                    pu = urlparse(url)
                    if pu.path.startswith("/data/") and pu.hostname != "uploads.mangadex.org":
                        r2 = _rq.get("https://uploads.mangadex.org" + pu.path,
                                     headers=hdrs, timeout=30)
                        if r2.status_code == 200:
                            return self._send_binary(
                                r2.content, r2.headers.get("Content-Type", "image/jpeg"))
                except Exception:  # noqa: BLE001
                    pass
            return self._send_json({"error": f"图片加载失败: {exc}"}, 502)

    def _api_source_export(self):
        """POST /api/source_export {name} → 返回该书源规则 JSON(供下载/分享)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        name = (data.get("name") or "").strip()
        if not name:
            return self._send_json({"error": "缺少书源名"}, 400)
        for s in load_all_sources():
            if s.get("name") == name:
                # 关键字段(分享用),过滤内部字段
                rule = {k: v for k, v in s.items() if k not in ("custom", "enabled", "score", "last_ok")}
                return self._send_json({"ok": True, "rule": rule})
        return self._send_json({"error": "未找到该书源"}, 404)

    # ---- 书源体检:启动快速探测启用源,自动停用失效源 ----
    def _api_source_health(self):
        if _health_state.get("running") or _sync_state.get("running"):
            return self._send_json({"error": "已有任务进行中,请稍候"}, 409)

        def _probe(source):
            import requests as _rq
            base = source["base"].rstrip("/")
            try:
                r = _rq.get(base, headers=_UA_HEADERS, timeout=6,
                            allow_redirects=True, stream=True)
                r.close()
                return r.status_code < 500
            except Exception:
                return False

        def _run():
            try:
                _health_state["running"] = True
                srcs = [s for s in load_all_sources() if s.get("enabled")]
                _health_state["total"] = len(srcs)
                dead = []
                with ThreadPoolExecutor(max_workers=8) as pool:
                    futs = {pool.submit(_probe, s): s for s in srcs}
                    for fut in as_completed(futs):
                        s = futs[fut]
                        try:
                            alive = fut.result()
                        except Exception:
                            alive = False
                        if not alive:
                            dead.append(s["name"])
                stopped = []
                for name in dead:
                    src = next((x for x in load_all_sources() if x["name"] == name), None)
                    if src is None or not src.get("enabled"):
                        continue
                    if src.get("custom"):
                        update_custom_source(name, {"enabled": False})
                    else:
                        set_source_state(name, False)
                    stopped.append(name)
                _health_state.update({"running": False, "dead": stopped, "total": len(srcs)})
            except Exception as exc:
                _health_state.update({"running": False, "error": str(exc)})

        _health_state.update({"running": True, "dead": [], "total": 0, "error": ""})
        threading.Thread(target=_run, daemon=True).start()
        return self._send_json({"ok": True})

    def _api_source_health_status(self):
        return self._send_json(dict(_health_state))

    # ---- EPUB 阅读 ----
    def _api_epub_meta(self, qs):
        from novel.epub import parse_epub
        fname = (qs.get("file") or [""])[0].strip()
        if not fname:
            return self._send_json({"error": "缺少 file"}, 400)
        if ".." in fname or "/" in fname or "\\" in fname:
            return self._send_json({"error": "非法文件名"}, 400)
        out_dir = get_out_dir()
        path = os.path.join(out_dir, fname)
        if not os.path.isfile(path):
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            chs = parse_epub(path)
            return self._send_json({"title": fname, "chapters": [
                {"idx": c["idx"], "title": c["title"], "path": c.get("path", ""),
                 "volume": c.get("volume", "") or ""} for c in chs]})
        except Exception as exc:
            return self._send_json({"error": f"EPUB 解析失败: {exc}"}, 500)

    def _api_network(self, qs=None):
        """局域网访问信息:是否开启 + 本机局域网 IP 列表 + 二维码(base64)。

        性能关键:每次打开设置都会调用,必须快!已去掉 ipconfig subprocess(134ms),
        只用 UDP 探测(1ms) + getaddrinfo(7ms)。二维码 + IP 缓存 30 秒。

        ?force=1 可强制刷新(热点开启后「重新检测」用,否则 30s 内二维码仍指向旧 IP)。
        """
        import socket as _sk
        from novel.config import load_settings as _ls3
        import time as _t
        qs = qs or {}
        force = str((qs.get("force") or [""])[0] or "") in ("1", "true", "yes")
        # 缓存:同一端口/IP 组合 30s 内直接返回
        now = _t.time()
        cache = getattr(self.server, "_lan_cache", None)
        if cache and not force and now - cache["ts"] < 30:
            return self._send_json(cache["data"])
        lan = bool(_ls3().get("lan_access"))
        port = ""
        try:
            port = str(self.server.server_address[1])
        except Exception:  # noqa: BLE001
            pass
        ips: list[str] = []
        try:
            s = _sk.socket(_sk.AF_INET, _sk.SOCK_DGRAM)
            s.settimeout(0.5)
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
            s.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            for info in _sk.getaddrinfo(_sk.gethostname(), None, _sk.AF_INET):
                ip = info[4][0]
                if ip not in ips and not ip.startswith("127."):
                    ips.append(ip)
        except Exception:  # noqa: BLE001
            pass
        # 去掉了 ipconfig subprocess(134ms 阻塞),getaddrinfo 已足够
        # 热点网段 IP 置顶(校园网下手机连电脑热点后扫码,IP 即 192.168.137.1)
        try:
            from novel.hotspot import detect as _hs_detect
            _hs = _hs_detect()
            for ip in reversed(_hs.get("hotspot_ips") or []):
                if ip in ips:
                    ips.remove(ip)
                ips.insert(0, ip)
        except Exception:  # noqa: BLE001
            pass
        qr_b64 = ""
        try:
            import base64 as _b64
            import io as _io
            import qrcode as _qr
            from novel.hotspot import best_lan_ip as _best_lan
            primary_ip = _best_lan() or (ips[0] if ips else "127.0.0.1")
            qr = _qr.QRCode(box_size=4, border=1, error_correction=_qr.constants.ERROR_CORRECT_M)
            qr.add_data(f"http://{primary_ip}:{port}/mobile")
            qr.make(fit=True)
            img = qr.make_image(fill_color="#1d1d1f", back_color="white")
            buf = _io.BytesIO(); img.save(buf, format="PNG")
            qr_b64 = _b64.b64encode(buf.getvalue()).decode()
        except Exception:  # noqa: BLE001
            pass
        data = {"lan_access": lan, "ips": ips[:6], "port": port, "qr_b64": qr_b64}
        self.server._lan_cache = {"ts": now, "data": data}
        return self._send_json(data)

    # ---------------- 远程连接:热点检测 / 内网穿透 / WebRTC 扫码 ----------------
    def _api_hotspot(self, qs=None):
        """校园网场景检测:移动热点是否开启/热点 IP/无线状态。

        ?force=1 跳过 5s 缓存(刚开启热点后点「重新检测」时用)。
        """
        qs = qs or {}
        force = str((qs.get("force") or [""])[0] or "") in ("1", "true", "yes")
        from novel import hotspot as _hs_mod
        if force:
            d = _hs_mod.detect(force=True)
        else:
            d = _hs_mod.detect()
        return self._send_json(d)

    def _api_hotspot_open(self):
        """POST /api/hotspot/open → 打开 Windows「移动热点」系统设置页。

        校园网引导:与其让用户自己找设置入口,电脑直接跳转(其余交给电脑)。
        """
        if os.name != "nt":
            return self._send_json({"ok": False, "error": "仅支持 Windows"})
        try:
            os.startfile("ms-settings:network-mobilehotspot")  # noqa: S606
            return self._send_json({"ok": True})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"ok": False, "error": str(exc)}, 500)

    def _api_tunnel(self):
        """隧道状态(运行中/公网 URL/日志/配置)。"""
        return self._send_json(_get_tunnel().status())

    def _api_tunnel_ctrl(self):
        """POST /api/tunnel {action, cmd, args, url_regex} → 启动/停止 + 持久化配置。

        action=start_auto: 免注册 SSH 临时隧道(localhost.run/serveo/pinggy 依次尝试),
        首个成功拿到公网地址的胜出 —— 方法一,手机任意网络扫码即可完成首次准备。
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        from novel.config import load_settings as _ls5, save_settings as _ss5
        from novel.tunnel import parse_args as _pa
        action = payload.get("action", "")
        mgr = _get_tunnel()
        if action == "start_auto":
            import shutil as _shutil
            from novel.tunnel import get_ssh_presets
            if os.name != "nt" and not _shutil.which("ssh"):
                return self._send_json({"ok": False,
                                        "error": "系统没有 ssh 命令(Windows 10+ 自带 OpenSSH)"}, 400)
            port = self.server.server_address[1]
            errors = []
            for p in get_ssh_presets(port):
                mgr.stop()
                r = mgr.start(p["cmd"], _pa(p["args"]), "")
                if not r.get("ok"):
                    errors.append(f"{p['name']}: {r.get('error', '?')}")
                    continue
                # 最多等 12 秒抓公网地址(ssh 横幅打到 stdout 后由守护线程捕获)
                for _ in range(24):
                    st = mgr.status()
                    if st.get("url"):
                        try:
                            _ss5({"tunnel_cmd": p["cmd"], "tunnel_args": p["args"],
                                  "tunnel_url_regex": "", "tunnel_autostart": False})
                        except Exception:  # noqa: BLE001
                            pass
                        return self._send_json({"ok": True, "url": st["url"],
                                                "preset": p["name"], "running": True})
                    if not st.get("running"):
                        break
                    time.sleep(0.5)
                errors.append(f"{p['name']}: 未获得公网地址")
                mgr.stop()
            return self._send_json({
                "ok": False,
                "error": "免费免注册隧道服务当前都连不上(校园网常拦出站 22 端口,"
                         "部分服务已改为需注册)。可用替代:点「📥 下载连接文件」发给手机,"
                         "或配置 natapp/cpolar 后在「公网穿透」页签启动。详情: " + " | ".join(errors), }, 502)
        if action == "start":
            cmd = (payload.get("cmd") or "").strip()
            args = payload.get("args") or ""
            url_regex = payload.get("url_regex") or ""
            if not cmd:  # 未提供则用已保存配置
                cur = _ls5()
                cmd = cur.get("tunnel_cmd", "")
                args = cur.get("tunnel_args", "")
                url_regex = cur.get("tunnel_url_regex", "")
            r = mgr.start(cmd, _pa(str(args)), str(url_regex))
            if r.get("ok"):
                try:
                    _ss5({"tunnel_cmd": cmd, "tunnel_args": str(args),
                          "tunnel_url_regex": str(url_regex), "tunnel_autostart": True})
                except Exception:  # noqa: BLE001
                    pass
            return self._send_json(r)
        if action == "stop":
            r = mgr.stop()
            try:
                from novel.config import save_settings as _ss6
                _ss6({"tunnel_autostart": False})
            except Exception:  # noqa: BLE001
                pass
            return self._send_json(r)
        return self._send_json({"error": "未知 action"}, 400)

    def _api_webrtc_offer(self):
        """生成 WebRTC 连接:返回 offer(压缩 base64)+ 二维码(base64)。

        同时在云端信令总线上按 offer 派生的主题订阅:手机扫码后把 answer
        自动 publish 上来(手机只扫一次码),摄像头扫码/手动粘贴降级为备用。
        """
        _get_wrtc().set_port(self.server.server_address[1])
        r = _get_wrtc().create_offer()
        if r.get("ok"):
            # 连接码 = novelist-wrtc://v1/{offer_b64}(可选 #{ice 提示})
            # ice 提示把 STUN/TURN 下发给手机;老手机页解析正则只取 base64 段,
            # 自动忽略 # 段,向后兼容。
            offer_b64 = r["offer"].rsplit("/", 1)[-1]
            try:
                from novel.webrtc import phone_ice_hints, encode_phone_hints
                hints = phone_ice_hints()
                r["offer"] += "#" + encode_phone_hints(hints)
            except Exception:  # noqa: BLE001
                pass
            qr_b64 = ""
            try:
                import base64 as _b64
                import io as _io
                import qrcode as _qr
                # 连接码约 1KB(混合大小写的 base64)→ 字节模式编码,密度很低:
                #   ECC=M 会到 version 26(123×123 模块)
                #   ECC=L 只到 version 23(111×111 模块)
                # 屏幕扫码不需要高纠错(没有污损),用 L 换取更低版本 = 更大的模块。
                qr = _qr.QRCode(box_size=3, border=1,
                                error_correction=_qr.constants.ERROR_CORRECT_L)
                qr.add_data(r["offer"])
                qr.make(fit=True)
                img = qr.make_image(fill_color="#1d1d1f", back_color="white")
                buf = _io.BytesIO(); img.save(buf, format="PNG")
                qr_b64 = _b64.b64encode(buf.getvalue()).decode()
            except Exception:  # noqa: BLE001
                pass
            r["qr_b64"] = qr_b64
            # 云端自动回传:订阅派生主题,收到 answer 直接提交(与摄像头扫码等效)
            try:
                from novel.signal_mqtt import derive_topic, parse_signal_payload
                from novel.webrtc import note as _note, get_manager
                topic = derive_topic(offer_b64)
                session = r["session"]

                def _on_signal(payload: str) -> None:
                    answer_b64 = parse_signal_payload(payload)
                    if not answer_b64:
                        return
                    _note("收到云端自动回传的应答码,正在提交…")
                    sub = get_manager().submit_answer(session, answer_b64)
                    if sub.get("ok"):
                        _note("应答码已自动提交,等待直连建立…")
                    else:
                        _note("自动提交失败: " + str(sub.get("error") or "?")
                              + "(可改用摄像头扫码或手动粘贴)")

                _get_signal().listen(topic, _on_signal)
                r["signal_topic"] = topic
                r["signal_auto"] = True
            except Exception as exc:  # noqa: BLE001
                r["signal_auto"] = False
                from novel.webrtc import note as _note2
                _note2(f"云端信令启动失败({exc}),请用摄像头扫码或手动粘贴应答码")
        return self._send_json(r)

    def _api_webrtc_status(self):
        """WebRTC 会话状态 + 摄像头扫码状态 + 云端信令状态 + 事件日志。"""
        w = _get_wrtc().status()
        c = _get_cam().status()
        try:
            sig = _get_signal().status()
        except Exception:  # noqa: BLE001
            sig = {"online": 0, "topic": "", "brokers": []}
        return self._send_json({**w, "cam": c, "signal": sig})

    def _api_webrtc_answer(self):
        """POST /api/webrtc/answer {session, answer_b64} → 提交手机端 answer。"""
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        session = payload.get("session") or ""
        answer = payload.get("answer_b64") or ""
        if not session or not answer:
            return self._send_json({"error": "缺少 session 或 answer_b64"}, 400)
        return self._send_json(_get_wrtc().submit_answer(session, answer))

    def _api_webrtc_stop(self):
        """POST /api/webrtc/stop {session} → 主动断开指定会话。"""
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        session = payload.get("session") or ""
        if session == "__all__":   # 断开全部(前端「断开」按钮)
            r = _get_wrtc().drop_all()
            _get_signal().stop()   # 没有等待中的会话就不必再听云端
            return self._send_json(r)
        if session:
            r = _get_wrtc().drop(session)
        else:
            # 未指定则兜底断开全部,避免残留会话
            r = _get_wrtc().drop_all()
            _get_signal().stop()
        # 全部会话都结束(无等待中)时顺带停掉云端信令
        st = _get_wrtc().status()
        if not any(not s.get("connected") for s in st.get("sessions", [])):
            _get_signal().stop()
        return self._send_json(r)

    def _api_webrtc_cam(self):
        """POST /api/webrtc/cam {action: start|stop} → 启停 PC 摄像头扫码。

        扫码识别到 novelist-wrtc:// 前缀的 answer 二维码后自动提交给
        最近一个等待 answer 的 WebRTC 会话。
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        action = payload.get("action", "")
        cam = _get_cam()

        def _on_qr(text: str) -> None:
            answer_b64 = text.split("novelist-wrtc://v1/", 1)[-1] if "://" in text else text
            w = _get_wrtc()
            st = w.status()
            sessions = [s for s in st.get("sessions", []) if not s.get("connected")]
            if not sessions:
                # 之前这里静默返回,前端会一直显示「摄像头扫码中…」却毫无进展
                _cam_note("扫码成功,但当前没有等待连接的会话 —— 请先点「生成连接码」")
                return
            target = sessions[-1]
            r = w.submit_answer(target["session"], answer_b64)
            if r.get("ok"):
                _cam_note(f"应答码已提交给会话 {target['session']},等待直连建立…")
            else:
                _cam_note("应答码提交失败: " + str(r.get("error") or "未知原因")
                          + "。请重新点「生成连接码」后再扫。")

        if action == "start":
            w = _get_wrtc()
            st = w.status()
            if not any(not s.get("connected") for s in st.get("sessions", [])):
                return self._send_json(
                    {"ok": False, "error": "还没有等待连接的会话,请先点「生成连接码」"})
            return self._send_json(cam.start(_on_qr))
        if action == "stop":
            return self._send_json(cam.stop())
        return self._send_json({"error": "未知 action"}, 400)

    def _api_qr(self, qs):
        """GET /api/qr?text=... → {qr_b64} 通用二维码生成(公网穿透地址等)。"""
        text = (qs.get("text") or [""])[0].strip()
        if not text:
            return self._send_json({"error": "缺少 text"}, 400)
        qr_b64 = ""
        try:
            import base64 as _b64
            import io as _io
            import qrcode as _qr
            qr = _qr.QRCode(box_size=4, border=1,
                            error_correction=_qr.constants.ERROR_CORRECT_M)
            qr.add_data(text)
            qr.make(fit=True)
            img = qr.make_image(fill_color="#1d1d1f", back_color="white")
            buf = _io.BytesIO(); img.save(buf, format="PNG")
            qr_b64 = _b64.b64encode(buf.getvalue()).decode()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "二维码生成失败(缺 qrcode 库?)"}, 500)
        return self._send_json({"qr_b64": qr_b64})

    def _api_notes(self, qs):
        """GET /api/notes?key=书名 → {bookmarks, notes}"""
        key = (qs.get("key") or [""])[0].strip()
        if not key:
            return self._send_json({"error": "缺少 key"}, 400)
        from novel.notes import get_book
        return self._send_json(get_book(key))

    def _api_notes_post(self):
        """POST /api/notes {key, action, ...} → 操作后的最新数据"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        key = (data.get("key") or "").strip()
        action = data.get("action") or ""
        if not key or not action:
            return self._send_json({"error": "缺少 key/action"}, 400)
        from novel import notes as _notes
        try:
            if action == "bookmark_toggle":
                return self._send_json(_notes.bookmark_toggle(key, int(data.get("ch", 0))))
            if action == "note_add":
                return self._send_json({"notes": _notes.note_add(
                    key, int(data.get("ch", 0)), data.get("text", ""), data.get("quote", ""))})
            if action == "note_del":
                return self._send_json({"notes": _notes.note_del(key, data.get("id", ""))})
            return self._send_json({"error": f"未知 action: {action}"}, 400)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": str(exc)}, 500)

    def _api_epub_read(self, qs):
        from novel.epub import read_chapter
        fname = (qs.get("file") or [""])[0].strip()
        ch = int((qs.get("ch") or ["1"])[0] or 1)
        if not fname:
            return self._send_json({"error": "缺少 file"}, 400)
        if ".." in fname or "/" in fname or "\\" in fname:
            return self._send_json({"error": "非法文件名"}, 400)
        out_dir = get_out_dir()
        path = os.path.join(out_dir, fname)
        if not os.path.isfile(path):
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            return self._send_json(read_chapter(path, ch))
        except Exception as exc:
            return self._send_json({"error": f"章节读取失败: {exc}"}, 500)

    def _api_epub_asset(self, qs):
        """读取 EPUB 内嵌资源(图片/字体等),返回二进制。"""
        from novel.epub import read_asset
        fname = (qs.get("file") or [""])[0].strip()
        asset = (qs.get("path") or [""])[0].strip()
        if not fname or not asset:
            return self._send_json({"error": "缺少 file/path"}, 400)
        if ".." in fname or "/" in fname or "\\" in fname:
            return self._send_json({"error": "非法文件名"}, 400)
        out_dir = get_out_dir()
        path = os.path.join(out_dir, fname)
        if not os.path.isfile(path):
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            data = read_asset(path, asset)
        except FileNotFoundError:
            return self._send_json({"error": "资源不存在"}, 404)
        except Exception as exc:
            return self._send_json({"error": f"资源读取失败: {exc}"}, 500)
        ext = os.path.splitext(asset)[1].lower()
        ctype = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
            ".bmp": "image/bmp", ".woff": "font/woff", ".woff2": "font/woff2",
            ".ttf": "font/ttf", ".css": "text/css",
        }.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    # ---------------- EPUB 在线阅读(不落盘,直读远程直链) ----------------
    # 缓存:url -> {'path': 临时文件, 'ts': 下载时间};TTL 30 分钟
    _epub_online_cache: dict = {}
    _epub_online_lock = threading.Lock()

    def _epub_online_fetch(self, url: str) -> tuple[str | None, str]:
        """下载远程 EPUB 到临时缓存(去重并发),返回 (路径, 错误信息)。"""
        import hashlib as _hl
        now = time.time()
        with self._epub_online_lock:
            hit = self._epub_online_cache.get(url)
            if hit and now - hit["ts"] < 1800 and os.path.isfile(hit["path"]):
                return hit["path"], ""
        import tempfile as _tf, requests as _rq
        from urllib.parse import urlparse as _up
        # 带 Referer(源域名)+ 移动端 UA:部分 OPDS 源(如 wenku8 附件)校验来源
        try:
            host = _up(url).hostname or ""
        except Exception:  # noqa: BLE001
            host = ""
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "Referer": f"https://{host}/" if host else "",
            "Accept": "application/epub+zip, application/octet-stream, */*",
        }
        r = None
        try:
            r = _rq.get(url, headers=headers, timeout=90, allow_redirects=True)
            # 403/401 → 尝试验证中心 cookies(带 cf_clearance 等)
            if r.status_code in (401, 403):
                try:
                    from novel.verify import get_cookies
                    ret = get_cookies(url)
                    if ret is not None:
                        ck, vua = ret
                        r = _rq.get(url, headers={**headers, "User-Agent": vua}, timeout=90, cookies=ck, allow_redirects=True)
                except Exception:  # noqa: BLE001
                    pass
            # 202 = 源服务端异步生成 EPUB 中(wol.moe 等):立即失败,上层(wol.moe)会自动
            # 回退 wenku8 主站直抓,不等生成(生成可能要几分钟,在线看等不起)
            if r.status_code == 202:
                return None, "源服务端异步生成中"
        except Exception as exc:  # noqa: BLE001
            return None, f"网络请求失败: {type(exc).__name__}"
        if r is None:
            return None, "网络请求失败"
        if r.status_code == 202:
            return None, "源服务端正在生成 EPUB(异步),生成较慢,请稍后再试或改用「下载 EPUB」"
        if r.status_code != 200:
            return None, f"源返回 HTTP {r.status_code}(可能需要验证或源不稳定)"
        if not r.content or r.content[:2] != b"PK":  # EPUB/ZIP 魔数校验
            return None, "下载内容不是有效 EPUB 文件"
        key = _hl.md5(url.encode("utf-8")).hexdigest()[:16]
        tmp_dir = _tf.gettempdir()
        path = os.path.join(tmp_dir, f"nc_epub_online_{key}.epub")
        try:
            with open(path, "wb") as f:
                f.write(r.content)
            with self._epub_online_lock:
                self._epub_online_cache[url] = {"path": path, "ts": time.time()}
            return path, ""
        except Exception as exc:  # noqa: BLE001
            return None, f"本地写入失败: {exc}"

    def _api_epub_online(self, qs):
        """GET /api/epub_online?url= → 解析远程 EPUB 目录(不落盘)。"""
        from novel.epub import parse_epub
        url = (qs.get("url") or [""])[0].strip()
        if not url.startswith("http"):
            return self._send_json({"error": "非法 EPUB 地址"}, 400)
        path, err = self._epub_online_fetch(url)
        if not path:
            # 回退:opds.wol.moe/.../epub/{id}.epub(wol.moe 异步生成慢) → wenku8 主站直抓
            if "wol.moe" in url or "wenku8" in url:
                m = re.search(r"/epub/(\d+)\.epub", url)
                if m:
                    try:
                        from novel import wenku8 as _w8
                        chs = _w8.fetch_toc(m.group(1))
                        if chs:
                            with self._epub_online_lock:
                                self._epub_online_cache[url] = {"path": "", "ts": time.time(), "wenku8_toc": chs}
                            return self._send_json({"ok": True, "mode": "wenku8",
                                                    "title": "", "chapters": chs})
                    except Exception as exc:  # noqa: BLE001
                        err = f"{err};wenku8 回退也失败: {exc}"
            return self._send_json({"error": f"EPUB 下载失败: {err}"}, 502)
        try:
            chapters = parse_epub(path)
            return self._send_json({"ok": True, "mode": "epub", "title": chapters[0].get("title", "") if chapters else "", "chapters": chapters})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"EPUB 解析失败: {exc}"}, 500)

    def _api_epub_online_read(self, qs):
        """GET /api/epub_online_read?url=&ch= → 章节内容。
        wol.moe epub 直链(wenku8 回退模式)→ 从缓存的 wenku8 目录抓章节文本。"""
        from urllib.parse import quote as _quote
        url = (qs.get("url") or [""])[0].strip()
        ch = int((qs.get("ch") or ["1"])[0] or 1)
        if not url.startswith("http"):
            return self._send_json({"error": "非法 EPUB 地址"}, 400)
        # wenku8 回退模式:缓存目录,逐章直抓主站文本
        with self._epub_online_lock:
            hit = self._epub_online_cache.get(url)
        if hit and hit.get("wenku8_toc"):
            toc = hit["wenku8_toc"]
            if ch < 1 or ch > len(toc):
                return self._send_json({"error": "章节序号越界"}, 404)
            try:
                from novel import wenku8 as _w8
                text = _w8.fetch_chapter_text(toc[ch - 1]["url"])
                return self._send_json({"title": toc[ch - 1]["title"], "text": text, "html": ""})
            except Exception as exc:  # noqa: BLE001
                return self._send_json({"error": f"wenku8 章节抓取失败: {exc}"}, 502)
        from novel.epub import read_chapter
        path, err = self._epub_online_fetch(url)
        if not path:
            return self._send_json({"error": f"EPUB 下载失败: {err}"}, 502)
        try:
            chd = read_chapter(path, ch)
            # 本地 asset 接口(file=X) → 在线 asset 接口(url=U),图片/字体自动指向
            html = chd.get("html", "")
            if html:
                chd["html"] = re.sub(
                    r"/api/epub_asset\?file=[^&\s]*&path=",
                    f"/api/epub_online_asset?url={_quote(url, safe='')}&path=",
                    html,
                )
            return self._send_json(chd)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"章节读取失败: {exc}"}, 500)

    def _api_epub_online_asset(self, qs):
        """GET /api/epub_online_asset?url=&path= → 内嵌资源(图片/字体)二进制。"""
        from novel.epub import read_asset
        url = (qs.get("url") or [""])[0].strip()
        asset = (qs.get("path") or [""])[0].strip()
        if not url.startswith("http") or not asset:
            return self._send_json({"error": "缺少 url/path"}, 400)
        path, err = self._epub_online_fetch(url)
        if not path:
            return self._send_json({"error": f"EPUB 下载失败: {err}"}, 502)
        try:
            data = read_asset(path, asset)
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"资源读取失败: {exc}"}, 404)
        ext = os.path.splitext(asset)[1].lower()
        ctype = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
            ".bmp": "image/bmp", ".woff": "font/woff", ".woff2": "font/woff2",
            ".ttf": "font/ttf", ".css": "text/css",
        }.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    def _api_task_history(self):
        """返回任务历史记录(下载/OPDS/追更的最终结果)。"""
        from novel.tasklog import list_history
        return self._send_json({"history": list_history()})

    def _api_task_control(self):
        """POST /api/task_control {id, action: stop|pause|resume}
        控制后台下载任务:停止(取消)/暂停/继续。OPDS 任务只支持 stop。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        tid = (data.get("id") or "").strip()
        action = (data.get("action") or "").strip().lower()
        if not tid or action not in ("stop", "pause", "resume", "switch_local"):
            return self._send_json({"error": "参数缺失(id/action)"}, 400)
        # 搜索任务在独立容器(_search_tasks)里,语义也不同:
        # 暂停是让 search_all 在下一个源结束后提前 break,无法原地续跑。
        # 这里统一兜底,避免全局任务面板点「停止」时报「任务不存在」。
        with _tasks_lock:
            st = _search_tasks.get(tid)
        if st is not None:
            if action == "switch_local":
                return self._send_json({"error": "搜索任务不支持该操作"}, 400)
            if action == "stop":
                st["paused"] = True
                st["state"] = "cancelled"
                st["current"] = "已停止"
                return self._send_json({"ok": True, "state": "cancelled"})
            if action == "pause":
                st["paused"] = True
                return self._send_json({"ok": True, "state": st.get("state", "running")})
            # resume:搜索被中断后无法续跑(已跳过的源不会重来)
            return self._send_json({"error": "搜索任务暂停后无法继续,请重新搜索"}, 400)
        with _tasks_lock:
            t = _tasks.get(tid)
            if t is None:
                return self._send_json({"error": "任务不存在或已结束"}, 404)
            if action == "stop":
                t["state"] = "cancelled"
                t["current"] = "已请求停止…"
            elif action == "switch_local":
                # 服务端轮询中的 OPDS 任务 → 切换为本地直抓
                if t.get("kind") != "opds_download" or t.get("mode") == "local":
                    return self._send_json({"error": "仅服务端轮询中的 OPDS 任务可切换"}, 400)
                if t.get("state") not in ("running", "downloading"):
                    return self._send_json({"error": "任务已结束,无法切换"}, 400)
                t["mode"] = "local"  # 轮询循环检测到后重新走本地直抓
                t["current"] = "已请求切换本地直抓…"
            elif action == "pause":
                # 只有 worker 循环里实现了「暂停等待」的任务才能真正暂停。
                # 订阅刷新/同步/OPDS 等任务置 paused 后没有任何地方会唤醒它,
                # 会被永久冻结(既不是终态 → _prune_tasks 也清不掉)。
                if t.get("kind") not in _PAUSABLE_KINDS:
                    return self._send_json({"error": "该任务不支持暂停"}, 400)
                if t.get("state") in ("running", "downloading"):
                    t["state"] = "paused"
                    t["current"] = "已暂停(可继续)"
            elif action == "resume":
                if t.get("state") == "paused":
                    t["state"] = "running"
                    t["current"] = "继续下载…"
        return self._send_json({"ok": True, "state": t["state"]})

    def _api_cover(self, qs):
        """代理加载封面图(解决防盗链/UA 限制/跨域加载失败)。"""
        url = (qs.get("url") or [""])[0].strip()
        if not url.startswith("http"):
            return self._send_json({"error": "非法封面地址"}, 400)
        import requests as _rq
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "Referer": url.split("/")[0] + "//" + url.split("/")[2] + "/",
        }
        # 尝试验证中心 cookies(遇到 403 时带上;UA 用验证时的,cf_clearance 与之绑定)
        try:
            r = _rq.get(url, headers=headers, timeout=15)
            if r.status_code in (401, 403):
                from novel.verify import get_cookies
                ret = get_cookies(url)
                if ret is not None:
                    ck, vua = ret
                    r = _rq.get(url, headers={**headers, "User-Agent": vua}, timeout=15, cookies=ck)
            # 404 纠错:mangadex 缩略图后缀(.256.jpg/.512.jpg)已失效,历史
            # 收藏/书架存的封面地址可能形如 xxx.jpg.256.jpg 或 xxx.256.jpg,
            # 统一回退为全尺寸原图再试
            if r.status_code == 404:
                fixed = re.sub(r"\.\d{3}\.(?:jpg|jpeg|png)$", "", url, flags=re.I)
                if not re.search(r"\.(?:jpg|jpeg|png)$", fixed, flags=re.I):
                    m = re.search(r"\.(?:jpg|jpeg|png)$", url, flags=re.I)
                    if m:
                        fixed += m.group(0)
                if fixed != url:
                    r2 = _rq.get(fixed, headers=headers, timeout=15)
                    if r2.status_code == 200:
                        r = r2
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "封面加载失败"}, 502)
        if r.status_code != 200 or not r.content:
            return self._send_json({"error": f"封面加载失败 HTTP {r.status_code}"}, 502)
        ctype = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(r.content)))
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(r.content)

    def _api_convert(self):
        """POST /api/convert {file} → 已下载 TXT 转 EPUB(同目录生成 .epub)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        fname = (data.get("file") or "").strip()
        if not fname.lower().endswith(".txt"):
            return self._send_json({"error": "仅支持 TXT 转 EPUB"}, 400)
        out_dir = get_out_dir()
        src = os.path.join(out_dir, os.path.basename(fname))
        if not os.path.isfile(src):
            return self._send_json({"error": "文件不存在"}, 404)
        try:
            import re as _re
            from novel.exporter import write_epub
            with open(src, encoding="utf-8", errors="replace") as f:
                text = f.read()
            # 按章节标记切分:【章节】第N章 / == 标题 ==
            segs = _re.split(r"【章节】第\d+章", text)
            chapters = []
            titles = _re.findall(r"==\s*([^=]{1,60}?)\s*==", text)
            for i, seg in enumerate(segs[1:], 1):
                seg = seg.strip()
                if not seg:
                    continue
                title = (titles[i - 1] if i - 1 < len(titles) else f"第{i}章")
                chapters.append({"title": title.strip() or f"第{i}章", "text": seg})
            if not chapters:
                # 无章节标记:按空行分块
                blocks = [b.strip() for b in text.split("\n\n") if b.strip()]
                chapters = [{"title": f"第{i}章", "text": b} for i, b in enumerate(blocks[:500], 1)]
            if not chapters:
                return self._send_json({"error": "文件内容为空"}, 400)
            book_title = os.path.splitext(fname)[0].split("[")[0].strip() or "小说"
            out_path = os.path.join(out_dir, os.path.splitext(fname)[0] + ".epub")
            write_epub(book_title, "TXT转换", chapters, out_path)
            return self._send_json({"ok": True, "file": os.path.basename(out_path),
                                    "chapters": len(chapters), "size": os.path.getsize(out_path)})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"转换失败: {exc}"}, 500)

    def _api_shelf_backup(self):
        """GET /api/shelf_backup → 书架数据(前端触发下载)。"""
        from novel.shelf import load_shelf
        return self._send_json({"shelf": load_shelf(), "exported": True})

    def _api_shelf_import(self):
        """POST /api/shelf_import {shelf: [...]} → 合并导入(按 url 去重)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            return self._send_json({"error": "请求体非法"}, 400)
        incoming = data.get("shelf") or []
        if not isinstance(incoming, list):
            return self._send_json({"error": "数据格式错误"}, 400)
        try:
            from novel.shelf import merge_shelf
            added, total = merge_shelf(incoming)
            return self._send_json({"ok": True, "added": added, "total": total})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"error": f"导入失败: {exc}"}, 500)

    def _api_files(self):
        out_dir = get_out_dir()
        files = []
        # 主目录(downloads/novel,或用户自定义) + 旧版 downloads/ 根目录残留合并
        roots = [out_dir]
        legacy = os.path.join(APP_DATA_DIR, "downloads")
        if os.path.abspath(legacy) != os.path.abspath(out_dir) and os.path.isdir(legacy):
            roots.append(legacy)
        seen = set()
        for root in roots:
            if not os.path.isdir(root):
                continue
            for fn in sorted(os.listdir(root)):
                if fn in seen:
                    continue
                # 漫画目录(下载/comic/ 与 novel/ 子目录)不属于小说下载列表
                if os.path.isdir(os.path.join(root, fn)):
                    continue
                fp = os.path.join(root, fn)
                if (fn.endswith(".txt") or fn.endswith(".epub")) and os.path.getsize(fp) > 0:
                    seen.add(fn)
                    files.append({"name": fn, "size": os.path.getsize(fp)})
        return self._send_json({"files": files})

    def _build_offline_page(self, qs: dict):
        """离线手机页:单文件 HTML 内嵌书架列表 + 全部书(或 ?favs= 精选)的完整章节内容。

        手机浏览器保存此文件后,电脑关闭/无局域网也能打开书架并阅读已内嵌的书。
        (Service Worker 需 HTTPS 才能注册,局域网 HTTP 下不可用,故采用内嵌快照方案)
        """
        import json as _json
        import time as _t2

        # 1) 文件列表(与 /api/files 同源合并逻辑)
        roots = [get_out_dir()]
        legacy = os.path.join(APP_DATA_DIR, "downloads")
        if os.path.abspath(legacy) != os.path.abspath(roots[0]) and os.path.isdir(legacy):
            roots.append(legacy)
        seen = set()
        files = []
        for root in roots:
            if not os.path.isdir(root):
                continue
            for fn in sorted(os.listdir(root)):
                if fn in seen or os.path.isdir(os.path.join(root, fn)):
                    continue
                fp = os.path.join(root, fn)
                if (fn.endswith(".txt") or fn.endswith(".epub")) and os.path.getsize(fp) > 0:
                    seen.add(fn)
                    files.append({"name": fn, "size": os.path.getsize(fp)})

        # 2) 精选书(?favs=书名1,书名2,手机端收藏会带过来)或全部书 → 内嵌章节内容
        favs = [s.strip() for s in (qs.get("favs") or [""])[0].split(",") if s.strip()]
        books = {}
        for f in files:
            if favs and f["name"] not in favs:
                continue
            try:
                books[f["name"]] = self._pack_book_offline(f["name"])
            except Exception:  # noqa: BLE001
                books[f["name"]] = {"chapters": [], "error": True}
        # 3) 精选漫画(?comics=书名1,书名2):整本 PDF 转 base64 内嵌(离线可下载)
        comic_titles = [s.strip() for s in (qs.get("comics") or [""])[0].split(",") if s.strip()]
        comics = self._pack_comic_offline(comic_titles) if comic_titles else []
        data = {
            "gen_time": _t2.strftime("%Y-%m-%d %H:%M"),
            "files": files,
            "books": books,
            "comics": comics,
        }
        js = "const OFFLINE = " + _json.dumps(data, ensure_ascii=False).replace("</", "<\\/") + ";"
        try:
            with open(os.path.join(STATIC_DIR, "mobile.html"), "r", encoding="utf-8") as f:
                html = f.read()
        except OSError:
            return self._send_json({"error": "mobile.html 不存在"}, 500)
        marker = "let files = [], comics = [], favOnly = false, curTab = 'book';"
        if marker in html:
            html = html.replace(marker, js + "\n" + marker, 1)
        else:
            html = html.replace("</head>", "<script>" + js + "</script></head>", 1)
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        if qs.get("dl"):
            # ?dl=1 → 手机端「打包快照」直接附件下载(带时间戳文件名,避免覆盖)
            fn = "小说管家-离线版-" + _t2.strftime("%Y%m%d-%H%M") + ".html"
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{_url_quote(fn)}")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _pack_comic_offline(self, titles: list) -> list:
        """漫画离线打包:每部漫画所有 PDF → base64(快照内嵌,离线可下载/尝试打开)。

        注意:PDF 内嵌会使快照体积明显增大(base64 约 +33%),由调用方展示体积提示。
        """
        import base64 as _b64
        out = []
        for title in titles:
            if not title or ".." in title or "/" in title or "\\" in title:
                continue
            d = os.path.join(COMIC_OUT_DIR, title)
            if not os.path.isdir(d):
                continue
            pdfs = sorted(f for f in os.listdir(d) if f.lower().endswith(".pdf"))
            if not pdfs:
                continue
            files = []
            total = 0
            for p in pdfs:
                fp = os.path.join(d, p)
                try:
                    with open(fp, "rb") as fh:
                        raw = fh.read()
                except OSError:
                    continue
                total += len(raw)
                files.append({"name": p, "size": len(raw),
                              "b64": _b64.b64encode(raw).decode()})
            if files:
                out.append({"title": title, "files": files, "size": total})
        return out

    def _pack_book_offline(self, fname: str) -> dict:
        """把一本书的完整章节内容打包进离线包。

        EPUB:章节 html 中 /api/epub_asset 图片资源转 data URI(离线可显示);
        TXT:直接解析【章节】标记切分。
        附带同名 EPUB 文件(base64 内嵌,快照页可重新下载该文件)。
        """
        fp = self._resolve_book_file(fname)
        if fp is None:
            # 旧版 downloads/ 根目录残留(列表可见,这里也要能打包)
            legacy = os.path.join(APP_DATA_DIR, "downloads")
            alt = os.path.abspath(os.path.join(legacy, fname))
            if (os.path.abspath(legacy) != os.path.abspath(get_out_dir())
                    and alt.startswith(os.path.abspath(legacy)) and os.path.isfile(alt)):
                fp = alt
        if fp is None:
            raise FileNotFoundError(fname)
        chapters = []
        if fname.lower().endswith(".epub"):
            import zipfile as _z2
            from novel.epub import parse_epub as _pe
            chs = _pe(fp)
            with _z2.ZipFile(fp) as z:
                for c in chs:
                    chapters.append({"title": c["title"],
                                     "html": self._inline_assets(c.get("html", ""), z)})
        else:
            from novel.reader import parse_txt as _pt
            for c in _pt(fp):
                chapters.append({"title": c["title"] or f"第{c['idx']}章",
                                 "text": c["text"]})
        out = {"chapters": chapters}
        # 同名 EPUB 文件内嵌:同一本书的 .txt/.epub 同名共存时带上 epub,离线可重新下载
        import base64 as _b64f
        ep = fp if fname.lower().endswith(".epub") else None
        if ep is None:
            base = os.path.splitext(os.path.basename(fname))[0]
            cand = os.path.join(os.path.dirname(fp), base + ".epub")
            if os.path.isfile(cand):
                ep = cand
        if ep:
            try:
                with open(ep, "rb") as fh:
                    raw = fh.read()
                # 存储大小无上限:离线快照完整内嵌 EPUB,离线可重新下载原文件
                out["epub"] = {"name": os.path.basename(ep), "size": len(raw),
                               "b64": _b64f.b64encode(raw).decode()}
            except OSError:
                pass
        return out

    @staticmethod
    def _inline_assets(html: str, z) -> str:
        """把 html 中 /api/epub_asset 引用的资源 src 替换为 data URI(离线可显示)。"""
        import base64 as _b64
        import re as _re3
        from urllib.parse import parse_qs as _pqs3, urlparse as _urlp3

        def _rep(m) -> str:
            u = m.group(1)
            try:
                p = _urlp3(u)
                if p.path != "/api/epub_asset":
                    return m.group(0)
                ap = (_pqs3(p.query).get("path") or [""])[0]
                if not ap or ".." in ap.split("/"):
                    return m.group(0)
                raw = z.read(ap)
            except Exception:  # noqa: BLE001
                return m.group(0)
            ext = os.path.splitext(ap)[1].lower()
            ctype = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                     ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
                     ".bmp": "image/bmp", ".woff": "font/woff", ".woff2": "font/woff2",
                     ".ttf": "font/ttf"}.get(ext, "image/jpeg")
            b64 = _b64.b64encode(raw).decode()
            return f'src="data:{ctype};base64,{b64}"'

        return _re3.sub(r'(?:src|poster)\s*=\s*["\']([^"\']+)["\']',
                        lambda m: _rep(m) if m.group(1).startswith("/api/") else m.group(0),
                        html, flags=_re3.I)

    # ---------------- 快照 ZIP 打包(两阶段:start → status → download) ----------------
    # 快照 = ZIP:index.html(框架+元数据,立即渲染)+ data/*.js(每书章节,按需注入)
    #        + files/*(原文件 EPUB/TXT + 漫画 PDF,可选)。后台线程生成,进度上报 sync 会话。
    _snapshot_jobs: dict = {}
    _snapshot_lock = threading.RLock()

    def _api_snapshot_start(self, payload: dict):
        """POST /api/snapshot_start {favs, comics, with_files, sid} → {job_id, est}"""
        import uuid as _uuid
        favs = [str(x) for x in (payload.get("favs") or []) if str(x).strip()]
        comics = [str(x) for x in (payload.get("comics") or []) if str(x).strip()]
        with_files = bool(payload.get("with_files", True))
        sid = str(payload.get("sid") or "")[:64]
        good_favs = []
        for f in favs:
            if self._resolve_book_file(f) is not None:
                good_favs.append(f)
        good_comics = []
        for c in comics:
            d = os.path.join(COMIC_OUT_DIR, c)
            if not c or ".." in c or "/" in c or "\\" in c or not os.path.isdir(d):
                continue
            pdfs = sorted(f for f in os.listdir(d) if f.lower().endswith(".pdf"))
            if pdfs:
                good_comics.append({"title": c, "pdfs": pdfs})
        if not good_favs and not good_comics:
            return self._send_json({"error": "没有可打包的内容"})
        # 清理过期 job(>2h)的临时文件
        now = time.time()
        with self._snapshot_lock:
            for jid, j in list(self._snapshot_jobs.items()):
                if now - j.get("t0", 0) > 7200:
                    self._snapshot_jobs.pop(jid, None)
                    try:
                        os.remove(j.get("tmp", ""))
                    except OSError:
                        pass
        job_id = "snap" + _uuid.uuid4().hex[:12]
        tmp = os.path.join(tempfile.gettempdir(), f"novelist_snap_{job_id}.zip")
        est = 250000  # index.html + 元数据
        for f in good_favs:
            est += int(os.path.getsize(self._resolve_book_file(f)) * 2.1)
        for c in good_comics:
            for p in c["pdfs"]:
                est += os.path.getsize(os.path.join(COMIC_OUT_DIR, c["title"], p))
        job = {"status": "packing", "progress": 0, "est": est, "tmp": tmp,
               "favs": good_favs, "comics": good_comics, "with_files": with_files,
               "sid": sid, "error": "", "t0": now}
        with self._snapshot_lock:
            self._snapshot_jobs[job_id] = job
        th = threading.Thread(target=self._run_snapshot, args=(job_id,), daemon=True)
        th.start()
        return self._send_json({"job_id": job_id, "est": est})

    def _run_snapshot(self, job_id: str) -> None:
        """后台线程:生成 ZIP 快照,按文件粒度累计进度并上报手机会话。"""
        import json as _js
        import time as _t3
        import zipfile as _zfs
        from urllib.parse import quote as _quote
        job = self._snapshot_jobs.get(job_id)
        if job is None:
            return
        favs, comics, with_files, sid = job["favs"], job["comics"], job["with_files"], job["sid"]
        est = max(1, job["est"])
        done = 0
        try:
            def _report(final=False):
                job["progress"] = min(100, int(done * 100 / est))
                self._sync_touch(sid, task="打包快照", size=est, sent=done,
                                 status="done" if final else "packing")
            with _zfs.ZipFile(job["tmp"], "w", _zfs.ZIP_DEFLATED) as zf:
                meta_books = []
                for fname in favs:
                    fp = self._resolve_book_file(fname)
                    if fp is None:
                        continue
                    chapters = []
                    try:
                        if fname.lower().endswith(".epub"):
                            from novel.epub import parse_epub as _pe2
                            import zipfile as _z2b
                            with _z2b.ZipFile(fp) as z:
                                for c in _pe2(fp):
                                    chapters.append({"title": c["title"],
                                                     "html": self._inline_assets(c.get("html", ""), z)})
                        else:
                            from novel.reader import parse_txt as _pt2
                            for c in _pt2(fp):
                                chapters.append({"title": c["title"] or f"第{c['idx']}章",
                                                 "text": c["text"]})
                    except Exception:  # noqa: BLE001
                        chapters = []
                    data_name = _quote(fname, safe="")
                    js = ("window.__SNAP_DATA__ = window.__SNAP_DATA__ || {};"
                          + "window.__SNAP_DATA__[" + _js.dumps(fname, ensure_ascii=False) + "] = "
                          + _js.dumps({"chapters": chapters}, ensure_ascii=False) + ";")
                    js_b = js.encode("utf-8")
                    # ZIP 内用原始文件名;meta.data 用 URL 编码(script src 会被浏览器解码回原名)
                    zf.writestr(f"data/{fname}.js", js_b)
                    done += len(js_b)
                    meta_books.append({"name": fname, "size": os.path.getsize(fp),
                                       "chs": len(chapters), "has_body": bool(chapters),
                                       "data": f"data/{data_name}.js"})
                    _report()
                if with_files:
                    for fname in favs:
                        fp = self._resolve_book_file(fname)
                        if fp is None:
                            continue
                        zf.write(fp, f"files/{fname}")
                        done += os.path.getsize(fp)
                        _report()
                    for c in comics:
                        d = os.path.join(COMIC_OUT_DIR, c["title"])
                        for p in c["pdfs"]:
                            fp = os.path.join(d, p)
                            zf.write(fp, f"files/{c['title']}/{p}")
                            done += os.path.getsize(fp)
                        _report()
                meta_comics = [{"title": c["title"], "files": c["pdfs"],
                                "dir": "files/" + _quote(c["title"], safe="")}
                               for c in comics]
                meta = {"gen_time": _t3.strftime("%Y-%m-%d %H:%M"), "format": "zip",
                        "with_files": with_files, "books": meta_books, "comics": meta_comics}
                try:
                    with open(os.path.join(STATIC_DIR, "snapshot.html"), "r", encoding="utf-8") as f:
                        html = f.read()
                except OSError:
                    raise RuntimeError("snapshot.html 不存在")  # noqa: B904
                marker = "const SNAP_RAW = null;"
                js_inject = ("const SNAP_RAW = "
                             + _js.dumps(meta, ensure_ascii=False).replace("</", "<\\/") + ";")
                if marker in html:
                    html = html.replace(marker, js_inject, 1)
                else:
                    html = html.replace("</head>", "<script>" + js_inject + "</script></head>", 1)
                zf.writestr("index.html", html.encode("utf-8"))
                done += len(html)
            job["status"] = "ready"
            _report(final=True)
            job["progress"] = 100
        except Exception as exc:  # noqa: BLE001
            job["status"] = "error"
            job["error"] = str(exc)
            self._sync_touch(sid, task="打包快照", size=est, sent=done, status="error")

    def _api_snapshot_status(self, qs: dict):
        """GET /api/snapshot_status?job= → {status: packing/ready/error/not_found, progress, est}"""
        jid = (qs.get("job") or [""])[0].strip()
        with self._snapshot_lock:
            job = self._snapshot_jobs.get(jid)
        if job is None:
            return self._send_json({"status": "not_found"})
        return self._send_json({"status": job["status"], "progress": job["progress"],
                                "est": job["est"], "error": job["error"]})

    def _api_snapshot_download(self, qs: dict):
        """GET /api/snapshot_download?job= → ZIP 附件(带时间戳文件名),发送后清理任务。"""
        import time as _t4
        jid = (qs.get("job") or [""])[0].strip()
        with self._snapshot_lock:
            job = self._snapshot_jobs.get(jid)
        if job is None:
            return self._send_json({"error": "任务不存在"}, 404)
        if job["status"] != "ready":
            return self._send_json({"error": "任务尚未完成"}, 409)
        fn = "小说管家-离线版-" + _t4.strftime("%Y%m%d-%H%M") + ".zip"
        tmp = job["tmp"]
        self._send_file(tmp, "application/zip", as_attachment=True, filename=fn)
        with self._snapshot_lock:
            self._snapshot_jobs.pop(jid, None)
        try:
            os.remove(tmp)
        except OSError:
            pass

    def _api_upload(self):
        """POST /api/upload(多部分表单,字段 file)→ 保存到下载目录,返回文件信息。
        支持本地上传 .txt/.epub → 手机通过局域网阅读/缓存观看。
        (Python 3.13 移除了 cgi,这里用正则手动解析 multipart)"""
        import re as _re
        out_dir = get_out_dir()
        os.makedirs(out_dir, exist_ok=True)
        ctype = self.headers.get("Content-Type", "")
        mct = _re.search(r"boundary=([^;]+)", ctype)
        if "multipart/form-data" not in ctype or not mct:
            return self._send_json({"error": "需要 multipart/form-data 上传"}, 400)
        boundary = mct.group(1).strip().strip('"')
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 500 * 1024 * 1024:  # 上限 500MB
            return self._send_json({"error": "非法文件大小"}, 400)
        body = self.rfile.read(length)
        # 按 boundary 切分 parts
        parts = body.split(("--" + boundary).encode())
        fname = ""
        payload = b""
        for part in parts:
            if b"name=\"file\"" not in part:
                continue
            # 分离 header 与 body(空行分隔)
            sep = part.find(b"\r\n\r\n")
            if sep < 0:
                sep = part.find(b"\n\n")
            if sep < 0:
                continue
            header_blob = part[:sep].decode("utf-8", "replace")
            file_body = part[sep + 4 if b"\r\n\r\n" in part else sep + 2:]
            # 提取 filename
            fm = _re.search(r'filename="([^"]*)"', header_blob)
            if not fm:
                continue
            fname = fm.group(1)
            payload = file_body
            break
        # 去掉末尾残留的 \r\n-- (boundary 结束标记后的空白)
        if payload.endswith(b"\r\n") and b"--" in payload[-6:]:
            payload = payload.rstrip(b"\r\n")
        # 兜底:boundary 结尾可能残留 -- 或 \r\n
        payload = payload.rstrip(b"\r\n")
        if not fname:
            return self._send_json({"error": "未选择文件"}, 400)
        fname = os.path.basename(fname)
        if not fname.lower().endswith((".txt", ".epub")):
            return self._send_json({"error": "仅支持 .txt / .epub 文件"}, 400)
        from novel.downloader import safe_filename
        safe = safe_filename(fname)
        path = os.path.join(out_dir, safe)
        # 同名覆盖保护:存在则加序号
        n = 1
        while os.path.exists(path):
            base, ext = os.path.splitext(safe)
            path = os.path.join(out_dir, f"{base}({n}){ext}")
            n += 1
        try:
            with open(path, "wb") as wf:
                wf.write(payload)
        except OSError as exc:
            return self._send_json({"error": f"写入失败: {exc}"}, 500)
        size = os.path.getsize(path)
        # 上传完成 → 默认入书架(本地文件收藏)
        try:
            from novel.shelf import add_to_shelf as _add_shelf
            title = safe_filename(os.path.splitext(safe)[0])
            _add_shelf(title, "file:" + safe, "本地上传")
        except Exception:  # noqa: BLE001
            pass
        return self._send_json({"ok": True, "file": safe, "size": size})

    def _api_open_dir(self):
        """在系统文件管理器中打开下载目录(Windows 用 explorer 选中文件并激活到前台)。"""
        try:
            data = self._body()
        except Exception:  # noqa: BLE001
            data = {}
        fname = (data.get("name") or "").strip()
        out_dir = get_out_dir()
        abs_dir = os.path.abspath(out_dir)
        if not os.path.isdir(abs_dir):
            os.makedirs(abs_dir, exist_ok=True)
        # 支持子路径(如 书名/第1话.pdf):安全拼接防路径遍历
        rel = fname.replace("\\", "/").strip("/") if fname else ""
        if rel and (".." in rel.split("/") or ":" in rel.split("/")[0] or rel.startswith("/")):
            return self._send_json({"ok": False, "error": "非法路径"})
        target = os.path.join(abs_dir, rel) if rel else abs_dir
        # 漫画书名目录在 downloads/comic/ 下,优先定位到漫画目录
        if rel:
            comic_target = os.path.join(COMIC_OUT_DIR, rel)
            if os.path.isdir(comic_target) or os.path.isfile(comic_target):
                target = comic_target
                abs_dir = os.path.dirname(comic_target) if os.path.isfile(comic_target) else comic_target
        try:
            import subprocess
            if os.name == "nt":
                if os.path.isfile(target):
                    subprocess.Popen(["explorer", "/select,", os.path.normpath(target)])
                else:
                    os.startfile(abs_dir)  # type: ignore[attr-defined]
                # 资源管理器窗口激活到前台:等窗口出现后置前
                self._activate_window(os.path.basename(target)[:40], abs_dir)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", target] if os.path.isfile(target) else ["open", abs_dir])
            else:
                subprocess.Popen(["xdg-open", abs_dir])
            return self._send_json({"ok": True})
        except Exception as exc:  # noqa: BLE001
            return self._send_json({"ok": False, "error": str(exc)})

    @staticmethod
    def _activate_window(title_key: str, dir_path: str) -> None:
        """Windows 下把资源管理器窗口激活到前台(标题含文件名或目录名)。"""
        import time
        import threading
        try:
            import ctypes
            from ctypes import wintypes
        except Exception:  # noqa: BLE001
            return

        user32 = ctypes.windll.user32
        title_key = title_key.split(".")[0]  # 去扩展名,资源管理器标题通常不含扩展名
        candidates = {title_key, os.path.basename(dir_path.rstrip("\\/"))}

        def _do() -> None:
            time.sleep(1.2)  # 等 explorer 窗口出现
            try:
                hwnds: list[int] = []

                @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
                def _cb(hwnd, lparam):
                    if user32.IsWindowVisible(hwnd):
                        hwnds.append(int(hwnd))
                    return True

                user32.EnumWindows(_cb, 0)
                for hwnd in hwnds:
                    length = user32.GetWindowTextLengthW(hwnd)
                    if not length:
                        continue
                    buf = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buf, length + 1)
                    text = buf.value
                    for key in candidates:
                        if key and key.lower() in text.lower():
                            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                            user32.SetForegroundWindow(hwnd)
                            return
            except Exception:  # noqa: BLE001
                pass

        threading.Thread(target=_do, daemon=True).start()


def main() -> None:
    ap = argparse.ArgumentParser(description="多源小说爬虫 Web GUI")
    ap.add_argument("--port", type=int, default=8765, help="监听端口(默认8765)")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址(默认127.0.0.1)")
    ap.add_argument("--open", action="store_true", help="启动后自动打开浏览器")
    args = ap.parse_args()

    if getattr(sys, "frozen", False):
        os.chdir(os.path.dirname(sys.executable))  # 数据文件(downloads等)落在 exe 目录

    # 局域网访问:config 开启 lan_access 时绑定 0.0.0.0
    if args.host == "127.0.0.1":
        try:
            from novel.config import load_settings as _ls2
            if _ls2().get("lan_access"):
                args.host = "0.0.0.0"
        except Exception:  # noqa: BLE001
            pass

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    start_remote_services(srv)  # WebRTC 端口注册 + 隧道自动启动
    # 0.0.0.0 只是监听通配,不是可访问地址;本机访问/自动打开浏览器用 127.0.0.1
    url = f"http://127.0.0.1:{args.port}/"
    print("=" * 52)
    print("  多源小说爬虫 GUI")
    print(f"  请用浏览器打开: {url}")
    if args.host == "0.0.0.0":
        print("  已开启局域网访问:手机/其他电脑请用本机局域网 IP 访问(设置页可查)")
    print("  按 Ctrl+C 停止服务")
    print("=" * 52)
    if args.open:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")


if __name__ == "__main__":
    main()


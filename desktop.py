# -*- coding: utf-8 -*-
"""小说管家 · 桌面壳(pywebview)

把 Web GUI 包进原生桌面窗口:
  - 单进程:后端 HTTPServer 线程 + pywebview 窗口(Edge WebView2)
  - 关闭窗口 = 退出程序;下载在窗口内后台继续
  - js_api 桥接:前端可调用 Python(打开目录/系统通知/托盘)

用法:
  python desktop.py            # 桌面模式(默认)
  python desktop.py --port 0   # 随机端口(默认 0,避免占用)
"""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# --noconsole 打包后 sys.stdout/stderr 为 None,print 会崩溃;这里做兜底
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")


def find_free_port() -> int:
    """随机空闲端口,避免与已运行实例冲突。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    ap = argparse.ArgumentParser(description="小说管家桌面版")
    ap.add_argument("--port", type=int, default=0, help="后端端口(默认随机空闲端口)")
    ap.add_argument("--dev", action="store_true", help="开发模式:不关窗口也打印日志")
    args = ap.parse_args()

    if getattr(sys, "frozen", False):
        os.chdir(os.path.dirname(sys.executable))  # 数据文件落在 exe 目录

    import gui_server
    from http.server import ThreadingHTTPServer

    port = args.port or find_free_port()
    # 局域网访问:设置里开启 lan_access 后绑定 0.0.0.0(手机/其他电脑可访问)
    try:
        from novel.config import load_settings as _ls2
        host = "0.0.0.0" if _ls2().get("lan_access") else "127.0.0.1"
    except Exception:  # noqa: BLE001
        host = "127.0.0.1"

    srv = ThreadingHTTPServer((host, port), gui_server.Handler)
    gui_server.start_remote_services(srv)  # WebRTC 端口注册 + 隧道自动启动
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    # WebView 加载地址必须用 127.0.0.1:0.0.0.0 只是"监听所有网卡",
    # 它不是可访问地址(Chromium 内核直接报 ERR_ADDRESS_INVALID)。
    # 局域网用户请用 /api/network 返回的真实局域网 IP 访问。
    url = f"http://127.0.0.1:{port}/"
    if args.dev:
        print(f"[desktop] 后端已启动: {url} (lan={host == '0.0.0.0'})")

    import webview
    # 拖动逻辑由 WndProc 子类化(WM_NCHITTEST→HTCAPTION)完全接管,
    # 系统原生处理拖动/Aero Snap/双击最大化;禁用 pywebview 的像素级模拟拖动
    webview.settings['DRAG_REGION_SELECTOR'] = '.pywebview-drag-region-disabled'
    webview.settings['DRAG_REGION_DIRECT_TARGET_ONLY'] = True
    # 固定 WebView2 用户数据目录(默认 private_mode 每次启动用临时目录:
    # 残留的 msedgewebview2 进程会占住目录 → 启动时删除失败 → WebView2 初始化
    # 异常(BrowserProcessId=None)→ 页面异常/崩溃 → "卡死退出"。
    # 固定目录可复用,无删除冲突,二次启动更快,缓存可随 exe 目录整体带走)
    _webview_cache = os.path.join(
        os.path.dirname(sys.executable) if getattr(sys, "frozen", False)
        else os.path.dirname(os.path.abspath(__file__)),
        ".webview2-cache")

    class Api:
        """前端可调用的桌面能力(js_api 注入 window.pywebview.api)。"""

        def open_dir(self, name: str = "") -> None:
            """在系统文件管理器中打开下载目录。"""
            import subprocess
            from novel.config import get_out_dir
            out_dir = os.path.abspath(get_out_dir())  # 与下载/书架识别同一目录(默认 downloads/novel)
            os.makedirs(out_dir, exist_ok=True)
            target = os.path.join(out_dir, os.path.basename(name)) if name else out_dir
            if os.name == "nt" and os.path.isfile(target):
                subprocess.Popen(["explorer", "/select,", os.path.normpath(target)])
            elif os.name == "nt":
                os.startfile(out_dir)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", target] if os.path.isfile(target) else ["open", out_dir])
            else:
                subprocess.Popen(["xdg-open", out_dir])

        def notify(self, msg: str) -> None:
            """系统级桌面通知。"""
            try:
                if sys.platform == "win32":
                    import ctypes
                    ctypes.windll.user32.MessageBoxW(None, str(msg), "小说管家", 0x40)
                else:
                    subprocess_run = subprocess.run
                    if sys.platform == "darwin":
                        subprocess_run(["osascript", "-e", f'display notification "{msg}"'])
                    else:
                        subprocess_run(["notify-send", "小说管家", str(msg)])
            except Exception:  # noqa: BLE001
                pass

        def get_platform(self) -> str:
            return sys.platform

        def is_frameless(self) -> bool:
            return True

        # ---- 无边框自绘标题栏的窗口控制(前端 titlebar 按钮调用) ----
        def win_minimize(self) -> None:
            _win().minimize()

        def start_drag(self) -> None:
            """(已弃用)系统级拖动现在由 WM_NCHITTEST 子类化自动接管,
            无需前端调用;保留此方法仅为兼容旧前端。"""
            try:
                import ctypes
                hwnd = ctypes.windll.user32.FindWindowW(None, "小说管家")
                if hwnd:
                    ctypes.windll.user32.ReleaseCapture()
                    # WM_NCLBUTTONDOWN = 0xA1, HTCAPTION = 2(标题栏命中)
                    ctypes.windll.user32.SendMessageW(hwnd, 0xA1, 2, 0)
            except Exception:  # noqa: BLE001
                pass

        def win_maximize_toggle(self) -> None:
            w = _win()
            # 用 ctypes 直接查真实窗口状态(避免 frameless 下 w.state 不准)
            try:
                import ctypes
                hwnd = ctypes.windll.user32.FindWindowW(None, "小说管家")
                if hwnd:
                    # IsZoomed(最大)= 1 表示已最大化
                    if ctypes.windll.user32.IsZoomed(hwnd):
                        ctypes.windll.user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                    else:
                        ctypes.windll.user32.ShowWindow(hwnd, 3)  # SW_MAXIMIZE
                    return
            except Exception:  # noqa: BLE001
                pass
            # 兜底:走 pywebview API
            if w.state == "maximized":
                w.restore()
            else:
                w.maximize()

        def win_close(self) -> None:
            _win().destroy()

    _win_ref: list = []

    def _win() -> webview.Window:
        return _win_ref[0]

    window = webview.create_window(
        "小说管家",
        url,
        width=1280,
        height=820,
        min_size=(1020, 640),   # 与前端布局 min-width:1020px 对齐(D5:原 960 在 960-1020 区间横向滚动)
        frameless=True,          # 无 Windows 原生边框/标题栏(窗口逻辑由 WndProc 子类接管)
        easy_drag=False,         # 关键:禁止整个页面拖动(默认True会导致任意位置拖窗口);
                                 # 拖动由 WM_NCHITTEST 返回 HTCAPTION 交给系统原生处理
        text_select=True,        # 关键:允许文字框选/复制(pywebview 默认 False 会注入 user-select:none)
        js_api=Api(),
        background_color="#f5f5f7",
        confirm_close=False,
        hidden=True,             # 关键:窗口先隐藏,等 webview2 初始化+bootMask 准备好才显示,
                                 # 彻底避免 WebView2 容器创建时的"CMD 默认大小"窗口闪现。
                                 # bootMask 也会被这个 hidden 窗口盖住(load 后才一起揭晓)
    )
    _win_ref.append(window)
    # 关闭窗口(含自绘关闭按钮)时停止后端服务
    window.events.closed += lambda: (srv.shutdown(), srv.server_close())

    def _show_window_via_ctypes() -> None:
        """用 Win32 API 直接强制显示主窗口,居中于屏幕;同时把句柄注册给
        gui_server,让前端 HTTP /api/window/*(最小化/最大化/关闭/拖动/缩放)可用。"""
        try:
            import ctypes
            ctypes.windll.user32.FindWindowW.restype = ctypes.c_void_p  # 句柄是 64 位指针,防截断
            hwnd = ctypes.windll.user32.FindWindowW(None, "小说管家")
            if hwnd:
                try:
                    gui_server.set_main_hwnd(int(hwnd))  # 窗口控制 HTTP 端点依赖此句柄
                except Exception:  # noqa: BLE001
                    pass
                if _shown[0]:  # 已显示过 → 不再强制居中/重置尺寸(尊重用户已摆好的窗口)
                    return
                _shown[0] = True
                SWP_NOZORDER = 0x4
                # 屏幕居中
                sw = ctypes.windll.user32.GetSystemMetrics(0)   # SM_CXSCREEN
                sh = ctypes.windll.user32.GetSystemMetrics(1)   # SM_CYSCREEN
                x = (sw - 1280) // 2
                y = (sh - 820) // 2
                ctypes.windll.user32.SetWindowPos(hwnd, 0, x, y, 1280, 820, SWP_NOZORDER)
                ctypes.windll.user32.ShowWindow(hwnd, 5)  # SW_SHOW
        except Exception:  # noqa: BLE001
            pass

    _shown = [False]          # 一次性显示标志:loaded 与 5s 兜底只生效一次
    _wnd_installed = [False]  # 窗口逻辑安装标志:防止 loaded+兜底双重子类化 WndProc

    MIN_W, MIN_H = 1020, 640  # 窗口最小尺寸(防止排版错乱;1020 与前端布局对齐,见 L173)
    TITLEBAR_H = 40          # HTML 自绘标题栏高度(px)
    BTN_AREA_W = 140         # 右侧按钮区宽度(最小化/最大化/关闭,需可点击,不能当标题栏拖)
    EDGE = 8                 # 窗口边缘可拖拽调大小的宽度(px)

    _ORIG_WNDPROC: int = 0
    _WNDPROC_REFS: list = []  # 全局引用,防止回调被 GC 导致窗口崩溃

    def _install_window_logic() -> None:
        """把窗口逻辑完整交给 Windows 系统(官方自定义标题栏方案,同 Electron):

        - 补回 WS_THICKFRAME|WS_CAPTION|WS_MINIMIZEBOX|WS_MAXIMIZEBOX|WS_SYSMENU 样式,
          让系统把它当成"标准窗口"→ Aero Snap 吸附、拖到顶部最大化、双击标题栏
          最大化、最大化后拖拽还原、Alt+Space 系统菜单等全部原生可用;
        - WM_NCCALCSIZE 返回 0 → 系统标题栏/边框不绘制,客户区=整个窗口
          (外观仍是我们自绘的标题栏,最大化时精确填满 work area,无边框偏移);
        - WM_NCHITTEST → 顶部标题栏区返回 HTCAPTION(系统接管拖动/双击最大化),
          边缘返回 resize 手柄(四边/四角可拖拽调大小),
          右侧按钮区返回 HTCLIENT(HTML 按钮正常点击);
        - WM_GETMINMAXINFO → 最小尺寸 960x640(原生限制,不再需要守护线程)。
        """
        if _wnd_installed[0]:  # 已安装过:避免 loaded 与 5s 兜底重复子类化
            return
        _wnd_installed[0] = True
        nonlocal _ORIG_WNDPROC
        import ctypes

        ctypes.windll.user32.FindWindowW.restype = ctypes.c_void_p  # 句柄 64 位,防截断
        hwnd = ctypes.windll.user32.FindWindowW(None, "小说管家")
        if not hwnd:
            if args.dev:
                print("[desktop-window] 未找到窗口,跳过窗口逻辑安装", flush=True)
            return

        # 诊断:窗口线程 vs 当前线程(GWL_WNDPROC 必须在窗口线程修改)
        if args.dev:
            try:
                wtid = ctypes.windll.user32.GetWindowThreadProcessId(hwnd, None)
                ctid = ctypes.windll.kernel32.GetCurrentThreadId()
                print(f"[desktop-window] hwnd={hwnd} 窗口线程={wtid} 当前线程={ctid}", flush=True)
            except Exception:  # noqa: BLE001
                pass

        # ---------- 结构体定义 ----------
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                        ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

        class MINMAXINFO(ctypes.Structure):
            _fields_ = [("ptReserved", POINT), ("ptMaxSize", POINT),
                        ("ptMaxPosition", POINT), ("ptMinTrackSize", POINT),
                        ("ptMaxTrackSize", POINT)]

        class NCCALCSIZE_PARAMS(ctypes.Structure):
            _fields_ = [("rgrc", RECT * 3), ("lppos", ctypes.c_void_p)]

        class MONITORINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", RECT),
                        ("rcWork", RECT), ("dwFlags", ctypes.c_ulong)]

        # ---------- 消息/命中常量 ----------
        WM_NCCALCSIZE = 0x0083
        WM_NCHITTEST = 0x0084
        WM_GETMINMAXINFO = 0x0024
        WM_NCLBUTTONDOWN = 0x00A1
        # 自定义消息(wParam=命中测试码):gui_server.py 的 /api/window/drag|resize
        # 通过 PostMessageW 投递,由窗口所属(UI)线程发起系统原生移动/缩放循环
        # (必须与 window2.py 的 WM_APP_MOVERESIZE 定义一致)
        WM_APP_MOVERESIZE = 0x8001
        HTCLIENT = 1
        HTCAPTION = 2
        HTLEFT, HTRIGHT = 10, 11
        HTTOP, HTTOPLEFT, HTTOPRIGHT = 12, 13, 14
        HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT = 15, 16, 17

        user32 = ctypes.windll.user32
        LRESULT = ctypes.c_longlong
        # 64 位关键:返回指针/句柄的 API 不设 restype 会被截断成 32 位;
        # 传指针参数的 API 不设 argtypes 会把 64 位地址按 c_int 转换 → OverflowError
        user32.SetWindowLongPtrW.restype = LRESULT
        user32.GetWindowLongPtrW.restype = LRESULT
        user32.CallWindowProcW.restype = LRESULT
        user32.SendMessageW.restype = LRESULT
        user32.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        user32.GetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int]
        user32.CallWindowProcW.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                           ctypes.c_uint, ctypes.c_uint64, ctypes.c_int64]
        user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint,
                                        ctypes.c_uint64, ctypes.c_int64]
        user32.GetCursorPos.restype = ctypes.c_int
        user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
        user32.ReleaseCapture.restype = ctypes.c_int
        user32.ReleaseCapture.argtypes = []

        # 子类化窗口过程:lparam 可能为负(多显示器),用有符号 64 位接收
        WNDPROC_T = ctypes.WINFUNCTYPE(
            LRESULT, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint64, ctypes.c_int64)

        # 回调运行状态:rect 缓存(WM_NCHITTEST 高频) + 快速失败保护
        import time as _t2
        _st = {
            "rect": None,        # (left, top, width, height) 缓存
            "rect_ts": 0.0,      # 缓存时间戳
            "err": 0,            # 连续异常次数
            "dead": False,       # 异常过多 → 恢复原 proc,回调降级为纯透传
        }

        @WNDPROC_T
        def wndproc(h, msg, wparam, lparam):
            try:
                if _st["dead"]:
                    return user32.CallWindowProcW(_ORIG_WNDPROC, h, msg, wparam, lparam)
                if msg == WM_NCCALCSIZE:
                    # 隐藏系统标题栏/边框:客户区=整个窗口。
                    # 最大化时把 proposed rect 精确对准 work area,
                    # 消除"最大化后内容溢出/偏移"的问题(有边框样式但客户区全屏)。
                    if wparam and user32.IsZoomed(h):
                        params = ctypes.cast(lparam, ctypes.POINTER(NCCALCSIZE_PARAMS)).contents
                        mon = user32.MonitorFromWindow(h, 2)  # MONITOR_DEFAULTTONEAREST
                        mi = MONITORINFO()
                        mi.cbSize = ctypes.sizeof(MONITORINFO)
                        if user32.GetMonitorInfoW(mon, ctypes.byref(mi)):
                            params.rgrc[0] = mi.rcWork
                    return 0

                if msg == WM_APP_MOVERESIZE:
                    # 前端标题栏拖动/边缘缩放 → HTTP → PostMessage 本消息。
                    # 拖动/缩放必须在窗口所属(UI)线程发起:ReleaseCapture 只对
                    # 持有捕获的本线程生效;WM_NCLBUTTONDOWN 的 lParam 须为真实
                    # 光标屏幕坐标(否则起始点=0,0,窗口跳变)。
                    # 逻辑与 window2.py 一致。
                    if user32.IsZoomed(h):
                        return 0
                    pt = POINT()
                    user32.GetCursorPos(ctypes.byref(pt))
                    user32.ReleaseCapture()
                    user32.SendMessageW(h, WM_NCLBUTTONDOWN, wparam,
                                        ((pt.y & 0xFFFF) << 16) | (pt.x & 0xFFFF))
                    return 0

                if msg == WM_NCHITTEST:
                    # lparam = 屏幕坐标(low= x, high= y,有符号 16 位)
                    x = ctypes.c_short(lparam & 0xFFFF).value
                    y = ctypes.c_short((lparam >> 16) & 0xFFFF).value
                    # 窗口位置缓存(鼠标高频移动时避免反复 GetWindowRect)
                    now = _t2.time()
                    if _st["rect"] is None or now - _st["rect_ts"] > 0.05:
                        rr = RECT()
                        user32.GetWindowRect(h, ctypes.byref(rr))
                        _st["rect"] = (rr.left, rr.top, rr.right - rr.left, rr.bottom - rr.top)
                        _st["rect_ts"] = now
                    lft, top, w, hgt = _st["rect"]
                    cx = x - lft
                    cy = y - top
                    if not user32.IsZoomed(h):  # 最大化窗口不能 resize
                        if cx <= EDGE and cy <= EDGE:
                            return HTTOPLEFT
                        if cx >= w - EDGE and cy <= EDGE:
                            return HTTOPRIGHT
                        if cx <= EDGE and cy >= hgt - EDGE:
                            return HTBOTTOMLEFT
                        if cx >= w - EDGE and cy >= hgt - EDGE:
                            return HTBOTTOMRIGHT
                        if cy <= EDGE:
                            return HTTOP
                        if cy >= hgt - EDGE:
                            return HTBOTTOM
                        if cx <= EDGE:
                            return HTLEFT
                        if cx >= w - EDGE:
                            return HTRIGHT
                    # 顶部标题栏(非按钮区)→ HTCAPTION:系统原生拖动/
                    # Aero Snap/双击最大化/最大化后拖拽还原
                    if cy < TITLEBAR_H and cx < w - BTN_AREA_W:
                        return HTCAPTION
                    return HTCLIENT

                if msg == WM_GETMINMAXINFO:
                    mm = ctypes.cast(lparam, ctypes.POINTER(MINMAXINFO)).contents
                    mm.ptMinTrackSize.x = MIN_W
                    mm.ptMinTrackSize.y = MIN_H
                    return 0

                # 其他消息:窗口位置变化时失效缓存
                if msg in (0x0003, 0x0005, 0x0007):  # WM_MOVE / WM_SIZE / WM_SHOWWINDOW
                    _st["rect"] = None
            except Exception:  # noqa: BLE001
                # 快速失败保护:回调连续出错说明子类化与宿主不兼容,
                # 恢复原窗口过程,降级为纯透传(回到 pywebview 默认行为),避免崩溃/卡死
                _st["err"] += 1
                if _st["err"] >= 20 and _ORIG_WNDPROC:
                    try:
                        _st["dead"] = True
                        user32.SetWindowLongPtrW(h, GWL_WNDPROC, _ORIG_WNDPROC)
                    except Exception:  # noqa: BLE001
                        pass
            if _ORIG_WNDPROC:
                return user32.CallWindowProcW(_ORIG_WNDPROC, h, msg, wparam, lparam)
            return 0

        # ---------- 安装子类 + 补标准窗口样式 ----------
        GWL_WNDPROC = -4
        GWL_STYLE = -16
        WS_THICKFRAME = 0x00040000   # 可调整大小边框(拖动边缘/Aero Snap 依赖)
        WS_MINIMIZEBOX = 0x00020000
        WS_MAXIMIZEBOX = 0x00010000
        WS_SYSMENU = 0x00080000      # Alt+Space 系统菜单
        WS_CAPTION = 0x00C00000      # 标题栏样式位(被 NCCALCSIZE 隐藏,只影响系统逻辑)
        style = user32.GetWindowLongPtrW(hwnd, GWL_STYLE)
        if style:
            user32.SetWindowLongPtrW(
                hwnd, GWL_STYLE,
                style | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
                       | WS_SYSMENU | WS_CAPTION)
        wndproc_ptr = ctypes.cast(wndproc, ctypes.c_void_p).value
        _ORIG_WNDPROC = user32.SetWindowLongPtrW(hwnd, GWL_WNDPROC, wndproc_ptr)
        _WNDPROC_REFS.append(wndproc)  # 防 GC,保活回调对象
        if args.dev:
            print(f"[desktop-window] SetWindowLongPtrW(GWL_WNDPROC) → 原proc={_ORIG_WNDPROC}, 新proc={wndproc_ptr}", flush=True)
        # 刷新窗口边框(应用新样式+子类,不改变位置/大小)
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                            0x4 | 0x1 | 0x2 | 0x20)  # NOZORDER|NOSIZE|NOMOVE|FRAMECHANGED

    # 窗口显示策略:仅启动时用 ctypes 居中显示一次;此后窗口逻辑完全由
    # 系统接管(WndProc 子类),用户可自由拖动/吸附/最大化/resize,不做任何强制纠正
    def _on_loaded():
        try:
            _show_window_via_ctypes()
            _install_window_logic()
        except Exception:  # noqa: BLE001
            pass
    window.events.loaded += _on_loaded

    # 兜底:loaded 不触发时,5 秒后也做显示 + 安装窗口逻辑
    def _fallback_show():
        import time as _t
        _t.sleep(5)
        _show_window_via_ctypes()
        _install_window_logic()
    threading.Thread(target=_fallback_show, daemon=True).start()

    # 窗口看门狗:窗口曾经存在、之后句柄消失(=窗口已关闭) → 强制退出进程。
    # 解决 pywebview 窗口关闭后 webview.start() 可能不返回(WebView2 环境
    # 清理挂起/崩溃转储卡住)导致的"关闭后进程残留/看起来卡死"问题。
    def _window_watchdog():
        import time as _t
        import ctypes as _c
        seen = False
        while True:
            try:
                _t.sleep(1)
                hwnd = _c.windll.user32.FindWindowW(None, "小说管家")
                if hwnd:
                    seen = True
                elif seen:
                    # 窗口曾存在 → 现在消失了 → 已关闭,立即退出
                    os._exit(0)
            except Exception:  # noqa: BLE001
                pass
    threading.Thread(target=_window_watchdog, daemon=True).start()

    try:
        webview.start(debug=args.dev, private_mode=False, storage_path=_webview_cache)
        # 窗口已关闭:立即退出进程。
        # 注意:不能只靠 main 返回——pywebview/.NET 的后台线程会阻止 Python
        # 解释器退出,导致进程残留;必须 os._exit 强制立即退出。
        os._exit(0)
    except Exception as exc:  # noqa: BLE001 桌面窗口启动失败(无 GUI 环境等)→ 降级浏览器模式
        if args.dev:
            print(f"[desktop] 桌面窗口启动失败({exc}),降级为浏览器模式")
        import webbrowser
        webbrowser.open(url)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""小说管家 · 自制窗口引擎(Win32 + WebView2 COM 直嵌)

完全脱离 pywebview / .NET,窗口逻辑 100% 自己控制:
- 窗口:纯 ctypes 创建 Win32 窗口;拖动 / Aero Snap / 双击最大化 / 四边缩放
  全部由系统原生处理(WM_NCHITTEST + WM_GETMINMAXINFO)
- WebView2:通过 WebView2Loader.dll 的 COM 接口直接嵌入(环境 → 控制器 → CoreWebView2)
- JS 桥:window.chrome.webview postMessage ⇄ Python(替代 pywebview js_api)
- 稳定性:WebView2 渲染进程崩溃(ProcessFailed)自动重载恢复,不再"卡死退出"
- 缓存:固定 .webview2-cache 目录,无临时目录冲突

用法:
  python window2.py [--port N] [--dev]
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
from ctypes import c_int, c_long, c_uint, c_ulong, c_void_p, c_wchar_p
from ctypes import POINTER, Structure, WINFUNCTYPE, byref, cast
from ctypes import wintypes

from novel.paths import APP_DATA_DIR as _APP_DATA_DIR

if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

DEBUG = "--dev" in sys.argv


def _dbg(msg):
    if DEBUG:
        print(f"[w2dbg] {msg}", flush=True)

HRESULT = c_long
HWND = c_void_p

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
ole32 = ctypes.windll.ole32
oleaut32 = ctypes.windll.oleaut32

# ---------- 窗口常量 ----------
WM_NCHITTEST = 0x0084
WM_NCLBUTTONDOWN = 0x00A1
WM_GETMINMAXINFO = 0x0024
WM_SIZE = 0x0005
WM_MOVE = 0x0003
WM_CLOSE = 0x0010
WM_ERASEBKGND = 0x0014
WM_ACTIVATE = 0x0006
WM_NCCALCSIZE = 0x0083
# 自定义消息:wParam=命中测试码(HTCAPTION/HTLEFT...),UI 线程收到后
# 发起系统原生移动/缩放循环。gui_server.py 的 /api/window/drag|resize 通过
# PostMessageW 投递本消息(跨线程 PostMessage 可靠;直接跨线程 SendMessage+
# ReleaseCapture 会因捕获归属/起始坐标问题失效)
WM_APP_MOVERESIZE = 0x8001
WM_APP_OPENREADER = 0x8002   # wParam=待创建阅读器 URL 在 _PENDING_READERS 里的下标
HTCAPTION, HTCLIENT = 2, 1
HTLEFT, HTRIGHT = 10, 11
HTTOP, HTTOPLEFT, HTTOPRIGHT = 12, 13, 14
HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT = 15, 16, 17
SW_SHOW, SW_MINIMIZE, SW_MAXIMIZE, SW_RESTORE = 5, 6, 3, 9
WS_POPUP = 0x80000000
WS_VISIBLE = 0x10000000
WS_CLIPCHILDREN = 0x02000000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000
WS_CAPTION = 0x00C00000  # WS_BORDER|WS_DLGFRAME

MIN_W, MIN_H = 1020, 640  # 最小窗口尺寸(MIN_W 与前端 .app min-width:1020px 对齐)
TITLEBAR_H = 40           # HTML 自绘标题栏高度
BTN_AREA_W = 140          # 右侧按钮区宽度(可点击)
EDGE = 10                 # 可缩放边缘宽度(与前端 GRIP 边条保持一致)

# 窗口背景色(#f5f5f7,与前端 var(--card)/bootMask 一致):
# WebView2 就绪前/渲染面瞬时重置时露出的底色,保持一致即"闪不可见"
BG_R, BG_G, BG_B = 0xF5, 0xF5, 0xF7
BG_COLORREF = BG_R | (BG_G << 8) | (BG_B << 16)

# ---------- 窗口尺寸/位置持久化 ----------
# 单独小文件,不写大 config.json(避免与书源数据并发写竞争)
_WIN_STATE_PATH = os.path.join(_APP_DATA_DIR, "window_state.json")


def _load_win_state() -> tuple | None:
    """读上次窗口位置尺寸 (l, t, w, h);不存在/损坏返回 None。"""
    try:
        with open(_WIN_STATE_PATH, "r", encoding="utf-8") as f:
            r = json.load(f).get("rect")
        if r and len(r) == 4 and all(isinstance(v, int) for v in r):
            return tuple(r)
    except Exception:  # noqa: BLE001
        pass
    return None


def _save_win_state(rect) -> None:
    try:
        with open(_WIN_STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"rect": list(rect)}, f)
    except Exception:  # noqa: BLE001
        pass


def _validated_win_state() -> tuple | None:
    """读持久化窗口位置并校验/夹取:确保在当前屏幕可见区内且不小于最小尺寸。

    处理换显示器/分辨率变化/拔副屏后旧位置离屏的情况。
    """
    r = _load_win_state()
    if not r:
        return None
    l, t, w, h = r
    sw = user32.GetSystemMetrics(0)  # SM_CXSCREEN
    sh = user32.GetSystemMetrics(1)  # SM_CYSCREEN
    # 尺寸夹取:不小于最小尺寸,不大于主屏(多显示器超宽场景退主屏保底)
    w = max(MIN_W, min(w, max(sw, MIN_W)))
    h = max(MIN_H, min(h, max(sh, MIN_H)))
    # 位置:至少留 80px 在可见区内,否则拉回屏幕内
    if l + w < 80 or t + h < 80 or l > sw - 80 or t > sh - 80:
        l = max(0, min(l, sw - w)) if sw >= w else 0
        t = max(0, min(t, sh - h)) if sh >= h else 0
    return (l, t, w, h)

# ---------- 结构体 ----------
class POINT(Structure):
    _fields_ = [("x", c_long), ("y", c_long)]

class RECT(Structure):
    _fields_ = [("left", c_long), ("top", c_long), ("right", c_long), ("bottom", c_long)]

class MINMAXINFO(Structure):
    _fields_ = [("ptReserved", POINT), ("ptMaxSize", POINT),
                ("ptMaxPosition", POINT), ("ptMinTrackSize", POINT),
                ("ptMaxTrackSize", POINT)]

class MONITORINFO(Structure):
    _fields_ = [("cbSize", c_ulong), ("rcMonitor", RECT),
                ("rcWork", RECT), ("dwFlags", c_ulong)]

class NCCALCSIZE_PARAMS(Structure):
    _fields_ = [("rgrc", RECT * 3), ("lppos", c_void_p)]

class WNDCLASSEXW(Structure):
    _fields_ = [("cbSize", c_uint), ("style", c_uint), ("lpfnWndProc", c_void_p),
                ("cbClsExtra", c_int), ("cbWndExtra", c_int), ("hInstance", c_void_p),
                ("hIcon", c_void_p), ("hCursor", c_void_p), ("hbrBackground", c_void_p),
                ("lpszMenuName", c_wchar_p), ("lpszClassName", c_wchar_p), ("hIconSm", c_void_p)]

# ---------- Win32 API 声明 ----------
user32.DefWindowProcW.restype = c_long
user32.DefWindowProcW.argtypes = [HWND, c_uint, c_void_p, c_void_p]
user32.ShowWindow.restype = c_int
user32.ShowWindow.argtypes = [HWND, c_int]
user32.IsZoomed.restype = c_int
user32.IsZoomed.argtypes = [HWND]
user32.GetWindowRect.restype = c_int
user32.GetWindowRect.argtypes = [HWND, POINTER(RECT)]
user32.GetClientRect.restype = c_int
user32.GetClientRect.argtypes = [HWND, POINTER(RECT)]
user32.MonitorFromWindow.restype = c_void_p
user32.MonitorFromWindow.argtypes = [HWND, c_ulong]
user32.GetMonitorInfoW.restype = c_int
user32.GetMonitorInfoW.argtypes = [c_void_p, POINTER(MONITORINFO)]
user32.PostMessageW.restype = c_int
user32.PostMessageW.argtypes = [HWND, c_uint, c_void_p, c_void_p]
user32.SendMessageW.restype = c_long
user32.SendMessageW.argtypes = [HWND, c_uint, c_void_p, c_void_p]
user32.ReleaseCapture.restype = c_int
user32.ReleaseCapture.argtypes = []
user32.GetCursorPos.restype = c_int
user32.GetCursorPos.argtypes = [POINTER(POINT)]
user32.FindWindowW.restype = HWND
user32.FindWindowW.argtypes = [c_wchar_p, c_wchar_p]
# Win11 窗口圆角:DWMWA_WINDOW_CORNER_PREFERENCE(33) = DWMWCP_ROUND(2)。
# 无边框窗口(WM_NCCALCSIZE 剥非客户区)默认失去 Win11 自动圆角,需显式设置;
# Win10 及以下无此属性,调用返回失败静默保持直角。
dwmapi = ctypes.windll.dwmapi
dwmapi.DwmSetWindowAttribute.restype = c_long
dwmapi.DwmSetWindowAttribute.argtypes = [c_void_p, c_ulong, c_void_p, c_ulong]
gdi32 = ctypes.windll.gdi32
gdi32.CreateSolidBrush.restype = c_void_p
gdi32.CreateSolidBrush.argtypes = [c_ulong]
gdi32.DeleteObject.restype = c_int
gdi32.DeleteObject.argtypes = [c_void_p]
user32.FillRect.restype = c_int
user32.FillRect.argtypes = [c_void_p, POINTER(RECT), c_void_p]
ole32.CoInitializeEx.restype = HRESULT
ole32.CoInitializeEx.argtypes = [c_void_p, c_ulong]
ole32.CoUninitialize.restype = None
oleaut32.SysAllocString.restype = c_void_p
oleaut32.SysAllocString.argtypes = [c_wchar_p]
oleaut32.SysFreeString.restype = None
oleaut32.SysFreeString.argtypes = [c_void_p]
oleaut32.SysStringLen.restype = c_uint
oleaut32.SysStringLen.argtypes = [c_void_p]

# 背景刷(需在 gdi32 声明后创建):窗口类背景 + WM_ERASEBKGND 填色用
_BG_BRUSH = gdi32.CreateSolidBrush(BG_COLORREF)


# =====================================================================
# WebView2 COM(vtable 直调)
# =====================================================================

def com_call(ptr, index, restype, argtypes):
    """通过 vtable 调用 COM 方法。"""
    vtbl = cast(ptr, POINTER(POINTER(c_void_p))).contents
    fn = cast(vtbl[index], WINFUNCTYPE(restype, c_void_p, *argtypes))
    return fn


def com_addref(ptr):
    return com_call(ptr, 1, c_ulong, [])(ptr)


def com_release(ptr):
    return com_call(ptr, 2, c_ulong, [])(ptr)


def bstr(s: str):
    return oleaut32.SysAllocString(s or "")


def read_bstr(ptr) -> str:
    """读取 BSTR 指针内容并释放。"""
    if not ptr:
        return ""
    try:
        length = oleaut32.SysStringLen(ptr)
        return ctypes.wstring_at(ptr, length)
    finally:
        oleaut32.SysFreeString(ptr)


class ComCallback:
    """伪 COM 回调对象(带 vtable)。

    invoke_fn: (this, *args) -> HRESULT;调用方通过 event 等待。
    invoke_argtypes: Invoke 除 this 外的参数类型列表。
      - 创建类回调: [HRESULT, c_void_p](errorCode + 对象指针)
      - 事件类回调: [c_void_p, c_void_p](sender + args),默认
    """

    def __init__(self, invoke_fn, invoke_argtypes=None):
        self._invoke = invoke_fn
        self._refs = []
        # vtable: QueryInterface / AddRef / Release / Invoke
        @WINFUNCTYPE(c_ulong, c_void_p, c_void_p, c_void_p)
        def _qi(this, riid, ppv):
            return 0x80004002  # E_NOINTERFACE

        @WINFUNCTYPE(c_ulong, c_void_p)
        def _ar(this):
            return 1

        @WINFUNCTYPE(c_ulong, c_void_p)
        def _rl(this):
            return 0

        # Invoke: this + 声明的参数类型(COM 回调第一个参数是 this!)
        argtypes = [c_void_p] + list(invoke_argtypes or [c_void_p, c_void_p])

        @WINFUNCTYPE(HRESULT, *argtypes)
        def _inv(this, *args):
            try:
                return invoke_fn(this, *args) or 0
            except Exception:  # noqa: BLE001
                return 0x80004005  # E_FAIL

        class _Vtbl(Structure):
            _fields_ = [("QueryInterface", c_void_p), ("AddRef", c_void_p),
                        ("Release", c_void_p), ("Invoke", c_void_p)]

        class _Obj(Structure):
            _fields_ = [("lpVtbl", POINTER(_Vtbl))]

        self._vtbl = _Vtbl()
        self._vtbl.QueryInterface = cast(_qi, c_void_p)
        self._vtbl.AddRef = cast(_ar, c_void_p)
        self._vtbl.Release = cast(_rl, c_void_p)
        self._vtbl.Invoke = cast(_inv, c_void_p)
        self._obj = _Obj()
        self._obj.lpVtbl = ctypes.pointer(self._vtbl)
        self._refs = [self._vtbl, self._obj, _qi, _ar, _rl, _inv]

    @property
    def ptr(self):
        return cast(byref(self._obj), c_void_p)


def find_loader() -> str | None:
    """定位 WebView2Loader.dll(打包后从 _MEIPASS;开发时从 webview 包)。"""
    cands = []
    if getattr(sys, "frozen", False):
        cands.append(os.path.join(sys._MEIPASS, "webview", "lib", "runtimes",
                                  "win-x64", "native", "WebView2Loader.dll"))
        cands.append(os.path.join(os.path.dirname(sys.executable), "WebView2Loader.dll"))
    try:
        import webview, inspect
        wdir = os.path.dirname(inspect.getfile(webview))
        cands.append(os.path.join(wdir, "lib", "runtimes", "win-x64", "native", "WebView2Loader.dll"))
    except Exception:  # noqa: BLE001
        pass
    cands.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "WebView2Loader.dll"))
    for p in cands:
        if p and os.path.isfile(p):
            return p
    return None


class WebView2:
    """WebView2 COM 封装:环境 → 控制器 → CoreWebView2 + 事件 + JS 桥。"""

    # ICoreWebView2 接口 vtable 索引(本机 WebView2 Runtime 实测,与官方 IDL 有偏移)
    # 实测:11 add_NavigationCompleted / 21 add_ProcessFailed / 25 add_WebMessageReceived
    #      34 add_WebResourceResponseReceived / 42 add_NewWindowRequested(官方位置)
    NAVIGATE = 5
    ADD_WEBMESSAGE = 25            # add_WebMessageReceived(实测,非官方27)
    POST_WEBMESSAGE_JSON = 49      # ICoreWebView2_2::PostWebMessageAsJson(官方)
    ADD_NEWWINDOW = 42             # add_NewWindowRequested
    ADD_NAVCOMPLETED = 11          # add_NavigationCompleted
    ADD_PROCESSFAILED = 21         # add_ProcessFailed
    GET_SETTINGS = 3

    def __init__(self, hwnd, url, user_data_dir, on_message=None, on_ready=None):
        self.hwnd = hwnd
        self.url = url
        self.current_url = url
        self.user_data_dir = user_data_dir
        self.on_message = on_message      # (json_str) -> None
        self.on_ready = on_ready          # () -> None(首次导航完成)
        self._env = None
        self._ctrl = None
        self._core = None
        self._callbacks: list[ComCallback] = []
        self._ready_once = False

    # ---------- 创建 ----------
    def create(self):
        loader_path = find_loader()
        if not loader_path:
            raise RuntimeError("找不到 WebView2Loader.dll")
        loader = ctypes.WinDLL(loader_path)
        loader.CreateCoreWebView2EnvironmentWithOptions.restype = HRESULT
        loader.CreateCoreWebView2EnvironmentWithOptions.argtypes = [
            c_wchar_p, c_wchar_p, c_void_p, c_void_p, c_void_p]

        os.makedirs(self.user_data_dir, exist_ok=True)

        # 1) 环境
        e_done = threading.Event()
        e_res: dict = {}

        def _env_cb(this, err, env):
            e_res["err"] = err
            if err == 0 and env:
                com_addref(env)
                e_res["env"] = env
            e_done.set()
            return 0

        env_cb = ComCallback(_env_cb, [HRESULT, c_void_p])  # (errorCode, env)
        self._callbacks.append(env_cb)
        hr = loader.CreateCoreWebView2EnvironmentWithOptions(
            None, self.user_data_dir, None, env_cb.ptr, None)
        if hr != 0 or not _pump_until(e_done):
            raise RuntimeError(f"WebView2 环境创建失败 hr=0x{hr & 0xFFFFFFFF:08X}")
        if e_res.get("err") != 0:
            raise RuntimeError(f"WebView2 环境创建失败 0x{e_res['err'] & 0xFFFFFFFF:08X}")
        self._env = e_res["env"]
        _dbg(f"create(): 环境 OK env={self._env}")

        # 2) 控制器(嵌入自制窗口)
        c_done = threading.Event()
        c_res: dict = {}

        def _ctrl_cb(this, err, ctrl):
            c_res["err"] = err
            if err == 0 and ctrl:
                com_addref(ctrl)
                c_res["ctrl"] = ctrl
            c_done.set()
            return 0

        ctrl_cb = ComCallback(_ctrl_cb, [HRESULT, c_void_p])  # (errorCode, controller)
        self._callbacks.append(ctrl_cb)
        hr = com_call(self._env, 3, HRESULT, [c_void_p, c_void_p])(self._env, self.hwnd, ctrl_cb.ptr)
        if hr != 0 or not _pump_until(c_done):
            raise RuntimeError(f"WebView2 控制器创建失败 hr=0x{hr & 0xFFFFFFFF:08X}")
        if c_res.get("err") != 0:
            raise RuntimeError(f"WebView2 控制器创建失败 0x{c_res['err'] & 0xFFFFFFFF:08X}")
        self._ctrl = c_res["ctrl"]
        _dbg(f"create(): 控制器 OK ctrl={self._ctrl}")

        # 3) 可见 + Bounds(填满客户区)
        rc = RECT()
        user32.GetClientRect(self.hwnd, byref(rc))
        com_call(self._ctrl, 4, HRESULT, [c_int])(self._ctrl, 1)          # put_IsVisible(TRUE)
        com_call(self._ctrl, 6, HRESULT, [RECT])(self._ctrl, rc)          # put_Bounds
        # 3.5) 默认背景色(ICoreWebView2Controller2::put_DefaultBackgroundColor):
        # 已放弃。本机 Runtime 控制器 vtable 与官方 IDL 偏移(get_CoreWebView2
        # 实测在 25 而非官方 12),无法可靠定位 put 槽位:实测调 24 虽返回
        # S_OK,但会导致随后所有 add_ 事件注册报 0x8007139F(JS 桥/崩溃
        # 恢复/导航完成全部失效);调 19 则是 add_* 方法 → COLORREF 被当
        # 回调指针 AddRef → access violation。窗口底色已由背景刷 +
        # WM_ERASEBKGND 兜底(#F5F5F7,与前端一致),不再冒风险设置。

        # 4) CoreWebView2(实测 index 25)
        core = c_void_p()
        hr = com_call(self._ctrl, 25, HRESULT, [POINTER(c_void_p)])(self._ctrl, byref(core))
        if hr != 0 or not core.value:
            raise RuntimeError(f"获取 CoreWebView2 失败 hr=0x{hr & 0xFFFFFFFF:08X}")
        com_addref(core.value)
        self._core = core.value
        _dbg(f"create(): CoreWebView2 OK core={self._core}")

        # 5) 注册事件
        self._register_events()

        # 6) 导航到应用页面
        self.navigate(self.url)

    # ---------- 事件 ----------
    def _add_event(self, idx: int, cb: ComCallback) -> int:
        """注册 add_ 事件:token 必须传有效指针(add_ 方法会写入,传 None 会崩溃)。"""
        tok = ctypes.c_ulonglong(0)
        hr = com_call(self._core, idx, HRESULT,
                      [c_void_p, POINTER(ctypes.c_ulonglong)])(
            self._core, cb.ptr, byref(tok))
        if hr != 0:
            _dbg(f"add_event(idx={idx}) hr=0x{hr & 0xFFFFFFFF:08X}")
        return hr

    def _register_events(self):

        def _on_msg(this, sender, args):
            try:
                # WebMessageReceivedEventArgs.get_WebMessageAsJson = index 4
                b = c_void_p()
                com_call(args, 4, HRESULT, [POINTER(c_void_p)])(args, byref(b))
                text = read_bstr(b.value)
                if text and self.on_message:
                    self.on_message(text)
            except Exception:  # noqa: BLE001
                pass
            return 0

        cb = ComCallback(_on_msg)
        self._callbacks.append(cb)
        self._add_event(self.ADD_WEBMESSAGE, cb)   # add_WebMessageReceived

        def _on_newwindow(this, sender, args):
            # 新窗口一律拒绝,改为当前窗口导航
            try:
                com_call(args, 5, HRESULT, [c_int])(args, 1)  # SetHandled(TRUE)
            except Exception:  # noqa: BLE001
                pass
            return 0

        cb = ComCallback(_on_newwindow)
        self._callbacks.append(cb)
        self._add_event(self.ADD_NEWWINDOW, cb)    # add_NewWindowRequested

        def _on_nav_done(this, sender, args):
            # 首次导航完成 → 显示窗口(HTML + bootMask 就绪)
            if not self._ready_once:
                self._ready_once = True
                if self.on_ready:
                    try:
                        self.on_ready()
                    except Exception:  # noqa: BLE001
                        pass
            return 0

        cb = ComCallback(_on_nav_done)
        self._callbacks.append(cb)
        self._add_event(self.ADD_NAVCOMPLETED, cb) # add_NavigationCompleted

        def _on_procfail(this, sender, args):
            # 渲染进程崩溃 → 自动重载(彻底解决"卡死退出")
            try:
                kind = c_int()
                com_call(args, 3, HRESULT, [POINTER(c_int)])(args, byref(kind))
                # ProcessFailedKind: 1=BrowserProcessExited, 2=RenderProcessExited, ...
                if kind.value in (2, 3) and self._core and self.current_url:
                    time.sleep(0.5)
                    self.navigate(self.current_url)
            except Exception:  # noqa: BLE001
                pass
            return 0

        cb = ComCallback(_on_procfail)
        self._callbacks.append(cb)
        self._add_event(self.ADD_PROCESSFAILED, cb) # add_ProcessFailed

    # ---------- 操作 ----------
    def navigate(self, url: str):
        if not self._core:
            return
        self.current_url = url
        b = bstr(url)
        try:
            com_call(self._core, self.NAVIGATE, HRESULT, [c_void_p])(self._core, b)
        finally:
            oleaut32.SysFreeString(b)

    def post_json(self, obj):
        """向页面发送 JSON(桥回传)。"""
        if not self._core:
            return
        b = bstr(json.dumps(obj, ensure_ascii=False))
        try:
            hr = com_call(self._core, self.POST_WEBMESSAGE_JSON, HRESULT, [c_void_p])(
                self._core, b)
            if hr != 0:
                _dbg(f"post_json hr=0x{hr & 0xFFFFFFFF:08X}")
        finally:
            oleaut32.SysFreeString(b)

    def execute_script(self, js: str):
        """注入 JS 到页面。注:本机 Runtime vtable 未实测 ExecuteScript 索引,
        且与 add_WebMessageReceived 同处 index 25 冲突,当前无调用点,禁用。"""
        return

    def resize(self):
        if not self._ctrl:
            return
        rc = RECT()
        user32.GetClientRect(self.hwnd, byref(rc))
        com_call(self._ctrl, 6, HRESULT, [RECT])(self._ctrl, rc)

    def release(self):
        for obj in (self._core, self._ctrl, self._env):
            if obj:
                try:
                    com_release(obj)
                except Exception:  # noqa: BLE001
                    pass
        self._core = self._ctrl = self._env = None


# =====================================================================
# 自制主窗口
# =====================================================================

# 多窗口注册表:main=主窗口,readerN=阅读器窗口(独立阅读器窗口功能)
_ALL_WINS: dict = {}
_PENDING_READERS: list[str] = []   # 待创建的阅读器 URL(UI 线程从队列取)
_READER_SEQ = 0
_WNDCLASS_REGISTERED = False
_MAIN_CACHE_DIR = ".webview2-cache"


class MainWindow:
    def __init__(self, title: str, width: int, height: int, url: str, cache_dir: str,
                 initial_rect: tuple | None = None,
                 wid: str = "main", reader: bool = False):
        self.title = title
        self.width = width
        self.height = height
        self.url = url
        self.cache_dir = cache_dir
        self.wid = wid
        self.is_reader = reader
        self.hwnd = None
        self.wv2: WebView2 | None = None
        self.api = Api(self)
        self._closing = False
        self._normal_rect = None  # 最近一次 normal 窗口位置(还原用)
        self._initial_rect = None if reader else initial_rect  # 阅读器窗口不恢复主窗口位置
        self._save_timer = None   # 尺寸/位置落盘防抖定时器(仅主窗口)
        # 关键:窗口过程回调必须保活(否则 GC 回收 → 窗口逻辑全部失效)
        self._wndproc_ref = WNDPROC_T(self._wndproc)

        global _WNDCLASS_REGISTERED
        hinst = kernel32.GetModuleHandleW(None)
        # 每窗口一个独立窗口类:类过程绑定各自的 _wndproc。若共用类名,
        # 后建窗口的消息会全部路由进首个窗口的窗口过程(实测踩坑)。
        self._cls_name = "NovelCrawlerMainWin" if not reader else f"NovelCrawlerReader_{wid}"
        if self._cls_name != "NovelCrawlerMainWin" or not _WNDCLASS_REGISTERED:
            wc = WNDCLASSEXW()
            wc.cbSize = ctypes.sizeof(WNDCLASSEXW)
            wc.lpfnWndProc = cast(self._wndproc_ref, c_void_p)
            wc.hInstance = hinst
            wc.hbrBackground = _BG_BRUSH  # 窗口底色 = 应用背景色,WebView2 就绪前不露黑底
            wc.lpszClassName = self._cls_name
            user32.RegisterClassExW(byref(wc))
            _WNDCLASS_REGISTERED = True

        # 关键:样式位按"有框窗口"给足(WS_CAPTION/WS_SYSMENU/WS_THICKFRAME +
        # 最小/最大化框),再用 WM_NCCALCSIZE 剥掉整个非客户区实现视觉无边框。
        # 系统因此仍把它当带标题栏窗口对待:最小化/最大化原生过渡动画、任务栏
        # 飞入效果、Aero Snap 全部恢复;WS_THICKFRAME 同时是 DefWindowProc 响应
        # WM_NCLBUTTONDOWN 移动/缩放模态循环的前提。
        self.hwnd = user32.CreateWindowExW(
            0, self._cls_name, title,
            WS_CLIPCHILDREN | WS_THICKFRAME | WS_CAPTION | WS_SYSMENU
            | WS_MINIMIZEBOX | WS_MAXIMIZEBOX,
            -32000, -32000, width, height, None, None, hinst, None)
        if not self.hwnd:
            raise RuntimeError("窗口创建失败")
        _ALL_WINS[self.wid] = self
        # Win11 圆角(显示前设置,避免直角一闪):DWM 圆角作用于整个窗口
        # 合成面(含 WebView2 子窗口),最大化时系统自动切回直角。
        try:
            pref = c_ulong(2)  # DWMWCP_ROUND
            hr = dwmapi.DwmSetWindowAttribute(self.hwnd, 33, byref(pref), ctypes.sizeof(pref))
            _dbg(f"DWM 圆角 hr=0x{hr & 0xFFFFFFFF:08X}")
        except Exception:  # noqa: BLE001
            pass
        # 恢复上次窗口位置/尺寸(仍在离屏态,show() 时才显示)
        if initial_rect:
            l, t, w, h = initial_rect
            user32.SetWindowPos(self.hwnd, 0, l, t, w, h, 0x4 | 0x20)  # NOZORDER|NOACTIVATE

    # ---------- 窗口过程 ----------
    def _wndproc(self, h, msg, wp, lp):
        try:
            if msg == WM_NCCALCSIZE:
                # 关键:wParam 无论是 0(首次创建)还是 1(调整尺寸)都把客户区扩到整窗,
                # 否则 wParam=0 时系统会用默认边框尺寸→OS 标题栏/边框一直存在。
                # 最大化(IsZoomed)时不盖任务栏,把客户区夹到工作区。
                try:
                    prm = cast(lp, POINTER(NCCALCSIZE_PARAMS)).contents
                    if wp and user32.IsZoomed(h):
                        mon = user32.MonitorFromWindow(h, 2)
                        mi = MONITORINFO()
                        mi.cbSize = ctypes.sizeof(MONITORINFO)
                        if user32.GetMonitorInfoW(mon, byref(mi)):
                            prm.rgrc[0].left = mi.rcWork.left
                            prm.rgrc[0].top = mi.rcWork.top
                            prm.rgrc[0].right = mi.rcWork.right
                            prm.rgrc[0].bottom = mi.rcWork.bottom
                except Exception:  # noqa: BLE001
                    pass
                # wParam=0 或 1: 客户区=整个窗口(无 OS 标题栏/边框)
                return 0

            if msg == WM_APP_OPENREADER:
                # UI 线程创建阅读器窗口(HTTP 线程经 PostMessage 转交,队列下标在 wParam)
                try:
                    i = int(wp or 0)   # wp 为 c_void_p,0 值会是 None
                    if 0 <= i < len(_PENDING_READERS):
                        u = _PENDING_READERS[i]
                        _spawn_reader(u)
                except Exception as exc:  # noqa: BLE001
                    _dbg(f"open reader failed: {exc}")
                return 0

            if msg == WM_APP_MOVERESIZE:
                # 拖动/缩放必须在窗口所属(UI)线程发起:ReleaseCapture 只对持有
                # 捕获的本线程生效;WM_NCLBUTTONDOWN 的 lParam 须为真实光标屏幕
                # 坐标(否则起始点=0,0,窗口跳变)。
                if user32.IsZoomed(h):
                    return 0
                pt = POINT()
                user32.GetCursorPos(byref(pt))
                user32.ReleaseCapture()
                user32.SendMessageW(h, WM_NCLBUTTONDOWN, wp,
                                    ((pt.y & 0xFFFF) << 16) | (pt.x & 0xFFFF))
                return 0

            if msg == WM_NCHITTEST:
                # 系统原生:标题栏拖动 / Aero Snap / 边缘缩放 / 按钮区可点
                x = ctypes.c_short(lp & 0xFFFF).value
                y = ctypes.c_short((lp >> 16) & 0xFFFF).value
                r = RECT()
                user32.GetWindowRect(h, byref(r))
                w = r.right - r.left
                hgt = r.bottom - r.top
                cx = x - r.left
                cy = y - r.top
                if not user32.IsZoomed(h):
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
                if cy < TITLEBAR_H and cx < w - BTN_AREA_W:
                    return HTCAPTION
                return HTCLIENT

            if msg == WM_GETMINMAXINFO:
                mm = cast(lp, POINTER(MINMAXINFO)).contents
                mm.ptMinTrackSize.x = MIN_W
                mm.ptMinTrackSize.y = MIN_H
                # 最大化 = 填满 work area(不盖任务栏,WS_POPUP 默认会填全屏)
                try:
                    mon = user32.MonitorFromWindow(h, 2)
                    mi = MONITORINFO()
                    mi.cbSize = ctypes.sizeof(MONITORINFO)
                    if user32.GetMonitorInfoW(mon, byref(mi)):
                        mm.ptMaxSize.x = mi.rcWork.right - mi.rcWork.left
                        mm.ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top
                        mm.ptMaxPosition.x = mi.rcWork.left
                        mm.ptMaxPosition.y = mi.rcWork.top
                except Exception:  # noqa: BLE001
                    pass
                return 0

            if msg == WM_SIZE or msg == WM_MOVE:
                # 客户区/位置变化 → 同步 WebView2 区域;并跟踪 normal 位置
                try:
                    if not user32.IsZoomed(h) and not user32.IsIconic(h):
                        r = RECT()
                        user32.GetWindowRect(h, byref(r))
                        if self._normal_rect and (r.left < -30000 or r.top < -30000):
                            # 最大化→还原时系统可能把 WS_POPUP 窗口放回离屏初始位置,
                            # 强制拉回上次 normal 位置(并保持记录,不被离屏值覆盖)
                            l, t, w, hh = self._normal_rect
                            user32.SetWindowPos(h, 0, l, t, 0, 0, 0x4 | 0x1)  # NOZORDER|NOSIZE
                        else:
                            new_rect = (r.left, r.top, r.right - r.left, r.bottom - r.top)
                            if new_rect != self._normal_rect:
                                self._normal_rect = new_rect
                                self._schedule_save()  # 防抖落盘,保持下次启动尺寸
                except Exception:  # noqa: BLE001
                    pass
                if self.wv2 and msg == WM_SIZE:  # 仅尺寸变化才重设 Bounds,拖动移动不做冗余 COM 调用
                    self.wv2.resize()
                return 0

            if msg == WM_ERASEBKGND:
                # 填应用背景色(不依赖类刷时机),防黑底/闪烁
                try:
                    rc = RECT()
                    user32.GetClientRect(h, byref(rc))
                    user32.FillRect(wp, byref(rc), _BG_BRUSH)
                except Exception:  # noqa: BLE001
                    pass
                return 1

            if msg == WM_CLOSE:
                if self.is_reader:
                    # 阅读器窗口关闭 = 只销毁自己,消息循环继续服务主窗口
                    _ALL_WINS.pop(self.wid, None)
                    user32.DestroyWindow(h)
                    return 0
                # 主窗口关闭:连带关闭全部阅读器窗口再退出
                for w in list(_ALL_WINS.values()):
                    if w.is_reader and w.hwnd:
                        user32.PostMessageW(w.hwnd, WM_CLOSE, 0, 0)
                self._closing = True
                user32.PostQuitMessage(0)
                return 0
        except Exception:  # noqa: BLE001
            pass
        return user32.DefWindowProcW(h, msg, wp, lp)

    # ---------- 生命周期 ----------
    def _schedule_save(self) -> None:
        """窗口尺寸/位置落盘(防抖 0.8s,拖动/缩放过程中不频繁写盘)。"""
        if self._save_timer is not None:
            self._save_timer.cancel()
        rect = self._normal_rect
        if not rect:
            return
        self._save_timer = threading.Timer(0.8, _save_win_state, args=(rect,))
        self._save_timer.daemon = True
        self._save_timer.start()

    def center_on_screen(self):
        sw = user32.GetSystemMetrics(0)
        sh = user32.GetSystemMetrics(1)
        x = max(0, (sw - self.width) // 2)
        y = max(0, (sh - self.height) // 2)
        user32.SetWindowPos(self.hwnd, 0, x, y, self.width, self.height, 0x4)

    def show(self):
        _dbg("show(): 显示窗口")
        # 先定位再显示:避免窗口在离屏/旧位置一闪后才归位
        if not self._initial_rect:
            self.center_on_screen()
        user32.ShowWindow(self.hwnd, SW_SHOW)
        try:
            r = RECT()
            user32.GetWindowRect(self.hwnd, byref(r))
            self._normal_rect = (r.left, r.top, r.right - r.left, r.bottom - r.top)
        except Exception:  # noqa: BLE001
            pass

    def run(self):
        """创建 WebView2 + 进入消息循环(阻塞)。"""
        # WebView2 创建(STA 线程,内部泵消息)
        ready = threading.Event()

        def _on_ready():
            # 页面首次加载完成 → 显示窗口(HTML bootMask 就绪)
            try:
                self.show()
                ready.set()
            except Exception:  # noqa: BLE001
                pass

        self.wv2 = WebView2(self.hwnd, self.url, self.cache_dir,
                            on_message=self._on_webmessage, on_ready=_on_ready)
        self.wv2.create()

        # 兜底:页面加载异常时 8 秒后也显示
        def _fallback():
            time.sleep(8)
            if not ready.is_set():
                try:
                    self.show()
                except Exception:  # noqa: BLE001
                    pass
        threading.Thread(target=_fallback, daemon=True).start()

        # 消息循环
        msg = wintypes.MSG()
        while user32.GetMessageW(byref(msg), None, 0, 0) > 0:
            user32.TranslateMessage(byref(msg))
            user32.DispatchMessageW(byref(msg))

    # ---------- JS 桥 ----------
    def _on_webmessage(self, text: str):
        try:
            data = json.loads(text)
            mid = data.get("id")
            method = data.get("method", "")
            args = data.get("args") or []
            _dbg(f"桥调用: {method}{args} id={mid}")
            try:
                fn = getattr(self.api, method)
                result = fn(*args) if callable(fn) else None
                self.wv2.post_json({"id": mid, "result": result})
            except Exception as exc:  # noqa: BLE001
                self.wv2.post_json({"id": mid, "error": str(exc)})
        except Exception:  # noqa: BLE001
            pass


# ---------- 多窗口:阅读器窗口创建与控制 ----------
def _spawn_reader(url: str) -> None:
    """在 UI 线程创建阅读器窗口(由 WM_APP_OPENREADER 触发,勿在 HTTP 线程直调)。

    不进入消息循环:主窗口的 GetMessage 循环服务同线程全部窗口。
    WebView2 环境与主窗口同 user-data-folder(共享浏览器进程)。"""
    global _READER_SEQ
    _READER_SEQ += 1
    wid = f"reader{_READER_SEQ}"
    main = _ALL_WINS.get("main")
    cache_dir = main.cache_dir if main else _MAIN_CACHE_DIR
    win = MainWindow("阅读器 · 漫画+小说", 980, 1040, url, cache_dir,
                     wid=wid, reader=True)
    win.wv2 = WebView2(win.hwnd, url, cache_dir,
                       on_message=win._on_webmessage,
                       on_ready=lambda w=win: w.show())
    try:
        win.wv2.create()
        _dbg(f"阅读器窗口已创建 wid={wid} url={url[:60]}")
    except Exception as exc:  # noqa: BLE001
        _dbg(f"阅读器窗口创建失败: {exc}")
        _ALL_WINS.pop(wid, None)
        try:
            user32.DestroyWindow(win.hwnd)
        except Exception:  # noqa: BLE001
            pass


def request_reader_window(url: str) -> dict:
    """HTTP 线程入口:把 URL 排队并投递到 UI 线程创建阅读器窗口。"""
    main = _ALL_WINS.get("main")
    if not main or not main.hwnd:
        return {"ok": False, "error": "主窗口未就绪"}
    _PENDING_READERS.append(url)
    user32.PostMessageW(main.hwnd, WM_APP_OPENREADER, len(_PENDING_READERS) - 1, 0)
    return {"ok": True}


def _window_ctl(action: str, win: str, edge: str = "") -> dict:
    """阅读器窗口控制(gui_server /api/window/* 带 win 参数时路由到这里)。"""
    w = _ALL_WINS.get(win)
    if not w or not w.hwnd:
        return {"ok": False, "error": "窗口不存在或已关闭"}
    h = w.hwnd
    if action == "drag":
        pt = POINT()
        user32.GetCursorPos(byref(pt))
        user32.PostMessageW(h, WM_APP_MOVERESIZE, HTCAPTION,
                            ((pt.y & 0xFFFF) << 16) | (pt.x & 0xFFFF))
        return {"ok": True}
    if action == "resize":
        ht = {"left": 10, "right": 11, "top": 12, "bottom": 15,
              "top-left": 13, "top-right": 14, "bottom-left": 16, "bottom-right": 17}.get(edge or "")
        if not ht:
            return {"ok": False, "error": "未知 edge"}
        pt = POINT()
        user32.GetCursorPos(byref(pt))
        user32.PostMessageW(h, WM_APP_MOVERESIZE, ht,
                            ((pt.y & 0xFFFF) << 16) | (pt.x & 0xFFFF))
        return {"ok": True}
    if action == "minimize":
        user32.ShowWindow(h, 6)   # SW_MINIMIZE
        return {"ok": True}
    if action == "maximize":
        user32.ShowWindow(h, 9 if user32.IsZoomed(h) else 3)
        return {"ok": True}
    if action == "close":
        user32.PostMessageW(h, WM_CLOSE, 0, 0)
        return {"ok": True}
    return {"ok": False, "error": f"未知 action: {action}"}


class Api:
    """前端可调用的桌面能力(替代 pywebview js_api,经 WebMessage 桥)。"""

    def __init__(self, win: MainWindow):
        self._win = win

    def open_dir(self, name: str = "") -> None:
        import os as _os
        from novel.config import get_out_dir as _god
        out_dir = _god()  # 与下载/书架识别同一目录(默认 downloads/novel)
        _os.makedirs(out_dir, exist_ok=True)
        target = _os.path.join(out_dir, _os.path.basename(name)) if name else out_dir
        if _os.name == "nt" and _os.path.isfile(target):
            subprocess.Popen(["explorer", "/select,", _os.path.normpath(target)])
        elif _os.name == "nt":
            _os.startfile(out_dir)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", target] if _os.path.isfile(target) else ["open", out_dir])
        else:
            subprocess.Popen(["xdg-open", out_dir])

    def notify(self, msg: str) -> None:
        try:
            user32.MessageBoxW(None, str(msg), "小说管家", 0x40)
        except Exception:  # noqa: BLE001
            pass

    def get_platform(self) -> str:
        return sys.platform

    def is_frameless(self) -> bool:
        return True

    def start_drag(self) -> None:
        """标题栏按下 → 投递自定义消息,由 UI 线程发起系统原生拖动循环
        (含 Aero Snap / 最大化后下拉还原)。WebView2 子窗口盖满客户区,主窗口
        收不到 WM_NCHITTEST,故走消息桥/HTTP → PostMessage → UI 线程
        ReleaseCapture + WM_NCLBUTTONDOWN(HTCAPTION) 交给系统拖动。"""
        h = self._win.hwnd
        if h:
            user32.PostMessageW(h, WM_APP_MOVERESIZE, HTCAPTION, 0)

    _HT_EDGE = {
        "left": HTLEFT, "right": HTRIGHT, "top": HTTOP,
        "bottom": HTBOTTOM, "top-left": HTTOPLEFT, "top-right": HTTOPRIGHT,
        "bottom-left": HTBOTTOMLEFT, "bottom-right": HTBOTTOMRIGHT,
    }

    def start_resize(self, edge: str = "") -> None:
        """窗口边缘按下 → 投递自定义消息,UI 线程发起系统原生缩放循环。"""
        ht = self._HT_EDGE.get(edge)
        h = self._win.hwnd
        if ht and h:
            user32.PostMessageW(h, WM_APP_MOVERESIZE, ht, 0)

    def win_minimize(self) -> None:
        user32.ShowWindow(self._win.hwnd, SW_MINIMIZE)

    def win_maximize_toggle(self) -> None:
        h = self._win.hwnd
        if user32.IsZoomed(h):
            user32.ShowWindow(h, SW_RESTORE)
        else:
            user32.ShowWindow(h, SW_MAXIMIZE)

    def win_close(self) -> None:
        user32.PostMessageW(self._win.hwnd, WM_CLOSE, 0, 0)


WNDPROC_T = WINFUNCTYPE(c_long, HWND, c_uint, c_void_p, c_void_p)


def _pump_until(done, timeout: float = 20.0) -> bool:
    """STA 线程等待异步回调:必须泵消息循环。"""
    t0 = time.time()
    while not done.is_set():
        if time.time() - t0 > timeout:
            return False
        m = wintypes.MSG()
        while user32.PeekMessageW(byref(m), None, 0, 0, 1):
            user32.TranslateMessage(byref(m))
            user32.DispatchMessageW(byref(m))
        time.sleep(0.005)
    return True


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    # 高分屏(125%/150%/200% 缩放)DPI 感知:避免整窗发虚 + 边缘缩放热区错位。
    # 必须在任何窗口创建前调用;WebView2 子窗口继承进程 DPI 上下文。
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:  # noqa: BLE001 Win7/旧系统无 shcore
        try:
            ctypes.windll.user32.SetProcessDPIAware()  # 系统级 DPI aware(兼容回退)
        except Exception:  # noqa: BLE001
            pass

    ap = argparse.ArgumentParser(description="小说管家 · 自制窗口")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--dev", action="store_true")
    args = ap.parse_args()

    if getattr(sys, "frozen", False):
        os.chdir(os.path.dirname(sys.executable))

    import gui_server
    from http.server import ThreadingHTTPServer

    port = args.port or find_free_port()
    try:
        from novel.config import load_settings as _ls2
        host = "0.0.0.0" if _ls2().get("lan_access") else "127.0.0.1"
    except Exception:  # noqa: BLE001
        host = "127.0.0.1"

    srv = ThreadingHTTPServer((host, port), gui_server.Handler)
    gui_server.start_remote_services(srv)  # WebRTC 端口注册 + 隧道自动启动
    srv.daemon_threads = True  # 关键:请求线程不阻止进程退出
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    if args.dev:
        print(f"[window2] 后端已启动: {url}")

    # COM 初始化:WebView2 需要 STA(COINIT_APARTMENTTHREADED)
    hr = ole32.CoInitializeEx(None, 0x2)
    if args.dev:
        print(f"[window2] CoInitializeEx(STA): 0x{hr & 0xFFFFFFFF:08X}")

    cache_dir = os.path.join(os.getcwd(), ".webview2-cache")
    win = MainWindow("小说管家", 1280, 820, url, cache_dir,
                     initial_rect=_validated_win_state())  # 恢复上次窗口尺寸/位置
    gui_server.set_main_hwnd(win.hwnd, cache_dir)  # 主窗口句柄 + 缓存目录(退出时识别子进程)
    # 多窗口钩子:阅读器窗口的创建(/api/window/open_reader)与控制(win 参数路由)
    gui_server.set_window_ctl_hook(_window_ctl)
    gui_server.set_open_reader_hook(request_reader_window)
    _dbg(f"主窗口 HWND 已注册: {win.hwnd}")

    try:
        win.run()  # 阻塞直到窗口关闭
    except Exception as exc:  # noqa: BLE001 桌面窗口启动失败 → 降级浏览器模式
        if args.dev:
            import traceback as _tb
            print(f"[window2] 窗口启动失败({exc}),降级浏览器模式", flush=True)
            _tb.print_exc()
        import webbrowser
        webbrowser.open(url)
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        return

    # 窗口已关闭:快速退出。
    # 实测(PyInstaller 打包版):srv.shutdown()/CoUninitialize() 会挂起导致进程不退出
    # (dev 模式正常,打包版环境 COM/线程状态不同)。故跳过阻塞清理,
    # 用 TerminateProcess 直接终止(os._exit 在 onefile 下可能被 bootloader 卡住)。
    # 注:原"WebView2 子进程自动清理"结论有误——实测强杀后 browser/crashpad
    # 子进程会成为孤儿残留,故退出前按 user-data-dir 主动清理本实例子进程;
    # daemon 后端线程随进程终止。
    _dbg("退出: 窗口已关闭,清理 WebView2 子进程后快速退出")
    try:
        srv.server_close()  # 仅关监听 socket,不阻塞
    except Exception:  # noqa: BLE001
        pass
    # 复用 gui_server 统一强杀入口(内含 WebView2 子进程清理,CREATE_NO_WINDOW 不弹终端)
    gui_server._force_exit()


if __name__ == "__main__":
    main()

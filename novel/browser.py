# -*- coding: utf-8 -*-
"""无头/有头浏览器渲染与验证(Playwright)。

用途:
  1. JS 渲染站(目录/正文由前端脚本加载)的正文兜底抓取
  2. 验证中心:有头浏览器打开被 403/Cloudflare 拦截的页面,用户手动完成验证,
     保存 cookies 供请求层自动携带
  3. 缺 Playwright 时的能力体检 + 免依赖兜底(系统浏览器打开 + 粘贴 cookies)

Playwright 缺失时的行为:不再抛裸的 ModuleNotFoundError,而是给出可执行指引,
并让上层降级到「系统浏览器打开 + 粘贴 Cookie」的手动流程(见 gui_server
/api/verify_cookie)。exe 打包已内置 playwright(见 NovelCrawler.spec)。
"""
from __future__ import annotations

import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import zipfile

logger = logging.getLogger("novel.browser")

_lock = threading.Lock()
_render_lock = threading.Lock()  # 串行化渲染:sync Playwright 并发 new_page 会崩溃
_playwright = None
_browser = None

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

# 浏览器内核优先顺序:先复用系统装好的 Edge/Chrome,避免额外下载内核
_CHANNELS = (("msedge", "系统 Edge"), ("chrome", "系统 Chrome"), (None, "Playwright 内置 Chromium"))


def _dir_writable(path: str) -> bool:
    """目录可写性探测(只以"能创建文件"为准)。"""
    if not path or not os.path.isdir(path):
        return False
    probe = os.path.join(path, f".pw_probe_{os.getpid()}")
    try:
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        return True
    except OSError:
        return False
    finally:
        try:
            os.remove(probe)
        except OSError:
            pass


def ensure_temp_env() -> str:
    """确保 TEMP/TMP 指向**可写**目录,否则 Playwright 起不来。

    Playwright 的 node 驱动会在 TEMP 下建 playwright-artifacts-XXXX 之类的工作目录;
    该目录不可写(受限令牌、Temp 被清理/改权限、企业策略)时,启动浏览器会直接
    报 `EPERM: mkdtemp ...playwright-artifacts-XXXXXX`,表现就是"验证按钮没反应/
    报错"。这里探测一次,不行就改用数据目录下的 tmp(必然可写)。
    返回最终使用的 TEMP 路径。
    """
    cur = (os.environ.get("TEMP") or os.environ.get("TMP") or "").strip()
    if _dir_writable(cur):
        return cur
    cands = [os.path.join(_data_root(), "tmp", "playwright")]
    if getattr(sys, "frozen", False):
        cands.append(os.path.join(os.path.dirname(sys.executable), "tmp", "playwright"))
    cands.append(os.path.join(tempfile.gettempdir(), "playwright"))
    for c in cands:
        try:
            os.makedirs(c, exist_ok=True)
        except OSError:
            continue
        if _dir_writable(c):
            os.environ["TEMP"] = os.environ["TMP"] = c
            logger.info("系统 TEMP 不可写,Playwright 工作目录改用: %s", c)
            return c
    return cur  # 都不行:保留原值,让后续报错如实暴露


def _data_root() -> str:
    try:
        from .paths import APP_DATA_DIR
        return APP_DATA_DIR
    except Exception:  # noqa: BLE001
        return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 系统浏览器常见安装路径(能力体检用,不启动进程)
_BROWSER_PATHS = {
    "msedge": (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ),
    "chrome": (
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
    ),
}


def _meipass() -> str:
    return getattr(sys, "_MEIPASS", "") or ""


def ensure_driver() -> str:
    """确保 Playwright 的 node 驱动可用;返回 node.exe 路径(找不到返回 "")。

    打包版把 node.exe 压成 playwright_node.zip 内嵌在 exe 里(见 NovelCrawler.spec),
    首次需要时解压到数据目录并设置 PLAYWRIGHT_NODEJS_PATH;之后每次直接复用
    (不做"每次启动都解压 94MB"的蠢事)。源码运行/系统 node 都能兜住。
    """
    env_path = (os.environ.get("PLAYWRIGHT_NODEJS_PATH") or "").strip()
    if env_path and os.path.isfile(env_path):
        return env_path
    # 1) 常规位置(exe 内解压目录 / 源码环境 site-packages)
    try:
        import playwright as _pw
        cand = os.path.join(os.path.dirname(_pw.__file__), "driver", "node.exe")
        if os.path.isfile(cand):
            return cand
    except Exception:  # noqa: BLE001
        pass
    # 2) 数据目录里已解压过的(或用户手动放置的)
    target_dir = os.path.join(_data_root(), "playwright_driver")
    target = os.path.join(target_dir, "node.exe")
    if os.path.isfile(target):
        os.environ["PLAYWRIGHT_NODEJS_PATH"] = target
        return target
    # 3) exe 目录旁的用户自带 node.exe(便携/自备驱动)
    if getattr(sys, "frozen", False):
        ext = os.path.join(os.path.dirname(sys.executable), "playwright_driver", "node.exe")
        if os.path.isfile(ext):
            os.environ["PLAYWRIGHT_NODEJS_PATH"] = ext
            return ext
    # 4) 解压内嵌 zip(仅第一次)
    zp = os.path.join(_meipass(), "playwright_node.zip")
    if os.path.isfile(zp):
        try:
            os.makedirs(target_dir, exist_ok=True)
            tmp = target + ".part"
            with zipfile.ZipFile(zp) as z:
                with z.open("node.exe") as src, open(tmp, "wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
            os.replace(tmp, target)
            logger.info("已解压内置 Playwright node 驱动: %s", target)
            os.environ["PLAYWRIGHT_NODEJS_PATH"] = target
            return target
        except Exception as exc:  # noqa: BLE001
            logger.warning("解压内置 node 驱动失败: %s", exc)
    # 5) 系统 Node.js 兜底(package/cli.js 需要 node 运行)
    node = shutil.which("node") or shutil.which("node.exe")
    if node:
        logger.info("使用系统 Node.js 运行 Playwright 驱动: %s", node)
        os.environ["PLAYWRIGHT_NODEJS_PATH"] = node
        return node
    return ""


def driver_available() -> tuple[bool, str]:
    """**不触发解压**地判断 node 驱动是否可得(能力体检用)。返回 (是否可用, 来源)。"""
    env_path = (os.environ.get("PLAYWRIGHT_NODEJS_PATH") or "").strip()
    if env_path and os.path.isfile(env_path):
        return True, "环境变量指定"
    try:
        import playwright as _pw
        if os.path.isfile(os.path.join(os.path.dirname(_pw.__file__), "driver", "node.exe")):
            return True, "程序内置"
    except Exception:  # noqa: BLE001
        pass
    if os.path.isfile(os.path.join(_data_root(), "playwright_driver", "node.exe")):
        return True, "已解压缓存"
    if getattr(sys, "frozen", False) and os.path.isfile(
            os.path.join(os.path.dirname(sys.executable), "playwright_driver", "node.exe")):
        return True, "用户自备"
    if os.path.isfile(os.path.join(_meipass(), "playwright_node.zip")):
        return True, "内置压缩包(首次使用自动解压)"
    node = shutil.which("node") or shutil.which("node.exe")
    if node:
        return True, "系统 Node.js"
    return False, ""


def _import_playwright():
    """导入 sync_playwright;失败时抛出带指引的 RuntimeError。"""
    try:
        from playwright.sync_api import sync_playwright
        return sync_playwright
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "自动验证需要 Playwright(浏览器自动化):当前环境未安装或加载失败"
            f"({type(exc).__name__}: {exc})。\n"
            "解决方式:① 用内置的「手动粘贴 Cookie」验证方式(免依赖,推荐);"
            "或 ② 执行 pip install playwright 后重试。") from exc


def capability() -> dict:
    """体检自动验证能力(不启动浏览器,秒回):供前端决定走自动还是手动流程。"""
    info: dict = {"playwright": False, "version": "", "error": "",
                  "channels": [], "installed_browsers": []}
    try:
        import importlib.metadata as _md
        info["version"] = _md.version("playwright")
    except Exception:  # noqa: BLE001
        pass
    try:
        import playwright  # noqa: F401
        info["playwright"] = True
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"未安装 playwright({type(exc).__name__})"
        # 仍然报告系统浏览器情况:手动流程要用系统浏览器打开验证页
        for name, paths in _BROWSER_PATHS.items():
            if any(os.path.isfile(p) for p in paths if p):
                info["channels"].append(name)
        return info
    for name, paths in _BROWSER_PATHS.items():
        if any(os.path.isfile(p) for p in paths if p):
            info["channels"].append(name)
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "ms-playwright")
    try:
        if os.path.isdir(root):
            info["installed_browsers"] = sorted(
                d for d in os.listdir(root) if not d.startswith("."))
    except OSError:
        pass
    if not info["channels"] and not info["installed_browsers"]:
        info["error"] = "未找到系统 Edge/Chrome,也未安装 Playwright 内核"
    ok_drv, src_drv = driver_available()
    info["driver"], info["driver_src"] = ok_drv, src_drv
    if not ok_drv:
        info["error"] = (info["error"] or "") + " 未找到 Playwright 的 node 驱动" \
            "(重装完整版 exe,或用「粘贴 Cookie」手动验证)"
    info["temp_writable"] = _dir_writable(
        (os.environ.get("TEMP") or os.environ.get("TMP") or "").strip())
    return info


def _launch(p, *, headless: bool, proxy: str | None = None):
    """按 系统 Edge → 系统 Chrome → 内置 Chromium 顺序启动,全部失败给出原因。"""
    kw: dict = {"headless": headless}
    if proxy:
        kw["proxy"] = {"server": proxy}
    errs: list[str] = []
    for channel, label in _CHANNELS:
        try:
            b = p.chromium.launch(channel=channel, **kw) if channel else p.chromium.launch(**kw)
            logger.info("已启动浏览器内核: %s", label)
            return b
        except Exception as exc:  # noqa: BLE001
            first = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
            errs.append(f"{label}: {first[:120]}")
    raise RuntimeError(
        "浏览器启动失败,无可用内核(需系统 Edge/Chrome,或执行 playwright install chromium):\n  "
        + "\n  ".join(errs))


def _get_browser(headless: bool = True):
    """惰性启动浏览器(复用系统 Edge/Chrome,带锁保证线程安全)。"""
    global _playwright, _browser
    sync_playwright = _import_playwright()
    ensure_driver()    # 保证 node 驱动就位(exe 内置 zip 首次解压)
    ensure_temp_env()  # TEMP 不可写会让 node 驱动起不来(EPERM mkdtemp)
    with _lock:
        if _browser is not None and _browser.is_connected():
            return _browser
        if _playwright is not None:
            try:
                _playwright.stop()
            except Exception:  # noqa: BLE001
                pass
        _playwright = sync_playwright().start()
        try:
            _browser = _launch(_playwright, headless=headless)
        except Exception:
            try:
                _playwright.stop()
            except Exception:  # noqa: BLE001
                pass
            _playwright = None
            raise
        return _browser


def render_html(url: str, headers: dict | None = None, wait_ms: int = 2000,
                timeout: int = 20, scroll: bool = False,
                scroll_max: int = 25) -> str:
    """打开页面,等待 JS 渲染后返回最终 HTML。

    scroll: True 时反复滚动到底部,触发懒加载(分卷目录页适用)。
    """
    browser = _get_browser()
    page = None
    with _render_lock:  # 串行渲染:sync 浏览器同一时刻只能有一个 page 在用
        try:
            page = browser.new_page(user_agent=UA)
            if headers:
                page.set_extra_http_headers(headers)
            page.goto(url, timeout=timeout * 1000, wait_until="domcontentloaded")
            if wait_ms > 0:
                page.wait_for_timeout(wait_ms)
            if scroll:
                page.evaluate("""
                    (async () => {
                        for (let i = 0; i < %d; i++) {
                            window.scrollTo(0, document.body.scrollHeight);
                            await new Promise(r => setTimeout(r, 300));
                        }
                    })();
                """ % scroll_max)
                page.wait_for_timeout(800)
            html = page.content()
            return html
        except Exception as exc:  # noqa: BLE001
            logger.warning("渲染 %s 失败: %s", url, exc)
            raise
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:  # noqa: BLE001
                    pass


# ---- 验证中心:可读性判定 ----

_CHALLENGE_MARKERS = (
    "just a moment", "cf-chl", "challenge-platform",
    "cf-browser-verification", "cf-bm", "验证码", "安全验证", "人机验证",
    "访问过于频繁", "访问频繁", "too many requests",
)


def detect_challenge(url: str, cookies=None, ua: str = "", proxy: str | None = None,
                     timeout: int = 15) -> tuple[bool, str]:
    """请求目标 URL 判断内容是否可读(非 Cloudflare 挑战页/限流页)。

    返回 (可读, 原因)。cookies 可为 requests cookiejar 或 [{name,value}] 列表。
    """
    import requests as _rq
    if cookies is not None and not hasattr(cookies, "get_dict"):
        try:
            cookies = _rq.utils.cookiejar_from_dict(
                {c["name"]: c["value"] for c in cookies if c.get("name")})
        except Exception:  # noqa: BLE001
            cookies = None
    try:
        r = _rq.get(url, headers={"User-Agent": ua or UA}, cookies=cookies,
                    timeout=timeout, allow_redirects=True,
                    proxies=({"http": proxy, "https": proxy} if proxy else None))
    except Exception as exc:  # noqa: BLE001
        return False, f"请求失败({type(exc).__name__})"
    if r.status_code in (401, 403):
        return False, f"仍被拦截(HTTP {r.status_code})"
    if r.status_code >= 400:
        return False, f"HTTP {r.status_code}"
    low = r.text[:4000].lower()
    for m in _CHALLENGE_MARKERS:
        if m in low:
            return False, f"页面仍是验证/限流页(命中特征 {m})"
    return True, ""


def probe_cookie_text(url: str, cookie_text: str, ua: str = "",
                      proxy: str | None = None) -> tuple[list[dict], str]:
    """校验用户粘贴的 Cookie 是否可用:解析 → 带 cookie 请求目标页 → 判定可读。

    返回 (cookies 列表, 失败原因);成功时原因为 ""。
    """
    from .verify import parse_cookie_text
    cookies, bad = parse_cookie_text(cookie_text)
    if not cookies:
        return [], bad or "没有解析到任何 cookie,请粘贴 name=value; name2=value2 形式的内容"
    ok, reason = detect_challenge(url, cookies, ua=ua or UA, proxy=proxy)
    if not ok:
        return [], f"Cookie 未能通过验证:{reason}(可能复制不完整或已过期)"
    return cookies, ""


def open_in_default_browser(url: str) -> bool:
    """用系统默认浏览器打开验证页(免依赖兜底流程第一步)。"""
    try:
        import webbrowser
        return bool(webbrowser.open(url, new=2))
    except Exception as exc:  # noqa: BLE001
        logger.warning("打开默认浏览器失败: %s", exc)
        return False


def solve_cloudflare(url: str, cookie_path: str | None = None,
                     timeout: int = 240, hint: str | None = None,
                     proxy: str | None = None) -> tuple[list[dict], str]:
    """有头浏览器打开**指定的验证页面**(触发 403 的 URL),等用户完成验证。

    验证成功的判定:用当前 cookies 实际请求该 URL,确认返回可读内容
    (HTTP 200 且不含 Cloudflare 挑战特征)才算通过——避免"打开首页标题
    不含 moment 就误判成功"的假阳性。

    proxy: 应用代理(验证浏览器与可读性探测共用同一出口 IP;
           cf_clearance 与 IP/UA 绑定,与抓取侧不一致会导致验证失效)。
    返回 (cookies 列表, 验证时 UA);未验证通过返回 ([], UA)。
    """
    import json as _json
    sync_playwright = _import_playwright()
    ensure_driver()    # 同上:node 驱动就位
    ensure_temp_env()  # 同上:验证用的浏览器同样需要可写 TEMP

    with sync_playwright() as p:
        browser = _launch(p, headless=False, proxy=proxy)
        try:
            ctx = browser.new_context(user_agent=UA)
            page = ctx.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
            except Exception:  # noqa: BLE001 挑战页可能中断导航,继续等待用户
                pass
            # 循环:每 2s 探测一次目标页可读性,通过才算验证成功
            deadline = time.time() + timeout
            passed = False
            while time.time() < deadline:
                ck = ctx.cookies()
                ok, _why = detect_challenge(url, ck, ua=UA, proxy=proxy)
                if ok:
                    passed = True
                    break
                time.sleep(2)
            if not passed:
                return [], UA
            cookies = ctx.cookies()
            if cookie_path:
                with open(cookie_path, "w", encoding="utf-8") as f:
                    _json.dump(cookies, f, ensure_ascii=False, indent=1)
            page.close()
            ctx.close()
            return cookies, UA
        finally:
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass
# -*- coding: utf-8 -*-
"""无头浏览器渲染(Playwright)。

用于 JS 渲染站(目录/正文由前端脚本加载的站点)。
优先复用系统 Chrome/Edge,避免下载浏览器内核。

用法(仅在需要渲染的书源上调用):
    html = render_html(url, headers=None, wait_ms=2000, timeout=20)
"""
from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger("novel.browser")

_lock = threading.Lock()
_render_lock = threading.Lock()  # 串行化渲染:sync Playwright 并发 new_page 会崩溃
_playwright = None
_browser = None


def _get_browser():
    """惰性启动浏览器(复用系统 Edge/Chrome,带锁保证线程安全)。"""
    global _playwright, _browser
    with _lock:
        if _browser is not None and _browser.is_connected():
            return _browser
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise RuntimeError("未安装 playwright: pip install playwright")
        if _playwright is not None:
            try:
                _playwright.stop()
            except Exception:  # noqa: BLE001
                pass
        _playwright = sync_playwright().start()
        # 优先复用系统浏览器,避免下载内核
        launch_kwargs = {"headless": True}
        for channel in ("msedge", "chrome"):
            try:
                _browser = _playwright.chromium.launch(channel=channel, **launch_kwargs)
                logger.info("已启动系统浏览器: %s", channel)
                return _browser
            except Exception:  # noqa: BLE001
                continue
        try:
            _browser = _playwright.chromium.launch(**launch_kwargs)
            logger.info("已启动 playwright chromium")
            return _browser
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"浏览器启动失败: {exc}\n如需内置内核: playwright install chromium") from exc
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
            page = browser.new_page(user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"))
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


def browser_available() -> bool:
    """检查浏览器引擎是否可用(不实际启动)。"""
    try:
        import playwright  # noqa: F401
        return True
    except ImportError:
        return False


_CF_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


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
    import requests as _rq
    from playwright.sync_api import sync_playwright

    _CHALLENGE_MARKERS = (
        "just a moment", "cf-chl", "challenge-platform",
        "cf-browser-verification", "cf-bm", "验证码", "安全验证", "人机验证",
    )

    def _probe_readable(cookies: list[dict]) -> bool:
        """带 cookies 请求目标 URL,判断是否真正可读(非挑战页)。"""
        try:
            cj = _rq.utils.cookiejar_from_dict(
                {c["name"]: c["value"] for c in cookies if c.get("name")})
            r = _rq.get(url, headers={"User-Agent": _CF_UA}, cookies=cj,
                        timeout=15, allow_redirects=True,
                        proxies=({"http": proxy, "https": proxy} if proxy else None))
            if r.status_code != 200:
                return False
            low = r.text[:4000].lower()
            return not any(m in low for m in _CHALLENGE_MARKERS)
        except Exception:  # noqa: BLE001 超时/网络异常:视为暂不可读,继续等待
            return False

    with sync_playwright() as p:
        launch_kwargs = {"channel": "msedge", "headless": False}
        if proxy:
            launch_kwargs["proxy"] = {"server": proxy}
        browser = p.chromium.launch(**launch_kwargs)
        try:
            ctx = browser.new_context(user_agent=_CF_UA)
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
                if _probe_readable(ck):
                    passed = True
                    break
                time.sleep(2)
            if not passed:
                return [], _CF_UA
            cookies = ctx.cookies()
            if cookie_path:
                import json
                with open(cookie_path, "w", encoding="utf-8") as f:
                    json.dump(cookies, f, ensure_ascii=False, indent=1)
            page.close()
            ctx.close()
            return cookies, _CF_UA
        finally:
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass

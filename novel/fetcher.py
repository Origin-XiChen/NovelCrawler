# -*- coding: utf-8 -*-
"""
防封禁 HTTP 请求模块
=====================
特性:
  * 随机 User-Agent 池,每次请求轮换
  * 每次请求之间的随机延迟(人性化间隔,min_delay~max_delay)
  * 按域名自适应限速(并发闸门 + 最小间隔 + 限流惩罚退避,见 novel/throttle.py)
  * 针对 429 / 5xx / 连接失败的指数退避重试(429 遵循 Retry-After)
  * 每个书源独立的"冷却时间"控制(某些站点搜索间隔 15 秒)
  * 可选代理支持(环境变量 NOVEL_PROXY 或参数传入)
  * 会话复用(自动处理 cookie)
  * 图片/二进制下载可校验内容类型(拒绝限流占位页,避免"下重复下漏页")
"""
from __future__ import annotations

import os
import random
import threading
import time
import logging

import requests

from . import throttle as _throttle

logger = logging.getLogger("novel.fetcher")

# 常见浏览器 UA 池
UA_POOL = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

TIMEOUT = 12  # 单次请求超时(秒)

# 自适应限速参数:文本页(含搜索/目录/正文)与图片分别一套
TEXT_INTERVAL = 0.20       # 同域两次文本请求最小间隔
TEXT_CONCURRENCY = 4       # 同域文本请求最大并发
IMG_INTERVAL = 0.15        # 同域两次图片请求最小间隔
IMG_CONCURRENCY = 4        # 同域图片请求最大并发

# 被视为"限流/拦截"的 HTTP 状态
_RATE_STATUS = (429, 503)


class BadContent(Exception):
    """服务端返回的不是期望的二进制内容(限流占位页/HTML 错误页/JSON 提示)。"""

    def __init__(self, msg: str, sample: bytes = b"") -> None:
        super().__init__(msg)
        self.sample = sample[:200]


def looks_like_image(data: bytes) -> bool:
    """按文件头判断是否为图片;显式识别 HTML/JSON/文本等错误页。"""
    if not data or len(data) < 12:
        return False
    head = data[:16]
    if head[:3] == b"\xff\xd8\xff":                      # JPEG
        return True
    if head[:8] == b"\x89PNG\r\n\x1a\n":                 # PNG
        return True
    if head[:6] in (b"GIF87a", b"GIF89a"):               # GIF
        return True
    if head[:2] == b"BM":                                # BMP
        return True
    if head[:4] == b"RIFF" and data[8:12] == b"WEBP":    # WEBP
        return True
    if head[:4] in (b"II*\x00", b"MM\x00*"):             # TIFF
        return True
    if data[4:8] == b"ftyp":                             # AVIF/HEIC/HEIF
        brand = data[8:12]
        if brand in (b"avif", b"avis", b"heic", b"heix", b"heif", b"mif1", b"msf1"):
            return True
    # 文本类错误页(限流提示/验证页/Cloudflare 挑战):明确拒绝
    low = data[:512].lstrip().lower()
    if low.startswith((b"<", b"{", b"[", b"<!doctype", b"<?xml")):
        return False
    if b"<html" in data[:2048].lower() or b"just a moment" in data[:2048].lower():
        return False
    # 未知头:交给 Pillow 判定(只看文件头,开销很小)
    try:
        import io as _io
        from PIL import Image
        with Image.open(_io.BytesIO(data)) as im:
            im.verify()
        return True
    except Exception:  # noqa: BLE001
        return False


class SourceCooldown:
    """每个书源独立的冷却控制,防止触发站点搜索间隔限制。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}  # 每源一把锁:同源串行、异源并行
        self._last_access: dict[str, float] = {}
        self._interval: dict[str, float] = {}

    def set_interval(self, source_name: str, seconds: float) -> None:
        self._interval[source_name] = seconds

    def wait(self, source_name: str) -> None:
        """在访问某源前调用;若距上次访问不足间隔,则休眠补齐。

        check-then-act 必须原子:多线程同时到冷却末尾会一起放行,
        导致站点收到的请求频率仍超限(旧实现为竞态,已加每源锁)。
        """
        with self._lock:
            slock = self._locks.setdefault(source_name, threading.Lock())
        with slock:
            interval = self._interval.get(source_name, 0.0)
            last = self._last_access.get(source_name, 0.0)
            elapsed = time.time() - last
            if elapsed < interval:
                wait = interval - elapsed
                logger.debug("[%s] 冷却中,等待 %.1f 秒", source_name, wait)
                time.sleep(wait)
            self._last_access[source_name] = time.time()


class Fetcher:
    """带防封禁策略的请求器。"""

    def __init__(
        self,
        min_delay: float = 1.0,
        max_delay: float = 3.5,
        max_retries: int = 3,
        proxy: str | None = None,
        verify: bool = True,
    ) -> None:
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.max_retries = max_retries
        self.proxy = proxy or os.environ.get("NOVEL_PROXY")
        self.verify = verify  # 部分小说站证书过期,置 False 才能访问
        self.cooldown = SourceCooldown()
        # 每线程独立 Session:requests.Session 非线程安全,全局共享会导致
        # cookie jar 并发读写竞态(丢 cookie/偶发异常);
        # 验证中心 cookies 在 401 重试里显式传入,不依赖共享 jar。
        self._session_local = threading.local()

    @property
    def session(self) -> requests.Session:
        s = getattr(self._session_local, "session", None)
        if s is None:
            s = requests.Session()
            s.headers.update({"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"})
            self._session_local.session = s
        return s

    # ------------------------------------------------------------------
    def _headers(self) -> dict:
        headers = {
            "User-Agent": random.choice(UA_POOL),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Referer": "https://www.bing.com/",
        }
        return headers

    def _proxies(self) -> dict | None:
        if self.proxy:
            return {"http": self.proxy, "https": self.proxy}
        return None

    def _jitter(self, cancel_check=None) -> None:
        """请求间人性化随机延迟(旧实现漏用 min_delay/max_delay,等于没限速)。"""
        lo, hi = float(self.min_delay or 0), float(self.max_delay or 0)
        if hi <= 0 and lo <= 0:
            return
        if hi < lo:
            lo, hi = hi, lo
        _throttle.sleep_cancellable(random.uniform(lo, hi), cancel_check)

    def _penalty_from(self, resp, url: str, group: str | None) -> None:
        """按响应判定限流并施加退避(429/503 + 200 文本占位页由调用方判断)。"""
        try:
            status = resp.status_code
        except Exception:  # noqa: BLE001
            return
        if status in _RATE_STATUS:
            ra = _throttle.retry_after_seconds(getattr(resp, "headers", {}) or {})
            _throttle.penalty(url, group=group, cooldown=5.0, retry_after=ra)
            logger.warning("命中限流 [%s] %s,已对该站退避(Retry-After=%s)", status, url, ra)

    def fetch(
        self,
        url: str,
        *,
        source: str = "",
        method: str = "GET",
        data: dict | None = None,
        encoding: str | None = None,
        verify: bool | None = None,
        headers: dict | None = None,
        group: str | None = None,
        cancel_check=None,
    ) -> str:
        """
        发起请求并返回解码后的 HTML/JSON 文本。
        带重试 + 退避 + 源冷却 + 按域名自适应限速。失败时抛出 requests.RequestException。
        verify: None=用实例默认;False=忽略证书错误(站点证书过期时)
        headers: 额外请求头(书源自定义,如 Referer/Origin)
        group:   限速分组(默认按 URL 主机名;同一服务的多域名可显式归组)
        cancel_check: 可取消回调(抛异常即中断等待)
        """
        if source:
            self.cooldown.wait(source)
        use_verify = self.verify if verify is None else verify
        tkey = group or None

        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                extra = {**self._headers(), **(headers or {})}
                if source:
                    self._jitter(cancel_check)
                with _throttle.acquire(url, group=tkey, interval=TEXT_INTERVAL,
                                       concurrency=TEXT_CONCURRENCY,
                                       cancel_check=cancel_check):
                    if method.upper() == "POST":
                        resp = self.session.post(
                            url, data=data, headers=extra, proxies=self._proxies(),
                            timeout=TIMEOUT, verify=use_verify,
                        )
                    else:
                        resp = self.session.get(
                            url, headers=extra, proxies=self._proxies(),
                            timeout=TIMEOUT, verify=use_verify,
                        )
                self._penalty_from(resp, url, tkey)
                resp.raise_for_status()
                _throttle.reward(url, group=tkey)
                # 探测响应编码:优先服务器声明,否则用指定编码,再兜底 ISO-8859-1
                if resp.encoding and resp.encoding.lower() not in ("iso-8859-1", "ascii"):
                    pass  # 保留 requests 自动探测的编码
                elif encoding:
                    resp.encoding = encoding
                else:
                    resp.encoding = resp.apparent_encoding
                return resp.text

            except requests.RequestException as exc:
                last_exc = exc
                status = getattr(exc.response, "status_code", None)
                # 401/403:尝试验证中心 cookies(手动验证过 Cloudflare 等服务)
                if status in (401, 403) and attempt == 1:
                    from .verify import get_cookies
                    ret = get_cookies(url)
                    if ret is not None:
                        ck, vua = ret  # 必须用验证时的 UA:cf_clearance 与 UA/IP 绑定
                        try:
                            headers_c = {**extra, "User-Agent": vua}
                            with _throttle.acquire(url, group=tkey, cancel_check=cancel_check):
                                if method.upper() == "POST":
                                    resp2 = self.session.post(
                                        url, data=data, headers=headers_c, cookies=ck,
                                        proxies=self._proxies(), timeout=TIMEOUT, verify=use_verify)
                                else:
                                    resp2 = self.session.get(
                                        url, headers=headers_c, cookies=ck,
                                        proxies=self._proxies(), timeout=TIMEOUT, verify=use_verify)
                            resp2.raise_for_status()
                            _throttle.reward(url, group=tkey)
                            if resp2.encoding and resp2.encoding.lower() not in ("iso-8859-1", "ascii"):
                                pass  # 保留 requests 自动探测的编码
                            elif encoding:
                                resp2.encoding = encoding
                            else:
                                resp2.encoding = resp2.apparent_encoding
                            return resp2.text
                        except requests.RequestException:
                            # 带验证 cookies 仍失败:记录已失效,清除并重新登记待验证
                            from .verify import remove as vremove
                            vremove(url)
                    # 无有效 cookie → 自动登记到验证中心(供用户手动验证)
                    from .verify import add_pending
                    add_pending(url, name=source)
                # 429/403/5xx 或网络错误 → 退避重试
                if attempt < self.max_retries:
                    # 连接类错误(对端重置/拒连)重试意义不大,用短退避快速跳过;
                    # 超时/HTTP 错误用指数退避。
                    if isinstance(exc, requests.exceptions.ConnectionError):
                        backoff = 0.5 + random.uniform(0, 0.8)
                    else:
                        backoff = 2 ** (attempt - 1) + random.uniform(0, 1.5)
                    logger.warning(
                        "请求失败 [%s] %s (第%d次, %s),%.1fs 后重试",
                        status, url, attempt, exc.__class__.__name__, backoff,
                    )
                    _throttle.sleep_cancellable(backoff, cancel_check)
                else:
                    logger.error("请求最终失败 [%s] %s: %s", status, url, exc)
                    raise
        raise RuntimeError(f"unreachable: {url}") from last_exc

    def fetch_bytes(
        self,
        url: str,
        *,
        source: str = "",
        headers: dict | None = None,
        timeout: int = 30,
        verify: bool | None = None,
        group: str | None = None,
        cancel_check=None,
        expect_image: bool = False,
        min_size: int = 1000,
    ) -> bytes:
        """下载二进制内容(图片/文件),复用防封全链路。

        与 fetch() 相同策略:UA 池轮换、随机延迟、按域名自适应限速、指数退避重试、
        源冷却、代理、401/403 自动带验证中心 cookies 重试。返回 resp.content。

        expect_image=True 时校验内容确实是图片(文件头判定):限流返回的
        HTML/JSON 占位页会被判定为失败并重试,避免把错误页当漫画页塞进 PDF
        (这是"下重复、下漏页"的主要来源之一)。
        min_size: 小于该字节数视为无效(防盗链占位图)。
        """
        if source:
            self.cooldown.wait(source)
        use_verify = self.verify if verify is None else verify
        tkey = group or None
        interval = IMG_INTERVAL if expect_image else TEXT_INTERVAL
        concurrency = IMG_CONCURRENCY if expect_image else TEXT_CONCURRENCY

        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                extra = {**self._headers(), **(headers or {})}
                if source:
                    self._jitter(cancel_check)
                with _throttle.acquire(url, group=tkey, interval=interval,
                                       concurrency=concurrency,
                                       cancel_check=cancel_check):
                    resp = self.session.get(
                        url, headers=extra, proxies=self._proxies(),
                        timeout=timeout, verify=use_verify,
                    )
                self._penalty_from(resp, url, tkey)
                resp.raise_for_status()
                content = resp.content
                if expect_image:
                    if not looks_like_image(content):
                        ctype = (resp.headers.get("Content-Type") or "")[:60]
                        _throttle.penalty(url, group=tkey, cooldown=2.0)
                        raise BadContent(
                            f"非图片内容(Content-Type={ctype or '?'}, {len(content)}B,"
                            "疑似限流/错误页)", content)
                    if len(content) < min_size:
                        raise BadContent(
                            f"内容过小({len(content)}B,疑似防盗链占位图)", content)
                _throttle.reward(url, group=tkey)
                return content
            except BadContent as exc:
                last_exc = exc
                if attempt < self.max_retries:
                    backoff = 1.0 * attempt + random.uniform(0, 1.0)
                    logger.warning("内容校验失败 %s (第%d次): %s,%.1fs 后重试",
                                   url, attempt, exc, backoff)
                    _throttle.sleep_cancellable(backoff, cancel_check)
                else:
                    logger.error("内容校验最终失败 %s: %s", url, exc)
                    raise
            except requests.RequestException as exc:
                last_exc = exc
                status = getattr(exc.response, "status_code", None)
                if status in (401, 403) and attempt == 1:
                    from .verify import get_cookies
                    ret = get_cookies(url)
                    if ret is not None:
                        ck, vua = ret  # 验证时 UA 与 cf_clearance 绑定,不可用随机 UA
                        try:
                            with _throttle.acquire(url, group=tkey, cancel_check=cancel_check):
                                resp2 = self.session.get(
                                    url, headers={**extra, "User-Agent": vua}, cookies=ck,
                                    proxies=self._proxies(), timeout=timeout, verify=use_verify)
                            resp2.raise_for_status()
                            _throttle.reward(url, group=tkey)
                            content2 = resp2.content
                            if expect_image and not looks_like_image(content2):
                                _throttle.penalty(url, group=tkey, cooldown=2.0)
                                last_exc = BadContent(
                                    f"非图片内容({len(content2)}B,疑似限流/错误页)", content2)
                                continue
                            if expect_image and len(content2) < min_size:
                                last_exc = BadContent(
                                    f"内容过小({len(content2)}B,疑似占位图)", content2)
                                continue  # 交由下一轮重试
                            return content2
                        except requests.RequestException:
                            # 带验证 cookies 仍失败:记录已失效,清除并重新登记待验证
                            from .verify import remove as vremove
                            vremove(url)
                    from .verify import add_pending
                    add_pending(url, name=source)
                if attempt < self.max_retries:
                    if isinstance(exc, requests.exceptions.ConnectionError):
                        backoff = 0.5 + random.uniform(0, 0.8)
                    else:
                        backoff = 2 ** (attempt - 1) + random.uniform(0, 1.5)
                    logger.warning(
                        "字节请求失败 [%s] %s (第%d次, %s),%.1fs 后重试",
                        status, url, attempt, exc.__class__.__name__, backoff,
                    )
                    _throttle.sleep_cancellable(backoff, cancel_check)
                else:
                    logger.error("字节请求最终失败 [%s] %s: %s", status, url, exc)
                    raise
        raise RuntimeError(f"unreachable: {url}") from last_exc

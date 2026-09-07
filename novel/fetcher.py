# -*- coding: utf-8 -*-
"""
防封禁 HTTP 请求模块
=====================
特性:
  * 随机 User-Agent 池,每次请求轮换
  * 每次请求之间的随机延迟(人性化间隔)
  * 针对 429 / 5xx / 连接失败的指数退避重试
  * 每个书源独立的"冷却时间"控制(某些站点搜索间隔 15 秒)
  * 可选代理支持(环境变量 NOVEL_PROXY 或参数传入)
  * 会话复用(自动处理 cookie)
"""
from __future__ import annotations

import os
import random
import threading
import time
import logging

import requests

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

    def _sleep(self) -> None:
        """请求之间的随机间隔,模拟人类阅读节奏。"""
        time.sleep(random.uniform(self.min_delay, self.max_delay))

    # ------------------------------------------------------------------
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
    ) -> str:
        """
        发起请求并返回解码后的 HTML/JSON 文本。
        带重试 + 退避 + 源冷却。失败时抛出 requests.RequestException。
        verify: None=用实例默认;False=忽略证书错误(站点证书过期时)
        headers: 额外请求头(书源自定义,如 Referer/Origin)
        """
        if source:
            self.cooldown.wait(source)
        use_verify = self.verify if verify is None else verify

        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                extra = {**self._headers(), **(headers or {})}
                if method.upper() == "POST":
                    resp = self.session.post(
                        url,
                        data=data,
                        headers=extra,
                        proxies=self._proxies(),
                        timeout=TIMEOUT,
                        verify=use_verify,
                    )
                else:
                    resp = self.session.get(
                        url,
                        headers=extra,
                        proxies=self._proxies(),
                        timeout=TIMEOUT,
                        verify=use_verify,
                    )
                resp.raise_for_status()
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
                            if method.upper() == "POST":
                                resp2 = self.session.post(
                                    url, data=data, headers=headers_c, cookies=ck,
                                    proxies=self._proxies(), timeout=TIMEOUT, verify=use_verify)
                            else:
                                resp2 = self.session.get(
                                    url, headers=headers_c, cookies=ck,
                                    proxies=self._proxies(), timeout=TIMEOUT, verify=use_verify)
                            resp2.raise_for_status()
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
                    time.sleep(backoff)
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
    ) -> bytes:
        """下载二进制内容(图片/文件),复用防封全链路。

        与 fetch() 相同策略:UA 池轮换、随机延迟、指数退避重试、源冷却、
        代理、401/403 自动带验证中心 cookies 重试。返回 resp.content。
        """
        if source:
            self.cooldown.wait(source)
        use_verify = self.verify if verify is None else verify

        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            try:
                extra = {**self._headers(), **(headers or {})}
                resp = self.session.get(
                    url, headers=extra, proxies=self._proxies(),
                    timeout=timeout, verify=use_verify,
                )
                resp.raise_for_status()
                return resp.content
            except requests.RequestException as exc:
                last_exc = exc
                status = getattr(exc.response, "status_code", None)
                if status in (401, 403) and attempt == 1:
                    from .verify import get_cookies
                    ret = get_cookies(url)
                    if ret is not None:
                        ck, vua = ret  # 验证时 UA 与 cf_clearance 绑定,不可用随机 UA
                        try:
                            resp2 = self.session.get(
                                url, headers={**extra, "User-Agent": vua}, cookies=ck,
                                proxies=self._proxies(), timeout=timeout, verify=use_verify)
                            resp2.raise_for_status()
                            return resp2.content
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
                    time.sleep(backoff)
                else:
                    logger.error("字节请求最终失败 [%s] %s: %s", status, url, exc)
                    raise
        raise RuntimeError(f"unreachable: {url}") from last_exc

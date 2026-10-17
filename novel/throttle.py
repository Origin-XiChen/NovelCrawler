# -*- coding: utf-8 -*-
"""按域名自适应限速:并发闸门 + 最小间隔 + 服务端限流惩罚退避。

解决的问题:漫画/小说下载链路此前对同一站点(CDN)全速并发猛打,
站点限流(如拷贝漫画 210 访问过频、Cloudflare 429)后返回错误页/占位图,
表现为"下重复、下漏页"。旧 `Fetcher.min_delay/max_delay` 是死参数从未生效。

策略(对每个 key 独立,key 默认取 URL 主机名,调用方可显式指定 group
把同一服务的不同域名归到一桶,例如拷贝漫画 API + 图片 CDN):
  * 并发闸门:同一 key 同时在途请求数不超过 `concurrency`(默认 4)
  * 最小间隔:同一 key 两次请求之间至少间隔 `interval`(默认 0.2s)
  * 全局限流:全局在途上限 `GLOBAL_LIMIT`,避免多任务叠加把出口打满
  * 惩罚退避:命中 429/503/210 等限流信号后,间隔倍增(最多 8 倍)
    并对该 key 施加冷却(优先采用服务端 Retry-After / 提示秒数)
  * 成功衰减:每次成功把倍增系数向 1.0 缓慢回收,流量自动恢复

sleep 均为分片(默认 0.1s)并在每片检查 cancel_check,用户点"停止"
时不会卡在几十秒的冷却里。

对外 API::

    slot = acquire(url_or_key, group=None, concurrency=None, interval=None,
                   cancel_check=None)
    with slot:                     # 进入时占并发位 + 等满最小间隔
        resp = requests.get(...)
        if rate_limited(resp):
            penalty(url_or_key, retry_after=..., group=...)
        else:
            reward(url_or_key, group=...)

    stats()                        # 各 key 当前间隔/在途/冷却,供排障展示
"""
from __future__ import annotations

import threading
import time
from urllib.parse import urlparse

# 默认参数(可按 key 覆盖)
DEFAULT_INTERVAL = 0.20      # 同一 key 两次请求最小间隔(秒)
DEFAULT_CONCURRENCY = 4      # 同一 key 最大在途请求数
GLOBAL_LIMIT = 16            # 全局最大在途请求数
MAX_MULTIPLIER = 8.0         # 惩罚后间隔最多放大 8 倍
MAX_COOLDOWN = 90.0          # 单次冷却上限(秒),防止服务端给出天文数字
SLEEP_SLICE = 0.1            # 分片 sleep 粒度(取消响应速度)


class ThrottleCancelled(Exception):
    """限速等待期间被取消(调用方传入的 cancel_check 抛出别的异常时不会走到这里)。"""


def host_key(url_or_key: str) -> str:
    """URL → 限速 key(主机名);非 URL(已是指定 key)原样返回。"""
    s = (url_or_key or "").strip()
    if not s:
        return "unknown"
    if "://" in s:
        net = urlparse(s).netloc.lower()
        return net or "unknown"
    return s.lower()


class _Bucket:
    __slots__ = ("cond", "inflight", "limit", "interval", "last", "mult",
                 "not_before", "hits")

    def __init__(self, interval: float, limit: int) -> None:
        self.cond = threading.Condition()
        self.inflight = 0
        self.limit = max(1, int(limit))
        self.interval = max(0.0, float(interval))
        self.last = 0.0
        self.mult = 1.0
        self.not_before = 0.0
        self.hits = 0            # 命中限流次数(排障用)


_registry: dict[str, _Bucket] = {}
_reg_lock = threading.Lock()
_global_cond = threading.Condition()
_global_inflight = 0


def _bucket(key: str, interval: float | None = None,
            concurrency: int | None = None) -> _Bucket:
    with _reg_lock:
        b = _registry.get(key)
        if b is None:
            b = _Bucket(
                DEFAULT_INTERVAL if interval is None else interval,
                DEFAULT_CONCURRENCY if concurrency is None else concurrency,
            )
            _registry[key] = b
        else:
            # 显式传入即按调用方要求设定(各子系统对同一 key 的参数保持一致,
            # 因此后写覆盖不会产生抖动;未传则保留已有值)
            if interval is not None:
                b.interval = max(0.0, float(interval))
            if concurrency is not None:
                b.limit = max(1, int(concurrency))
        return b


def sleep_cancellable(seconds: float, cancel_check=None) -> None:
    """分片 sleep;每片检查取消回调(回调通常直接抛 DownloadCancelled)。"""
    if seconds <= 0:
        if cancel_check:
            cancel_check()
        return
    end = time.time() + seconds
    while True:
        if cancel_check:
            cancel_check()
        remain = end - time.time()
        if remain <= 0:
            return
        time.sleep(min(SLEEP_SLICE, remain))


class _Slot:
    """一次请求的限速位:with 语句进入时占并发 + 等间隔,退出时释放。"""

    __slots__ = ("key", "interval_arg", "concurrency_arg", "cancel_check",
                 "b", "g_held", "b_held")

    def __init__(self, key: str, interval: float | None, concurrency: int | None,
                 cancel_check=None) -> None:
        self.key = key
        self.interval_arg = interval
        self.concurrency_arg = concurrency
        self.cancel_check = cancel_check
        self.b: _Bucket | None = None
        self.g_held = False
        self.b_held = False

    def __enter__(self) -> "_Slot":
        global _global_inflight
        b = _bucket(self.key, self.interval_arg, self.concurrency_arg)
        self.b = b
        try:
            # 1) 全局闸门
            with _global_cond:
                while _global_inflight >= GLOBAL_LIMIT:
                    if self.cancel_check:
                        self.cancel_check()
                    _global_cond.wait(0.2)
                _global_inflight += 1
                self.g_held = True
            # 2) 本 key 并发闸门
            with b.cond:
                while b.inflight >= b.limit:
                    if self.cancel_check:
                        self.cancel_check()
                    b.cond.wait(0.2)
                b.inflight += 1
                self.b_held = True
                b.cond.notify_all()
            # 3) 冷却 + 最小间隔(分片等待,期间可取消)
            with b.cond:
                now = time.time()
                wait = max(b.not_before - now, 0.0)
                if wait <= 0:
                    wait = max(b.interval * b.mult - (now - b.last), 0.0)
            sleep_cancellable(wait, self.cancel_check)
        except BaseException:
            self._release()
            raise
        b.last = time.time()
        return self

    def _release(self) -> None:
        global _global_inflight
        b = self.b
        if self.b_held and b is not None:
            with b.cond:
                b.inflight = max(0, b.inflight - 1)
                b.cond.notify_all()
            self.b_held = False
        if self.g_held:
            with _global_cond:
                _global_inflight = max(0, _global_inflight - 1)
                _global_cond.notify_all()
            self.g_held = False

    def __exit__(self, *exc) -> None:
        self._release()


def acquire(url_or_key: str, *, group: str | None = None,
            concurrency: int | None = None, interval: float | None = None,
            cancel_check=None) -> _Slot:
    """取得一次请求的限速位(建议配合 with 使用)。"""
    key = group or host_key(url_or_key)
    return _Slot(key, interval, concurrency, cancel_check)


def penalty(url_or_key: str, *, group: str | None = None,
            cooldown: float = 0.0, retry_after: float | None = None,
            factor: float = 2.0) -> None:
    """命中服务端限流(429/503/210/文本占位页)时调用:加倍间隔 + 冷却该 key。"""
    key = group or host_key(url_or_key)
    b = _bucket(key)
    with b.cond:
        b.hits += 1
        b.mult = min(MAX_MULTIPLIER, max(1.0, b.mult) * max(1.0, float(factor)))
        cd = float(retry_after) if retry_after else float(cooldown)
        if cd > 0:
            b.not_before = max(b.not_before, time.time() + min(cd, MAX_COOLDOWN))
        b.cond.notify_all()


def reward(url_or_key: str, *, group: str | None = None) -> None:
    """请求成功:倍增系数向 1.0 缓慢回收(每次 -15%)。"""
    key = group or host_key(url_or_key)
    b = _registry.get(key)
    if b is None:
        return
    with b.cond:
        if b.mult > 1.0:
            b.mult = max(1.0, b.mult * 0.85)


def retry_after_seconds(headers) -> float | None:
    """解析 Retry-After 头(秒数;HTTP 日期格式按 30s 兜底)。"""
    try:
        raw = (headers or {}).get("Retry-After")
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        return None
    raw = str(raw).strip()
    if raw.isdigit():
        return float(raw)
    try:
        import email.utils
        dt = email.utils.parsedate_to_datetime(raw)
        delta = dt.timestamp() - time.time()
        return max(0.0, delta)
    except Exception:  # noqa: BLE001
        return 30.0


def stats() -> dict:
    """当前各 key 的限速状态(排障/自测用)。"""
    out = {}
    with _reg_lock:
        items = list(_registry.items())
    now = time.time()
    for k, b in items:
        with b.cond:
            out[k] = {
                "interval": round(b.interval * b.mult, 3),
                "base_interval": round(b.interval, 3),
                "multiplier": round(b.mult, 2),
                "inflight": b.inflight,
                "limit": b.limit,
                "cooldown_left": round(max(0.0, b.not_before - now), 2),
                "rate_limited": b.hits,
            }
    out["__global__"] = {"inflight": _global_inflight, "limit": GLOBAL_LIMIT}
    return out


def reset() -> None:
    """清空限速状态(测试用)。"""
    global _global_inflight
    with _reg_lock:
        _registry.clear()
    with _global_cond:
        _global_inflight = 0
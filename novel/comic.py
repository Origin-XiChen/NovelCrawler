# -*- coding: utf-8 -*-
"""
漫画抓取与 PDF 打包
====================
与书源同构的"源适配器"架构:每个漫画源一个 adapter(搜索/目录/图片列表),
图片并发下载后由 img2pdf 打包为 PDF。

已接入源:
  - MangaDex  : 国际公开 REST API,多语言翻译,无需签名
  - 拷贝漫画   : 中文源,HMAC 签名(secret+timestamp),deviceinfo/pseudoid 随机,
                 章节按 words 排序 + c1500x 高清替换;参考皮皮喵/VeneraX 生态规则

用法:
    search(kw, source)          -> [{id, title, cover, lang, desc}]
    chapters(manga_id, source)  -> [{id, volume, chapter, title, lang}]
    pages(ep_id, source, comic_id) -> [图片完整 URL]
    download_comic(...)         -> 每话打包一个 PDF(断点续传),返回文件列表
"""
from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import io
import json
import logging
import os
import random
import re
import shutil
import string
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from . import throttle as _throttle
from .downloader import DownloadCancelled
from .throttle import host_key as _host_key

logger = logging.getLogger("novel.comic")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
}

# MangaDex
_MD_API = "https://api.mangadex.org"
_MD_COVER_CDN = "https://uploads.mangadex.org/covers"
_MD_IMG_REFERER = "https://mangadex.org/"

# 拷贝漫画
_COPY_API = "https://api.copy2000.online"
_COPY_SECRET = "M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM="
_COPY_QUALITY = "1500"
_COPY_IMG_REFERER = "https://www.copymanga.fun/"
_COPY_GROUP = "copymanga"  # 站级限速桶(API 210 是整站限制)
_copy_state: dict = {}


class CopyBlocked(RuntimeError):
    """拷贝漫画站级封禁(识别为"破解版 APP 特征"后对该 IP 封约 1 小时)。

    与普通频率限制(210)区分:这种重试无效且会加重封禁,必须直接上报,
    让用户换源/换代理/等待,而不是原地空转。
    """

# 动漫之家(Cimoc Dmzjv2 移植)
_DMZJ_BASE = "https://m.dmzj.com"
_DMZJ_IMG_REFERER = "http://images.dmzj.com/"
# 漫画DB(Cimoc ManHuaDB 移植)
_MDB_BASE = "https://www.manhuadb.com"
_MDB_IMG_REFERER = "https://www.manhuadb.com"
# CC漫画(Cimoc CCMH 移植,移动端页,lazy 分页图)
_CCMH_BASE = "http://m.ccmh6.com"
_CCMH_IMG_REFERER = "http://m.ccmh6.com/"
_CCMH_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) "
            "AppleWebKit/604.1.38 (KHTML, like Gecko) Version/12.0 Mobile/15A372 Safari/604.1")


def normalize_cdn(raw: str) -> str:
    """规范化 CDN 域名输入:去协议头/路径/查询,返回裸域名(非法返回空串)。"""
    s = str(raw or "").strip()
    if not s:
        return ""
    s = re.sub(r"^https?://", "", s, flags=re.I)
    s = s.split("/", 1)[0].split("?", 1)[0].strip()
    return s if re.fullmatch(r"[A-Za-z0-9.\-]+(?::\d+)?", s) else ""


def _md_custom_cdns() -> list[str]:
    """读取设置中的自定义 MangaDex 图片 CDN 列表(首个为默认;空=用 API 返回的官方 baseUrl)。"""
    try:
        from .config import load_settings
        out: list[str] = []
        for x in (load_settings().get("manga_cdn_custom") or []):
            d = normalize_cdn(x)
            if d and d not in out:
                out.append(d)
        return out
    except Exception:  # noqa: BLE001
        return []


def _proxies() -> dict | None:
    """读取用户配置的 HTTP 代理(settings.proxy)。"""
    try:
        from .config import load_settings
        p = (load_settings().get("proxy") or "").strip()
        return {"http": p, "https": p} if p else None
    except Exception:  # noqa: BLE001
        return None


# ---------------- 通用工具 ----------------
# 文本类请求(搜索/目录/图片列表)的限速参数:与小说侧 Fetcher 文本档保持一致
_TEXT_INTERVAL = 0.20
_TEXT_CONCURRENCY = 4


def _get(url: str, timeout: int = 20, retries: int = 2, **kw) -> requests.Response:
    """GET(带验证中心 403 兜底);网络错误/5xx/429 指数退避重试,最终失败抛异常。

    自带按域名自适应限速(并发闸门 + 最小间隔):同一站点不会被并发猛打;
    命中 429/503 时按 Retry-After 对该站退避(这是"访问过于频繁"的直接对策)。
    """
    headers = dict(HEADERS)
    headers.update(kw.pop("headers", {}) or {})
    proxies = kw.pop("proxies", None)
    if proxies is None:
        proxies = _proxies()
    method = kw.pop("method", "GET").upper()
    req_fn = requests.post if method == "POST" else requests.get
    cancel_check = kw.pop("cancel_check", None)
    group = kw.pop("group", None)
    last: Exception | None = None
    for i in range(retries + 1):
        try:
            with _throttle.acquire(url, group=group, interval=_TEXT_INTERVAL,
                                   concurrency=_TEXT_CONCURRENCY,
                                   cancel_check=cancel_check):
                r = req_fn(url, headers=headers, timeout=timeout, proxies=proxies, **kw)
            # 429/503:服务端明确限流 → 退避后再重试(等待由限速闸门兜住)
            if r.status_code in (429, 503):
                ra = _throttle.retry_after_seconds(r.headers)
                _throttle.penalty(url, group=group, cooldown=5.0, retry_after=ra)
                last = RuntimeError(f"HTTP {r.status_code}(访问过频/限流): {url}")
                continue
            # Cloudflare/站点验证:403 时自动带验证中心 cookies 重试(小说侧同款方案),
            # 无有效 cookies 则登记到验证中心(前端"验证中心"手动验证一次后自动生效)
            if r.status_code in (401, 403):
                from .verify import add_pending, get_cookies
                _throttle.penalty(url, group=group, cooldown=2.0)
                ret = get_cookies(url)
                if ret is not None:
                    ck, vua = ret  # cf_clearance 绑定验证时 UA
                    try:
                        with _throttle.acquire(url, group=group, cancel_check=cancel_check):
                            r2 = req_fn(url, headers={**headers, "User-Agent": vua}, cookies=ck,
                                        timeout=timeout, proxies=proxies, **kw)
                        if r2.status_code < 400:
                            _throttle.reward(url, group=group)
                            return r2
                    except requests.RequestException:
                        pass
                    from .verify import remove as vremove  # 带 cookies 仍失败:记录失效
                    vremove(url)
                add_pending(url, name="漫画")
            if r.status_code >= 500:
                last = RuntimeError(f"HTTP {r.status_code}: {url}")
                if i < retries:
                    _throttle.sleep_cancellable(1.5 * (i + 1), cancel_check)
                continue
            _throttle.reward(url, group=group)
            r.raise_for_status()
            return r
        except requests.RequestException as exc:
            last = exc
            if i < retries:
                _throttle.sleep_cancellable(1.5 * (i + 1), cancel_check)
    raise last or RuntimeError(f"请求失败: {url}")


def _pick_title(title: dict) -> str:
    """从多语言标题 dict 挑一个可读标题:优先中/英,否则第一个非空。"""
    if not title or not isinstance(title, dict):
        return ""
    for lang in ("zh", "zh-hk", "zh-cn", "en", "ja-ro"):
        v = (title.get(lang) or "").strip()
        if v:
            return v
    for v in title.values():
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


# ---------------- MangaDex 适配器 ----------------
def _md_search(keyword: str, limit: int = 20) -> list[dict]:
    r = _get(f"{_MD_API}/manga", params={
        "title": keyword, "limit": limit, "includes[]": "cover_art",
    })
    r.raise_for_status()
    out: list[dict] = []
    for m in (r.json().get("data") or []):
        attrs = m.get("attributes") or {}
        title = _pick_title(attrs.get("title"))
        if not title:
            continue
        cover = ""
        for rel in m.get("relationships") or []:
            if rel.get("type") == "cover_art":
                fn = ((rel.get("attributes") or {}).get("fileName") or "")
                if fn:
                    # mangadex fileName 自带扩展名(如 xxx.jpg);缩略图后缀
                    # (.256.jpg/.512.jpg)已失效,直接用全尺寸原图
                    cover = f"{_MD_COVER_CDN}/{m['id']}/{fn}"
                break
        desc = re.sub(r"<[^>]+>", "", (attrs.get("description") or {}).get("en", "") or "")[:200]
        out.append({
            "id": m.get("id", ""), "title": title, "cover": cover,
            "lang": attrs.get("originalLanguage", ""),
            "desc": desc or ((attrs.get("description") or {}).get("zh", "")[:200]
                             if isinstance(attrs.get("description"), dict) else ""),
        })
    return out


def _md_chapters(manga_id: str, langs: tuple = ("zh", "zh-hk", "zh-cn", "en")) -> list[dict]:
    out: list[dict] = []
    offset = 0
    seen: set[str] = set()
    while True:
        params = {"limit": 500, "offset": offset,
                  "order[volume]": "asc", "order[chapter]": "asc", "includeExternalUrl": "0"}
        for i, lg in enumerate(langs):
            params[f"translatedLanguage[{i}]"] = lg
        r = _get(f"{_MD_API}/manga/{manga_id}/feed", params=params)
        r.raise_for_status()
        data = r.json()
        for c in data.get("data") or []:
            a = c.get("attributes") or {}
            if a.get("externalUrl"):
                continue
            # pages==0:该话图源不在 MangaDex 服务器上(官方授权站外托管),
            # at-home 接口必然 404;留在目录里只会让这一话永远失败(下漏的来源),
            # 直接剔除,避免用户选中一话却下不下来。
            if a.get("pages") == 0:
                continue
            cid = c.get("id", "")
            if cid in seen:
                continue
            seen.add(cid)
            out.append({
                "id": cid,
                "volume": (a.get("volume") or "").strip(),
                "chapter": (a.get("chapter") or "").strip(),
                "title": (a.get("title") or "").strip(),
                "lang": a.get("translatedLanguage", ""),
            })
        total = data.get("total", 0)
        offset += len(data.get("data") or [])
        if offset >= total or not data.get("data"):
            break
    # 同卷同话多语言去重:优先 zh / zh-hk / zh-cn / en
    _pri = {"zh": 0, "zh-hk": 1, "zh-cn": 2, "en": 3}
    best: dict[tuple, dict] = {}
    for c in out:
        key = (c["volume"], c["chapter"]) if (c["volume"] or c["chapter"]) else ("", c["id"])
        pri = _pri.get(c["lang"], 99)
        if key not in best or pri < _pri.get(best[key]["lang"], 99):
            best[key] = c
    return sorted(best.values(), key=lambda c: (
        float(c["volume"]) if re.match(r"^\d+(\.\d+)?$", c["volume"]) else 1e9,
        float(c["chapter"]) if re.match(r"^\d+(\.\d+)?$", c["chapter"]) else 1e9,
        c["title"]))


def _md_pages_with_base(chapter_id: str, use_custom_cdn: bool = True) -> tuple[list[str], str]:
    """返回 (图片 URL 列表, 官方 baseUrl)。官方 baseUrl 供镜像失败时回退使用。"""
    r = _get(f"{_MD_API}/at-home/server/{chapter_id}")
    r.raise_for_status()
    j = r.json()
    base = j.get("baseUrl", "")
    ch = j.get("chapter") or {}
    h = ch.get("hash", "")
    files = ch.get("data") or []
    cdns = _md_custom_cdns() if use_custom_cdn else []
    use_base = ("https://" + cdns[0]) if cdns else base
    return [f"{use_base}/data/{h}/{f}" for f in files], base


def _md_pages(chapter_id: str, use_custom_cdn: bool = True) -> list[str]:
    return _md_pages_with_base(chapter_id, use_custom_cdn)[0]


# ---------------- 拷贝漫画适配器(HMAC 签名) ----------------
def _copy_headers() -> dict:
    """构造拷贝漫画签名请求头(deviceinfo/device/pseudoid 进程内固定一次)。"""
    st = _copy_state
    if not st:
        r = random.randint
        ca = lambda: chr(65 + r(0, 25))  # noqa: E731
        cd = lambda: chr(48 + r(0, 9))   # noqa: E731
        st["deviceinfo"] = f"{r(1000000, 9999999)}V-{r(1000, 9999)}"
        st["device"] = f"{ca()}{ca()}{cd()}{ca()}.{cd()}{cd()}{cd()}{cd()}{cd()}{cd()}.{cd()}{cd()}{cd()}"
        st["pseudoid"] = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(16))
    ts = str(int(time.time()))
    sig = _hmac.new(base64.b64decode(_COPY_SECRET), ts.encode(), hashlib.sha256).hexdigest()
    now = time.localtime()
    return {
        "User-Agent": "COPY/3.0.6", "source": "copyApp",
        "deviceinfo": st["deviceinfo"], "dt": f"{now.tm_year}.{now.tm_mon:02d}.{now.tm_mday:02d}",
        "platform": "3", "referer": "com.copymanga.app-3.0.6", "version": "3.0.6",
        "device": st["device"], "pseudoid": st["pseudoid"],
        "Accept": "application/json", "region": "0", "authorization": "Token",
        "umstring": "b4c89ca4104ea9a97750314d791520ac",
        "x-auth-timestamp": ts, "x-auth-signature": sig,
    }


def _copy_get(path: str, params: dict | None = None, retries: int = 4) -> dict:
    """拷贝漫画 GET(带签名与代理);210 访问过频时按提示等待后重试。

    210 是该站的站级限流:命中后按站点提示秒数(或 Retry-After)对拷贝漫画
    整站退避,并降低后续请求速率(throttle),避免连环 210 导致整话/整卷丢失。
    """
    last: Exception | None = None
    url = _COPY_API + path
    for i in range(retries + 1):
        try:
            with _throttle.acquire(url, group=_COPY_GROUP, interval=0.35,
                                   concurrency=3):
                r = requests.get(url, headers=_copy_headers(), params=params or {},
                                 timeout=25, proxies=_proxies())
            if r.status_code == 210:  # 访问过频 / 站级封禁
                raw = r.text or ""
                body_msg = ""
                try:
                    body_msg = str((r.json() or {}).get("message") or "")
                except Exception:  # noqa: BLE001
                    pass
                blob = (body_msg + raw)[:500]
                # 这个 210 分两种:① 普通频率限制(等几秒即可);② 站级封禁——
                # 站点识别出"破解版 APP 特征"后对当前 IP 封 1 小时(错误信息里
                # 要求去官网下正版 APP / 等待 1 小时)。后者重试毫无意义,还会
                # 加重封禁,所以立刻上报并拉长冷却,让上层换源/换代理。
                blocked = any(k in blob for k in
                              ("APP", "破解", "1小時", "1小时", "小時", "小时", "正版"))
                if blocked:
                    msg = body_msg.strip() or blob.strip()
                    _throttle.penalty(url, group=_COPY_GROUP, cooldown=180.0)
                    raise CopyBlocked(
                        "拷贝漫画已对该 IP 临时封禁(约 1 小时)并提示需使用正版客户端:\n"
                        f"  站点原话:{msg[:220]}\n"
                        "  建议:① 换用其它源(如 MangaDex)继续;② 在设置里配置代理更换出口 IP;"
                        "③ 等待约 1 小时后重试(本任务已停止重试,不会加重封禁)。")
                wait = 5
                m = re.search(r"(\d+)\s*seconds", raw)
                if m:
                    wait = int(m.group(1))
                ra = _throttle.retry_after_seconds(r.headers)
                _throttle.penalty(url, group=_COPY_GROUP, cooldown=wait, retry_after=ra)
                last = RuntimeError(f"拷贝漫画访问过频(210),等待 {wait}s 后重试")
                if i < retries:
                    _throttle.sleep_cancellable(min(wait, 40))
                continue
            if r.status_code in (401, 403):
                # Cloudflare/站点验证:带验证中心 cookies 重试,无则登记(小说侧同款方案)
                from .verify import add_pending, get_cookies
                _throttle.penalty(url, group=_COPY_GROUP, cooldown=2.0)
                ret = get_cookies(url)
                if ret is not None:
                    ck, vua = ret
                    with _throttle.acquire(url, group=_COPY_GROUP):
                        r2 = requests.get(url, headers={**_copy_headers(), "User-Agent": vua},
                                          params=params or {}, cookies=ck,
                                          timeout=25, proxies=_proxies())
                    if r2.status_code not in (401, 403):
                        r = r2
                    else:
                        from .verify import remove as vremove  # 记录失效,重新登记
                        vremove(url)
                        add_pending(url, name="拷贝漫画")
                else:
                    add_pending(url, name="拷贝漫画")
            if r.status_code >= 500:
                last = RuntimeError(f"拷贝漫画 HTTP {r.status_code}")
                if i < retries:
                    _throttle.sleep_cancellable(1.5 * (i + 1))
                continue
            _throttle.reward(url, group=_COPY_GROUP)
            r.raise_for_status()
            return r.json()
        except CopyBlocked:
            raise  # 站级封禁:不重试,直接上报(重试只会加重封禁)
        except requests.RequestException as exc:
            last = exc
            if i < retries:
                _throttle.sleep_cancellable(1.5 * (i + 1))
        except Exception as exc:  # noqa: BLE001  JSON 解析等非网络错误:重试意义有限,仍保留两轮
            last = exc
            if i < retries:
                _throttle.sleep_cancellable(1.5 * (i + 1))
    if last is None:
        last = RuntimeError("拷贝漫画请求失败")
    raise last


def copymanga_search(keyword: str, limit: int = 30) -> list[dict]:
    """拷贝漫画搜索 → [{id, title, cover, lang, desc}]。"""
    data = _copy_get("/api/v3/search/comic", {"limit": limit, "offset": 0, "q": keyword, "q_type": ""})
    out: list[dict] = []
    for comic in (data.get("results") or {}).get("list") or []:
        if comic.get("comic"):
            comic = comic["comic"]
        authors = comic.get("author") or []
        out.append({
            "id": comic.get("path_word", ""),
            "title": comic.get("name", ""),
            "cover": comic.get("cover", ""),
            "lang": "zh",
            "desc": (authors[0].get("name", "") if authors else "") or "",
        })
    return out


def copymanga_chapters(comic_id: str) -> list[dict]:
    """拷贝漫画话列表(合并全部分组,按话序排序)。"""
    data = _copy_get(f"/api/v3/comic2/{comic_id}", {"in_mainland": "true", "platform": "3"})
    groups = (data.get("results") or {}).get("groups") or {}
    chs: list[dict] = []
    for g in groups.values():
        path = (g or {}).get("path_word") or ""
        if not path:
            continue
        offset = 0
        while True:
            d = _copy_get(f"/api/v3/comic/{comic_id}/group/{path}/chapters",
                          {"limit": 100, "offset": offset})
            lst = (d.get("results") or {}).get("list") or []
            for e in lst:
                chs.append({
                    "id": e.get("uuid", ""),
                    "chapter": str(e.get("order", "") or ""),
                    "title": e.get("name", "") or "",
                    "volume": "", "lang": "zh",
                })
            total = (d.get("results") or {}).get("total", 0)
            offset += len(lst)
            if offset >= total or not lst:
                break
    chs.sort(key=lambda c: float(c["chapter"]) if re.match(r"^\d+(\.\d+)?$", c["chapter"]) else 1e9)
    return chs


def copymanga_pages(comic_id: str, ep_id: str) -> list[str]:
    """拷贝漫画某话图片 URL(按 words 排序 + c1500x 高清替换)。

    words 是服务端给的"页序数组"。旧实现无条件按 words 回填,一旦 words 不是
    0..n-1 的完整排列(缺项/重复,限流或改版时都会出现),被重复覆盖的槽位
    会挤掉另一页、空槽位被静默丢弃 —— 这就是"下重复 + 下漏页"。
    现在:只有 words 是完整排列时才重排;否则保留服务端原始顺序并告警。
    """
    data = _copy_get(f"/api/v3/comic/{comic_id}/chapter2/{ep_id}", {"in_mainland": "true"})
    chapter = (data.get("results") or {}).get("chapter") or {}
    contents = chapter.get("contents") or []
    words = chapter.get("words") or []
    urls = [(e or {}).get("url", "") for e in contents]
    hd = [re.sub(r"([./])c\d+x\.[a-zA-Z]+$", rf"\1c{_COPY_QUALITY}x.webp", u) for u in urls]
    n = len(hd)
    if not n:
        return []
    valid_words = [w for w in words if isinstance(w, int) and not isinstance(w, bool)
                   and 0 <= w < n]
    is_permutation = (len(valid_words) == n and len(set(valid_words)) == n)
    if is_permutation:
        imgs: list[str] = [""] * n
        for i, u in enumerate(hd):
            if (i < len(words) and isinstance(words[i], int) and not isinstance(words[i], bool)
                    and 0 <= words[i] < n):
                imgs[words[i]] = u
        out = [u for u in imgs if u]
    else:
        # words 不可信:保持服务端顺序,宁可不重排也不丢页/错页
        logger.warning("拷贝漫画 %s 的 words 不是完整排列(contents=%d, words=%d),"
                       "改为按服务端顺序下载", ep_id, n, len(words))
        out = [u for u in hd if u]
    # 去重(保留首次出现),避免同一页被写两次
    seen: set[str] = set()
    dedup: list[str] = []
    for u in out:
        if u and u not in seen:
            seen.add(u)
            dedup.append(u)
    return dedup


# ---------------- 漫画源注册表 ----------------
MANGA_SOURCES = {
    "mangadex": {"name": "MangaDex", "enabled": True, "needs_proxy": False,
                 "note": "国际公开源,多语言翻译"},
    "copymanga": {"name": "拷贝漫画", "enabled": True, "needs_proxy": False,
                  "note": "中文源,HMAC 签名已接入"},
    "dmzj": {"name": "动漫之家", "enabled": False, "needs_proxy": False,
             "note": "中文源(Cimoc 移植);2026-09 实测全域名连接重置,站点死亡"},
    "manhuadb": {"name": "漫画牛", "enabled": True, "needs_proxy": False,
                 "note": "原漫画DB已迁 manhua666.cc 并更名,2026-09 重写规则实测可用"},
    "ccmh": {"name": "CC漫画", "enabled": False, "needs_proxy": False,
             "note": "中文源;2026-09 实测 ccmh6 域名已挂牌出售,站点死亡"},
    "dm5": {"name": "动漫屋", "enabled": False, "needs_proxy": False,
            "note": "中文源;搜索已恢复但图片页 JS 混淆无法解析,待站点改版"},
    "baozimh": {"name": "包子漫画", "enabled": True, "needs_proxy": False,
                "note": "中文源(Cimoc 规则引擎),2026 实测可用"},
    "mangagg": {"name": "MangaGG", "enabled": True, "needs_proxy": False,
                "note": "英文源(中文翻译,Madara 引擎)"},
    "mangapill": {"name": "MangaPill", "enabled": True, "needs_proxy": False,
                  "note": "英文源(日漫为主)"},
    "weebcentral": {"name": "WeebCentral", "enabled": True, "needs_proxy": False,
                    "note": "英文聚合站(MangaSee 继承者),平台级稳定,2026-09 实测全链路可用"},
}


# ---------------- 动漫之家(Dmzjv2 移植) ----------------
def dmzj_search(keyword: str, limit: int = 20) -> list[dict]:
    """动漫之家搜索 → [{id(comic_py), title, cover, desc}]。
    m.dmzj.com/search/{kw}.html 内嵌 var serchArry=[{comic_py,name,cover,authors}]。"""
    url = f"{_DMZJ_BASE}/search/{requests.utils.quote(keyword)}.html"
    r = _get(url, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"动漫之家搜索失败 HTTP {r.status_code}")
    html = r.text
    m = re.search(r"var\s+serchArry=(\[.*?\])", html, re.S)
    if not m:
        return []
    try:
        arr = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    out = []
    for it in arr[:limit]:
        cid = str(it.get("comic_py") or "")
        if not cid:
            continue
        cover = str(it.get("cover") or "")
        if cover and not cover.startswith("http"):
            cover = "https://images.dmzj.com/" + cover
        out.append({
            "id": cid, "title": str(it.get("name") or cid),
            "cover": cover, "lang": "zh",
            "desc": str(it.get("authors") or ""),
        })
    return out


def dmzj_chapters(comic_id: str) -> list[dict]:
    """动漫之家章节 → [{id: '{comic_id}/{chapter_id}', title}]。
    info 页内嵌 initIntroData([{title, data:[{chapter_name, comic_id, id}]}])。"""
    url = f"{_DMZJ_BASE}/info/{comic_id}.html"
    r = _get(url, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"动漫之家目录失败 HTTP {r.status_code}")
    html = r.text
    m = re.search(r"initIntroData\((.*)\);", html, re.S)
    if not m:
        return []
    try:
        groups = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    out = []
    for g in groups:
        tag = str(g.get("title") or "")
        for ch in g.get("data") or []:
            ch_id = str(ch.get("id") or "")
            cid = str(ch.get("comic_id") or comic_id)
            name = str(ch.get("chapter_name") or "")
            out.append({"id": f"{cid}/{ch_id}", "title": f"{tag} {name}".strip(),
                        "volume": tag, "chapter": name, "lang": "zh"})
    return out


def dmzj_pages(ep_id: str) -> list[str]:
    """动漫之家页图 → [url]。view 页内嵌 \"page_url\":[...] 。"""
    url = f"{_DMZJ_BASE}/view/{ep_id}.html"
    r = _get(url, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"动漫之家图片列表失败 HTTP {r.status_code}")
    html = r.text
    m = re.search(r'"page_url":(\[.*?\]),', html, re.S)
    if not m:
        return []
    try:
        urls = json.loads(m.group(1))
    except json.JSONDecodeError:
        return []
    return [str(u) for u in urls if str(u).startswith("http")]


# ---------------- 漫画DB(ManHuaDB 移植) ----------------
def _html_list_links(html: str, selector: str) -> list[dict]:
    """极简 CSS 选择器匹配:按标签+class 前缀粗匹配 <a> 的 href/title/img src。
    仅支持本项目需要的几种形态(搜索卡/章节列表),无需完整 DOM 解析。"""
    items = []
    for m in re.finditer(r"<a\s+([^>]*)>(.*?)</a>", html, re.S | re.I):
        attrs, inner = m.group(1), m.group(2)
        if selector and not re.search(selector, attrs):
            continue
        def _a(name: str) -> str:
            mm = re.search(name + r'\s*=\s*"([^"]*)"', attrs, re.I)
            return mm.group(1) if mm else ""
        def _img_src(inner_html: str) -> str:
            mm = re.search(r"<img[^>]*\b(?:data-original|src|data-src)\s*=\s*[\"']([^\"']+)[\"']", inner_html, re.I)
            return mm.group(1) if mm else ""
        items.append({"href": _a("href"), "title": _a("title"), "img": _img_src(inner),
                      "text": re.sub(r"<[^>]+>", " ", inner).strip()})
    return items


def manhuadb_search(keyword: str, limit: int = 20) -> list[dict]:
    """漫画DB搜索。https://www.manhuadb.com/search?q={kw} → a.d-block 卡。"""
    url = f"{_MDB_BASE}/search?q={requests.utils.quote(keyword)}"
    r = _get(url, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"漫画DB搜索失败 HTTP {r.status_code}")
    out = []
    for it in _html_list_links(r.text, r"class=\"[^\"]*d-block"):
        href = it["href"]
        # /manhua/{cid}/xxx  → 第 1 段为 cid
        parts = [p for p in href.split("/") if p]
        if len(parts) < 2:
            continue
        cid = parts[1]
        out.append({
            "id": cid, "title": it["title"] or it["text"] or cid,
            "cover": it["img"], "lang": "zh", "desc": "",
        })
        if len(out) >= limit:
            break
    return out


def manhuadb_chapters(comic_id: str) -> list[dict]:
    """漫画DB章节 → [{id: path, title}]。#comic-book-list li>a。"""
    url = f"{_MDB_BASE}/manhua/{comic_id}"
    r = _get(url, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"漫画DB目录失败 HTTP {r.status_code}")
    out = []
    for it in _html_list_links(r.text, r"#comic-book-list|class=\"[^\"]*list"):
        href = it["href"]
        parts = [p for p in href.split("/") if p]
        # /manhua/{cid}/{path}.html → 第 2 段为 path
        if len(parts) < 3:
            continue
        path = parts[2].replace(".html", "")
        out.append({"id": path, "title": it["title"] or it["text"] or path,
                    "volume": "", "chapter": it["text"] or path, "lang": "zh"})
    return out


def manhuadb_pages(comic_id: str, ep_id: str) -> list[str]:
    """漫画DB页图 → [url]。阅读页内嵌 data-host/data-img_pre + base64(img_data) JSON。"""
    url = f"{_MDB_BASE}/manhua/{comic_id}/{ep_id}.html"
    r = _get(url, timeout=25)
    if r.status_code != 200:
        raise RuntimeError(f"漫画DB图片列表失败 HTTP {r.status_code}")
    html = r.text
    host = re.search(r'data-host="(.*?)"', html)
    pre = re.search(r'data-img_pre="(.*?)"', html)
    imgdata = re.search(r"var img_data = '(.*?)';", html, re.S)
    if not (host and imgdata):
        return []
    try:
        dec = base64.b64decode(imgdata.group(1)).decode("utf-8", "replace")
        arr = json.loads(dec)
    except Exception:  # noqa: BLE001
        return []
    pre_s = pre.group(1) if pre else ""
    return [str(host.group(1)) + pre_s + str(it.get("img") or "")
            for it in arr if it.get("img")]


# ---------------- CC漫画(CCMH 移植) ----------------
def _ccmh_get(url: str, **kw) -> requests.Response:
    h = dict(kw.pop("headers", {}) or {})
    h.setdefault("User-Agent", _CCMH_UA)
    return _get(url, headers=h, **kw)


def ccmh_search(keyword: str, limit: int = 20) -> list[dict]:
    """CC漫画搜索。POST /Search body Key=kw → .list>div 卡。"""
    url = f"{_CCMH_BASE}/Search"
    try:
        r = _get(url, method="POST",
                 data=requests.utils.urlencode({"Key": keyword}),
                 headers={
                     "User-Agent": _CCMH_UA,
                     "Referer": f"{_CCMH_BASE}/Search",
                     "Origin": _CCMH_BASE,
                     "Content-Type": "application/x-www-form-urlencoded",
                 }, timeout=20)
    except Exception:  # noqa: BLE001 兼容 _get 无 method 参数时回退
        import urllib.parse
        r = requests.post(url, data=urllib.parse.urlencode({"Key": keyword}),
                          headers={"User-Agent": _CCMH_UA,
                                   "Referer": f"{_CCMH_BASE}/Search",
                                   "Origin": _CCMH_BASE},
                          timeout=20, proxies=_proxies())
    if r.status_code != 200:
        raise RuntimeError(f"CC漫画搜索失败 HTTP {r.status_code}")
    out = []
    for it in _html_list_links(r.text, r"class=\"[^\"]*list"):
        href = it["href"]
        parts = [p for p in href.split("/") if p]
        if len(parts) < 2:
            continue
        cid = parts[1]
        out.append({
            "id": cid, "title": it["title"] or it["text"].split()[0] if it["text"] else cid,
            "cover": it["img"], "lang": "zh", "desc": "",
        })
        if len(out) >= limit:
            break
    return out


def ccmh_chapters(comic_id: str) -> list[dict]:
    """CC漫画章节 → [{id: path, title}]。详情页 .list>a,顺序倒排(旧→新)。"""
    url = f"{_CCMH_BASE}/manhua/{comic_id}"
    r = _ccmh_get(url, timeout=20)
    if r.status_code != 200:
        raise RuntimeError(f"CC漫画目录失败 HTTP {r.status_code}")
    out = []
    for it in _html_list_links(r.text, r"class=\"[^\"]*list"):
        href = it["href"]
        parts = [p for p in href.split("/") if p]
        if len(parts) < 3:
            continue
        path = parts[2].replace(".html", "")
        out.append({"id": path, "title": it["title"] or it["text"] or path,
                    "volume": "", "chapter": it["text"] or path, "lang": "zh"})
    out.reverse()  # 站点列表倒序(最新在前),还原为自然顺序
    return out


def ccmh_pages(comic_id: str, ep_id: str) -> list[str]:
    """CC漫画页图 → [url]。移动端为 lazy 分页:阅读页按 ?p=N 分页,每页取 .img>img src。

    分页请求失败时**不再静默跳过**(旧实现 continue 会让整话悄悄少几页):
    重试多轮仍失败则抛错,由下载层把整话判失败并整轮重试。
    """
    urls = []
    base = f"{_CCMH_BASE}/manhua/{comic_id}/{ep_id}.html"
    # 第 1 页:提取总页数(最多请求 120 页兜底)
    first = _ccmh_get(base, timeout=25)
    if first.status_code != 200:
        raise RuntimeError(f"CC漫画图片列表失败 HTTP {first.status_code}")
    pages_n = 1
    for m in re.finditer(r'<a href="\?p=(\d+)">\d+</a>', first.text):
        pages_n = max(pages_n, int(m.group(1)))
    pages_n = min(pages_n, 120)
    missing_pages: list[int] = []
    for i in range(1, pages_n + 1):
        if i == 1:
            html = first.text
        else:
            html = ""
            for _try in range(3):  # _get 内部已有退避重试,这里再补偿两轮
                try:
                    r = _ccmh_get(f"{base}?p={i}", timeout=25)
                    if r.status_code == 200:
                        html = r.text
                        break
                except Exception:  # noqa: BLE001
                    pass
                _throttle.sleep_cancellable(1.5 * (_try + 1))
            if not html:
                missing_pages.append(i)
                continue
        m = re.search(r'<div class="img[^"]*"[^>]*>\s*<img[^>]*\b(?:src|data-src)\s*=\s*["\']([^"\']+)["\']', html, re.I)
        if not m:
            m = re.search(r'<img[^>]*\b(?:src|data-src)\s*=\s*["\']([^"\']+)["\']', html, re.I)
        if m:
            u = m.group(1)
            if u.startswith("//"):
                u = "https:" + u
            urls.append(u)
    if missing_pages:
        # 宁可整话重试,也不要产出缺页的 PDF(旧实现静默丢页)
        raise RuntimeError(f"CC漫画分页拉取失败 {len(missing_pages)} 页: {missing_pages[:10]}")
    return urls


def get_sources() -> list[dict]:
    """可用漫画源列表(前端源下拉/管理用),enabled 取持久化启停状态;
    自定义源(订阅/导入)一并列出并标记 custom。"""
    from .config import load_comic_source_states
    states = load_comic_source_states()
    ovs = load_base_overrides()
    out = []
    for k, v in MANGA_SOURCES.items():
        note = v.get("note", "")
        if k in ovs:
            note = (note + " · " if note else "") + f"地址已修正→{ovs[k].get('base', '')}"
        out.append({
            "key": k, "name": v["name"],
            "enabled": states.get(k, v.get("enabled", True)),
            "needs_proxy": v.get("needs_proxy", False),
            "note": note,
        })
    for r in load_custom_sources():
        key = r.get("key", "")
        if not key:
            continue
        out.append({
            "key": key, "name": r.get("name", key),
            "enabled": states.get(key, r.get("enabled", True)),
            "needs_proxy": False,
            "note": "自定义(订阅/导入)",
            "custom": True,
            "sub": r.get("sub", ""),
        })
    return out


def set_source_state(name: str, enabled: bool) -> dict:
    """启用/停用漫画源(持久化到 config.json)。"""
    _source(name)  # 校验源存在
    from .config import save_comic_source_state
    save_comic_source_state(name, bool(enabled))
    return {"ok": True, "key": name, "enabled": bool(enabled)}


def test_source(name: str, keyword: str = "slime") -> dict:
    """测速:实际执行一次搜索并计时,返回 {ok, ms, count} 或错误。"""
    import time as _t
    t0 = _t.time()
    try:
        res = search(keyword, limit=5, source=name)
        return {"ok": True, "ms": int((_t.time() - t0) * 1000), "count": len(res)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "ms": int((_t.time() - t0) * 1000),
                "error": f"{type(exc).__name__}: {exc}"}


def _source(name: str) -> dict:
    s = MANGA_SOURCES.get(name or "mangadex")
    if s is None:
        s = _custom_rule(name)  # 自定义源(订阅/导入)
    if s is None:
        raise ValueError(f"未知漫画源: {name}")
    return s


def _check_source(name: str) -> None:
    s = _source(name)
    # 启用状态以持久化配置为准(用户可在设置里启停漫画源)
    from .config import load_comic_source_states
    states = load_comic_source_states()
    if not states.get(name, s.get("enabled", True)):
        raise RuntimeError(
            f"漫画源《{s['name']}》已停用(可在漫画源设置中重新启用)。"
            f"{'请先在设置中配置 HTTP 代理。' if s.get('needs_proxy') else ''}"
        )


# ---------------- Cimoc 规则引擎接入 ----------------
_CIMOC_CACHE: dict = {}


def _cimoc(key: str) -> "CimocSource":
    """按 key 懒加载 Cimoc 规则引擎实例(规则优先内置 RULES,其次自定义源)。
    base 地址优先应用 sourceBaseUrl 修正表记录。"""
    from .comic_cimoc import CimocSource, RULES
    if key not in _CIMOC_CACHE:
        rule = RULES.get(key)
        if rule is None:
            rule = _custom_rule(key)
        if rule is None:
            raise KeyError(f"未知 Cimoc 源: {key}")
        ov = (load_base_overrides().get(key) or {}).get("base")
        if ov and ov != rule.get("base"):
            rule = {**rule, "base": ov}
        _CIMOC_CACHE[key] = CimocSource(rule)
    return _CIMOC_CACHE[key]


# ---------------- 自定义漫画源(订阅/粘贴导入) ----------------
# 规则与 comic_cimoc.RULES 同构:{key?, name, base, referer?, search, toc, pages}
_CUSTOM_SOURCES: list | None = None


def _custom_path() -> str:
    from .paths import COMIC_CUSTOM_SOURCES_PATH
    return COMIC_CUSTOM_SOURCES_PATH


def load_custom_sources() -> list:
    """读取自定义漫画源规则列表(文件不存在/损坏时返回空)。"""
    global _CUSTOM_SOURCES
    if _CUSTOM_SOURCES is None:
        rules: list = []
        try:
            with open(_custom_path(), "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, list):
                rules = [r for r in raw if isinstance(r, dict)]
            elif isinstance(raw, dict):
                rules = [raw]
        except (OSError, json.JSONDecodeError):
            rules = []
        _CUSTOM_SOURCES = rules
    return _CUSTOM_SOURCES


def save_custom_sources(rules: list) -> None:
    """持久化自定义源规则(写入后清空 Cimoc 实例缓存,规则变更立即生效)。"""
    global _CUSTOM_SOURCES
    _CUSTOM_SOURCES = rules
    _CIMOC_CACHE.clear()
    try:
        with open(_custom_path(), "w", encoding="utf-8") as f:
            json.dump(rules, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        raise RuntimeError(f"保存自定义漫画源失败: {exc}") from exc


def _custom_rule(key: str) -> dict | None:
    for r in load_custom_sources():
        if r.get("key") == key:
            return r
    return None


def _normalize_custom_rule(raw: dict, sub_url: str = "") -> dict:
    """校验并规范化一条自定义规则 → {key, name, base, referer?, search, toc, pages, sub?}。"""
    name = str(raw.get("name") or raw.get("title") or "").strip()[:24]
    if not name:
        raise ValueError("规则缺少 name(源名称)")
    base = str(raw.get("base") or raw.get("url") or "").strip().rstrip("/")
    if not base:
        raise ValueError(f"源《{name}》缺少 base(站点地址)")
    for sec in ("search", "toc", "pages"):
        if not isinstance(raw.get(sec), dict):
            raise ValueError(f"源《{name}》缺少 {sec} 配置(必须为对象)")
    key = re.sub(r"[^\w\u4e00-\u9fff]+", "", str(raw.get("key") or "").strip())
    if not key:
        key = re.sub(r"[^\w\u4e00-\u9fff]+", "", name) or "custom"
        key = "custom_" + key[:24]
    if key in MANGA_SOURCES:
        key = "custom_" + key
    rule: dict = {"key": key, "name": name, "base": base,
                  "search": raw["search"], "toc": raw["toc"], "pages": raw["pages"]}
    for fld in ("referer", "headers"):
        if raw.get(fld) is not None:
            rule[fld] = raw[fld]
    if raw.get("enabled") is not None:
        rule["enabled"] = bool(raw["enabled"])
    if sub_url:
        rule["sub"] = sub_url
    return rule


def import_custom_sources(json_text: str, sub_url: str = "") -> dict:
    """粘贴导入自定义漫画源(JSON 单条或数组)。返回 {added, dup, errors:[...]}。"""
    try:
        obj = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败: {exc}") from exc
    arr = obj if isinstance(obj, list) else [obj]
    rules = load_custom_sources()
    keys = {r.get("key") for r in rules if r.get("key")}
    added, dup, errors = 0, 0, []
    for it in arr:
        if not isinstance(it, dict):
            errors.append("存在非对象条目,已跳过")
            continue
        try:
            rule = _normalize_custom_rule(it, sub_url)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        if rule["key"] in keys:  # 同名更新
            dup += 1
            rules = [r for r in rules if r.get("key") != rule["key"]]
        rules.append(rule)
        keys.add(rule["key"])
        added += 1
    if added:
        save_custom_sources(rules)
    return {"added": added, "dup": dup, "errors": errors}


def remove_custom_source(key: str) -> bool:
    rules = load_custom_sources()
    rest = [r for r in rules if r.get("key") != key]
    if len(rest) == len(rules):
        return False
    save_custom_sources(rest)
    return True


# ---------------- 漫画订阅管理(GitHub 仓库/规则直链/地址修正表) ----------------
# 内置默认订阅:Cimoc sourceBaseUrl 地址修正表(国内三镜像 + 海外备份),
# 首次使用时自动写入,按 key 修正内置/自定义源的 base 地址
COMIC_SUBS_DEFAULTS = [
    {"name": "Cimoc 地址修正·国服1", "url": "https://miuscapp.com/cimoc/sourceBaseUrl.json",
     "file": "", "remark": "sourceBaseUrl 修正表(国内镜像)",
     "resolved": "https://miuscapp.com/cimoc/sourceBaseUrl.json",
     "added": 0.0, "last_sync": None, "status": "未同步", "count": 0},
    {"name": "Cimoc 地址修正·国服2", "url": "http://www.cimoc.top/cimoc/sourc/master/raw/sourceBaseUrl.json",
     "file": "", "remark": "sourceBaseUrl 修正表(国内镜像)",
     "resolved": "http://www.cimoc.top/cimoc/sourc/master/raw/sourceBaseUrl.json",
     "added": 0.0, "last_sync": None, "status": "未同步", "count": 0},
    {"name": "Cimoc 地址修正·国服3", "url": "https://raw.gitcode.com/Haleydutest/cupdate/raw/main/sourceBaseUrl.json",
     "file": "", "remark": "sourceBaseUrl 修正表(国内镜像)",
     "resolved": "https://raw.gitcode.com/Haleydutest/cupdate/raw/main/sourceBaseUrl.json",
     "added": 0.0, "last_sync": None, "status": "未同步", "count": 0},
    {"name": "Cimoc 地址修正·海外", "url": "https://raw.githubusercontent.com/haleydu-test/cimocUpdate/main/sourceBaseUrl.json",
     "file": "", "remark": "sourceBaseUrl 修正表(海外备份)",
     "resolved": "https://raw.githubusercontent.com/haleydu-test/cimocUpdate/main/sourceBaseUrl.json",
     "added": 0.0, "last_sync": None, "status": "未同步", "count": 0},
]


def load_comic_subs() -> list:
    """读取漫画订阅列表;文件不存在时写入内置默认订阅(地址修正表镜像)。"""
    from .paths import COMIC_SUBSCRIPTIONS_PATH
    try:
        with open(COMIC_SUBSCRIPTIONS_PATH, "r", encoding="utf-8") as f:
            subs = json.load(f)
        if isinstance(subs, list):
            return subs
    except (OSError, json.JSONDecodeError):
        pass
    defaults = [dict(s, added=time.time()) for s in COMIC_SUBS_DEFAULTS]
    try:
        save_comic_subs(defaults)
    except OSError:
        pass
    return defaults


def save_comic_subs(subs: list) -> None:
    from .paths import COMIC_SUBSCRIPTIONS_PATH
    with open(COMIC_SUBSCRIPTIONS_PATH, "w", encoding="utf-8") as f:
        json.dump(subs, f, ensure_ascii=False, indent=2)


def add_comic_sub(name: str, url: str, file: str = "", remark: str = "") -> dict:
    """新增漫画订阅;url 校验并解析直链,失败抛 ValueError。"""
    from .source_registry import resolve_repo_file
    name = name.strip() or url
    url = url.strip()
    if not url.startswith("http"):
        raise ValueError("订阅地址必须是 http(s) 开头")
    resolved = resolve_repo_file(url, file or "")
    subs = load_comic_subs()
    for s in subs:
        if s["url"] == url:
            raise ValueError("该订阅已存在")
    sub = {"name": name, "url": url, "file": file, "remark": remark,
           "resolved": resolved, "added": time.time(),
           "last_sync": None, "status": "未同步", "count": 0}
    subs.append(sub)
    save_comic_subs(subs)
    return sub


def remove_comic_sub(url: str) -> bool:
    """移除订阅,并同步删除该订阅导入的自定义规则及其 base 地址修正。"""
    subs = load_comic_subs()
    rest = [s for s in subs if s["url"] != url]
    if len(rest) == len(subs):
        return False
    save_comic_subs(rest)
    rules = [r for r in load_custom_sources() if r.get("sub") != url]
    save_custom_sources(rules)
    ovs = load_base_overrides()
    rem = [k for k, v in ovs.items() if v.get("sub") == url]
    if rem:
        for k in rem:
            del ovs[k]
        save_base_overrides(ovs)
    return True


def _is_base_table(data) -> bool:
    """判断 JSON 是否为 Cimoc sourceBaseUrl 地址修正表(顶层 dict,
    且非"完整单条规则";数组中条目含搜索/解析字段但无完整规则结构)。"""
    if not isinstance(data, dict):
        return False
    if data.get("name") and "search" in data and "toc" in data:
        return False  # 单条完整规则
    return True


def refresh_comic_sub(url: str) -> dict:
    """拉取订阅直链 JSON。两种内容:
    1) 规则数组/单条规则 → 合并为自定义源;
    2) sourceBaseUrl 地址修正表({key: {baseUrl}}) → 按 key 修正同名源 base。
    返回 {ok, count, errors}。"""
    from .source_registry import resolve_repo_file
    sub = next((s for s in load_comic_subs() if s["url"] == url), None)
    if sub is None:
        return {"ok": False, "error": "未找到该订阅"}
    resolved = sub.get("resolved") or resolve_repo_file(sub["url"], sub.get("file", ""))
    try:
        r = requests.get(resolved, headers=HEADERS, timeout=30, proxies=_proxies())
    except requests.RequestException as exc:
        return {"ok": False, "error": f"拉取失败: {exc}"}
    if r.status_code != 200:
        return {"ok": False, "error": f"拉取失败 HTTP {r.status_code}"}
    try:
        data = r.json()
    except ValueError as exc:
        return {"ok": False, "error": f"内容不是合法 JSON: {exc}"}
    if _is_base_table(data):
        return _refresh_comic_base_table(url, data)
    arr = data if isinstance(data, list) else [data]
    rules = [x for x in load_custom_sources() if x.get("sub") != url]  # 移除本订阅旧规则
    keys = {x.get("key") for x in rules if x.get("key")}
    added, errors = 0, []
    for it in arr:
        if not isinstance(it, dict):
            continue
        try:
            rule = _normalize_custom_rule(it, url)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        if rule["key"] in keys:
            rules = [x for x in rules if x.get("key") != rule["key"]]
        rules.append(rule)
        keys.add(rule["key"])
        added += 1
    save_custom_sources(rules)
    subs = load_comic_subs()
    for s in subs:
        if s["url"] == url:
            s["last_sync"] = time.time()
            s["count"] = added
            s["status"] = f"已同步({added} 源)" + (f",{len(errors)} 条无效" if errors else "")
            break
    save_comic_subs(subs)
    return {"ok": True, "count": added, "errors": errors}


# ---------------- sourceBaseUrl 地址修正表 ----------------
def load_base_overrides() -> dict:
    """读取漫画源 base 地址修正表 {key: {base, ts, sub}}。"""
    from .paths import COMIC_BASE_OVERRIDES_PATH
    try:
        with open(COMIC_BASE_OVERRIDES_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_base_overrides(data: dict) -> None:
    from .paths import COMIC_BASE_OVERRIDES_PATH
    with open(COMIC_BASE_OVERRIDES_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    _CIMOC_CACHE.clear()


def _refresh_comic_base_table(url: str, data: dict) -> dict:
    """地址修正表扫描:拉取后列出可修正源(不自动应用),待用户勾选后 apply_comic_base 落盘。

    返回 {ok, count, unmatched, pending, matches:[{key,name,base,old_base,applied}]};
    匹配结果暂存于订阅记录 pending 字段(重启不丢失)。"""
    from .comic_cimoc import RULES
    ovs = load_base_overrides()
    rules = load_custom_sources()
    rname = {k.lower(): v.get("name", k) for k, v in RULES.items()}
    rname.update({r.get("key", "").lower(): r.get("name", r.get("key", "")) for r in rules})
    keys = set(rname) | {r.get("key", "").lower() for r in rules if r.get("key")}
    # 同源存在 v2 条目时,跳过旧条目(DMZJ 让位 DMZJV2),避免地址来回抖动
    v2s = {key[:-2].lower() for key in data if isinstance(key, str) and key.lower().endswith("v2")}
    items = {}  # k -> base(长 key v2 后处理,覆盖旧地址)
    unmatched = 0
    for key, info in data.items():
        if not isinstance(key, str):
            continue
        if isinstance(info, str):
            base = info.strip()
        elif isinstance(info, dict):
            base = str(info.get("baseUrl") or info.get("serverUrl") or info.get("base") or "").strip()
        else:
            continue  # backup_update 等自引用链接/非地址条目跳过
        if not base:
            continue
        k = key.lower()
        if k in v2s and not k.endswith("v2"):
            continue  # 已被 v2 条目取代的旧地址
        if k not in keys and k.endswith("v2") and k[:-2] in keys:
            k = k[:-2]  # DMZJV2 → dmzj(v2 为现行规则)
        if k not in keys:
            unmatched += 1
            continue
        items[k] = base  # 同 k 重复条目:后出现者覆盖(v2 旧条目已在上方跳过)
    matches = []
    for k, base in sorted(items.items()):
        if k in rname:
            cur = (ovs.get(k) or {}).get("base") or RULES[k].get("base", "")
        else:
            r = next((x for x in rules if x.get("key", "").lower() == k), None)
            cur = r.get("base", "") if r else ""
        if not cur or not base or base == cur:
            continue  # 无旧地址/地址未变化 → 不算可修正项
        matches.append({"key": k, "name": rname.get(k, k), "base": base,
                        "old_base": cur, "applied": False})
    subs = load_comic_subs()
    for s in subs:
        if s["url"] == url:
            s["last_sync"] = time.time()
            s["count"] = len(matches)
            s["unmatched"] = unmatched
            s["pending"] = {"ts": time.time(),
                            "data": {m["key"]: m["base"] for m in matches},
                            "matches": matches}
            s["status"] = (f"已拉取({len(matches)} 个可修正,待应用)" if matches
                           else "已同步(0 个地址修正)")
            if unmatched:
                s["status"] += f",{unmatched} 个未收录"
            break
    save_comic_subs(subs)
    return {"ok": True, "count": len(matches), "unmatched": unmatched,
            "pending": True, "matches": matches}


def apply_comic_base(url: str, keys: list) -> dict:
    """应用地址修正:对勾选的 key 写入修正记录(内置源)/修改规则 base(自定义源)。

    keys 里的 base 取值自该订阅 pending 快照(刷新时暂存)。"""
    from .comic_cimoc import RULES
    sub = next((s for s in load_comic_subs() if s["url"] == url), None)
    if sub is None:
        return {"ok": False, "error": "未找到该订阅"}
    pend = (sub.get("pending") or {}).get("data") or {}
    if not pend:
        return {"ok": False, "error": "请先刷新该订阅,再选择要应用的源"}
    ovs = load_base_overrides()
    rules = load_custom_sources()
    applied, skipped = 0, []
    for key in keys or []:
        k = (key or "").strip().lower()
        base = pend.get(k)
        if not base:
            skipped.append(key)
            continue
        if k in RULES:  # 内置源 → 持久化修正记录(按订阅回滚)
            if (ovs.get(k) or {}).get("base") != base:
                ovs[k] = {"base": base, "ts": time.time(), "sub": url}
                applied += 1
        else:  # 自定义源 → 直接改规则 base
            for r in rules:
                if r.get("key", "").lower() == k and r.get("base") != base:
                    r["base"] = base
                    applied += 1
    if ovs:
        save_base_overrides(ovs)
    if rules:
        save_custom_sources(rules)
    subs = load_comic_subs()
    for s in subs:
        if s["url"] == url:
            s["last_sync"] = time.time()
            s["count"] = applied
            s["pending"] = None
            s["status"] = f"已同步({applied} 个地址修正)"
            break
    save_comic_subs(subs)
    return {"ok": True, "count": applied, "skipped": skipped}


# ---------------- 对外统一入口(按 source 分发) ----------------
_CN_SOURCES = ("copymanga", "dmzj", "manhuadb", "ccmh")  # 中文源:直接原词搜索
_CIMOC_SOURCES = ("dmzj", "manhuadb", "ccmh", "dm5", "baozimh", "mangagg", "mangapill",
                  "weebcentral")     # 规则引擎托管源


def search(keyword: str, limit: int = 20, source: str = "mangadex") -> list[dict]:
    """搜索漫画 → [{id, title, cover, lang, desc}]。

    复用小说 fuzzy 搜索容错:关键词自动生成变体序列(中文数字↔阿拉伯、
    拼音反查中文、别名),按"中文优先"顺序逐词尝试,首词无结果自动换变体。
    中文站(拷贝漫画/动漫之家/漫画DB/CC漫画)直接原词搜索,不走变体(变体反而降准)。
    """
    _check_source(source)
    if source == "copymanga":
        return copymanga_search(keyword, limit)
    if source in _CIMOC_SOURCES:
        # 优先规则引擎;引擎抛错时回退手写实现(两套并存,互为校验)
        try:
            return _cimoc(source).search(keyword, limit)
        except Exception:  # noqa: BLE001
            if source == "dmzj":
                return dmzj_search(keyword, limit)
            if source == "manhuadb":
                return manhuadb_search(keyword, limit)
            if source == "ccmh":
                return ccmh_search(keyword, limit)
            raise
    if _custom_rule(source):  # 自定义源:纯规则引擎,无手写回退
        return _cimoc(source).search(keyword, limit)
    try:
        from .fuzzy import build_search_queries
        queries = build_search_queries(keyword)
    except Exception:  # noqa: BLE001 fuzzy 不可用时退化为原关键词
        queries = [keyword]
    if not queries:
        queries = [keyword]
    for q in queries:
        res = _md_search(q, limit)
        if res:
            return res
    return []


def chapters(manga_id: str, source: str = "mangadex",
             langs: tuple = ("zh", "zh-hk", "zh-cn", "en")) -> list[dict]:
    """漫画章节(话)列表 → [{id, volume, chapter, title, lang}]。"""
    _check_source(source)
    if source == "copymanga":
        return copymanga_chapters(manga_id)
    if source in _CIMOC_SOURCES:
        try:
            return _cimoc(source).chapters(manga_id)
        except Exception:  # noqa: BLE001
            if source == "dmzj":
                return dmzj_chapters(manga_id)
            if source == "manhuadb":
                return manhuadb_chapters(manga_id)
            if source == "ccmh":
                return ccmh_chapters(manga_id)
            raise
    if _custom_rule(source):
        return _cimoc(source).chapters(manga_id)
    return _md_chapters(manga_id, langs)


def pages(chapter_id: str, source: str = "mangadex", comic_id: str = "") -> list[str]:
    """章节页图片完整 URL 列表。copymanga 需 comic_id(漫画 path_word);
    动漫之家 chapter_id 形如 'comic_id/chapter_id';漫画DB/CC漫画需 comic_id+ep_id。"""
    _check_source(source)
    if source == "copymanga":
        return copymanga_pages(comic_id or chapter_id, chapter_id)
    if source in _CIMOC_SOURCES:
        try:
            return _cimoc(source).pages(comic_id, chapter_id)
        except Exception:  # noqa: BLE001
            if source == "dmzj":
                return dmzj_pages(chapter_id)
            if source == "manhuadb":
                return manhuadb_pages(comic_id, chapter_id)
            if source == "ccmh":
                return ccmh_pages(comic_id, chapter_id)
            raise
    if _custom_rule(source):
        return _cimoc(source).pages(comic_id, chapter_id)
    return _md_pages(chapter_id)


def check_updates(comic_id: str, source: str = "mangadex", title: str = "") -> dict:
    """检查漫画更新:拉最新目录,对比本地已下载话数。

    返回 {ok, total, have, new};have 基于本地 COMIC_OUT_DIR/<书名>/ 下 PDF 数。
    """
    from .downloader import safe_filename
    from .paths import COMIC_OUT_DIR
    try:
        chs = chapters(comic_id, source=source)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    total = len(chs)
    have = 0
    if title:
        book_dir = os.path.join(COMIC_OUT_DIR, safe_filename(title))
        try:
            if os.path.isdir(book_dir):
                have = len([f for f in os.listdir(book_dir) if f.lower().endswith(".pdf")])
        except OSError:
            pass
    return {"ok": True, "total": total, "have": have, "new": max(0, total - have)}


_fetcher: "Fetcher | None" = None


def _get_fetcher() -> "Fetcher":
    """懒加载共享 fetcher(复用小说防封链路:UA 池/延迟/退避/代理/验证 cookies)。

    图片下载的节流主要交给 fetcher 内的按域名自适应限速(throttle):
    并发闸门 + 最小间隔 + 命中 429/503/210 后整站退避。
    """
    global _fetcher
    if _fetcher is None:
        from .fetcher import Fetcher
        _fetcher = Fetcher(min_delay=0.15, max_delay=0.5, max_retries=3)
    return _fetcher


# 单图最大下载轮次:每轮内部还有 fetcher 的指数退避重试(2 次),
# 全部轮次后仍有失败 → 整话标记失败(不落盘不记完成),重新下载续传重试直到成功,杜绝静默掉图
_IMG_RETRY_ROUNDS = 4

# 整话失败后的自动重试轮次与逐轮冷却(限流/网络抖动重试;仍失败才如实上报)
_CH_PASSES = 3
_CH_RETRY_WAIT = 6.0


def _download_image(url: str, timeout: int = 30,
                    referer: str = _MD_IMG_REFERER, cancel_check=None,
                    group: str | None = None) -> bytes:
    """下载单张漫画图(带源 Referer 防盗链)。

    走共享 fetcher:UA 池轮换 + 按域名自适应限速(并发闸门 + 最小间隔 +
    命中限流退避)+ 指数退避重试 + 代理 + 401/403 自动带验证中心 cookies。

    并且**校验内容确实是图片**(expect_image):站点限流时返回的
    "访问过于频繁" HTML/JSON 占位页会被判为失败并重试,不会当成漫画页塞进
    PDF(旧实现只判大小 >1000 字节,错误页会被静默采信)。
    最终失败返回 b""(不抛异常):pool.map 中单图失败不拖垮整批,
    由上层多轮补下 + 整话重试决定成败;用户取消时原样抛出 DownloadCancelled。
    """
    try:
        return _get_fetcher().fetch_bytes(
            url, headers={"Referer": referer}, timeout=timeout,
            cancel_check=cancel_check, group=group, expect_image=True)
    except DownloadCancelled:
        raise
    except Exception:  # noqa: BLE001
        return b""


# PDF 图片质量档位 → (长边上限 px, JPEG 质量);original 不压缩
_PDF_QUALITY = {"original": None, "hq": (2000, 80), "eco": (1600, 70)}


def _shrink_image(data: bytes, quality: str = "hq") -> bytes:
    """按档位压缩单张图(长边缩放 + JPEG 重编码)。失败/原图档原样返回,不影响下载流程。"""
    spec = _PDF_QUALITY.get(quality if quality in _PDF_QUALITY else "hq")
    if spec is None or not data:
        return data
    max_edge, q = spec
    try:
        import io as _io
        from PIL import Image
        im = Image.open(_io.BytesIO(data))
        im.seek(0)  # 动图 webp/gif 取首帧
        if (im.width <= max_edge and im.height <= max_edge
                and (im.format or "").upper() == "JPEG"):
            return data  # 尺寸达标且已是 JPEG,跳过重编码
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")  # CMYK/RGBA/调色板统一转 RGB
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        out = _io.BytesIO()
        im.save(out, "JPEG", quality=q, optimize=True)
        return out.getvalue()
    except Exception:  # noqa: BLE001
        return data


def _to_pdf(images: list[bytes]) -> bytes:
    """多张图 → 单 PDF 字节(保留原图尺寸)。压缩由调用方按 pdf_quality 档预处理。"""
    import img2pdf
    streams = [io.BytesIO(d) for d in images]
    return img2pdf.convert(streams, layout_fun=img2pdf.get_layout_fun(None))


def white_page_jpeg() -> bytes:
    """A4 比例白页 JPEG(1200×1697),无图/损坏页占位,保持页序可见。"""
    from PIL import Image
    im = Image.new("RGB", (1200, 1697), (255, 255, 255))
    out = io.BytesIO()
    im.save(out, "JPEG", quality=80)
    return out.getvalue()


def page_image(page) -> bytes:
    """取 pypdf 页对象里最大的内嵌图并统一成 JPEG;无图/损坏页返回白页占位。

    JPEG 原样透传零重编码,其他格式(JBIG2/Flate/PNG)用 PIL 兜底转 JPEG。
    网页逐页请求与手机离线包导出共用,保证两端出图完全一致。"""
    from PIL import Image
    data = b""
    try:
        best = b""
        for im in page.images:
            if len(im.data) > len(best):
                best = im.data
        data = best
    except Exception:  # noqa: BLE001
        data = b""
    if data and data[:2] != b"\xff\xd8":
        try:
            im = Image.open(io.BytesIO(data))
            im.seek(0)  # 动图取首帧
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            out = io.BytesIO()
            im.save(out, "JPEG", quality=85, optimize=True)
            data = out.getvalue()
        except Exception:  # noqa: BLE001
            data = b""
    return data or white_page_jpeg()


def page_jpeg(src: str, page_no: int) -> bytes:
    """按页码(1-based)抽取单页 JPEG,页码越界同样返回白页。"""
    from pypdf import PdfReader
    try:
        pages = PdfReader(src).pages
        if 1 <= page_no <= len(pages):
            return page_image(pages[page_no - 1])
    except Exception:  # noqa: BLE001
        pass
    return white_page_jpeg()


def compress_comic_pdf(src: str, dst: str, quality: str = "hq") -> None:
    """压缩存量漫画 PDF:逐页抽取最大内嵌图 → _shrink_image 重编码 → img2pdf 重建。

    服务于 pdf_quality 功能上线前下载的旧 PDF;无图页用白页占位保持页数,
    src 原样保留,输出写入 dst(调用方负责命名,一般为「原名_压缩.pdf」)。"""
    from pypdf import PdfReader
    reader = PdfReader(src)
    images: list[bytes] = []
    for page in reader.pages:
        best = b""
        try:
            for im in page.images:
                if len(im.data) > len(best):
                    best = im.data
        except Exception:  # noqa: BLE001
            best = b""
        images.append(_shrink_image(best, quality) if best else white_page_jpeg())
    with open(dst, "wb") as f:
        f.write(_to_pdf(images))


def split_comic_pdf(src: str, pages_per_part: int = 50, out_dir: str | None = None) -> list[str]:
    """把大 PDF 按固定页数拆为多卷,输出「原名_拆N.pdf」,原文件与图片数据原样保留。

    pypdf 直接复制页面流,不重编码不损画质;返回输出文件路径列表。"""
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(src)
    total = len(reader.pages)
    base = os.path.splitext(os.path.basename(src))[0]
    out_dir = out_dir or os.path.dirname(src) or "."
    outs: list[str] = []
    start = 0
    idx = 0
    while start < total:
        idx += 1
        end = min(start + pages_per_part, total)
        w = PdfWriter()
        for p in range(start, end):
            w.add_page(reader.pages[p])
        out = os.path.join(out_dir, f"{base}_拆{idx}.pdf")
        with open(out, "wb") as f:
            w.write(f)
        outs.append(out)
        start = end
    return outs


def split_comic_pdf_chapters(src: str, chapters: list[dict],
                             out_dir: str | None = None) -> tuple[list[dict], int]:
    """按章节页区间拆分合集 PDF(merged meta 的 chapters:first_page/last_page,1-based 闭区间)。

    输出「{label}.pdf」(与 per_chapter 下载命名一致);pypdf 原样复制页面流不损画质;
    目标文件已存在则跳过(绝不覆盖既有文件),原文件不动。
    返回 (拆分信息 [{label, file, pages}], 跳过数[已存在或区间非法])。"""
    from pypdf import PdfReader, PdfWriter
    from .downloader import safe_filename
    reader = PdfReader(src)
    total = len(reader.pages)
    out_dir = out_dir or os.path.dirname(src) or "."
    made: list[dict] = []
    skipped = 0
    for c in chapters:
        try:
            fp = int(c.get("first_page") or 0)
            lp = int(c.get("last_page") or 0)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if fp < 1 or lp < fp:
            skipped += 1
            continue
        fp = min(fp, total)
        lp = min(lp, total)
        name = safe_filename(c.get("label") or f"第{fp}页") + ".pdf"
        out = os.path.join(out_dir, name)
        if os.path.exists(out):
            skipped += 1
            continue
        w = PdfWriter()
        for p in range(fp - 1, lp):
            w.add_page(reader.pages[p])
        with open(out, "wb") as f:
            w.write(f)
        made.append({"label": c.get("label") or "", "file": name, "pages": lp - fp + 1})
    return made, skipped


def build_split_meta(meta: dict, made: list[dict]) -> dict:
    """由拆分结果构建 per_chapter 版 meta(供阅读器目录按章节呈现拆分产物)。

    仅收录实际产出文件的话;卷分组沿用原 meta.volumes,原 meta.json 不受影响。"""
    m = {d["label"]: d for d in made}
    volumes: list[dict] = []
    for v in meta.get("volumes") or []:
        chs = []
        for c in v.get("chapters") or []:
            d = m.get(c.get("label") or "")
            if d:
                chs.append({"chapter": c.get("chapter"), "title": c.get("title"),
                            "label": c.get("label"), "pdf": d["file"], "pages": d["pages"]})
        if chs:
            volumes.append({"volume": v.get("volume"), "chapters": chs})
    chapters = [c for v in volumes for c in v["chapters"]]
    return {"mode": "per_chapter", "chapters": chapters, "volumes": volumes}


def img_referer(source: str = "mangadex") -> str:
    """各源图片防盗链 Referer(下载与在线阅读代理共用)。"""
    if source in _CIMOC_SOURCES:
        try:
            return _cimoc(source).rule.get("referer", _MD_IMG_REFERER)
        except Exception:  # noqa: BLE001
            pass
    return {
        "mangadex": _MD_IMG_REFERER,
        "copymanga": _COPY_IMG_REFERER,
        "dmzj": _DMZJ_IMG_REFERER,
        "manhuadb": _MDB_IMG_REFERER,
        "ccmh": _CCMH_IMG_REFERER,
    }.get(source, _MD_IMG_REFERER)


def _img_group(url: str, source: str) -> str | None:
    """图片下载的限速分组。

    拷贝漫画的 210(访问过频)是**站级**限制,API 与图片 CDN 同源受限,
    所以整站图片共用一个限速桶;其他源返回 None 由 throttle 按主机名分桶。
    """
    return "copymanga-img" if source == "copymanga" else None


def download_comic(
    manga_title: str,
    chapter_list: list[dict],
    out_dir: str,
    *,
    on_log=None,
    on_progress=None,
    cancel_check=None,
    img_workers: int = 6,
    source: str = "mangadex",
    manga_id: str = "",
    mode: str = "per_chapter",
    pdf_quality: str = "hq",
    stats: dict | None = None,
) -> list[str]:
    """下载选中话并打包。

    mode:
      - per_chapter: 每话一个 PDF(默认)
      - merged:      全部选中话融合为一个 PDF(整本)
      - zip:         图片按话目录打进 ZIP
    pdf_quality: PDF 图片质量 original/hq/eco(merged/zip 时图片缓存也按该档压缩)
    断点续传:merged/zip 先把每话图缓存到 <书名目录>/.raw/,全部完成后打包,
    重跑时已缓存的话跳过;per_chapter 保持原"每话 PDF + 已完成话跳过"。

    限流韧性(访问过频下会"下重复/下漏页",故做了这几层保障):
      * 图片请求走共享 fetcher 的按域名自适应限速(并发闸门 + 最小间隔 +
        命中 429/503/210 后退避),不再对同一站点全速猛打
      * 图片内容校验:限流占位页/HTML/JSON 错误页判定为失败并补下,
        不会把错误页当成漫画页写进 PDF(重复页来源之一)
      * 图片列表去重:同一页出现两个地址时只保留一个
      * MangaDex 自定义 CDN 图失败时按文件名回退官方节点
      * 整话失败不静默丢弃:整轮自动重试 _CH_PASSES 轮(逐轮加长冷却),
        仍失败才记入 stats["failed"],由上层如实报"完成 N/M 话"
      * 同话标签重复时自动加 (2)/(3) 后缀,meta 以章节 id 为键,
        避免同名话互相覆盖(重复下载 + meta 丢话来源)

    stats: 传入 dict 时,函数结束写入 {total, done, failed:[{idx,label,reason}],
           made, mode} 供调用方如实上报进度/缺失话。
    """
    import time as _t
    from .downloader import safe_filename

    if mode not in ("per_chapter", "merged", "zip"):
        mode = "per_chapter"

    def _log(msg: str) -> None:
        if on_log:
            on_log(msg)

    book_dir = os.path.join(out_dir, safe_filename(manga_title or "manga"))
    os.makedirs(book_dir, exist_ok=True)
    partial_path = os.path.join(book_dir, ".partial.json")
    raw_dir = os.path.join(book_dir, ".raw")

    # 断点续传:恢复已完成话
    done_ids: set[str] = set()
    done_counts: dict[str, int] = {}  # 每话完成页数,续传时校验缓存完整性
    if os.path.isfile(partial_path):
        try:
            with open(partial_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("done"), list):
                done_ids = set(str(x) for x in data["done"])
                if isinstance(data.get("counts"), dict):
                    done_counts = {str(k): int(v) for k, v in data["counts"].items()}
                if done_ids:
                    _log(f"  ↻ 断点续传:跳过 {len(done_ids)} 个已完成话")
        except Exception:  # noqa: BLE001
            done_ids = set()

    def _save_partial() -> None:
        try:
            with open(partial_path, "w", encoding="utf-8") as f:
                json.dump({"done": sorted(done_ids), "counts": done_counts},
                          f, ensure_ascii=False)
        except Exception:  # noqa: BLE001
            pass

    ref = img_referer(source)
    made: list[str] = []
    fail_reason: dict[str, str] = {}   # meta 键 → 最终失败原因

    # ---- 选中话按 id 去重:目录里同一话出现两次(站点"短篇合集"常见)会让
    # merged/zip 装进重复页、meta 互相覆盖 —— 这是"下重复"的直接来源 ----
    chapters: list[dict] = []
    seen_ids: set[str] = set()
    dup_items = 0
    for ch in chapter_list:
        cid = str(ch.get("id") or "")
        if cid and cid in seen_ids:
            dup_items += 1
            continue
        if cid:
            seen_ids.add(cid)
        chapters.append(ch)
    if dup_items:
        _log(f"  ⚠ 选中话里有 {dup_items} 个重复条目(同章节 id),已合并为一话")
    total = len(chapters)

    # ---- 每话 spec:唯一标签 / 图缓存目录 / meta 键 ----
    used_labels: set[str] = set()
    specs: list[tuple[int, dict, str, str, str]] = []
    for i, ch in enumerate(chapters, 1):
        label = _chapter_label(ch, i)
        if label in used_labels:  # 同名话(不同分组/卷常有同名)加后缀,避免互相覆盖
            n = 2
            while f"{label} ({n})" in used_labels:
                n += 1
            label = f"{label} ({n})"
        used_labels.add(label)
        ch_dir = (os.path.join(raw_dir, f"{i:03d}_{safe_filename(label)}")
                  if mode != "per_chapter" else "")
        key = str(ch.get("id") or "") or label
        specs.append((i, ch, label, ch_dir, key))
    if len(used_labels) != len(chapters):
        _log(f"  ⚠ 选中话里有重名标签,已自动加序号区分({len(chapters)} 话)")

    done_cnt = len(done_ids)
    # 分卷元数据:meta 键 -> {label, pdf, volume, chapter, title, pages, cid}
    meta_entries: dict[str, dict] = {}
    meta_prev: dict = {}
    meta_path = os.path.join(book_dir, "meta.json")
    if mode in ("per_chapter", "merged") and os.path.isfile(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                mp = json.load(f)
            if mp.get("mode") == mode and isinstance(mp.get("chapters"), list):
                for e in mp["chapters"]:
                    # 以章节 id 为键(旧版以 label 为键,重名会互相覆盖 → 这里自动迁移)
                    k = str(e.get("cid") or e.get("id") or e.get("label") or "")
                    if k:
                        meta_prev[k] = e
                meta_entries = dict(meta_prev)
        except Exception:  # noqa: BLE001
            pass
    chapter_dirs: list[tuple[str, str]] = []  # merged/zip:(话label, 图缓存目录)

    # ---- 校验已完成话的产出完整性,不完整则剔除重下 ----
    for i, ch, label, ch_dir, key in specs:
        if key not in done_ids:
            continue
        redo = False
        if mode != "per_chapter":
            need = done_counts.get(key, 0)
            have = len(os.listdir(ch_dir)) if os.path.isdir(ch_dir) else 0
            redo = have < need
        else:
            redo = not os.path.isfile(
                os.path.join(book_dir, f"{safe_filename(label)}.pdf"))
        if redo:
            done_ids.discard(key)
            done_cnt = len(done_ids)
        else:
            if mode != "per_chapter":
                chapter_dirs.append((label, ch_dir))
            if on_progress:
                on_progress(done_cnt, total, label)

    todo = [s for s in specs if s[4] not in done_ids]

    def _one_chapter(i: int, ch: dict, label: str, ch_dir: str, key: str):
        """下载并产出单话;返回 (是否成功, 失败原因)。"""
        nonlocal done_cnt
        _log(f"  ▶ 第 {i}/{total} 话 {label}:解析图片…")
        try:
            urls = pages(ch["id"], source=source, comic_id=manga_id)
        except BaseException as exc:  # noqa: BLE001
            if isinstance(exc, (DownloadCancelled, CopyBlocked)):
                raise  # 取消 / 站级封禁:整轮终止,不再对同一站继续请求
            _log(f"  ✗ 第 {i} 话图片列表失败: {type(exc).__name__}: {exc}")
            if on_progress:
                on_progress(done_cnt, total, label, err=True)
            return False, f"图片列表失败({type(exc).__name__}: {exc})"
        if not urls:
            _log(f"  ⚠ 第 {i} 话无图片")
            if on_progress:
                on_progress(done_cnt, total, label, err=True)
            return False, "图片列表为空"
        # 去重:同一页出现两个地址会产生重复页
        seen_u: set[str] = set()
        uniq: list[str] = []
        for u in urls:
            if u and u not in seen_u:
                seen_u.add(u)
                uniq.append(u)
        if len(uniq) != len(urls):
            _log(f"  ⚠ 第 {i} 话图片列表含 {len(urls) - len(uniq)} 个重复地址,已去重")
        urls = uniq
        prev_n = done_counts.get(key, 0)
        if prev_n and prev_n != len(urls):
            _log(f"  ⚠ 第 {i} 话页数与此前记录不同({prev_n} → {len(urls)}),以最新列表为准")

        # MangaDex 自定义 CDN 失败 → 官方节点兜底(按文件名对应,避免顺序错位)
        fb_by_file: dict[str, str] = {}
        if source == "mangadex" and _md_custom_cdns():
            try:
                for u in _md_pages(ch["id"], use_custom_cdn=False):
                    fb_by_file[u.rsplit("/", 1)[-1]] = u
            except Exception:  # noqa: BLE001
                fb_by_file = {}

        pending = list(enumerate(urls))

        def _dl_round(items: list[tuple[int, str]], use_fb: bool = False) -> dict[int, bytes]:
            """并发下载一批图,返回 {序号: bytes};失败/过小/非图片内容不入结果。"""
            if not items:
                return {}
            grp = _img_group(items[0][1], source)

            def _one(t):
                i2, u = t
                d = _download_image(u, referer=ref, cancel_check=cancel_check, group=grp)
                if not d and use_fb:
                    alt = fb_by_file.get(u.rsplit("/", 1)[-1])
                    if alt:
                        d = _download_image(alt, referer=ref, cancel_check=cancel_check,
                                            group=_img_group(alt, source))
                return d

            with ThreadPoolExecutor(max_workers=max(1, int(img_workers))) as pool:
                datas = list(pool.map(_one, items))
            return {i3: d for (i3, _u), d in zip(items, datas) if d and len(d) > 1000}

        # 并发下载图片:失败图多轮补下,杜绝静默掉图
        img_map = _dl_round(pending)
        if not img_map and fb_by_file:
            _log("  ↻ 自定义 CDN 全部失败,回退官方节点重试…")
            img_map = _dl_round(pending, use_fb=True)
        for rnd in range(1, _IMG_RETRY_ROUNDS):
            missing = [(i2, u) for i2, u in pending if i2 not in img_map]
            if not missing:
                break
            _log(f"  ↻ 第 {rnd} 轮补下失败图({len(missing)} 张)…")
            _throttle.sleep_cancellable(1.5 * rnd, cancel_check)
            img_map.update(_dl_round(missing, use_fb=bool(fb_by_file)))
        if len(img_map) < len(urls):
            _log(f"  ✗ 第 {i} 话图片不全({len(img_map)}/{len(urls)}),"
                 f"已补下 {_IMG_RETRY_ROUNDS - 1} 轮,稍后整话自动重试(不落盘、不记完成)")
            if on_progress:
                on_progress(done_cnt, total, label, err=True)
            return False, f"图片不全({len(img_map)}/{len(urls)})"
        valid = [img_map[k] for k in sorted(img_map)]
        try:
            if mode == "per_chapter":
                pdf = _to_pdf([_shrink_image(d, pdf_quality) for d in valid])
                fpath = os.path.join(book_dir, f"{safe_filename(label)}.pdf")
                with open(fpath, "wb") as f:
                    f.write(pdf)
                made.append(fpath)
                meta_entries[key] = {
                    "cid": key, "label": label, "pdf": os.path.basename(fpath),
                    "volume": (ch.get("volume") or "").strip(),
                    "chapter": (ch.get("chapter") or "").strip(),
                    "title": (ch.get("title") or "").strip(),
                    "pages": len(valid),
                }
                _log(f"  ✓ 第 {i}/{total} 话 {label}({len(valid)} 页)")
            else:
                # 清掉上次残留缓存(避免图数/内容对不上),再写入本轮全部图
                if os.path.isdir(ch_dir):
                    shutil.rmtree(ch_dir, ignore_errors=True)
                os.makedirs(ch_dir, exist_ok=True)
                for k, d in enumerate(valid, 1):
                    with open(os.path.join(ch_dir, f"img{k:04d}.jpg"), "wb") as f:
                        f.write(_shrink_image(d, pdf_quality))
                chapter_dirs.append((label, ch_dir))
                meta_entries[key] = {
                    "cid": key, "label": label, "pdf": "",
                    "volume": (ch.get("volume") or "").strip(),
                    "chapter": (ch.get("chapter") or "").strip(),
                    "title": (ch.get("title") or "").strip(),
                    "pages": len(valid),
                }
                _log(f"  ✓ 第 {i}/{total} 话 {label}({len(valid)} 页,已缓存)")
        except BaseException as exc:  # noqa: BLE001
            if isinstance(exc, DownloadCancelled):
                raise
            _log(f"  ✗ 第 {i} 话处理失败: {type(exc).__name__}: {exc}")
            if on_progress:
                on_progress(done_cnt, total, label, err=True)
            return False, f"处理失败({type(exc).__name__}: {exc})"  # 未落盘未记完成,可续传重试
        done_counts[key] = len(valid)
        done_ids.add(key)
        done_cnt = len(done_ids)
        if on_progress:
            on_progress(done_cnt, total, label)
        _save_partial()  # 每话落盘:中断任意时刻都能续传
        return True, ""

    # ---- 多轮补下:整话失败(限流/网络)时自动重试,不静默丢话 ----
    for pass_no in range(1, _CH_PASSES + 1):
        if not todo:
            break
        if pass_no > 1:
            wait = _CH_RETRY_WAIT * (pass_no - 1)
            _log(f"  ↻ 第 {pass_no} 轮:重试 {len(todo)} 个失败话"
                 f"(等 {wait:.0f}s 让站点限流冷却)…")
            _throttle.sleep_cancellable(wait, cancel_check)
        nxt = []
        for i, ch, label, ch_dir, key in todo:
            if cancel_check:
                try:
                    cancel_check()
                except BaseException:
                    _save_partial()  # 取消/中断前落盘进度,保证断点续传可用
                    raise
            try:
                ok, reason = _one_chapter(i, ch, label, ch_dir, key)
            except BaseException as exc:  # noqa: BLE001
                if isinstance(exc, (DownloadCancelled, CopyBlocked)):
                    _save_partial()
                    raise  # 站级封禁:立即上报(继续跑只会重复撞墙),已完成的进度仍可续传
                ok, reason = False, f"{type(exc).__name__}: {exc}"
                _log(f"  ✗ 第 {i} 话异常: {reason}")
            if not ok:
                fail_reason[key] = reason
                nxt.append((i, ch, label, ch_dir, key))
        todo = nxt
    _save_partial()

    # ---- merged / zip:全部话就绪后统一打包(严格按选中话序,避免续传后页序错乱) ----
    if mode in ("merged", "zip"):
        ordered_dirs: list[tuple[str, str]] = []
        for i, ch, label, ch_dir, key in specs:
            if key in fail_reason:
                continue
            if ch_dir and os.path.isdir(ch_dir) and os.listdir(ch_dir):
                ordered_dirs.append((label, ch_dir))
        if len(ordered_dirs) != len(specs):
            _log(f"  ⚠ 有 {len(specs) - len(ordered_dirs)} 话未产出,"
                 f"打包仅包含成功的 {len(ordered_dirs)} 话")
        chapter_dirs = ordered_dirs
        if chapter_dirs:
            try:
                if mode == "merged":
                    all_imgs: list[bytes] = []
                    for _label, cd in chapter_dirs:
                        for fn in sorted(os.listdir(cd)):
                            try:
                                with open(os.path.join(cd, fn), "rb") as f:
                                    all_imgs.append(f.read())
                            except OSError:
                                pass
                    if all_imgs:
                        pdf = _to_pdf(all_imgs)
                        fpath = os.path.join(book_dir, f"{safe_filename(manga_title or 'manga')}_合集.pdf")
                        with open(fpath, "wb") as f:
                            f.write(pdf)
                        made.append(fpath)
                        _pdf_name = os.path.basename(fpath)
                        for _e in meta_entries.values():
                            _e["pdf"] = _pdf_name
                        _log(f"  ✓ 融合打包完成: {os.path.basename(fpath)}(共 {len(all_imgs)} 页)")
                else:  # zip
                    import zipfile as _zipfile
                    zpath = os.path.join(book_dir, f"{safe_filename(manga_title or 'manga')}.zip")
                    with _zipfile.ZipFile(zpath, "w", _zipfile.ZIP_DEFLATED) as zf:
                        for _label, cd in chapter_dirs:
                            for fn in sorted(os.listdir(cd)):
                                zf.write(os.path.join(cd, fn), f"{safe_filename(_label)}/{fn}")
                    made.append(zpath)
                    _log(f"  ✓ ZIP 打包完成: {os.path.basename(zpath)}({len(chapter_dirs)} 话)")
            except Exception as exc:  # noqa: BLE001
                _log(f"  ✗ 融合/ZIP 打包失败: {type(exc).__name__}: {exc}")
            finally:
                import shutil as _sh
                try:
                    if os.path.isdir(raw_dir):
                        _sh.rmtree(raw_dir)
                except OSError:
                    pass
        else:
            _log("  ⚠ 无成功下载的话,未生成融合/ZIP 包")

    # 全部选中话都成功才清理续传文件(有失败话则保留,便于重跑续传)
    if done_cnt >= total and not fail_reason:
        try:
            os.remove(partial_path)
        except OSError:
            pass
    # 分卷元数据落盘(per_chapter/merged):供本地 PDF 阅读按卷跳转
    if mode in ("per_chapter", "merged") and meta_entries:
        try:
            # 严格按"本次选中话序"排列;per_chapter 额外保留历史遗留话(不在本次列表内)
            chapters: list[dict] = []
            placed: set[str] = set()
            for i, ch, label, ch_dir, key in specs:
                e = meta_entries.get(key)
                if e and key not in placed:
                    if mode == "merged" and key in fail_reason:
                        continue  # 未进 PDF 的话不能出现在目录里(页码会错位)
                    chapters.append(e)
                    placed.add(key)
            if mode == "per_chapter":
                for k, e in meta_entries.items():
                    if k not in placed:
                        chapters.append(e)
                        placed.add(k)
            if mode == "merged":
                acc = 0
                volumes: dict[str, dict] = {}
                vorder: list[str] = []
                for e in chapters:
                    v = e["volume"] or ""
                    if v not in volumes:
                        volumes[v] = {"volume": v, "first_page": acc + 1, "chapters": []}
                        vorder.append(v)
                    volumes[v]["chapters"].append({
                        "chapter": e["chapter"], "title": e["title"],
                        "label": e["label"], "first_page": acc + 1,
                        "last_page": acc + e["pages"],
                    })
                    acc += e["pages"]
                for v in vorder:
                    # 逐卷收尾页:该卷末话的 last_page(旧实现统一写成总页数,
                    # 多卷时前面几卷的区间会一直延伸到全书末尾 → 阅读器按卷跳转错位)
                    volumes[v]["last_page"] = volumes[v]["chapters"][-1]["last_page"]
                meta = {
                    "mode": "merged",
                    "pdf": chapters[0]["pdf"] if chapters else "",
                    "total_pages": acc,
                    "chapters": chapters,
                    "volumes": [volumes[v] for v in vorder],
                }
            else:
                volumes: dict[str, dict] = {}
                vorder: list[str] = []
                for e in chapters:
                    v = e["volume"] or ""
                    if v not in volumes:
                        volumes[v] = {"volume": v, "chapters": []}
                        vorder.append(v)
                    volumes[v]["chapters"].append({
                        "chapter": e["chapter"], "title": e["title"],
                        "label": e["label"], "pdf": e["pdf"], "pages": e["pages"],
                    })
                meta = {
                    "mode": "per_chapter",
                    "chapters": chapters,
                    "volumes": [volumes[v] for v in vorder],
                }
            with open(meta_path, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=1)
            _log(f"  ✓ 已生成分卷元数据 meta.json({len(meta['volumes'])} 卷)")
        except Exception as exc:  # noqa: BLE001
            _log(f"  ⚠ meta.json 写入失败: {exc}")

    failed = [i for i, ch, label, ch_dir, key in specs if key in fail_reason]
    if failed:
        shown = "、".join(
            f"第{i}话({fail_reason[key][:28]})"
            for i, ch, label, ch_dir, key in specs if key in fail_reason)
        _log(f"  ⚠ 失败 {len(failed)} 话: {failed[:10]}{'…' if len(failed) > 10 else ''}"
             f"(已自动重试 {_CH_PASSES} 轮,可重新下载续传)")
        _log(f"  ⚠ 失败原因: {shown}")
    if stats is not None:
        stats.clear()
        stats.update({
            "total": total,
            "done": len([s for s in specs if s[4] in done_ids]),
            "failed": [{"idx": i, "label": label, "reason": fail_reason[key]}
                       for i, ch, label, ch_dir, key in specs if key in fail_reason],
            "made": list(made),
            "mode": mode,
        })
    return made


def _chapter_label(ch: dict, idx: int) -> str:
    """话的文件名标签:优先 第N话,有卷号则带卷号。"""
    vol = (ch.get("volume") or "").strip()
    chap = (ch.get("chapter") or "").strip()
    title = (ch.get("title") or "").strip()
    if chap:
        label = f"第{chap}话"
        if title:
            label += f" {title}"
    elif title:
        label = title
    else:
        label = f"第{idx}话"
    if vol:
        label = f"第{vol}卷 {label}"
    return label

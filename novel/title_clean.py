# -*- coding: utf-8 -*-
"""书名清洗:去除 ".txt全集下载 / 全文阅读 / 最新章节" 等噪音后缀,用于结果按书聚合。"""
import re

# 噪音后缀词表(仅长词,避免误删正常书名;按长度降序由调用方排序使用)
NOISE_SUFFIX = [
    "txt全集下载", "txt小说下载", "txt全集阅读", "txt全文阅读", "txt电子书",
    "txt全集", "txt下载", "txt阅读",
    "全集下载", "全文阅读", "最新章节列表", "最新章节", "免费阅读",
    "无弹窗阅读", "无弹窗", "手机阅读", "在线阅读", "小说下载",
    "全集阅读", "全文免费阅读", "完本", "全本", "电子书下载",
]

# 尾部残留的标点/空白/分隔符
_TAIL_JUNK = re.compile(r"[\s_\-—·,，。.；;：:!！?？'\"“”‘’()（）\[\]【】]+$")


def clean_book_title(title: str) -> str:
    """清洗书名:剥离噪音后缀与残留标点。返回空串表示书名无效。"""
    t = (title or "").strip()
    if not t:
        return t
    # 0) 先清尾部标点,让噪音词暴露出来
    t = _TAIL_JUNK.sub("", t).strip()
    # 1) .txt 后缀
    low = t.lower()
    if low.endswith(".txt") and len(t) > 5:
        t = t[: -4].strip()
        low = t.lower()
    # 2) 迭代剥离长噪音词(仅当剥离后仍有足够长度,避免删光)
    changed = True
    while changed and len(t) > 2:
        changed = False
        for n in sorted(NOISE_SUFFIX, key=len, reverse=True):
            if len(t) > len(n) + 1 and low.endswith(n):
                t = t[: -len(n)].strip()
                low = t.lower()
                changed = True
                break
    # 3) 再清一次尾部残留标点
    t = _TAIL_JUNK.sub("", t).strip()
    return t

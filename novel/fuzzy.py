# -*- coding: utf-8 -*-
"""
模糊搜索模块
============
需求核心:用户输入 "harry potter" 能命中中文站里的《哈利·波特》。
实现手段:
  1. 关键词归一化:小写、去空白与标点、全角转半角
  2. 内置"知名作品中英别名映射表"(可自行扩充)
  3. 逐词匹配(输入含多个词时,映射词也做同样的词级匹配)
  4. 中文变体扩展:哈利波特 / 哈利·波特 / 哈利.波特 / 哈利 波特 互相等价
"""
from __future__ import annotations

import re
import unicodedata

# ---------------------------------------------------------------------------
# 知名作品中英名称映射表(可自行扩充)
# 格式: 归一化英文名 -> (中文名, 别名列表)
# ---------------------------------------------------------------------------
ALIAS_MAP: dict[str, tuple[str, list[str]]] = {
    "harrypotter": ("哈利波特", ["哈利·波特", "哈利.波特", "哈利 波特", "哈利波特全集", "哈利波特与魔法石"]),
    "harrypotterandthephilosophersstone": ("哈利波特与魔法石", ["哈利波特与魔法石", "哈利波特1"]),
    "harrypotterandthedeathlyhallows": ("哈利波特与死亡圣器", ["哈利波特与死亡圣器", "哈利波特7"]),
    "lordoftherings": ("指环王", ["魔戒", "指环王", "魔戒之王"]),
    "thehobbit": ("霍比特人", ["霍比特人", "魔戒前传"]),
    "thehobbits": ("霍比特人", ["霍比特人", "魔戒前传"]),
    "gameofthrones": ("冰与火之歌", ["冰与火之歌", "权力的游戏"]),
    "asongoficeandfire": ("冰与火之歌", ["冰与火之歌", "权力的游戏"]),
    "throneofglass": ("玻璃王座", ["玻璃王座"]),
    "thedaodeof": ("道", ["道"]),
    "thethreebodyproblem": ("三体", ["三体", "三体全集"]),
    "threebody": ("三体", ["三体", "三体全集"]),
    "threebodyproblem": ("三体", ["三体", "三体全集"]),
    "thethreebody": ("三体", ["三体", "三体全集"]),
    "deathnote": ("死亡笔记", ["死亡笔记"]),
    "sherlockholmes": ("福尔摩斯探案全集", ["福尔摩斯", "福尔摩斯探案集", "福尔摩斯探案全集"]),
    "theadventuresofsherlockholmes": ("福尔摩斯探案集", ["福尔摩斯探案集", "福尔摩斯"]),
    "thelittleprince": ("小王子", ["小王子"]),
    "theoldmanandthesea": ("老人与海", ["老人与海"]),
    "onehundredyearsofsolitude": ("百年孤独", ["百年孤独"]),
    "cienanosdesoledad": ("百年孤独", ["百年孤独"]),
    "twentythousandleaguesunderthesea": ("海底两万里", ["海底两万里"]),
    "journeytothewest": ("西游记", ["西游记"]),
    "romanceofthethreekingdoms": ("三国演义", ["三国演义"]),
    "watermargin": ("水浒传", ["水浒传"]),
    "thedreamoftheredchamber": ("红楼梦", ["红楼梦"]),
    "dreamoftheredchamber": ("红楼梦", ["红楼梦"]),
    "theromanceofthethreekingdoms": ("三国演义", ["三国演义"]),
    "thecountofmontecristo": ("基督山伯爵", ["基督山伯爵", "基督山恩仇记"]),
    "lesmiserables": ("悲惨世界", ["悲惨世界"]),
    "notredamedeparis": ("巴黎圣母院", ["巴黎圣母院"]),
    "thehunchbackofnotredame": ("巴黎圣母院", ["巴黎圣母院"]),
    "warday": ("庆余年", ["庆余年"]),
    "joyoflife": ("庆余年", ["庆余年"]),
    "joyoflife2": ("庆余年", ["庆余年"]),
    "swordsofwandering": ("雪中悍刀行", ["雪中悍刀行"]),
    "thekingsofshangri": ("雪中悍刀行", ["雪中悍刀行"]),
    "lordofthemysteries": ("诡秘之主", ["诡秘之主"]),
    "circular": ("轮回乐园", ["轮回乐园"]),
    "paradiseofdemonsandgods": ("神墓", ["神墓"]),
    "perfectworld": ("完美世界", ["完美世界"]),
    "shroudingtheheavens": ("遮天", ["遮天"]),
    "battlethroughtheheavens": ("斗破苍穹", ["斗破苍穹"]),
    "martialuniverse": ("武动乾坤", ["武动乾坤"]),
    "wudongqiankun": ("武动乾坤", ["武动乾坤"]),
    "thegreatruler": ("大主宰", ["大主宰"]),
    "thelegendofmortalcultivation": ("凡人修仙传", ["凡人修仙传"]),
    "mortalcultivation": ("凡人修仙传", ["凡人修仙传"]),
    "wayofchoices": ("大道朝天", ["大道朝天"]),
    "nightfall": ("将夜", ["将夜"]),
    "eternalreverence": ("一念永恒", ["一念永恒"]),
    "revolutionofthefangirl": ("修真聊天群", ["修真聊天群"]),
    "thenovelisextra": ("小说家", ["小说家"]),
    "iampickingupthegirl": ("老婆", ["老婆"]),
    "deliberatelywrong": ("故意的", ["故意的"]),
    "reborn": ("重生", ["重生"]),
    "peerless": ("无敌", ["无敌"]),
    "throneofseal": ("神印王座", ["神印王座"]),
    "douluodalu": ("斗罗大陆", ["斗罗大陆"]),
    "soulland": ("斗罗大陆", ["斗罗大陆"]),
    "swordartonline": ("刀剑神域", ["刀剑神域"]),
    "overlord": ("不死者之王", ["不死者之王", "overlord"]),
    "thattimeigotreincarnatedasaslime": ("关于我转生变成史莱姆这档事", ["转生史莱姆", "史莱姆"]),
    "reincarnatedasaslime": ("转生史莱姆", ["关于我转生变成史莱姆这档事", "史莱姆"]),
    "fullmetal": ("钢之炼金术师", ["钢之炼金术师"]),
    "battleof": ("战争", ["战争"]),
    "mushroom": ("蘑菇", ["蘑菇"]),
    "allthingsgrow": ("万物", ["万物"]),
    "theshoreofdreams": ("沧海", ["沧海"]),
    "wuxia": ("武侠", ["武侠"]),
    "xiuxian": ("修仙", ["修仙"]),
    "fantasy": ("玄幻", ["玄幻"]),
    "urban": ("都市", ["都市"]),
    "military": ("军事", ["军事"]),
    "sciencefiction": ("科幻", ["科幻"]),
    "scifi": ("科幻", ["科幻"]),
    "horror": ("恐怖", ["恐怖"]),
    "mystery": ("悬疑", ["悬疑"]),
    "romance": ("言情", ["言情"]),
    "历史": ("历史", ["历史"]),
}

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
_FULLWIDTH_RE = re.compile(r"[\uff01-\uff5e]")


def normalize(s: str) -> str:
    """归一化关键词:全角转半角、小写、去空白与标点。"""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace(" ", "").replace("\u3000", "")
    s = s.lower()
    s = re.sub(r"[\s\-_.·•,:;!?()\[\]{}\"'`~@#$%^&*+=|\\/<>、。，；：！？（）【】《》「」『』\"'~]", "", s)
    return s


def strip_punct(s: str) -> str:
    """仅去标点,保留空白(用于词级匹配)。"""
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"[\-_.·•,:;!?()\[\]{}\"'`~@#$%^&*+=|\\/<>、。，；：！？（）【】《》「」『』]", " ", s)


def _candidates(keyword: str) -> list[str]:
    """返回所有搜索候选词:原词 + 中文名 + 别名 + 变体。"""
    kw = keyword.strip()
    cands: list[str] = []
    norm = normalize(kw)
    if not norm:
        return cands

    cands.append(kw)
    cands.append(norm)

    # 命中映射表 → 加入中文名与别名
    hit = ALIAS_MAP.get(norm)
    if hit is None:
        # 英文词级匹配:"Harry Potter 全集" → 英文词拼接 "harrypotter" → 命中
        words = [w for w in strip_punct(kw).lower().split() if w]
        en_words = [w for w in words if not re.search(r"[\u4e00-\u9fff]", w)]
        if en_words:
            joined = "".join(en_words)
            hit = ALIAS_MAP.get(joined)
        if hit is None:
            # 宽松:英文词子集匹配(如 "harry 全集 potter 下载")
            for key, (cn, aliases) in ALIAS_MAP.items():
                if not re.match(r"^[a-z0-9]+$", key):
                    continue
                if key in "".join(en_words) and len(key) >= 5:
                    hit = (cn, aliases)
                    break
    if hit:
        cn, aliases = hit
        cands.extend([cn, *aliases])

    # 中文变体扩展:哈利·波特 ↔ 哈利波特 ↔ 哈利 波特
    for c in list(cands):
        if re.search(r"[\u4e00-\u9fff]", c):
            cands.append(re.sub(r"[\s·.．]", "", c))        # 去连接符
            cands.append(re.sub(r"[\s·.．]", " ", c).strip())  # 空白连接
    return [c for c in dict.fromkeys(cands) if c]  # 去重保序


def build_search_queries(keyword: str, extra: list[str] | None = None) -> list[str]:
    """生成供各书源尝试的搜索词序列(中文词优先,便于中文站命中)。

    支持拼音输入:如 "ha li bo te" / "san ti" 会自动反查 ALIAS_MAP
    的中文名,生成"哈利波特"/"三体"等候选词(依赖 pypinyin,未安装则跳过)。
    支持中文数字↔阿拉伯数字互转:如 "三百年史莱姆" 额外生成 "300年史莱姆"。
    """
    queries = _candidates(keyword)
    queries += _digit_variants(keyword)
    if extra:
        queries.extend(extra)
    # 拼音反查:输入看起来是拼音(纯字母且不是已知英文作品名)
    if _looks_like_pinyin(keyword) and not ALIAS_MAP.get(normalize(keyword)):
        pyn = re.sub(r"[\s\-]", "", keyword.lower())
        for py_key, names in _build_pinyin_index().items():
            if py_key == pyn or py_key.startswith(pyn) or pyn.startswith(py_key):
                queries.extend(names)
    # 中文优先:含中文的候选排前面(中文小说站用中文搜最准);同组保持原顺序
    queries = [q for q in queries if is_chinese(q)] + [q for q in queries if not is_chinese(q)]
    # 归一化去重(避免"哈利·波特"与"哈利波特"重复请求)
    seen: set[str] = set()
    out: list[str] = []
    for q in queries:
        nq = normalize(q)
        if nq and nq not in seen:
            seen.add(nq)
            out.append(q)
    return out


# ---------------------------------------------------------------------------
# 中文数字 ↔ 阿拉伯数字 互转(用于 "三百年史莱姆" → "300年史莱姆" 类搜索)
# ---------------------------------------------------------------------------
_CN_DIGIT = {"零": "0", "一": "1", "二": "2", "两": "2", "三": "3",
             "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9"}
_CN_UNIT = {"十": 10, "百": 100, "千": 1000}


def _cn_num_to_arabic(s: str) -> str | None:
    """中文数字片段 → 阿拉伯数字串。'三百年' → '300','十五' → '15'。"""
    total = 0
    section = 0
    for ch in s:
        if ch in _CN_DIGIT:
            section = section * 10 + int(_CN_DIGIT[ch])
        elif ch in _CN_UNIT:
            unit = _CN_UNIT[ch]
            if section == 0:
                section = 1
            total += section * unit
            section = 0
        else:
            return None
    total += section
    return str(total) if total > 0 else None


def _arabic_to_cn(num_str: str) -> str | None:
    """阿拉伯数字串 → 中文数字;超过 9999 返回 None。"""
    n = int(num_str)
    if n <= 0 or n > 9999:
        return None
    digits = "零一二三四五六七八九"
    if n < 10:
        return digits[n]
    if n < 100:
        ten, one = divmod(n, 10)
        s = (digits[ten] if ten > 1 else "") + "十"
        if one:
            s += digits[one]
        return s
    if n < 1000:
        hun, rest = divmod(n, 100)
        s = digits[hun] + "百"
        if rest:
            s += _arabic_to_cn(str(rest))
        return s
    tho, rest = divmod(n, 1000)
    s = digits[tho] + "千"
    if rest:
        s += _arabic_to_cn(str(rest))
    return s


def _digit_variants(keyword: str) -> list[str]:
    """生成中文数字↔阿拉伯数字的搜索词变体。"""
    variants: list[str] = []
    for frag in re.findall(r"[零一二两三四五六七八九十百千]+", keyword):
        arab = _cn_num_to_arabic(frag)
        if arab:
            variants.append(keyword.replace(frag, arab, 1))
    for am in re.findall(r"\d+", keyword):
        cn = _arabic_to_cn(am)
        if cn:
            variants.append(keyword.replace(am, cn, 1))
    return variants


# ---------------------------------------------------------------------------
# 拼音反查(可选依赖 pypinyin)
# ---------------------------------------------------------------------------
_pinyin_cache: dict[str, list[str]] | None = None


def _build_pinyin_index() -> dict[str, list[str]]:
    """建立 中文名/别名 → 全拼(无空格) 的索引,带缓存。"""
    global _pinyin_cache
    if _pinyin_cache is not None:
        return _pinyin_cache
    idx: dict[str, list[str]] = {}
    try:
        from pypinyin import lazy_pinyin
    except ImportError:
        _pinyin_cache = idx
        return idx
    for _key, (cn, aliases) in ALIAS_MAP.items():
        for name in [cn, *aliases]:
            if not is_chinese(name):
                continue
            py = "".join(lazy_pinyin(name))
            if py:
                idx.setdefault(py, []).append(name)
    _pinyin_cache = idx
    return idx


def _looks_like_pinyin(s: str) -> bool:
    """判断输入是否像拼音:仅字母/空格/连字符,且含字母。"""
    if is_chinese(s):
        return False
    t = re.sub(r"[\s\-]", "", s)
    return bool(t) and t.isascii() and t.isalpha()


def is_chinese(s: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", s))

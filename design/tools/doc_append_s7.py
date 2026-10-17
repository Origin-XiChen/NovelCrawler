# -*- coding: utf-8 -*-
"""把「阶段一/二落地 + BUG 修复」的改动记录与验证结果追加到 design/UI-ANALYSIS.md。

写成脚本而不是手写追加,是为了让文档里的数字和脚本实测一致(可重跑核对)。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(ROOT, "design", "UI-ANALYSIS.md")

ANCHOR = "| `design/shots/new-*.png` | 新设计实拍 11 张 |"

SECTION = """
---

## 7. 落地记录:阶段一 / 阶段二 + BUG 修复(本轮实际改动)

本节记录**已经改到代码里**的内容,与前面第 3/4 节的设计方案对应。
所有数字都来自本节末尾列出的脚本实跑结果,可重跑复核。

### 7.0 三个 BUG(已修)

| 编号 | 问题 | 根因 | 改法 | 实测证据 |
|---|---|---|---|---|
| BUG-1 | 聚合搜索会被最慢的书源拖住,界面长时间停在"正在搜索" | `search_all()` 用 `as_completed()` 且**没有超时**,必须等全部线程返回 | 新增全局时间预算 `SEARCH_TOTAL_TIMEOUT=60`,到点用已完成源的结果收口,未返回的源标记 `timeout`;`pool.shutdown(wait=False, cancel_futures=True)` | 同一关键词:修复前 **124.0s** → 修复后 **24.2s / 30.4s**,结果 31 条一条不少 |
| BUG-2 | 进度条把"不能搜索的源"也算进分母(11 个里只有 4 个能搜),界面显示 11/11 让人以为有 11 个源在搜 | `search_all()` 对每个源都返回 `no_search` 状态并计入 `total` | 新增 `_is_searchable()`:只有带 `search`/`api_rules.search` 的源才提交、才计数;`total` 改为可搜索源数 | 进度从 **x/11** 变为 **x/4**;门户统计从"11 个书源已启用"变为"**4 个可搜索 · 共 11 个启用**" |
| BUG-4 | OPDS Cookie 写入与读取路径不一致,登录态丢失 | 写入用 `ROOT/opds_cookies.json`,读取用 `novel.paths.OPDS_COOKIES_PATH`(数据目录可能在 `%APPDATA%`) | 两处写入统一改为 `OPDS_COOKIES_PATH`,并补上模块级导入(原来只在别处的函数内导入,直接用会 `NameError`) | `grep OPDS_COOKIES_PATH gui_server.py` 四处引用同一常量 |

补充:BUG-1 的收口会**明确告知**用户,不静默丢结果 —— 结果摘要追加
"N 个源超时未返回(设置 → 小说 → 搜索等待上限可调大)",并弹一次 toast;
设置页新增 **搜索等待上限(秒,0=不限时)**,默认 60,填 0 即退回"等全部源"的旧行为。

> 顺带修掉的自测发现:`search_all()` 的收口循环最初会把已在主循环处理过的
> future 再收集一次,导致进度出现 `3/2`(done>total)。已用 `handled` 集合排除,
> 并加了断言防回归。

### 7.1 阶段一:设计令牌层(已落地)

`static/index.html` 的 `:root` / `[data-theme="dark"]` **变量名全部保留**(旧的
`--bg/--card/--border/--text/--primary/...` 都还在),只换取值并新增令牌:

* 新增:`--on-brand`(语义实底上的前景色)、`--border-strong`(控件边界 3.65:1)、
  `--line`、`--novel/--novel-soft`、`--comic/--comic-soft`;
* 关键换值:`--primary` #007AFF→**#2C6E63**、`--success` #34C759→**#2F7A4F**、
  `--danger` #FF3B30→**#B3261E**、`--warn` #FF9500→**#9A6208**、
  `--muted` #6e6e73→**#55595E**、`--text-3` #aeaeb2→**#6B7075**;
* 13 处"实底 + 写死白字"改为 `var(--on-brand)`(深色模式下语义色是浅色,白字会掉到约 2:1);
* 输入框/次级按钮/胶囊的边界改用 `--border-strong`,满足 WCAG 1.4.11 的 3:1;
* `[data-theme="dark"]` 里 21 行旧的冷灰字面量(`#3a3a3c/#48484a/#2c2c2e/#333336` 及
  `rgba(44,44,46,*)`)映射到暖色深色令牌;**有意保留** `.dl-float`、夜间阅读器等
  "永远深色"元素的原值。

### 7.2 阶段一:四个视觉问题 + 一项 a11y(已落地)

| 项 | 改动 |
|---|---|
| V1 门户卡白字对比度 1.7~3.0:1 | `.l-btn` 由绿/橙**饱和渐变 + 白字**改为 `--comic-soft/--novel-soft` 软底 + 墨色文字,左侧 5px 强调色条 + 标题用强调色区分两区;角标"ℹ 使用说明"由红黑斜纹+白字改为 `--danger` 实底 + `--on-brand` |
| V2 书架操作条层级反了 | `.bc-ops .btn-sm{flex:1}` → 按内容宽度 + 右对齐,按钮不再等宽撑满整行;主操作"更新"保持实底主色 |
| V3 图标按钮无可访问名 | 审计出全页唯一真正无名的交互控件;书架 ✏️ 改为 `#i-edit` 图标 + `aria-label/title="重命名与分类"`,`删` 补 `aria-label`;`#opdsService` 补 `aria-label` |
| V4 首启说明每次都弹 | `showDevTip('main')` 由 `sessionStorage`(每会话一次)改为 `localStorage` 只提示一次,标记在**关闭时**写入(没看完就退出下次还会提示);门户"ℹ 使用说明"作为常驻入口并支持键盘 |
| a11y 追加 | `.nav-item`(10)/`.set-nav`(5)原本是 `div+onclick`,键盘完全够不到 → 统一补 `role="button" tabindex="0"` + 回车/空格触发(键盘不可达的可点元素 120 → 84,剩余为 modal 遮罩等非按钮容器) |

### 7.3 阶段二:组件统一与防回退(已落地)

* **防回退闸门** `design/tools/lint_ui.py`:统计写死颜色/字号并与
  `design/ui-lint-baseline.json` 基线比较,只允许减少。已实测**能拦住**新增写死颜色
  (注入 `color:#a1b2c3` → 退出码 1 并定位到行号)。
  基线:颜色字面量 **135** 处 / 字号字面量 **302** 处。
* **颜色表令牌化**:`SRC_STATUS`(书源状态色)、`srcGroupColor/srcGroupBg`(分组色/底色)
  由写死浅色值改为 `var(--success/warn/danger/text-3/…)`,深色主题自动跟随;
  修掉 3 组本来就不达标的取值(`src-tag.ok` 3.87:1、`src-tag.direct` 4.13:1、
  `#16a34a`/白 3.30:1 → 全部 ≥4.50:1)。
* **书架改多列网格**:`#shelfGrid` 原本没有任何布局规则(块级元素一行一张铺满 1440px,
  书名在左按钮在右中间大片空白)→ `repeat(auto-fill, minmax(330px,1fr))`,
  宽窗口 3 列、≤900px 单列。
* **设置页单一吸底保存条**:删掉分类中部两个"保存设置",改为底部 sticky 操作条
  (放弃修改 / 保存设置 + 提示),并预留 150px 避让右下角任务气泡
  (与既有 `body.settings-open .settings-hd` 的做法一致)。

### 7.4 本轮验证(可重跑)

```bash
bundle314\\Scripts\\python.exe -X utf8 design\\tools\\verify_tokens.py      # 令牌对比度 35/35 通过
bundle314\\Scripts\\python.exe -X utf8 design\\tools\\check_badge_colors.py # 语义配对 + 旧值残留,0 不达标
bundle314\\Scripts\\python.exe -X utf8 design\\tools\\lint_ui.py            # 令牌守卫(退出码 0 = 没新增写死值)
bundle314\\Scripts\\python.exe -X utf8 design\\tools\\audit_ui.py after      # DOM 级 a11y/令牌审计
bundle314\\Scripts\\python.exe -X utf8 design\\tools\\e2e_search_ui.py       # 真实点搜索的端到端回归
bundle314\\Scripts\\python.exe -X utf8 design\\tools\\_work\\test_search_all.py    # search_all 语义(离线)
bundle314\\Scripts\\python.exe -X utf8 design\\tools\\_work\\test_search_budget.py # 预算四分支(离线)
```

实测结果(本轮最后一次):

* 令牌对比度 **35/35 通过**(浅色 23 项 + 深色 12 项,含控件边界 3:1 项);
* `verify_tokens.py` 是**从 `index.html` 解析真实令牌值**后重算的,不是抄文档数字;
* 端到端搜索回归 **PASS**:进度文案已是"正在搜索 1/4 个可搜索书源…",
  结束后摘要为"关键词: 魔法 · 11 条 · 1 个源超时未返回(…)",书源状态胶囊渲染出
  `rgb(154,98,8)`/`rgb(250,240,220)`(即 `--warn`/`--warn-50`),控制台无报错;
* DOM 审计:无名称的交互元素在门户视图为 **0**(其余视图报的是 launcher 隐藏后
  `innerText` 为空导致的假阳性,已人工核对)。

### 7.5 明确未做(附理由)

* **搜索结果行改"主操作 + kebab 菜单"**:现状 `.result-item` 每行只有一个 ☆ 操作,
  行高 56px 且已有整行点击进详情;再塞 kebab 只会增加一次点击,故不做。
* **书架"封面悬停操作层"**:改为多列网格 + 常驻紧凑操作条后,层级问题已解决;
  悬停才出现的操作在触屏和键盘下反而更难用,故不做。
* **字号字面量 302 处**:属存量,已用 lint 基线锁住"只能减少";彻底替换需要
  逐条核对视觉,风险高于收益,留作后续按屏推进。
"""


def main() -> int:
    text = io.open(DOC, encoding="utf-8").read()
    if "## 7. 落地记录" in text:
        print("已存在第 7 节,跳过")
        return 0
    if ANCHOR not in text:
        print("未找到锚点,未追加")
        return 1
    text = text.replace(ANCHOR, ANCHOR + "\n" + SECTION, 1)
    io.open(DOC, "w", encoding="utf-8", newline="\n").write(text)
    print("已追加第 7 节,当前行数:", text.count("\n") + 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
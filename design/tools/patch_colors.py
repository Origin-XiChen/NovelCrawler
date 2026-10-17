# -*- coding: utf-8 -*-
"""把残留的写死颜色统一到设计令牌(阶段一)。

只做"字面量 → var(--token)"这一件事,不改结构;每处替换都打印出来便于复核。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")

PAIRS = [
    # ---- theme-color / 顶部加载条 ----
    ('<meta name="theme-color" content="#007AFF">',
     '<meta name="theme-color" content="#2C6E63">',
     'meta theme-color → 新主色'),
    ('background: linear-gradient(90deg, transparent, #007AFF, transparent)',
     'background: linear-gradient(90deg, transparent, var(--primary), transparent)',
     'topBarFill 渐变 → var(--primary)'),
    ("mc.setAttribute('content', dark ? '#0A84FF' : '#007AFF')",
     "mc.setAttribute('content', dark ? '#5FB39F' : '#2C6E63')",
     'theme-color 动态(暗/亮)'),
    ("mc.setAttribute('content', _sysThemeMq.matches ? '#0A84FF' : '#007AFF')",
     "mc.setAttribute('content', _sysThemeMq.matches ? '#5FB39F' : '#2C6E63')",
     'theme-color 动态(跟随系统)'),

    # ---- 任务气泡/步骤色 ----
    ("const c = mode === 'orange' ? '#FF9500' : mode === 'green' ? '#34C759' : '#007AFF';",
     "const c = mode === 'orange' ? '#9A6208' : mode === 'green' ? '#2F7A4F' : '#2C6E63';",
     '任务气泡模式色(定义)'),
    ("const typeName = c === '#FF9500' ? '后台任务' : c === '#34C759' ? '下载任务' : '搜索任务';",
     "const typeName = c === '#9A6208' ? '后台任务' : c === '#2F7A4F' ? '下载任务' : '搜索任务';",
     '任务气泡类型名(依赖同一字面量,必须同步)'),
    ("const STEP_COLOR = {ok: '#16a34a', err: '#dc2626', empty: '#d97706', run: '#0A84FF', pause: '#F59E0B', warn: '#FF3B30', info: '#8a94a6'};",
     "const STEP_COLOR = {ok: '#2F7A4F', err: '#B3261E', empty: '#9A6208', run: '#2C6E63', pause: '#9A6208', warn: '#B3261E', info: '#6B7075'};",
     'STEP_COLOR → 新语义色'),

    # ---- 旧蓝 rgba(焦点环/阴影/边框) ----
    ('rgba(0,122,255,.25)', 'color-mix(in srgb, var(--primary) 25%, transparent)', 'rgba 旧蓝 .25'),
    ('rgba(0,122,255,.12)', 'color-mix(in srgb, var(--primary) 12%, transparent)', 'rgba 旧蓝 .12'),
    ('rgba(0,122,255,.15)', 'color-mix(in srgb, var(--primary) 15%, transparent)', 'rgba 旧蓝 .15'),
    ('border-color:rgba(0,122,255,.3)',
     'border-color:color-mix(in srgb, var(--primary) 30%, transparent)', 'src-chip.on 边框'),
    ('input:focus, select:focus, textarea:focus { border-color:var(--primary); background:#fff;',
     'input:focus, select:focus, textarea:focus { border-color:var(--primary); background:var(--card);',
     '聚焦背景 #fff → var(--card)(修复深色模式白底)'),

    # ---- 深色模式下失效的硬编码红/绿 ----
    ('.nav-item .badge.warn { background:#fff0f0; color:#FF3B30; }',
     '.nav-item .badge.warn { background:var(--danger-50); color:var(--danger); }',
     'badge.warn → 令牌'),
    ('var(--danger,#ff3b30)', 'var(--danger, #B3261E)', 'danger 兜底色'),
    ('color:#34C759; background:rgba(52,199,89,.12)',
     'color:var(--success); background:var(--success-50)', '已打包徽标'),
    ('<span style="color:#34C759">●</span>',
     '<span style="color:var(--success)">●</span>', '状态绿点(静态)'),
    ("s.connected ? '<span style=\"color:#34C759\">● 已直连</span>'",
     "s.connected ? '<span style=\"color:var(--success)\">● 已直连</span>'", '已直连状态'),
    ("? '<span style=\"color:#34C759\">●</span>'",
     "? '<span style=\"color:var(--success)\">●</span>'", '状态绿点(三元)'),
    ("(ok ? '#34C759' : 'var(--danger)')",
     "(ok ? 'var(--success)' : 'var(--danger)')", '云端回传状态'),

    # ---- 警示斜纹 ----
    ('repeating-linear-gradient(-45deg, #ff3b30 0 12px, #161616 12px 24px)',
     'repeating-linear-gradient(-45deg, #B3261E 0 12px, #161616 12px 24px)', '警示斜纹(12px)'),
    ('repeating-linear-gradient(-45deg, #ff3b30 0 16px, #161616 16px 32px)',
     'repeating-linear-gradient(-45deg, #B3261E 0 16px, #161616 16px 32px)', '警示斜纹(16px)'),

    # ---- SVG 进度环:presentation attribute 不吃 var(),改由 CSS 指定 ----
    ('stroke="#007AFF" stroke-width="5"', 'stroke-width="5"', 'panelRing 去掉写死描边色'),
]


def main() -> int:
    with io.open(TARGET, encoding="utf-8") as fh:
        text = fh.read()
    before = text
    hits, misses = [], []
    for old, new, label in PAIRS:
        n = text.count(old)
        if n:
            text = text.replace(old, new)
            hits.append((label, n))
        else:
            misses.append(label)
    # panelRing 的描边色补到 CSS 里(跟随主题)
    if '#panelRing' not in before:
        anchor = '  .progress-bar {'
        css = ('  #panelRing { stroke: var(--primary); }\n'
               '  [data-theme="dark"] #panelRing { stroke: var(--primary); }\n')
        if anchor in text and '  #panelRing { stroke' not in text:
            text = text.replace(anchor, css + anchor, 1)
            hits.append(('panelRing 描边色 → var(--primary) (CSS)', 1))
    if text != before:
        with io.open(TARGET, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
    for label, n in hits:
        print(f"  [OK x{n}] {label}")
    for label in misses:
        print(f"  [跳过,原文未匹配] {label}")
    print(f"命中 {len(hits)} 项 / 未命中 {len(misses)} 项")
    return 0


if __name__ == "__main__":
    sys.exit(main())
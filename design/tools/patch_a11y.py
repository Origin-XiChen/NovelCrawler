# -*- coding: utf-8 -*-
"""阶段一 a11y 收尾:给 OPDS 服务下拉补可访问名,并让侧栏导航键盘可达。

审计证据(design/tools/audit_ui.py):
  * #opdsService 是整页唯一一个既无文本、又无 title/aria-label 的交互控件;
  * .nav-item(10 个)+ .set-nav(5 个)是 div+onclick,键盘完全无法到达。
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(ROOT, "static", "index.html")

OLD_SELECT = '<select id="opdsService" style="flex:1; min-width:150px" onchange="opdsSwitchService()">'
NEW_SELECT = ('<select id="opdsService" aria-label="OPDS 服务地址" title="选择 OPDS 服务" '
              'style="flex:1; min-width:150px" onchange="opdsSwitchService()">')

# 键盘可达:统一由一段初始化脚本给侧栏导航补 role/tabindex + 回车/空格触发。
KEYBOARD_INIT = r"""
/* ---- 侧栏导航键盘可达(P0 a11y):.nav-item/.set-nav 是 div+onclick,键盘用户够不到 ---- */
function _initKbdNav(root) {
  const sel = '.nav-item, .set-nav, .dev-badge, .fab-rect, .l-dev .dev-badge';
  (root || document).querySelectorAll(sel).forEach(el => {
    if (el.dataset.kbdReady === '1') return;
    el.dataset.kbdReady = '1';
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    el.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        el.click();
      }
    });
  });
}
document.addEventListener('DOMContentLoaded', () => _initKbdNav());
"""
ANCHOR = "/* ---- 门户:双卡实时统计 + 快捷键(P1) ---- */"


def main() -> int:
    text = io.open(TARGET, encoding="utf-8").read()
    for old, new, label in (
        (OLD_SELECT, NEW_SELECT, 'OPDS 下拉补 aria-label'),
        (ANCHOR, KEYBOARD_INIT + "\n" + ANCHOR, '侧栏导航键盘可达初始化'),
    ):
        if old in text:
            text = text.replace(old, new, 1)
            print(f"  [OK] {label}")
        else:
            print(f"  [跳过] {label}(未匹配)")
    io.open(TARGET, "w", encoding="utf-8", newline="\n").write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
# -*- coding: utf-8 -*-
"""DOM 级可访问性/设计令牌审计(Playwright + 系统 Edge,headless)。

不是正则扫描,而是真的把页面渲染出来,然后:
  1. 统计没有"可访问名"的按钮/链接(aria-label / title / 文本 三者皆空);
  2. 统计行内样式数量、写死颜色数量(应与改动前对比);
  3. 统计字号字面量分布;
  4. 检查键盘可达性(有 onclick 但不可聚焦的元素)。

用法:bundle314\\Scripts\\python.exe -X utf8 design\\tools\\audit_ui.py [改后标签]
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["TEMP"] = os.path.join(ROOT, "design", "tools", "_work", "tmp")
os.environ["TMP"] = os.environ["TEMP"]
os.makedirs(os.environ["TEMP"], exist_ok=True)

BASE = os.environ.get("SHOT_BASE", "http://127.0.0.1:8899")
LABEL = sys.argv[1] if len(sys.argv) > 1 else "after"
OUT = os.path.join(ROOT, "design", "shots")
REPORT = os.path.join(ROOT, "design", f"audit-{LABEL}.json")

AUDIT_JS = r"""
() => {
  const out = {};
  const all = [...document.querySelectorAll('*')];
  out.totalEls = all.length;

  // ---- 1) 无字面文本的行内样式计数 ----
  out.inlineStyleEls = all.filter(e => e.getAttribute('style')).length;
  out.inlineStyleChars = all.reduce((a, e) => a + (e.getAttribute('style') || '').length, 0);
  out.emojiChars = (document.body.innerText.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  out.innerHTMLElCount = 0;
  out.onclickAttr = all.filter(e => e.hasAttribute('onclick')).length;
  out.ariaLabelCount = all.filter(e => e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby')).length;
  out.focusVisibleRules = 0; // CSS 规则数在下面单独统计
  out.tabindexPositive = all.filter(e => parseInt(e.getAttribute('tabindex') || '0', 10) > 0).length;

  // ---- 2) 可访问名缺失的交互元素 ----
  const inter = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], select, summary')];
  const nameOf = el => (el.getAttribute('aria-label') || el.getAttribute('title') ||
                        (el.innerText || '').trim() || el.getAttribute('value') ||
                        el.getAttribute('alt') || '').trim();
  out.interactive = inter.length;
  out.unnamed = inter.filter(el => !nameOf(el)).map(el => ({
    tag: el.tagName.toLowerCase(),
    cls: el.className || '',
    html: (el.outerHTML || '').slice(0, 120),
  })).slice(0, 40);

  // ---- 3) 只能靠鼠标的 div/span 点击(element with onclick but not focusable) ----
  const focusable = el => el.matches('a[href], button, input, select, textarea, [tabindex]');
  out.mouseOnlyClicks = all.filter(e => e.hasAttribute('onclick') && !focusable(e))
    .map(e => ({ tag: e.tagName.toLowerCase(), cls: (e.className || '').toString().slice(0, 60),
                 txt: (e.innerText || '').trim().slice(0, 30) })).slice(0, 30);

  // ---- 4) 字号/颜色字面量:从 CSSOM 规则里统计(能拿到真实生效的样式表)----
  let decls = 0, fsLiteral = 0, colorLiteral = 0, fsValues = {};
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const r of rules) {
      if (!r.style) continue;
      const t = r.style.cssText || '';
      decls++;
      const fs = r.style.fontSize;
      if (fs && /px$/.test(fs) && !t.includes('var(--fs')) {
        fsLiteral++;
        fsValues[fs] = (fsValues[fs] || 0) + 1;
      }
      for (const prop of ['color', 'background', 'backgroundColor', 'borderColor', 'fill', 'stroke']) {
        const v = r.style[prop];
        if (v && /#|rgb/.test(v) && !v.includes('var(')) colorLiteral++;
      }
    }
  }
  out.cssRules = decls;
  out.fontSizeLiterals = fsLiteral;
  out.colorLiterals = colorLiteral;
  out.fontSizeDistinct = Object.keys(fsValues).length;
  out.fontSizeTop = Object.entries(fsValues).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return out;
}
"""


def main() -> int:
    from playwright.sync_api import sync_playwright  # noqa: E402

    results = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="load", timeout=60000)
        page.wait_for_timeout(2600)
        # 逐个视图审计:门户 / 小说搜索 / 书架 / 设置
        steps = [
            ("launcher", "1"),
            ("book-search", "enterMode('book')"),
            ("book-shelf", "showView('shelf')"),
            ("book-settings", "showSettings()"),
        ]
        for name, script in steps:
            try:
                page.evaluate(script)
                page.wait_for_timeout(1300)
            except Exception as exc:  # noqa: BLE001
                print(f"  [{name}] 切换失败: {exc}")
            results[name] = page.evaluate(AUDIT_JS)
            print(f"  [{name}] 元素 {results[name]['totalEls']}, "
                  f"交互 {results[name]['interactive']}, "
                  f"无名称 {len(results[name]['unnamed'])}")
        ctx.close()
        browser.close()

    tot = {
        "unnamed": sum(len(v["unnamed"]) for v in results.values()),
        "mouseOnly": sum(len(v["mouseOnlyClicks"]) for v in results.values()),
        "inlineStyleEls": max(v["inlineStyleEls"] for v in results.values()),
        "inlineStyleChars": max(v["inlineStyleChars"] for v in results.values()),
        "onclickAttr": max(v["onclickAttr"] for v in results.values()),
        "ariaLabelCount": max(v["ariaLabelCount"] for v in results.values()),
        "fontSizeLiterals": max(v["fontSizeLiterals"] for v in results.values()),
        "fontSizeDistinct": max(v["fontSizeDistinct"] for v in results.values()),
        "colorLiterals": max(v["colorLiterals"] for v in results.values()),
        "emojiChars": max(v["emojiChars"] for v in results.values()),
        "interactive": max(v["interactive"] for v in results.values()),
        "tabindexPositive": max(v["tabindexPositive"] for v in results.values()),
    }
    io.open(REPORT, "w", encoding="utf-8").write(
        json.dumps({"summary": tot, "views": results}, ensure_ascii=False, indent=2))
    print("\n汇总(取各视图最大值):")
    for k, v in tot.items():
        print(f"  {k:20s} {v}")
    print(f"\n明细: {REPORT}")
    if tot["unnamed"]:
        print("\n无名称的交互元素:")
        for view, v in results.items():
            for u in v["unnamed"]:
                print(f"  [{view}] <{u['tag']} class=\"{u['cls']}\"> {u['html'][:90]}")
    if tot["mouseOnly"]:
        print("\n只能鼠标点击、键盘不可达:")
        for view, v in results.items():
            for m in v["mouseOnlyClicks"]:
                print(f"  [{view}] <{m['tag']} class=\"{m['cls']}\"> {m['txt']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
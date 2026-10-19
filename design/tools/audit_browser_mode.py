# -*- coding: utf-8 -*-
"""「浏览器模式(正常模式)下会失效/被拦截」的能力审计。

背景:应用有两套运行形态 ——
  * 桌面模式:WebView2 壳(window.chrome.webview 存在),能开原生窗口、走本地后端;
  * 浏览器模式:真正的浏览器(局域网/手机访问、或直接用浏览器打开),受浏览器
    安全策略约束 —— 弹窗拦截、剪贴板需权限/需手势、下载可能被拦、全屏需手势等。

本脚本把静态文件里所有"受浏览器策略约束"的调用点列出来,并判断:
  * 是否检查了返回值 / 是否有失败回退(没有 → 静默失败,用户看到"点了没反应");
  * 是否在 await 之后调用(用户手势已过期,浏览器会直接拦截),或是否来自 onclick(手势有效)。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FILES = [
    os.path.join(ROOT, "static", "index.html"),
    os.path.join(ROOT, "static", "mobile.html"),
    os.path.join(ROOT, "static", "reader-core.js"),
]

# 浏览器策略相关 API:(正则, 说明, 是否需要检查失败)
APIS = [
    (r"window\.open\s*\(", "弹窗(会被弹窗拦截器拦)", True),
    (r"navigator\.clipboard\b", "剪贴板(需权限/HTTPS/手势)", True),
    (r"document\.execCommand\(\s*['\"]copy", "旧剪贴板 API(部分浏览器禁用)", True),
    (r"\.requestFullscreen\s*\(", "全屏(需用户手势)", True),
    (r"new\s+Notification\b|Notification\.requestPermission", "系统通知(需授权)", True),
    (r"window\.print\s*\(", "打印对话框", False),
    (r"showSaveFilePicker|showOpenFilePicker", "文件选择器(需 HTTPS/安全上下文)", True),
    (r"URL\.createObjectURL", "Blob 下载链(受下载策略影响)", False),
    (r"\.download\s*=", "<a download> 触发下载(可能被浏览器拦)", False),
    (r"localStorage\.", "本地存储(隐私模式/被禁用会抛异常)", True),
    (r"window\.chrome\.webview", "桌面壳专有(浏览器模式无此对象)", True),
]

# 这些位置已知有意为之/已被 isDesktop() 守卫
BENIGN = ("isDesktop()", "window.chrome && window.chrome.webview")


def _window_open_handled(lines, i):
    """window.open 是否检查了返回值(被拦时 w 为 null)。

    只看本条语句及其后 4 行,避免被邻近无关的 try{ 误判(这正是第一版审计的假阴性来源)。
    """
    seg = "\n".join(lines[i - 1:i + 4])
    return bool(re.search(r"if\s*\(\s*!\s*\w+\s*\)|被拦截|被浏览器拦截", seg))


def main() -> int:
    findings = []
    for path in FILES:
        if not os.path.isfile(path):
            continue
        name = os.path.relpath(path, ROOT)
        lines = io.open(path, encoding="utf-8").read().split("\n")
        for i, line in enumerate(lines, 1):
            for pat, desc, need_check in APIS:
                if not re.search(pat, line):
                    continue
                ctx = "\n".join(lines[max(0, i - 13):i + 3])
                guarded = any(g in ctx for g in BENIGN)
                if pat == r"window\.open\s*\(":
                    # 弹窗只看本条语句的返回值处理
                    has_check = _window_open_handled(lines, i)
                else:
                    has_check = bool(re.search(
                        r"if\s*\(\s*!\s*\w+\s*\)|catch\s*\(|try\s*\{|被拦截|失败|不支持|toast\(",
                        ctx))
                prev = "\n".join(lines[max(0, i - 25):i])
                after_await = bool(re.search(r"\bawait\b", prev))
                findings.append({
                    "file": name, "line": i, "desc": desc,
                    "need_check": need_check, "guarded": guarded,
                    "has_check": has_check, "after_await": after_await,
                    "code": line.strip()[:96],
                })

    risky = [f for f in findings
             if f["need_check"] and not f["guarded"] and not f["has_check"]]
    other = [f for f in findings if f not in risky]

    print(f"共扫出 {len(findings)} 处受浏览器策略影响的调用\n")
    print("=" * 100)
    print("【A】需要看护但没有任何失败处理的点(点了没反应的高风险位置)")
    print("=" * 100)
    if not risky:
        print("  无")
    for f in risky:
        flag = "⚠ await后(手势可能已过期)" if f["after_await"] else "  手势内"
        print(f"  {f['file']}:{f['line']}  {flag}")
        print(f"      {f['desc']}")
        print(f"      {f['code']}")
    print()
    print("=" * 100)
    print("【B】已有守卫/已有失败处理的点(供核对)")
    print("=" * 100)
    for f in other:
        why = []
        if f["guarded"]:
            why.append("桌面壳守卫")
        if f["has_check"]:
            why.append("有失败处理")
        if not f["need_check"]:
            why.append("无需处理")
        print(f"  {f['file']}:{f['line']}  [{'+'.join(why) or '未分类'}]  {f['desc']}")
        print(f"      {f['code']}")
    print(f"\n高风险 {len(risky)} 处 / 共 {len(findings)} 处")
    return 1 if risky else 0


if __name__ == "__main__":
    sys.exit(main())
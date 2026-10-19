# -*- coding: utf-8 -*-
"""更正第 9 节的结论,并追加第 10 节:单文件启动器的临时目录问题(第 1 个弹窗的真正根因)。

第 9 节当时只找到 window2.py 的 WebView2 缓存目录这一处缺陷,并把它写成"唯一真会让出
管理员需求的地方" —— 用户随后给出了两个弹窗截图,证据表明**真正的根因是 onefile 启动器
在解压前要建临时目录**,而它发生在任何 Python 代码之前。必须回头更正,不能留着错结论。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(ROOT, "design", "UI-ANALYSIS.md")

OLD_HEAD = "### 9.2 程序侧唯一真会让出管理员需求的地方(已修)"
NEW_HEAD = "### 9.2 程序侧一处真会降级的地方(已修,但**不是**本问题的根因)"

OLD_CONCL = """**结论:"必须管理员"不是 exe 要求的。** 若确实每次都要提权,来源只能是外部:系统/快捷方式
勾了「以管理员身份运行」,或程序因为写不了某个目录而失败,被误当成"要提权"。"""
NEW_CONCL = """**结论(已在第 10 节修正):"必须管理员"不是 exe 清单要求的,而是单文件启动器解压阶段
的临时目录权限问题** —— 详见第 10 节。下面 9.2 这处仍然是个真缺陷(会让程序静默降级成
浏览器模式),但它**不是**「Could not create temporary directory!」的原因,当时把它当成
根因是我判断过早。"""

SECTION = """
---

## 10. 「Could not create temporary directory!」的真正根因与解法

用户给出了两张截图,信息决定性:*非管理员*运行时弹「Could not create temporary directory!」,
**所有情况**都弹「Windows 已保护你的电脑」。

### 10.1 弹窗是谁发的:PyInstaller 启动器,不是本程序

`design/tools/diag_temp_dir.py` 第 1 项实测:**exe 内含启动器原文**
`Could not create temporary directory!`。

单文件(onefile)打包的 exe,每次启动都要先把内嵌内容解压到一个临时目录
(`%TEMP%\\_MEIxxxxxx`)。**这一步发生在任何 Python 代码之前** —— 所以:

> 这个弹窗**不可能**通过改 Python 代码修掉。程序还没开始跑,就已经退出了。

### 10.2 为什么"以管理员运行就好了"

实测本机环境变量(`diag_temp_dir.py` 第 2 项,PowerShell 实测可写性):

| 作用域 | TEMP | 标准用户可写 |
|---|---|---|
| 用户级 | `C:\\Users\\XiChen\\AppData\\Local\\Temp` | ✅ 可写 |
| **系统级** | `C:\\WINDOWS\\TEMP` | ❌ **拒绝访问** |

启动器取临时目录的顺序是 TEMP → TMP → USERPROFILE → Windows 目录。
当进程里只看得见**系统级**那个值时(`diag_temp_dir.py` 第 3 项实测):

```
GetTempPathW() -> 'C:\\WINDOWS\\TEMP\\'
启动器将创建   -> C:\\WINDOWS\\TEMP\\_MEI123456
结果           -> PermissionError [WinError 5] 拒绝访问
```

而"以管理员身份运行"恰好让 `C:\\WINDOWS\\TEMP` 变得可写,所以表现成**「必须要管理员」**。

> 注意本沙箱的一个干扰:Python 进程写 `%LOCALAPPDATA%\\Temp` 会被 DSH 沙箱拒绝,
> 所以 `diag_temp_dir.py` 里用 Python 做的可写性探测对工作区外的路径不可信;
> 上表用的是 PowerShell 的真实 ACL 结果。

### 10.3 顺带测出的事实:每次启动解压 249MB

把 TEMP 指向可写目录后再跑,启动器立刻解压出 **249.2 MB** 的 `_MEI` 目录,
并且**该目录在程序被强杀后残留**(本程序退出走 `TerminateProcess`,见 spec 里的原有说明)。
同一轮里打包版的隐藏自检 `--selftest-verify` **完整通过**:

```json
{"frozen": true, "playwright": true, "driver_ok": true,
 "title": "Example Domain", "ok": true}
```

即:**exe 本身没问题**,只要有可写的临时目录就能跑起来(内置 Playwright + 系统 Edge 链路正常)。

### 10.4 三种解法(都不需要动电脑设置)

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 加一个启动器(最小改动,已验证思路可行)** | 一个几行的 `启动.bat`:先把 `TEMP`/`TMP` 指到 `%LOCALAPPDATA%\\NovelCrawler\\tmp` 再拉起正式 exe | 用户要双击 bat 而不是 exe;发布物多一个文件 |
| **B. 改成 onedir(文件夹)发布(推荐)** | `NovelCrawler.spec` 加 `COLLECT`、`EXE(exclude_binaries=True)` | 启动时**根本不解压** → 该弹窗从原理上消失;启动快得多、不再残留 249MB。代价:发布物从单 exe 变成文件夹/zip,`audit_exe.py`、`publish_release.ps1`、使用说明要跟着改 |
| **C. 保持单 exe 不动** | 只能继续靠管理员运行 | 不改 |

注意 `runtime_tmpdir` 不是好办法:它必须写死绝对路径(各用户不同),或写成 `.`
(等于每次往 exe 旁边解压 249MB、目录只读时照样失败)。

### 10.5 与「Windows 已保护你的电脑」的关系

那个弹窗**所有情况都出现**,说明与权限无关 —— 它判定的是**数字签名**(见 9.4)。
第 9 节做的版本资源、关 UPX、使用说明更正都只是"让二进制看起来正常",**消除不了它**:
只有签名(如 Azure Trusted Signing)能解决。
"""


def main() -> int:
    text = io.open(DOC, encoding="utf-8").read()
    changed = 0

    if OLD_HEAD in text:
        text = text.replace(OLD_HEAD, NEW_HEAD, 1)
        changed += 1
        print("  [OK] 更正 9.2 标题")
    else:
        print("  [跳过] 9.2 标题(可能已更正)")

    if OLD_CONCL in text:
        text = text.replace(OLD_CONCL, NEW_CONCL, 1)
        changed += 1
        print("  [OK] 更正 9.1 结论")
    else:
        print("  [跳过] 9.1 结论(可能已更正)")

    if "## 10. 「Could not create temporary directory!」" in text:
        print("  [跳过] 第 10 节已存在")
    else:
        text = text.rstrip("\n") + "\n" + SECTION
        changed += 1
        print("  [OK] 追加第 10 节")

    io.open(DOC, "w", encoding="utf-8", newline="\n").write(text)
    print(f"\n共 {changed} 处改动,当前行数:", text.count("\n") + 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
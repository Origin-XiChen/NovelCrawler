# -*- coding: utf-8 -*-
"""把「不需要管理员权限 / 发布者信任」这一轮的实测与修复追加到 UI-ANALYSIS.md。"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(ROOT, "design", "UI-ANALYSIS.md")

ANCHOR = "> 两个测试文件放在 `design/tools/_work/`(该目录已在 `.gitignore` 中)。\n> 它们是可重复运行的,只是不随仓库提交;需要时可直接 `node` 执行。"

SECTION = """
---

## 9. 「需要管理员运行 / 不信任」排查与修复

### 9.1 先测清楚:exe 到底有没有要求管理员

| 检查项 | 手段 | 实测结果 |
|---|---|---|
| 是否请求提权 | 读 exe 内嵌清单 `requestedExecutionLevel`(`design/tools/probe_exe_manifest.py`) | **`level="asInvoker"`** —— **没有**请求管理员 |
| 代码里是否有需要提权的操作 | 全仓 grep 防火墙/移动热点创建/`runas`/`HKLM` | 无。热点只做**检测**(`novel/hotspot.py` 只读 `netsh wlan show interfaces`)并跳转系统设置页 |
| 是否被 UPX 压缩 | 读 PE 节表(`design/tools/probe_exe_sections.py`) | **无 UPX 节**(构建机没装 UPX,`upx=True` 未生效) |
| 数字签名 | `Get-AuthenticodeSignature` | **NotSigned**(无签名) |
| 版本信息 | 读 PE 版本资源 | **全空**:公司/产品/文件描述/版本都没有 |
| 程序自身会不会报「不信任」 | 全仓 + exe 内串搜 `信任` | 0 处 —— 这个弹窗不是程序发的,是 Windows 的信任判定 |

**结论:"必须管理员"不是 exe 要求的。** 若确实每次都要提权,来源只能是外部:系统/快捷方式
勾了「以管理员身份运行」,或程序因为写不了某个目录而失败,被误当成"要提权"。

### 9.2 程序侧唯一真会让出管理员需求的地方(已修)

`window2.py` 原本把 WebView2 用户数据目录固定成 **`os.getcwd()/.webview2-cache`**:

* 双击启动时 cwd = exe 目录 → exe 装在不可写位置(如 `Program Files`)就创建失败;
* 走快捷方式时 cwd 取决于「起始位置」,可能落在完全无关甚至系统目录里。

失败后 WebView2 环境创建不起来,程序会**静默降级成浏览器模式**(`window2.py` 的
`except` 分支),用户能想到的绕过办法就只剩「以管理员身份运行」。

修复:改到数据目录 —— `novel/paths.py` 的 `APP_DATA_DIR` 自带「exe 目录不可写 → 回退
`%APPDATA%\\NovelCrawler`」的探测,再加一层系统临时目录兜底:

```python
def _webview_cache_dir() -> str:
    for base in (_APP_DATA_DIR, tempfile.gettempdir()):
        ...能创建并写入探针文件就用它...
```

开发模式下 `APP_DATA_DIR` 就是项目根目录,所以缓存仍落在 `<项目>/.webview2-cache`,
**行为与改前一致**;打包后不再要求 exe 目录可写。

### 9.3 信任观感:能做的都做了(但这不能替代签名)

* **补上版本资源**(原来全空):`NovelCrawler.spec` 在构建时从 `novel.__version__` 生成
  `build/version_info.txt`(公司/产品/描述/版权/原始文件名 + zh-CN 字符串表),
  再挂到 `EXE(version=...)`。版本号取自代码,不会和 `novel/__init__.py` 漂移。
  文件属性里从此有可核对的发布者与版本信息(签名后信誉也归属这个身份)。
* **显式关掉 UPX**(`upx=False`):实测产物本来没被压(构建机没装 UPX),但换台装了 UPX 的
  机器就会压出一个带 UPX 壳的 exe —— UPX 是杀软/SmartScreen 判定"可疑"的重要信号,
  这种"看机器脸色"的行为必须消除。
* **更正 `使用说明.txt`**:原文写"数据保存在 exe 同目录"(与 `novel/paths.py` 的回退逻辑
  不符),并明确写出"**不需要管理员权限**"以及遇到「未知发布者/Windows 已保护你的电脑」
  时点「更多信息 → 仍要运行」。避免用户自己去勾「以管理员身份运行」——那反而会引入
  UAC 弹窗(未签名时显示"未知发布者"),看起来更像"不信任"。

### 9.4 代码无法解决的部分(必须说清)

`未知发布者` / `Windows 已保护你的电脑`(SmartScreen)/ `智能应用控制已阻止` 这类弹窗,
判定的就是**数字签名**,不是程序行为。因此:

* **不能**靠改代码消除;只能**签名**;
* 用户侧「更多信息 → 仍要运行」「右键属性 → 解除锁定」可以绕过,但那属于改电脑设置;
* 可选路径:
  * **Azure Trusted Signing**:微软自家受信身份,约 $10/月,CI 友好,信誉积累快 —— 性价比最高;
  * **OV 证书**:便宜些,但需要一段时间的下载量积累信誉;
  * **EV 证书**:立刻有信誉,最贵;
  * **SignPath Foundation**:开源项目可申请免费签名。

> 已实现的 9.2/9.3 能让程序**不再需要管理员**、并让二进制"看起来正常";但要彻底消除
> SmartScreen,签名这一步绕不过去。

### 9.5 验证

* `design/tools/test_no_admin.py`:**13 条断言 PASS** ——
  缓存目录在"数据目录可写"时用数据目录、**不可写时回退临时目录且不抛异常**;
  并现场对照旧实现(`os.getcwd()`)在不可写目录下会直接抛 `PermissionError`;
  版本资源文件能被 PyInstaller 自己的 `VSVersionInfo` 解析器 eval 出来,
  四段版本还原为 `(0, 19, 6, 0)`、字符串表语言 `080404b0`(zh-CN)。
* 重新打包后用 `probe_exe_manifest.py` / `probe_exe_sections.py` / `Get-AuthenticodeSignature`
  复核产物:清单仍为 `asInvoker`、无 UPX 节、版本信息已填充(签名仍为 NotSigned,待证书)。
"""


def main() -> int:
    text = io.open(DOC, encoding="utf-8").read()
    if "## 9. 「需要管理员运行" in text:
        print("已存在第 9 节,跳过")
        return 0
    if ANCHOR not in text:
        print("未找到锚点,未追加")
        return 1
    text = text.replace(ANCHOR, ANCHOR + "\n" + SECTION, 1)
    io.open(DOC, "w", encoding="utf-8", newline="\n").write(text)
    print("已追加第 9 节,当前行数:", text.count("\n") + 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
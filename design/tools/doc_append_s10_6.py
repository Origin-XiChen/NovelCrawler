# -*- coding: utf-8 -*-
"""在 UI-ANALYSIS.md 第 10 节补上「方案 B 已落地 + 实测验证」小节。"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(ROOT, "design", "UI-ANALYSIS.md")

OLD_ROW = "| **B. 改成 onedir(文件夹)发布(推荐)** |"
NEW_ROW = "| **B. 改成 onedir(文件夹)发布(推荐)—— ✅ 已采用,见 10.6** |"

SECTION = """
### 10.6 落地:改用 onedir(方案 B)与实测验证

改动:

* `NovelCrawler.spec`:`EXE(..., exclude_binaries=True)` + 新增 `COLLECT`;
  并把 `runtime_tmpdir` 去掉(onedir 不再需要临时解压目录)。
  代码侧**无需改动** —— `gui_server` / `window2` / `browser` 取资源都走 `sys._MEIPASS`,
  onedir 下它指向 `_internal/`,语义与 onefile 完全一致。
* `build_exe.bat`:先输出到 `build\\dist_out`,再只把 `exe` 与 `_internal\\` **覆盖**进
  `dist\\NovelCrawler\\`。不能把 `--distpath` 直接指到 `dist\\NovelCrawler`:
  **PyInstaller 会清空输出目录**,而那里正存着用户的书架/配置数据
  (`novel/paths.py`:APP_DATA_DIR = exe 同目录),直接指过去会把数据删掉。
  复制用 robocopy 且不用 `/MIR`,所以用户数据不会被删。
* `build/audit_exe.py` 改为按 onedir 目录结构审计,并新增一条关键回归:
  **启动器体积必须 < 60MB** —— 否则说明又退回 onefile,而 onefile 正是本问题的根源。
* `build/publish_release.ps1` 改为上传 zip,并且**只挑构建产物**打包:实测
  `dist\\NovelCrawler\\` 下有 264MB 用户下载 + 208MB WebView2 缓存,整目录压缩会把
  个人数据(含可能带代理凭据的 `config.json`)一起发出去;现在只打 `exe` + `_internal`
  + 使用说明,并在上传前**断言**包内不含个人数据文件。

实测(同一台机器,同一份代码):

| | 改前 onefile | 改后 onedir |
|---|---|---|
| 启动器体积 | 124.6 MB | **10.9 MB** |
| 启动时解压 | 249.2 MB 的 `_MEI` 目录,强杀后残留 | **零解压**(实测临时目录里没有 `_MEI`) |
| 打包版自检 `--selftest-verify` | 必须先把 TEMP 指到可写目录才通过 | **直接跑就通过**(`ok:true`、headless Edge 取到 `Example Domain`、exit 0) |

顺带修掉两个"构建脚本自己"的坑(每一个都会让构建直接失败):

* `build_exe.bat` 存成 UTF-8,而 cmd 在中文系统按 **GBK(936)** 解析批处理 ——
  中文多字节序列会吞掉行尾,把**下一行的 `if` / `robocopy` 并进上一行**,表现为
  `'level' is not recognized` / `'/b' is not recognized` 这类报错、构建根本跑不完。
  现在该文件**保持纯 ASCII**(中文说明改由 `build/make_readme_txt.py` 生成,
  写 UTF-8 BOM 的 txt),并且**强制 CRLF** —— cmd 按 CRLF 读批处理,LF-only 会出现
  同样的截断现象(本项目 `core.autocrlf=true`,git 检出时本是 CRLF,工具直接写文件会写成 LF)。
* `build/audit_exe.py` 打印 `✓` 在 cp936 控制台上抛 `UnicodeEncodeError`,把构建判成失败;
  现在统一用 ASCII 的 `[OK]`/`[X]` 标记,并给 stdout 装 `errors="replace"` 兜底
  (`design/tools/add_stdout_guard.py` 把同类脚本一并加上)。

还有一个仓库配置问题一并修了:`.gitignore` 里的 `build/` 让 `build/` 下**没有任何文件入库**,
而 `build_exe.bat` 现在会调用其中的 `make_readme_txt.py` / `audit_exe.py` ——
**全新克隆将无法构建**。已把 `build/` 改成 `build/*` 并按扩展名反选脚本
(`!build/*.py` 等),压缩包/日志/中间产物继续忽略;`git check-ignore` 逐条验证过。

> 代码签名(消除「Windows 已保护你的电脑」)单独写在 [`design/CODE-SIGNING.md`](CODE-SIGNING.md):
> 含价格、申请步骤与推荐路线(个人可申请的 Azure Artifact Signing,$9.99/月起)。
"""


def main() -> int:
    text = io.open(DOC, encoding="utf-8").read()
    n = 0
    if OLD_ROW in text:
        text = text.replace(OLD_ROW, NEW_ROW, 1)
        n += 1
        print("  [OK] 10.4 表格标记 B 已采用")
    else:
        print("  [跳过] 10.4 表格行(可能已标记)")
    if "### 10.6 落地" in text:
        print("  [跳过] 10.6 已存在")
    else:
        text = text.rstrip("\n") + "\n" + SECTION
        n += 1
        print("  [OK] 追加 10.6")
    io.open(DOC, "w", encoding="utf-8", newline="\n").write(text)
    print(f"共 {n} 处改动,当前行数:", text.count("\n") + 1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
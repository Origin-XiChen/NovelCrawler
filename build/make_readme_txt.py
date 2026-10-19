# -*- coding: utf-8 -*-
"""生成 dist/NovelCrawler/使用说明.txt。

为什么单独用 Python 生成、而不在 build_exe.bat 里用 echo 写:
  cmd.exe 在中文系统默认按 GBK(936) 解析批处理,若 .bat 存成 UTF-8,中文多字节序列会被
  错解、甚至吞掉行尾换行,把**下一行**的控制语句(if / robocopy)并进上一行 —— 直接导致
  批处理报错跑不下去(实测过)。所以:
    * build_exe.bat 保持纯 ASCII,不含任何中文;
    * 需要中文的说明文件在这里生成,并带 UTF-8 BOM,确保记事本等任何工具都读得对。
"""
import os
import sys

TEXT = """NovelCrawler 小说管家 - 免安装版
=================================

双击 NovelCrawler.exe 即可使用,不需要管理员权限。

【必须保留 _internal 文件夹】
exe 依赖同目录下的 _internal\\,单独把 exe 拷走会无法启动。
分享给别人时,请把整个文件夹压缩成 zip,对方解压后双击 exe。

【数据位置】
书架 / 订阅 / 下载等数据默认保存在本文件夹(exe 同目录);
若该位置不可写(例如放在 Program Files),会自动改用
%APPDATA%\\NovelCrawler,并在「设置 - 数据存储位置」里显示实际路径。

【运行环境】
需要 Edge WebView2 运行时,Windows 10/11 自带。

【首次运行可能出现的提示】
若弹出「未知发布者 / Windows 已保护你的电脑」,点「更多信息」-「仍要运行」即可。
该提示来自"程序没有数字签名",与权限无关 —— 以管理员身份运行也不会让它消失,
反而会额外多弹一次 UAC 授权框。
"""


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dist = os.path.join(root, "dist", "NovelCrawler")
    os.makedirs(dist, exist_ok=True)
    path = os.path.join(dist, "使用说明.txt")
    # utf-8-sig:带 BOM,记事本/旧版编辑器也不会把中文显示成乱码
    with open(path, "w", encoding="utf-8-sig", newline="\r\n") as f:
        f.write(TEXT)
    print(f"[说明] 已生成 {path} ({os.path.getsize(path)} 字节)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
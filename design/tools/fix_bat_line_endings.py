# -*- coding: utf-8 -*-
"""修 .bat 的两个致命细节(实测都会让批处理崩掉)。

1) 换行必须是 CRLF
   cmd.exe 按 CRLF 读批处理。LF-only 的文件会出现"行被从中间截断、前半截被吞掉、
   后半截当命令执行"的现象 —— 表现为一堆
     'the' is not recognized / 'level' is not recognized / '/b' is not recognized
   即 `if exist ...`/`if errorlevel`/`exit /b` 这些控制语句整片失效。
   本项目 core.autocrlf=true,git 检出时本会还原成 CRLF,但工具直接写文件会写成 LF,
   所以这里显式规范化。

2) 内容必须纯 ASCII
   cmd 在中文系统按 GBK(936) 解析批处理,UTF-8 的中文会被错解并吞掉后续字节。
   凡是出现在批处理里的中文(哪怕只是注释)都要拿掉,中文说明改由
   build/make_readme_txt.py 生成。
"""
import io
import os
import sys


try:  # 中文控制台(cp936)编不出 ✓/⚠ 时会崩,这里只做兜底不改语义
    sys.stdout.reconfigure(errors="replace")
except (AttributeError, OSError):
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BAT = os.path.join(ROOT, "build_exe.bat")

FIXES = [
    ("(使用说明.txt) is written by", "(the Chinese readme) is written by"),
    ("(使用说明.txt)", "(Chinese readme)"),
]


def main() -> int:
    raw = open(BAT, "rb").read()
    print(f"修复前: {len(raw)} 字节  CRLF={raw.count(b'\r\n')}  纯LF={raw.count(b'\n') - raw.count(b'\r\n')}")

    text = raw.decode("utf-8")
    for old, new in FIXES:
        if old in text:
            text = text.replace(old, new)
            print(f"  [OK] 去中文: {old!r} -> {new!r}")

    bad = [(i, ch) for i, ch in enumerate(text) if ord(ch) > 127]
    if bad:
        print(f"  ✗ 仍有 {len(bad)} 个非 ASCII 字符,例如: "
              f"{[(i, ch) for i, ch in bad[:8]]}")
        # 兜底:整体转义掉,保证批处理可执行
        text = "".join(ch if ord(ch) < 128 else "?" for ch in text)
        print("  → 已把剩余非 ASCII 字符替换为 '?'(兜底)")
    else:
        print("  [OK] 内容纯 ASCII")

    # 统一 CRLF(先归一到 LF,再全部换成 CRLF,避免出现 CRCRLF)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n")
    with io.open(BAT, "w", encoding="ascii", newline="") as f:
        f.write(text)

    chk = open(BAT, "rb").read()
    crlf = chk.count(b"\r\n")
    lf_only = chk.count(b"\n") - crlf
    non_ascii = max(chk)
    print(f"修复后: {len(chk)} 字节  CRLF={crlf}  纯LF={lf_only}  最大字节={non_ascii}")
    ok = (lf_only == 0 and non_ascii < 128 and crlf > 0)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
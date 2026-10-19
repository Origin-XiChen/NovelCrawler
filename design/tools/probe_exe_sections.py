# -*- coding: utf-8 -*-
"""读 PE 节表:确认发布用的 exe 有没有被 UPX 压缩。

UPX 是杀软/信任判定的重要负面信号(大量恶意样本都用它),PyInstaller 的
`upx=True` 只在构建环境装了 UPX 时才真正生效 —— 必须看实际产物,不能只看配置。
"""
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def sections(path: str):
    b = open(path, "rb").read(4096 * 8)
    if b[:2] != b"MZ":
        raise ValueError("不是 PE 文件")
    pe = struct.unpack_from("<I", b, 0x3C)[0]
    if b[pe:pe + 4] != b"PE\0\0":
        raise ValueError("PE 头签名不对")
    nsec = struct.unpack_from("<H", b, pe + 6)[0]
    optsz = struct.unpack_from("<H", b, pe + 20)[0]
    base = pe + 24 + optsz
    out = []
    for i in range(nsec):
        off = base + i * 40
        name = b[off:off + 8].rstrip(b"\0").decode("latin-1")
        vsize = struct.unpack_from("<I", b, off + 8)[0]
        rawsize = struct.unpack_from("<I", b, off + 16)[0]
        chars = struct.unpack_from("<I", b, off + 36)[0]
        out.append((name, vsize, rawsize, chars))
    return out


def main() -> int:
    exe = os.path.join(ROOT, "dist", "NovelCrawler", "NovelCrawler.exe")
    print(f"exe: {exe}  ({os.path.getsize(exe)/1024/1024:.1f} MB)\n")
    secs = sections(exe)
    print(f"{'节名':10s}{'虚拟大小':>12s}{'原始大小':>12s}  可执行")
    upx = []
    for name, vs, rs, ch in secs:
        exec_flag = "是" if ch & 0x20000000 else "否"
        flag = ""
        if "upx" in name.lower():
            upx.append(name)
            flag = "   ← UPX"
        print(f"{name:10s}{vs:>12d}{rs:>12d}  {exec_flag}{flag}")

    print()
    if upx:
        print(f"❌ 检出 UPX 节: {', '.join(upx)} —— 发布产物确实被 UPX 压缩过")
        print("   这会明显提高杀软误报与「不信任」的概率,建议在 spec 里关掉 upx。")
    else:
        print("✅ 未检出 UPX 节 —— 发布产物没有被打包环境 UPX 压缩")
    return 0


if __name__ == "__main__":
    sys.exit(main())
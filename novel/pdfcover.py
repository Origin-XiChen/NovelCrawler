# -*- coding: utf-8 -*-
"""轻量 PDF 首面图像提取(零第三方依赖)。

面向本应用 img2pdf 打包的漫画 PDF:每页一张原图,
JPEG 原样嵌入(/Filter /DCTDecode),PNG 转为 FlateDecode 像素流。
提供 extract_first_image(pdf_bytes) -> (image_bytes, fmt) | None。
"""
from __future__ import annotations

import re
import struct
import zlib

_OBJ_RE = re.compile(rb"(\d+)\s+0\s+obj\b(.*?)endobj", re.S)
_STREAM_RE = re.compile(rb"stream\r?\n", re.S)


def _stream_bytes(body: bytes) -> bytes | None:
    """按 /Length N 精确截取流字节(JPEG 等二进制流内可能含 endstream 假象)。"""
    m = _STREAM_RE.search(body)
    if not m:
        return None
    start = m.end()
    lenm = re.search(rb"/Length\s+(\d+)\b", body)
    if lenm:
        n = int(lenm.group(1))
        return body[start:start + n]
    end = body.find(b"endstream", start)
    if end < 0:
        return None
    return body[start:end].rstrip(b"\r\n")


def _iter_objects(data: bytes):
    for m in _OBJ_RE.finditer(data):
        yield int(m.group(1)), m.group(2)


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)


def _build_png(w: int, h: int, raw_rgb: bytes) -> bytes:
    rows = b"".join(b"\x00" + raw_rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(rows))
            + _png_chunk(b"IEND", b""))


def _apply_png_pred(raw: bytes, w: int, bpp: int) -> bytes:
    stride = w * bpp + 1
    out = bytearray()
    prev = bytearray(w * bpp)
    for row in range(0, len(raw) - len(raw) % stride, stride):
        f = raw[row]
        line = bytearray(raw[row + 1:row + 1 + stride - 1])
        if f == 1:  # Sub
            for i in range(bpp, len(line)):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:  # Up
            for i in range(len(line)):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:  # Average
            for i in range(len(line)):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:  # Paeth
            for i in range(len(line)):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out += line
        prev = line
    return bytes(out)


def _apply_tiff_pred(raw: bytes, w: int, bpp: int) -> bytes:
    stride = w * bpp
    out = bytearray()
    for row in range(0, len(raw) - len(raw) % stride, stride):
        line = bytearray(raw[row:row + stride])
        for i in range(bpp, len(line)):
            line[i] = (line[i] + line[i - bpp]) & 0xFF
        out += line
    return bytes(out)


def extract_first_image(pdf_bytes: bytes):
    """提取 PDF 首页图像。返回 (image_bytes, fmt),fmt ∈ {'jpeg','png'};失败返回 None。"""
    if not pdf_bytes:
        return None
    # 主路径:JPEG 直嵌(DCTDecode)
    for _num, body in _iter_objects(pdf_bytes):
        if b"/Subtype" in body and b"/Image" in body and b"/DCTDecode" in body:
            st = _stream_bytes(body)
            if st and len(st) > 100:
                return st, "jpeg"
    # 兜底:FlateDecode 像素流 → 还原 → 构造 PNG
    for _num, body in _iter_objects(pdf_bytes):
        if b"/Subtype" not in body or b"/Image" not in body or b"/FlateDecode" not in body:
            continue
        w = re.search(rb"/Width\s+(\d+)", body)
        h = re.search(rb"/Height\s+(\d+)", body)
        cs = re.search(rb"/ColorSpace\s+/(\w+)", body)
        bpc = re.search(rb"/BitsPerComponent\s+(\d+)", body)
        pred = re.search(rb"/Predictor\s+(\d+)", body)
        st = _stream_bytes(body)
        if not (w and h and st):
            continue
        try:
            raw = zlib.decompress(st)
        except Exception:  # noqa: BLE001
            continue
        width, height = int(w.group(1)), int(h.group(1))
        if width < 3 or height < 3 or len(raw) < width * height:
            continue
        csn = (cs.group(1) if cs else b"DeviceRGB").decode(errors="ignore")
        bits = int(bpc.group(1)) if bpc else 8
        ncomp = {"DeviceRGB": 3, "DeviceGray": 1, "DeviceCMYK": 4}.get(csn, 3)
        bpp = ncomp * bits // 8
        if bpp <= 0:
            continue
        predn = int(pred.group(1)) if pred else 1
        try:
            if predn == 2:
                raw = _apply_tiff_pred(raw, width, bpp)
            elif predn >= 10:
                raw = _apply_png_pred(raw, width, bpp)
            if csn == "DeviceCMYK" and bpp == 4:
                px = bytearray()
                for i in range(0, len(raw) - 3, 4):
                    c, m, y, k = raw[i], raw[i + 1], raw[i + 2], raw[i + 3]
                    if k >= 255:
                        px += b"\x00\x00\x00"
                    else:
                        kk = (255 - k) / 255.0
                        px += bytes((int(c * kk), int(m * kk), int(y * kk)))
                raw = bytes(px)
                bpp = 3
            elif csn == "DeviceGray" and bpp == 1:
                raw = bytes(b for b in raw for _ in range(3))
                bpp = 3
            if bpp == 3 and bits == 8:
                img = _build_png(width, height, raw)
                if img:
                    return img, "png"
        except Exception:  # noqa: BLE001
            continue
    return None

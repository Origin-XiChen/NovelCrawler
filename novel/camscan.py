# -*- coding: utf-8 -*-
"""PC 摄像头扫码 —— 扫描手机信令页显示的 answer 二维码,完成 WebRTC 握手。

依赖(可选): opencv-python-headless(自带 cv2.QRCodeDetector,无需 zbar)。
未安装时 available()=False,前端显示降级提示。

线程模型: 单后台线程循环抓帧解码,识别到目标前缀后回调一次即自动停止。
"""
from __future__ import annotations

import threading

PREFIX = "novelist-wrtc://"


def available() -> bool:
    try:
        import cv2  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


class CamScanner:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._th: threading.Thread | None = None
        self._stop = threading.Event()
        self._on_qr = None
        self._last_frame_ok = False
        self._frames = 0
        self._error = ""      # 最近一次失败原因(摄像头被占用 / 无设备等)
        self._prefix = PREFIX
        self._fail = 0        # 连续取流失败计数

    def start(self, on_qr, prefix: str = PREFIX) -> dict:
        if not available():
            self._error = "未安装 opencv"
            return {"ok": False,
                    "error": "未安装 opencv(摄像头扫码库)。请执行: pip install opencv-python-headless"}
        with self._lock:
            if self._th and self._th.is_alive():
                return {"ok": True, "running": True}
            self._stop.clear()
            self._error = ""
            self._on_qr = on_qr
            self._prefix = prefix
            self._frames = 0
            self._fail = 0
            self._th = threading.Thread(target=self._run, daemon=True)
            self._th.start()
            return {"ok": True, "running": True}

    def stop(self) -> dict:
        self._stop.set()
        with self._lock:
            th = self._th
            self._th = None
        if th and th is not threading.current_thread():
            th.join(timeout=3)
        return {"ok": True, "running": False}

    def status(self) -> dict:
        with self._lock:
            alive = self._th is not None and self._th.is_alive()
            err = self._error
            frames = self._frames
        return {
            "available": available(),
            "running": alive,
            "frames": frames,
            "error": err,
        }

    def _run(self) -> None:
        import cv2
        cap = None
        try:
            cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)  # Windows 直连更快
            if not cap.isOpened():
                cap = cv2.VideoCapture(0)
            if not cap.isOpened():
                # 之前这里直接 return:前端只会看到「摄像头就绪(未启用)」,
                # 用户完全不知道失败原因。记录错误供 /api/webrtc/status 展示。
                self._error = "无法打开摄像头(设备不存在、被其他程序占用,或无相机权限)"
                return
            det = cv2.QRCodeDetector()
            while not self._stop.is_set():
                ok, frame = cap.read()
                if not ok:
                    self._fail += 1
                    if self._fail >= 10:  # 连续取流失败(被占用/已拔出)
                        self._error = "摄像头取流失败:可能已被其他程序独占占用"
                        break
                    self._stop.wait(0.3)
                    continue
                self._fail = 0
                self._frames += 1
                data, _pts, _ = det.detectAndDecode(frame)
                if data:
                    data = data.strip()
                    if data.startswith(self._prefix):
                        cb = self._on_qr
                        self._stop.set()
                        if cb:
                            try:
                                cb(data)
                            except Exception:  # noqa: BLE001
                                pass
                        break
                # 降频:约 6-8 fps,避免占满 CPU
                self._stop.wait(0.12)
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:  # noqa: BLE001
                    pass


# 单例
_scanner: CamScanner | None = None


def get_scanner() -> CamScanner:
    global _scanner
    if _scanner is None:
        _scanner = CamScanner()
    return _scanner

# -*- coding: utf-8 -*-
"""截图检查「手机连接」页新增的加密访问卡片(桌面端 WebView 同款渲染)。

用法: bundle314/Scripts/python.exe _diag/shot_tls_ui.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "_diag", "_uidata")
PORT = 8931
OUT = os.path.join(ROOT, "_diag")


def wait_port(port: int, timeout: float = 25.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.6):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def main() -> int:
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"sources": [], "settings": {"lan_access": True, "https_enabled": False}}, f)

    env = dict(os.environ, NOVEL_DATA_DIR=DATA, PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen([sys.executable, "-u", "gui_server.py", "--port", str(PORT)],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        if not wait_port(PORT):
            print("服务没起来")
            return 1
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1180, "height": 1500},
                                    device_scale_factor=1)
            page.goto(f"http://127.0.0.1:{PORT}/app/", wait_until="networkidle")
            page.wait_for_timeout(800)
            page.get_by_text("手机连接", exact=True).first.click()
            page.wait_for_timeout(1500)
            page.screenshot(path=os.path.join(OUT, "ui_tls_off.png"), full_page=True)

            # 打开 HTTPS 开关
            btn = page.locator(".mobile-card", has_text="加密访问").locator(".switch").first
            btn.click()
            page.wait_for_timeout(2500)
            page.wait_for_timeout(800)
            page.screenshot(path=os.path.join(OUT, "ui_tls_on.png"), full_page=True)
            # 展开手机安装步骤
            page.locator(".mobile-card", has_text="加密访问").locator("summary").first.click()
            page.wait_for_timeout(500)
            card = page.locator(".mobile-card", has_text="加密访问").first
            card.screenshot(path=os.path.join(OUT, "ui_tls_card.png"))
            browser.close()
        print("截图完成:", OUT)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())

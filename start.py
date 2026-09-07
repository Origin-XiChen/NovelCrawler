# -*- coding: utf-8 -*-
"""
多源小说爬虫 —— 一键启动器
==============================
自动完成:
  1. 定位 Python 解释器(优先隔离 venv,其次系统 python)
  2. 检查依赖(requests/bs4/lxml),缺失则自动安装
  3. 探测空闲端口(默认 8899,被占用自动顺延)
  4. 启动 GUI 服务并自动打开浏览器
  5. 按 Ctrl+C / 输入 q 优雅退出(关闭服务)

用法:
  python start.py               # 正常启动
  python start.py --port 9000   # 指定端口
  python start.py --no-browser  # 不自动打开浏览器
"""
from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import time
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(ROOT, "gui_server.py")

# 候选解释器(按优先级):隔离 venv → 项目同级 .venv → 系统 python
_CANDIDATES = [
    os.environ.get("NOVEL_PYTHON", ""),
    os.path.join(os.path.expanduser("~"), ".workbuddy", "binaries", "python", "envs", "default", "Scripts", "python.exe"),
    os.path.join(os.path.expanduser("~"), ".workbuddy", "binaries", "python", "versions", "3.13.12", "python.exe"),
    os.path.join(ROOT, ".venv", "Scripts", "python.exe"),
    shutil.which("python"),
    shutil.which("python3"),
]

REQUIRED = ["requests", "beautifulsoup4", "lxml"]


def find_python() -> str:
    for cand in _CANDIDATES:
        if cand and os.path.isfile(cand):
            return cand
    if sys.executable and os.path.isfile(sys.executable):
        return sys.executable
    raise RuntimeError("未找到 Python,请先安装 Python 3.9+ 并加入 PATH")


def ensure_deps(python: str) -> None:
    """检查依赖,缺失则 pip 安装。"""
    try:
        code = subprocess.run(
            [python, "-c", "import requests, bs4, lxml"],
            capture_output=True, text=True, timeout=30,
        ).returncode
        if code == 0:
            return
    except Exception:  # noqa: BLE001
        pass
    print("检测到缺少依赖,正在安装(仅首次需要)...")
    r = subprocess.run(
        [python, "-m", "pip", "install", "-q",
         "-r", os.path.join(ROOT, "requirements.txt")],
        capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0:
        print(r.stderr[-800:] if r.stderr else "安装失败,请手动执行 pip install -r requirements.txt")
        sys.exit(1)
    print("依赖安装完成 ✓")


def find_free_port(prefer: int) -> int:
    """探测空闲端口:优先 prefer,被占用则顺延。"""
    for port in range(prefer, prefer + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return prefer


def main() -> None:
    ap = argparse.ArgumentParser(description="多源小说爬虫启动器")
    ap.add_argument("--port", type=int, default=8899, help="服务端口(默认8899)")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--desktop", action="store_true", help="桌面窗口模式(pywebview,需已安装 pywebview)")
    args = ap.parse_args()

    print("=" * 56)
    print("  多源小说爬虫 · 一键启动器")
    print("=" * 56)

    # 1. 解释器
    python = find_python()
    print(f"[1/4] Python: {python}")

    # 2. 依赖
    ensure_deps(python)

    # 3. 端口
    port = find_free_port(args.port)
    print(f"[2/4] 端口: {port} (空闲)")

    # 4. 启动服务
    url = f"http://127.0.0.1:{port}/"
    print(f"[3/4] 启动服务 → {url}")
    proc = subprocess.Popen(
        [python, "-u", SERVER, "--port", str(port)],
        cwd=ROOT,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )

    # 等待服务就绪
    ready = False
    import urllib.request
    for _ in range(40):
        if proc.poll() is not None:
            print("[错误] 服务进程异常退出,请查看上方日志")
            sys.exit(1)
        try:
            urllib.request.urlopen(url, timeout=1)
            ready = True
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    if not ready:
        print("[错误] 服务启动超时")
        proc.terminate()
        sys.exit(1)

    print(f"[4/4] 服务已就绪 ✓  {url}")
    if args.desktop:
        # 桌面窗口模式:由 desktop.py 独立管理(自带后端 + pywebview 窗口)
        proc.terminate()  # 关掉刚起的 Web 服务子进程
        subprocess.Popen(
            [python, "-u", os.path.join(ROOT, "desktop.py"), "--dev"],
            cwd=ROOT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        )
        print("  已启动桌面窗口模式(独立进程),关闭窗口即退出")
        return
    if not args.no_browser:
        webbrowser.open(url)

    print("-" * 56)
    print("  按 Ctrl+C 或输入 q 后回车即可退出")
    print("-" * 56)
    try:
        while True:
            line = input("> ").strip().lower()
            if line in ("q", "quit", "exit", "关闭"):
                break
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        print("\n正在关闭服务...")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            proc.kill()
        print("已退出,欢迎下次使用 👋")


if __name__ == "__main__":
    main()

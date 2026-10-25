# -*- coding: utf-8 -*-
"""Electron 后端入口。

打包为无控制台程序后 sys.stdout/stderr 为 None；Electron 通过 NOVEL_LOG_FILE
指定日志文件，这里在导入业务代码前完成重定向，避免 print 触发异常。
"""
from __future__ import annotations

import os
import sys


def _redirect_output() -> None:
    log_path = (os.environ.get("NOVEL_LOG_FILE") or "").strip()
    if not log_path:
        return
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        stream = open(log_path, "a", encoding="utf-8", buffering=1)
    except OSError:
        return
    sys.stdout = stream
    sys.stderr = stream


_redirect_output()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gui_server import main  # noqa: E402

if __name__ == "__main__":
    main()

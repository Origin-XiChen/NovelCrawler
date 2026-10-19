# -*- mode: python ; coding: utf-8 -*-
"""正式 spec 的控制台孪生版(仅 console=True + 改名),用于在沙箱里验证发布版 exe 行为。"""
import os

_ROOT = os.path.dirname(os.path.abspath(SPECPATH))           # build/ 的上一级 = 项目根
_spec = os.path.join(_ROOT, "NovelCrawler.spec")
with open(_spec, "r", encoding="utf-8") as f:
    _src = f.read()

_src = _src.replace("['window2.py']", repr([os.path.join(_ROOT, "window2.py")]))
_src = _src.replace("('static', 'static')", repr((os.path.join(_ROOT, "static"), "static")))
_src = _src.replace("('icon', 'icon')", repr((os.path.join(_ROOT, "icon"), "icon")))
_src = _src.replace("icon=['app.ico']", f"icon=[{os.path.join(_ROOT, 'app.ico')!r}]")
_src = _src.replace('os.path.join("build", "playwright_node.zip")',
                    repr(os.path.join(_ROOT, "build", "playwright_node.zip")))
_src = _src.replace('os.makedirs("build", exist_ok=True)', "")
_src = _src.replace("name='NovelCrawler'", "name='NovelCrawlerDbg'")
_src = _src.replace("console=False", "console=True")
_src = _src.replace("disable_windowed_traceback=False", "disable_windowed_traceback=True")
exec(compile(_src, _spec, "exec"))
@echo off
rem ============================================
rem  Build standalone exe (PyInstaller onefile)
rem  Desktop mode: 自制窗口(window2.py,Win32+WebView2 COM)
rem  Output: dist\NovelCrawler\NovelCrawler.exe
rem  (放在同名文件夹,整个文件夹可直接压缩分发)
rem
rem  注意:打包配置**只维护 NovelCrawler.spec**(静态资源/WebView2Loader.dll/
rem  内置 Playwright 驱动等都在里面);本脚本只负责选解释器 + 调用 spec,
rem  避免以前 spec 与命令行两份配置不一致的问题。
rem ============================================
setlocal
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=%~dp0bundle314\Scripts\python.exe"
if not exist "%PY%" set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"

echo Using Python: %PY%
"%PY%" -m pip install --disable-pip-version-check -q pyinstaller
rem 验证中心"自动验证"依赖 playwright(exe 内置);缺了就打不出可用的验证功能
"%PY%" -c "import playwright" 2>nul
if errorlevel 1 (
    echo [warn] 当前构建环境未安装 playwright,自动验证将不可用:
    echo        "%PY%" -m pip install playwright
)

"%PY%" -m PyInstaller --noconfirm --clean ^
  --distpath "dist\NovelCrawler" ^
  --workpath "build\pyinstaller" ^
  NovelCrawler.spec

if errorlevel 1 (
    echo Build FAILED.
    pause
    exit /b 1
)

rem 附带一份简短说明,方便测试用户了解
echo NovelCrawler 小说管家 - 免安装版> "dist\NovelCrawler\使用说明.txt"
echo.>> "dist\NovelCrawler\使用说明.txt"
echo 双击 NovelCrawler.exe 即可使用。>> "dist\NovelCrawler\使用说明.txt"
echo 书架/订阅/下载等数据保存在 exe 同目录。>> "dist\NovelCrawler\使用说明.txt"
echo 需要 Edge WebView2 运行时,Windows 10/11 自带。>> "dist\NovelCrawler\使用说明.txt"

echo.
echo Done. exe is at: dist\NovelCrawler\NovelCrawler.exe
echo 整个 dist\NovelCrawler 文件夹可直接压缩发给测试用户。
pause
endlocal
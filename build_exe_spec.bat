@echo off
rem ============================================
rem  Build standalone exe (PyInstaller onefile) —— spec 方式
rem  与 build_exe.bat 等价,配置改 NovelCrawler.spec 后用本脚本打包
rem  Output: dist\NovelCrawler\NovelCrawler.exe
rem ============================================
setlocal
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"

echo Using Python: %PY%
"%PY%" -m pip install pyinstaller -q

"%PY%" -m PyInstaller --noconfirm --clean --distpath "dist\NovelCrawler" --workpath "build\pyinstaller" NovelCrawler.spec

if errorlevel 1 (
  echo Build FAILED.
  pause
  exit /b 1
)

echo NovelCrawler 小说管家 - 免安装版> "dist\NovelCrawler\使用说明.txt"
echo.>> "dist\NovelCrawler\使用说明.txt"
echo 双击 NovelCrawler.exe 即可使用。>> "dist\NovelCrawler\使用说明.txt"
echo 书架/订阅/下载等数据保存在 exe 同目录。>> "dist\NovelCrawler\使用说明.txt"
echo 需要 Edge WebView2 运行时,Windows 10/11 自带。>> "dist\NovelCrawler\使用说明.txt"

echo.
echo Done. exe is at: dist\NovelCrawler\NovelCrawler.exe
pause
endlocal

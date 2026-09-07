@echo off
rem ============================================
rem  Build standalone exe (PyInstaller onefile)
rem  Desktop mode: 自制窗口(window2.py,Win32+WebView2 COM,脱离 pywebview)
rem  Output: dist\NovelCrawler\NovelCrawler.exe
rem  (放在同名文件夹,整个文件夹可直接压缩分发)
rem ============================================
setlocal
cd /d "%~dp0"

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"

echo Using Python: %PY%
"%PY%" -m pip install pyinstaller -q

"%PY%" -m PyInstaller --noconfirm --clean --onefile --noconsole ^
  --name NovelCrawler ^
  --icon "app.ico" ^
  --distpath "dist\NovelCrawler" ^
  --workpath "build\pyinstaller" ^
  --add-data "static;static" ^
  --add-data "icon;icon" ^
  --add-data "%PY%\..\Lib\site-packages\webview\lib\runtimes\win-x64\native\WebView2Loader.dll;webview\lib\runtimes\win-x64\native" ^
  --hidden-import novel.browser ^
  --hidden-import novel.verify ^
  --hidden-import novel.opds ^
  --hidden-import novel.epub ^
  --hidden-import novel.searcher ^
  --hidden-import novel.jsonpath ^
  --hidden-import novel.fetcher ^
  --hidden-import novel.downloader ^
  --hidden-import novel.source_registry ^
  --hidden-import novel.paths ^
  --hidden-import novel.tasklog ^
  --hidden-import novel.notes ^
  --hidden-import novel.wenku8 ^
  --hidden-import novel.comic ^
  --hidden-import novel.hotspot ^
  --hidden-import novel.tunnel ^
  --hidden-import novel.webrtc ^
  --hidden-import novel.signal_mqtt ^
  --hidden-import novel.camscan ^
  --hidden-import img2pdf ^
  --hidden-import qrcode ^
  --hidden-import cv2 ^
  window2.py

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

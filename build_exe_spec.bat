@echo off
rem ============================================
rem  Build standalone exe (PyInstaller onefile) —— spec 方式
rem  保留此脚本作为历史入口:与 build_exe.bat 完全等价(直接转发),
rem  打包配置只在 NovelCrawler.spec 里维护,避免两份配置漂移。
rem  Output: dist\NovelCrawler\NovelCrawler.exe
rem ============================================
call "%~dp0build_exe.bat"
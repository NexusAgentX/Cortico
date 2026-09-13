@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Cortico
rem 逻辑一份都不在这里:见 bin\cortico.mjs。这个壳只负责 UTF-8 代码页与退出后别关窗。
node "%~dp0bin\cortico.mjs" %*
pause

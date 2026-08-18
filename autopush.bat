@echo off
setlocal
cd /d "%~dp0"
title Lieng Online - Auto Git Push
echo ========================================================
echo        LIENG ONLINE - AUTO PUSH TO GITHUB
echo ========================================================
echo.
node scripts/autopush.js %*
echo.
echo Done. Press any key to exit...
pause >nul
endlocal

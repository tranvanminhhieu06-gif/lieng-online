@echo off
chcp 65001 >nul
title Lieng Online - Tu Dong Day Len Git

echo ========================================================
echo        LIÊNG ONLINE - TỰ ĐỘNG ĐẨY CODE LÊN GIT
echo ========================================================
echo.

cd /d "%~dp0"
node scripts\autopush.js %*

echo.
echo Nhấn phím bất kỳ để đóng cửa sổ...
pause >nul

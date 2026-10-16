@echo off
title Dosti Pakki Expense Apna Apna — Group Trip Expense Splitter
echo ==============================================================
echo        Starting Dosti Pakki Expense Apna Apna...
echo ==============================================================
echo.

cd /d "%~dp0"

if exist "C:\Program Files\nodejs\node.exe" (
    echo Starting server with Node.js on http://127.0.0.1:8080 ...
    "C:\Program Files\nodejs\node.exe" server.js
    goto end
)

where node >nul 2>nul
if %errorlevel% equ 0 (
    echo Starting server with Node.js on http://127.0.0.1:8080 ...
    node server.js
    goto end
)

start "" "%~dp0index.html"

:end
pause

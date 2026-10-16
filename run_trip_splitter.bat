@echo off
title TripSplit AI — Group Trip Expense Splitter & Receipt Scanner
echo ==============================================================
echo        Starting TripSplit AI...
echo        PIN-Protected Trips, AI Receipt OCR & Smart Settle-Up
echo ==============================================================
echo.

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% equ 0 (
    echo Starting server with Node.js on http://127.0.0.1:8080 ...
    node server.js
    goto end
)

where python >nul 2>nul
if %errorlevel% equ 0 (
    echo Starting server with Python on http://127.0.0.1:8080 ...
    python server.py
    goto end
)

start "" "%~dp0index.html"

:end
pause

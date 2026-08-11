@echo off
rem Windows launcher for Agent OS (the .command files are Mac-only)
rem Guard: if the dashboard is already running on 3737, just open the browser
netstat -ano | findstr /R /C:":3737 .*LISTENING" >nul
if %errorlevel%==0 (
    echo Agent OS already running - opening browser...
    start http://localhost:3737
    exit /b 0
)
cd /d "%~dp0source"
set PORT=3737
start http://localhost:3737
npm start

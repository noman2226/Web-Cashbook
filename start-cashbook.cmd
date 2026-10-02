@echo off
set "APP_DIR=D:\Web Cashbook"
set "APP_URL=http://localhost:5173/"

cd /d "%APP_DIR%"
start "Cashbook Local Server" /min "%APP_DIR%\run-cashbook-server.cmd"

for /l %%i in (1,1,30) do (
	powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%APP_URL%' -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
	if not errorlevel 1 goto ready
	>nul ping 127.0.0.1 -n 2
)

echo Cashbook could not start. Check "%APP_DIR%\cashbook-server.log" for details.
pause
exit /b 1

:ready
rundll32.exe url.dll,FileProtocolHandler "%APP_URL%"

@echo off
cd /d "D:\Web Cashbook"
"C:\Program Files\nodejs\npm.cmd" run dev -- --host 0.0.0.0 > "D:\Web Cashbook\cashbook-server.log" 2>&1
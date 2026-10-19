@echo off
rem One-click launcher: Relay server + ngrok tunnel, so other devices can open the app.
rem Uses the same reserved ngrok domain as SecureMsg; only one of the two apps can use it at a time.
set NGROK_DIR=D:\Installed-apps-files\ngrok-v3-stable-windows-386
set NGROK_DOMAIN=pug-canister-founder.ngrok-free.dev

echo Starting Relay and the ngrok tunnel...

start "Relay Server" cmd /k "cd /d %~dp0 && set RELAY_SECURE_COOKIES=true&& set RELAY_ALLOWED_ORIGINS=https://%NGROK_DOMAIN%,http://localhost:3000&& npm run dev"

timeout /t 8 /nobreak >nul

rem Target localhost (not 127.0.0.1): the server binds localhost, which can resolve to IPv6 only.
start "Relay Tunnel" cmd /k "cd /d %NGROK_DIR% && ngrok.exe http --url=%NGROK_DOMAIN% http://localhost:3000"

echo Relay is starting. Open on any device:
echo https://%NGROK_DOMAIN%
echo Keep both windows open while chatting. Closing this window is fine.
pause

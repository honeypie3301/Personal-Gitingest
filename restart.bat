@echo off
cd /d "%~dp0"

REM 1. Auto-install dependencies if node_modules or vite is missing
if not exist "node_modules\" (
    echo [GitIngest] Installing missing dependencies...
    call npm install
)

REM 2. Build production bundle
call npm run build
if errorlevel 1 (
    echo [GitIngest] Build failed. Checking dependencies...
    call npm install
    call npm run build
)

REM 3. Restart server with PM2 or Node fallback
where pm2 >nul 2>&1
if %errorlevel% equ 0 (
    call pm2 restart gitingest >nul 2>&1 || call pm2 start dist-server/server.mjs --name gitingest --node-args="--expose-gc --max-old-space-size=512" >nul 2>&1
    echo GitIngest server restarted via PM2 at http://localhost:3000
    for /f "tokens=*" %%a in ('git log -1 --oneline') do echo Latest Commit: %%a
    goto end
)

:fallback
echo Starting GitIngest server at http://localhost:3000...
if exist "dist-server\server.mjs" (
    node --expose-gc --max-old-space-size=512 dist-server/server.mjs
) else (
    call npx tsx server.ts
)

:end

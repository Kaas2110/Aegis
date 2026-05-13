@echo off
REM ─────────────────────────────────────────────────────────────────
REM Aegis — первый запуск на ноутбуке (Windows)
REM Запускать из корня проекта: scripts\laptop\start.bat
REM ─────────────────────────────────────────────────────────────────

cd /d "%~dp0..\.."

echo [aegis] Проверяю зависимости...
where node >nul 2>&1 || (echo [error] Node.js не найден. Скачай: https://nodejs.org && pause && exit /b 1)
where pnpm >nul 2>&1 || (echo [error] pnpm не найден. Установи: npm install -g pnpm && pause && exit /b 1)

if not exist .env (
  echo [warn] .env не найден, копирую из .env.example...
  copy .env.example .env
  echo.
  echo [ВАЖНО] Открой .env в текстовом редакторе и заполни:
  echo   DATABASE_URL, ADMIN_TOKEN, SESSION_SECRET
  echo После заполнения запусти скрипт снова.
  notepad .env
  pause
  exit /b 1
)

echo [aegis] Устанавливаю зависимости...
call pnpm install

echo [aegis] Применяю схему БД...
call pnpm --filter @workspace/db run push

echo [aegis] Создаю папку для логов...
if not exist logs mkdir logs

where pm2 >nul 2>&1
if %ERRORLEVEL% == 0 (
  echo [aegis] Запускаю сервисы через PM2...
  call pm2 start scripts\laptop\ecosystem.config.cjs
  call pm2 save
  echo.
  echo [aegis] Сервисы запущены!
  echo   Админка:  http://localhost:24276/admin-web/
  echo   API:      http://localhost:8080/api/healthz
  echo   Лендинг:  http://localhost:8080/landing
  echo.
  echo Команды: pm2 status / pm2 logs / pm2 stop all
) else (
  echo [warn] PM2 не найден. Запускаю три окна консоли...
  echo Установи PM2 для фонового запуска: npm install -g pm2
  echo.
  start "Aegis ML Service"  cmd /k "pnpm --filter @workspace/ml-service run dev"
  timeout /t 5 /nobreak >nul
  start "Aegis API Server"  cmd /k "pnpm --filter @workspace/api-server run dev"
  timeout /t 5 /nobreak >nul
  start "Aegis Admin Web"   cmd /k "pnpm --filter @workspace/admin-web run dev"
  echo.
  echo [aegis] Открыто три окна с сервисами.
  echo   Админка:  http://localhost:24276/admin-web/
  echo   API:      http://localhost:8080/api/healthz
)

pause

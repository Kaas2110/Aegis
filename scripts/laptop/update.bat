@echo off
REM ─────────────────────────────────────────────────────────────────
REM Aegis — обновление до последней версии (Windows)
REM Запускать из корня проекта: scripts\laptop\update.bat
REM ─────────────────────────────────────────────────────────────────

cd /d "%~dp0..\.."

echo [1/4] Получаю обновления из git...
git pull --rebase
if %ERRORLEVEL% neq 0 (
  echo [error] git pull не удался. Реши конфликты вручную.
  pause && exit /b 1
)

echo [2/4] Обновляю зависимости...
call pnpm install

echo [3/4] Применяю изменения схемы БД...
call pnpm --filter @workspace/db run push

echo [4/4] Перезапускаю сервисы...
where pm2 >nul 2>&1
if %ERRORLEVEL% == 0 (
  call pm2 reload scripts\laptop\ecosystem.config.cjs --update-env
  echo.
  echo [aegis] Обновление завершено! Сервисы перезапущены.
  call pm2 status
) else (
  echo.
  echo [aegis] Обновление завершено!
  echo Перезапусти сервисы вручную или закрой и снова открой start.bat
)

pause

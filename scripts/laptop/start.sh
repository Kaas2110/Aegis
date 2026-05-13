#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Aegis — первый запуск на ноутбуке (Mac / Linux / Git Bash)
# Использование: bash scripts/laptop/start.sh
# ─────────────────────────────────────────────────────────────────
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[aegis]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
error() { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ── Проверка зависимостей ─────────────────────────────────────────
command -v node  >/dev/null 2>&1 || error "Node.js не найден. Скачай: https://nodejs.org"
command -v pnpm  >/dev/null 2>&1 || error "pnpm не найден. Установи: npm install -g pnpm"
command -v python3 >/dev/null 2>&1 || warn "Python 3 не найден — ML-сервис не запустится"
command -v psql  >/dev/null 2>&1 || warn "psql не найден — убедись что PostgreSQL запущен"

NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_VER" -lt 20 ]; then
  error "Нужен Node.js 20+, установлен v$NODE_VER. Обнови: https://nodejs.org"
fi

# ── .env ─────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  warn ".env не найден — копирую из .env.example"
  cp .env.example .env
  echo ""
  warn "ВАЖНО: открой .env и заполни DATABASE_URL, ADMIN_TOKEN, SESSION_SECRET"
  warn "После заполнения запусти скрипт снова."
  exit 1
fi

# ── Установка зависимостей ────────────────────────────────────────
info "Проверяю зависимости..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# ── БД ───────────────────────────────────────────────────────────
info "Применяю схему БД..."
pnpm --filter @workspace/db run push

# ── Папка логов ───────────────────────────────────────────────────
mkdir -p logs

# ── PM2 ──────────────────────────────────────────────────────────
if command -v pm2 >/dev/null 2>&1; then
  info "Запускаю сервисы через PM2..."
  pm2 start scripts/laptop/ecosystem.config.cjs
  pm2 save
  echo ""
  info "Сервисы запущены!"
  info "  Админка:  http://localhost:24276/admin-web/"
  info "  API:      http://localhost:8080/api/healthz"
  info "  Лендинг:  http://localhost:8080/landing"
  echo ""
  info "Логи:        pm2 logs"
  info "Статус:      pm2 status"
  info "Остановить:  pm2 stop all"
else
  warn "PM2 не найден. Запускаю в режиме разработки (Ctrl+C для остановки)..."
  warn "Для фонового запуска установи PM2: npm install -g pm2"
  echo ""
  # Запуск в фоне без PM2
  set -m
  pnpm --filter @workspace/ml-service run dev &
  ML_PID=$!
  pnpm --filter @workspace/api-server run dev &
  API_PID=$!
  pnpm --filter @workspace/admin-web run dev &
  ADMIN_PID=$!

  echo ""
  info "Сервисы запущены (PID: ml=$ML_PID, api=$API_PID, admin=$ADMIN_PID)"
  info "  Админка:  http://localhost:24276/admin-web/"
  info "  API:      http://localhost:8080/api/healthz"
  info "Нажми Ctrl+C для остановки всех сервисов"

  trap "kill $ML_PID $API_PID $ADMIN_PID 2>/dev/null; exit" INT TERM
  wait
fi

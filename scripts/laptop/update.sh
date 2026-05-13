#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Aegis — обновление до последней версии (Mac / Linux / Git Bash)
# Использование: bash scripts/laptop/update.sh
# ─────────────────────────────────────────────────────────────────
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[aegis]${NC} $*"; }
step()  { echo -e "${CYAN}──────${NC} $*"; }

step "Получаю обновления из git..."
git pull --rebase

step "Проверяю зависимости..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

step "Применяю изменения схемы БД..."
pnpm --filter @workspace/db run push

step "Перезапускаю сервисы..."
if command -v pm2 >/dev/null 2>&1; then
  pm2 reload scripts/laptop/ecosystem.config.cjs --update-env
  echo ""
  info "Обновление завершено! Сервисы перезапущены."
  pm2 status
else
  echo ""
  info "Обновление завершено!"
  echo -e "${YELLOW}Перезапусти сервисы вручную (или используй PM2).${NC}"
fi

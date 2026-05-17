#!/usr/bin/env bash
# Hourly Live Tracker — лёгкий часовой батч (~3-5 мин).
# Запускается через workflow "Hourly Live".
# Поддерживает свежесть match-данных и form-фичей между суточными retrain-циклами.
#   - ingest:matches 3  (~300 последних pro-матчей, быстро)
#   - compute:recent-form (30/90d форма команд)
#   - compute:bo3-series (BO3/BO5 агрегаты для T3 momentum)
#
# Не трогает: drafts, hero-stats, players-heroes, Glicko (это дела daily/enrichment).
# Не запускает ретрейн (правило replit.md: только после явного «да»).
# Логи: stdout (workflow) + /tmp/ingest_logs/hourly.log
set -u
cd "$(dirname "$0")/.."

LOG=/tmp/ingest_logs/hourly.log
mkdir -p /tmp/ingest_logs
ts() { date '+%Y-%m-%d %H:%M:%S'; }

exec > >(tee -a "$LOG") 2>&1

echo
echo "[$(ts)] ===== HOURLY LIVE START ====="

step() {
  local n=$1 total=$2 name="$3"
  shift 3
  echo
  echo "[$(ts)] --- STEP $n/$total: $name ---"
  if "$@"; then echo "[$(ts)] ✅ OK"
  else echo "[$(ts)] ⚠️  FAILED rc=$? (continuing)"; fi
}

step 1 3 "ingest:matches 3" \
  pnpm --filter @workspace/scripts run ingest:matches 3

step 2 3 "compute:recent-form" \
  pnpm --filter @workspace/scripts run compute:recent-form

step 3 3 "compute:bo3-series" \
  pnpm --filter @workspace/scripts run compute:bo3-series

echo
echo "[$(ts)] ===== HOURLY LIVE DONE ====="

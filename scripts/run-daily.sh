#!/usr/bin/env bash
# Лёгкий daily-батч (~10-15 мин). Запускать раз в день когда workspace открыт.
# Запуск: bash scripts/run-daily.sh   (или из workflow "Daily Batch")
#
# Что делает (по приоритету):
#   1. ingest:teams        — обновить рейтинги команд (~30с)
#   2. ingest:matches 5    — последние ~500 pro-матчей (~10с)
#   3. ingest:leagues      — названия турниров
#   4. ingest:hero-stats   — мета-винрейты (раз в день достаточно)
#   5. compute:recent-form — пересчитать форму команд (быстро)
#   6. compute:h2h         — H2H матрица (быстро)
#   7. compute:bo3-series  — агрегаты BO3/BO5 для T3 momentum
#
# НЕ запускается тут (это тяжёлые штуки из run-enrichment-pipeline.sh):
#   - ingest:drafts (1.7ч с MIN_AVG_GLICKO=0)
#   - ingest:players-heroes (Stratz, ~7-day freshness — нет смысла каждый день)
#   - compute:player-glicko (после ingest:drafts)
#   - тренировки моделей (отдельный график)
set -u
cd "$(dirname "$0")/.."

LOG=/tmp/ingest_logs/daily.log
mkdir -p /tmp/ingest_logs
ts() { date '+%H:%M:%S'; }
exec > >(tee -a "$LOG") 2>&1

echo
echo "[$(ts)] ===== DAILY BATCH START ====="

step() {
  local n=$1 total=$2 name="$3"
  shift 3
  echo
  echo "[$(ts)] --- STEP $n/$total: $name ---"
  if "$@"; then echo "[$(ts)] ✅ OK"
  else echo "[$(ts)] ⚠️  FAILED rc=$? (continuing)"; fi
}

step 1 7 "ingest:teams"        pnpm --filter @workspace/scripts run ingest:teams
step 2 7 "ingest:matches 5"    pnpm --filter @workspace/scripts run ingest:matches 5
step 3 7 "ingest:leagues"      pnpm --filter @workspace/scripts run ingest:leagues
step 4 7 "ingest:hero-stats"   pnpm --filter @workspace/scripts run ingest:hero-stats
step 5 7 "compute:recent-form" pnpm --filter @workspace/scripts run compute:recent-form
step 6 7 "compute:h2h"         pnpm --filter @workspace/scripts run compute:h2h
step 7 7 "compute:bo3-series"  pnpm --filter @workspace/scripts run compute:bo3-series

echo
echo "[$(ts)] ===== DAILY BATCH DONE ====="

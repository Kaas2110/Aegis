#!/usr/bin/env bash
# Полный daily-батч (~25-40 мин). Все 11 пресетов в правильном порядке.
# Запуск: bash scripts/run-daily.sh   (или из workflow "Daily Ingest")
#
# Зависимости порядка:
#   teams → matches → leagues → hero-stats → hero-matchups → hero-synergy →
#   recent-form → h2h → player-glicko → team-extended (peer_synergy) → bo3-series
#
# НЕ запускается тут (тяжёлые штуки из run-enrichment-pipeline.sh):
#   - ingest:drafts (1.7ч с MIN_AVG_GLICKO=0) — еженедельно
#   - ingest:players-heroes (Stratz, ~7-day freshness)
#   - тренировки моделей (отдельный график / auto-retrain)
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

TOTAL=11
step  1 $TOTAL "ingest:teams"          pnpm --filter @workspace/scripts run ingest:teams
step  2 $TOTAL "ingest:matches 5"      pnpm --filter @workspace/scripts run ingest:matches 5
step  3 $TOTAL "ingest:leagues"        pnpm --filter @workspace/scripts run ingest:leagues
step  4 $TOTAL "ingest:hero-stats"     pnpm --filter @workspace/scripts run ingest:hero-stats
step  5 $TOTAL "ingest:hero-matchups"  pnpm --filter @workspace/scripts run ingest:hero-matchups
step  6 $TOTAL "ingest:hero-synergy"   pnpm --filter @workspace/scripts run ingest:hero-synergy
step  7 $TOTAL "compute:recent-form"   pnpm --filter @workspace/scripts run compute:recent-form
step  8 $TOTAL "compute:h2h"           pnpm --filter @workspace/scripts run compute:h2h
step  9 $TOTAL "compute:player-glicko" pnpm --filter @workspace/scripts run compute:player-glicko
step 10 $TOTAL "compute:team-extended" pnpm --filter @workspace/scripts run compute:team-extended
step 11 $TOTAL "compute:bo3-series"    pnpm --filter @workspace/scripts run compute:bo3-series

echo
echo "[$(ts)] ===== DAILY BATCH DONE ====="

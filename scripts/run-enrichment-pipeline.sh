#!/usr/bin/env bash
# Data enrichment pipeline — запускается через workflow "Data Enrichment".
# Финиширует сам когда всё готово (workflow помечается finished, не restart'ится).
# Лог пишет и в stdout (видно в workflow logs), и в /tmp/ingest_logs/pipeline.log.
set -u
cd "$(dirname "$0")/.."

LOG=/tmp/ingest_logs/pipeline.log
mkdir -p /tmp/ingest_logs
ts() { date '+%H:%M:%S'; }

exec > >(tee -a "$LOG") 2>&1

echo
echo "[$(ts)] ============================="
echo "[$(ts)] DATA ENRICHMENT PIPELINE START"
echo "[$(ts)] ============================="
echo

step() {
  local n=$1 total=$2 name="$3"
  shift 3
  echo
  echo "[$(ts)] --- STEP $n/$total: $name ---"
  if "$@"; then
    echo "[$(ts)] ✅ STEP $n/$total OK: $name"
  else
    local rc=$?
    echo "[$(ts)] ⚠️  STEP $n/$total FAILED rc=$rc: $name (continuing pipeline)"
  fi
}

step 1 6 "ingest:drafts (MIN_AVG_GLICKO=0, ~24k матчей × ~260ms Stratz ≈ 1.7ч)" \
  pnpm --filter @workspace/scripts run ingest:drafts

step 2 6 "ingest:players-heroes (Stratz, 7-day freshness)" \
  pnpm --filter @workspace/scripts run ingest:players-heroes

step 3 6 "compute:player-glicko (Glicko-1, 30d period)" \
  pnpm --filter @workspace/scripts run compute:player-glicko

step 4 6 "compute:recent-form (30d/90d)" \
  pnpm --filter @workspace/scripts run compute:recent-form

step 5 6 "compute:h2h (365d)" \
  pnpm --filter @workspace/scripts run compute:h2h

step 6 6 "compute:team-extended (snapshots)" \
  pnpm --filter @workspace/scripts run compute:team-extended

# ── E0 Premium OD steps (добавлены 2026-05-17) ─────────────────────────────
# Три новых источника данных из OpenDota premium endpoints.
# Fail-soft: каждый шаг продолжает пайплайн даже при ошибке.
# Описание фичей: docs/ml-feature-audit.md, план: .local/session_plan.md §E0.
step 7 9 "ingest:od-scenarios (hero item-timing / lane-role winrates, OD premium)" \
  pnpm --filter @workspace/scripts run ingest:od-scenarios

step 8 9 "ingest:od-player-peers (pro-player peer winrates, 7-day freshness)" \
  pnpm --filter @workspace/scripts run ingest:od-player-peers

step 9 17 "ingest:od-distributions (hero durations + meta distributions, 7-day freshness)" \
  pnpm --filter @workspace/scripts run ingest:od-distributions

# ── E1 OD extension (добавлены 2026-05-18) ────────────────────────────────
# 8 новых OD ingest скриптов — дополнительные фичи для бустинг-моделей.
# План: replit.md «E1 OD-расширение», датасеты — там же.
# Throttle 20 req/s через scripts/src/lib/odPace.ts.
step 10 17 "ingest:od-pro-players (справочник pro-аккаунтов, 1 запрос, weekly)" \
  pnpm --filter @workspace/scripts run ingest:od-pro-players

step 11 17 "ingest:od-hero-benchmarks (перцентили GPM/XPM/kills, 138 req, weekly)" \
  pnpm --filter @workspace/scripts run ingest:od-hero-benchmarks

step 12 17 "ingest:od-hero-item-popularity (start/early/mid/late items, 138 req, weekly)" \
  pnpm --filter @workspace/scripts run ingest:od-hero-item-popularity

step 13 17 "ingest:od-team-rosters (текущий ростер команды, ~3000 req, 7d freshness)" \
  pnpm --filter @workspace/scripts run ingest:od-team-rosters

step 14 17 "ingest:od-team-hero-pools (hero pool команды, ~3000 req, 7d freshness)" \
  pnpm --filter @workspace/scripts run ingest:od-team-hero-pools

step 15 17 "ingest:od-player-totals (долгосрочные суммы статов, ~3000 req, 14d freshness)" \
  pnpm --filter @workspace/scripts run ingest:od-player-totals

step 16 17 "ingest:od-player-counts (lane_role/game_mode распределение, ~3000 req, 14d freshness)" \
  pnpm --filter @workspace/scripts run ingest:od-player-counts

step 17 17 "ingest:od-player-wl-pro (pro-only WL 180d, ~3000 req, 14d freshness)" \
  pnpm --filter @workspace/scripts run ingest:od-player-wl-pro

echo
echo "[$(ts)] ============================="
echo "[$(ts)] DATA ENRICHMENT PIPELINE DONE"
echo "[$(ts)] ============================="

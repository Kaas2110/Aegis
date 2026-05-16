#!/usr/bin/env bash
# Drafts backfill 365d — однократно, без glicko-фильтра, БЕЗ ингеста дальше.
# Запускается через workflow "Drafts Backfill 365d". Workflow финиширует
# (state=finished) когда скрипт отработает. ETA ~100 минут на ~23k матчей.
#
# Если упадёт — restart workflow, ingest:drafts идемпотентен (already-present
# skip'аются на стадии селектора).
#
# Лог: stdout (видно в workflow logs) + /tmp/ingest_logs/drafts-backfill.log
set -u
cd "$(dirname "$0")/.."

LOG=/tmp/ingest_logs/drafts-backfill.log
mkdir -p /tmp/ingest_logs
ts() { date '+%Y-%m-%d %H:%M:%S'; }

exec > >(tee -a "$LOG") 2>&1

echo
echo "[$(ts)] ============================="
echo "[$(ts)] DRAFTS BACKFILL 365d (ALL pro_matches, no glicko filter)"
echo "[$(ts)] ============================="
echo

pnpm --filter @workspace/scripts run ingest:drafts -- --all-365d
RC=$?

echo
echo "[$(ts)] ============================="
echo "[$(ts)] DONE rc=$RC"
echo "[$(ts)] ============================="
exit $RC

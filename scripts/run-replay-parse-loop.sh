#!/usr/bin/env bash
# T0.7 BACKFILL+CRUISE replay-parse loop. Долгоживущий процесс под workflow
# "Replay Parse Loop". Два периодических цикла:
#   * parse:request    каждый тик (10 мин) — ставит матчи в очередь OD parser
#                      (limit=1500, окно=365d). Premium OD key: 10 req/s
#                      → 1500 матчей ≈ 2.5 мин работы.
#   * ingest:parsed    каждый тик (10 мин) — забирает готовые из очереди
#                      (limit=600, ~1 мин при 10 req/s).
#
# Backfill режим активирован 2026-05-18: окно 90→365d (долг ~21k матчей),
# RATE_LIMIT_MS 500→100 (premium key, 10 req/s).
# Не запускает retraining (правило replit.md: только после явного «да»).
# Логи: stdout (workflow) + /tmp/ingest_logs/replay-parse.log
set -u
cd "$(dirname "$0")/.."

LOG=/tmp/ingest_logs/replay-parse.log
mkdir -p /tmp/ingest_logs
ts() { date '+%Y-%m-%d %H:%M:%S'; }

exec > >(tee -a "$LOG") 2>&1

echo
echo "[$(ts)] ============================="
echo "[$(ts)] REPLAY PARSE LOOP START"
echo "[$(ts)] parse:request every 10 min (limit=1500, since=365d) — BACKFILL"
echo "[$(ts)] ingest:parsed every 10 min (limit=600)"
echo "[$(ts)] ============================="
echo

# Trap SIGTERM от workflow restart'а: дожидаемся текущей итерации, выходим.
RUNNING=1
trap 'echo "[$(ts)] SIGTERM received, finishing current iteration…"; RUNNING=0' TERM INT

# Backfill+cruise: тик = 10 мин, parse:request и ingest:parsed каждый тик.
# При нагоне долга (~21k матчей) → ~3-4 дня до полного опустошения backlog,
# дальше станет «крейсерским» (queued=0 на каждом тике, fast no-op).
TICK_SEC=600
tick=0

while [ $RUNNING -eq 1 ]; do
  tick=$((tick + 1))

  echo
  echo "[$(ts)] --- tick=$tick · parse:request (backfill: limit=1500, since=365d) ---"
  pnpm --filter @workspace/scripts run parse:request -- --limit 1500 --since-days 365 \
    || echo "[$(ts)] parse:request failed (continuing)"

  echo
  echo "[$(ts)] --- tick=$tick · ingest:parsed (limit=600) ---"
  pnpm --filter @workspace/scripts run ingest:parsed -- --limit 600 \
    || echo "[$(ts)] ingest:parsed failed (continuing)"

  echo
  echo "[$(ts)] tick=$tick done · sleep ${TICK_SEC}s"
  # Прерываемый sleep: разбиваем на короткие интервалы чтобы SIGTERM
  # обрабатывался без задержки.
  for _ in $(seq 1 $((TICK_SEC / 5))); do
    [ $RUNNING -eq 0 ] && break
    sleep 5
  done
done

echo "[$(ts)] loop stopped (RUNNING=0)"

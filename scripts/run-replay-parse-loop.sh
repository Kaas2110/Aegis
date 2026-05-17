#!/usr/bin/env bash
# T0.7 CRUISE replay-parse loop. Долгоживущий процесс под workflow
# "Replay Parse Loop". Два периодических цикла (крейсерский режим):
#   * parse:request    каждые 2 ч  (каждый 4-й тик) — ставит свежие матчи в очередь OD parser
#   * ingest:parsed    каждые 30 мин — забирает готовые из очереди в match_parsed
#
# Крейсерский режим активирован 2026-05-17: parse 60d→90d покрытие >99%.
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
echo "[$(ts)] parse:request every 30 min (limit=500, since=60d)"
echo "[$(ts)] ingest:parsed every 10 min (limit=300)"
echo "[$(ts)] ============================="
echo

# Trap SIGTERM от workflow restart'а: дожидаемся текущей итерации, выходим.
RUNNING=1
trap 'echo "[$(ts)] SIGTERM received, finishing current iteration…"; RUNNING=0' TERM INT

# Крейсерский режим: тик = 30 мин, parse:request каждые 2ч (каждый 4-й тик).
TICK_SEC=1800
tick=0

while [ $RUNNING -eq 1 ]; do
  tick=$((tick + 1))

  if [ $((tick % 4)) -eq 1 ]; then
    echo
    echo "[$(ts)] --- tick=$tick · parse:request (cruise: limit=200, since=90d) ---"
    pnpm --filter @workspace/scripts run parse:request -- --limit 200 --since-days 90 \
      || echo "[$(ts)] parse:request failed (continuing)"
  fi

  echo
  echo "[$(ts)] --- tick=$tick · ingest:parsed (limit=150) ---"
  pnpm --filter @workspace/scripts run ingest:parsed -- --limit 150 \
    || echo "[$(ts)] ingest:parsed failed (continuing)"

  echo
  echo "[$(ts)] tick=$tick done · sleep ${TICK_SEC}s"
  # Прерываемый sleep: разбиваем на короткие интервалы чтобы SIGTERM
  # обрабатывался без задержки до 10 мин.
  for _ in $(seq 1 $((TICK_SEC / 5))); do
    [ $RUNNING -eq 0 ] && break
    sleep 5
  done
done

echo "[$(ts)] loop stopped (RUNNING=0)"

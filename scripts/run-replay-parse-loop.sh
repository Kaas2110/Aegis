#!/usr/bin/env bash
# T0.7 regular replay-parse loop. Долгоживущий процесс под workflow
# "Replay Parse Loop". Делает два параллельных периодических цикла:
#   * parse:request    каждые 30 мин — ставит свежие матчи в очередь OD parser
#   * ingest:parsed    каждые 10 мин — забирает готовые из очереди в match_parsed
#
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

# Тик = 10 минут. Каждый 3-й тик (== 30 мин) запускаем parse:request.
TICK_SEC=600
tick=0

while [ $RUNNING -eq 1 ]; do
  tick=$((tick + 1))

  if [ $((tick % 3)) -eq 1 ]; then
    echo
    echo "[$(ts)] --- tick=$tick · parse:request (limit=500, since=60d) ---"
    pnpm --filter @workspace/scripts run parse:request -- --limit 500 --since-days 60 \
      || echo "[$(ts)] parse:request failed (continuing)"
  fi

  echo
  echo "[$(ts)] --- tick=$tick · ingest:parsed (limit=300) ---"
  pnpm --filter @workspace/scripts run ingest:parsed -- --limit 300 \
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

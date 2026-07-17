#!/usr/bin/env bash
# T0.7 BACKFILL+CRUISE replay-parse loop. Долгоживущий процесс под workflow
# "Replay Parse Loop". Два периодических цикла:
#   * parse:request    каждый тик (30 мин) — ставит матчи в очередь OD parser
#                      (limit=100, окно=180d). FREE MODE: 1100ms троттл.
#   * ingest:parsed    каждый тик (30 мин) — забирает готовые из очереди
#                      (limit=200, 1100ms троттл в free mode).
#
# FREE MODE (2026-07-17): OD без ключа = 60 req/min / 3000 req/day НА ВСЁ
# приложение (LiveWorker + hourly/daily тоже тратят эту квоту). Поэтому:
# limit=100/тик × 48 тиков = макс ~4800 попыток, реально quota-guard в
# parse-request прерывает тик после 3× 429 подряд. Приоритет квоты — live
# данные для пользователя (LiveWorker), parse-loop добирает остаток.
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
echo "[$(ts)] parse:request every 30 min (limit=100, since=180d) — FREE MODE"
echo "[$(ts)] ingest:parsed every 30 min (limit=200)"
echo "[$(ts)] ============================="
echo

# Trap SIGTERM от workflow restart'а: дожидаемся текущей итерации, выходим.
RUNNING=1
trap 'echo "[$(ts)] SIGTERM received, finishing current iteration…"; RUNNING=0' TERM INT

# FREE MODE: тик = 30 мин (совпадает с расписанием ноута из laptop-deploy.md).
TICK_SEC=1800
tick=0

while [ $RUNNING -eq 1 ]; do
  tick=$((tick + 1))

  echo
  echo "[$(ts)] --- tick=$tick · parse:request (free mode: limit=100, since=180d) ---"
  pnpm --filter @workspace/scripts run parse:request -- --limit 100 --since-days 180 \
    || echo "[$(ts)] parse:request failed (continuing)"

  echo
  echo "[$(ts)] --- tick=$tick · ingest:parsed (limit=200) ---"
  pnpm --filter @workspace/scripts run ingest:parsed -- --limit 200 \
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

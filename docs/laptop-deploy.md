# Laptop deployment — переезд воркеров с Replit на ноут

> Контекст: пользователь планирует переехать с Replit на личный ноутбук. На
> Replit фоновые скрипты живут как **workflows**. На ноуте те же скрипты будут
> запускаться через **systemd timer / cron** (Linux/macOS) или **Task
> Scheduler** (Windows + WSL). Идея — никаких рефакторов, просто другой
> планировщик.

## Что переносим

В монорепо есть 5 long-running workflow-скриптов в `scripts/`:

| Скрипт                          | Запуск как Replit workflow | Интервал на ноуте                  |
|---------------------------------|----------------------------|------------------------------------|
| `scripts/run-daily.sh`          | Daily Ingest               | раз в сутки (например, 04:00)      |
| `scripts/run-hourly.sh`         | Hourly Live                | каждый час                         |
| `scripts/run-replay-parse-loop.sh` | Replay Parse Loop       | один раз (long-running) или per-tick cron каждые 30 минут |
| `scripts/run-enrichment-pipeline.sh` | Data Enrichment       | раз в неделю (например, воскресенье 03:00) |
| `scripts/run-drafts-backfill.sh` | Drafts Backfill 365d      | разовый запуск (или раз в квартал) |

Сам **api-server** (`artifacts/api-server`) запускается отдельным
long-running процессом (systemd-юнит, pm2, screen). Внутри него уже крутятся
**в-процессные воркеры** LiveWorker и SchedulerWorker — их трогать не нужно.

## Предусловия на ноуте

1. **Node 24** + **pnpm 9** + **Python 3.11+** (для ml-service)
2. Локальный **PostgreSQL** (или удалённый — если хотим оставить prod-БД)
3. `.env` файл рядом с репо со следующими переменными:
   ```bash
   # обязательное
   DATABASE_URL=postgres://aegis:password@127.0.0.1:5432/aegis

   # опциональное (если есть)
   OPENDOTA_API_KEY=...
   STRATZ_TOKEN=tok1,tok2,tok3
   PANDASCORE_API_KEY=...
   ADMIN_TOKEN=...
   SESSION_SECRET=...   # обязательно для admin + user-auth

   # выключатели (по необходимости)
   DISABLE_LIVE_WORKER=false
   DISABLE_SCHEDULER=false
   # Auto-retrain (P5): на ноуте включаем, на Replit — выключено.
   #   DISABLE_AUTO_RETRAIN=true → killswitch (фаза train пропускается).
   #   AUTO_RETRAIN_CRON_HOUR_UTC=0..23 → разрешено ТОЛЬКО в этот час UTC.
   # Стандарт для ноута:
   DISABLE_AUTO_RETRAIN=false
   AUTO_RETRAIN_CRON_HOUR_UTC=4  # ~07:00 МСК — тихий час, нет live-poll нагрузки
   ```
4. `pnpm install` в корне репо

## Smoke-test (перед cron)

Прогнать каждый скрипт вручную и убедиться, что он **зелёный** standalone:

```bash
# 0. Переменные окружения должны быть видны процессу
set -a; source ./.env; set +a

# 1. БД доступна
pnpm --filter @workspace/db run push   # одна раз для миграций

# 2. Лёгкий скрипт
bash scripts/run-hourly.sh             # ~3-5 мин

# 3. Тяжёлый daily (без auto-retrain — флаг выше)
bash scripts/run-daily.sh              # ~25-40 мин

# 4. Loop с прерыванием
bash scripts/run-replay-parse-loop.sh  # ставит первую итерацию,
                                       # затем Ctrl+C — должно корректно остановиться
```

Все скрипты пишут параллельно:
- в stdout (для workflow-логов Replit / journalctl на ноуте),
- в `/tmp/ingest_logs/<имя>.log` (постоянный файловый лог).

## Вариант A: crontab (самый простой)

`crontab -e`, потом вставить:

```cron
# Aegis — фоновые ingest/compute задачи
# .env подгружается per-job через bash -lc
PATH=/usr/local/bin:/usr/bin:/bin
AEGIS=/home/$USER/aegis
LOGDIR=/var/log/aegis

# Hourly Live — каждые 60 минут на 5-й минуте
5 * * * * cd $AEGIS && bash -lc 'set -a; source .env; set +a; bash scripts/run-hourly.sh >> $LOGDIR/hourly.log 2>&1'

# Daily Ingest — ежедневно в 04:00
0 4 * * * cd $AEGIS && bash -lc 'set -a; source .env; set +a; bash scripts/run-daily.sh >> $LOGDIR/daily.log 2>&1'

# Weekly Enrichment — воскресенье 03:00 (~1.7 часа)
0 3 * * 0 cd $AEGIS && bash -lc 'set -a; source .env; set +a; bash scripts/run-enrichment-pipeline.sh >> $LOGDIR/enrichment.log 2>&1'
```

**Replay Parse Loop** — это long-running процесс (внутри него уже свой
`TICK_SEC=1800` тикер с обработкой SIGTERM), поэтому через cron его не
запускают. Варианты:

- A1. systemd-юнит `aegis-replay-parse.service` (см. ниже)
- A2. tmux/screen сессия `screen -dmS replay bash scripts/run-replay-parse-loop.sh`

## Вариант B: systemd (рекомендуется для постоянной работы)

### B1. api-server как сервис

`/etc/systemd/system/aegis-api.service`:

```ini
[Unit]
Description=Aegis API server
After=network.target postgresql.service

[Service]
Type=simple
User=aegis
WorkingDirectory=/home/aegis/aegis
EnvironmentFile=/home/aegis/aegis/.env
Environment=PORT=8080
ExecStart=/usr/bin/pnpm --filter @workspace/api-server run start
Restart=always
RestartSec=10
StandardOutput=append:/var/log/aegis/api.log
StandardError=append:/var/log/aegis/api.log

[Install]
WantedBy=multi-user.target
```

### B2. ml-service (Python/FastAPI) — аналогично:

```ini
[Unit]
Description=Aegis ML service
After=network.target

[Service]
Type=simple
User=aegis
WorkingDirectory=/home/aegis/aegis/artifacts/ml-service
EnvironmentFile=/home/aegis/aegis/.env
ExecStart=/usr/bin/uv run uvicorn app:app --host 127.0.0.1 --port 8090
Restart=always

[Install]
WantedBy=multi-user.target
```

### B3. Replay parse loop — long-running

`/etc/systemd/system/aegis-replay-parse.service`:

```ini
[Unit]
Description=Aegis replay parse loop
After=network.target aegis-api.service

[Service]
Type=simple
User=aegis
WorkingDirectory=/home/aegis/aegis
EnvironmentFile=/home/aegis/aegis/.env
ExecStart=/bin/bash scripts/run-replay-parse-loop.sh
KillSignal=SIGTERM
TimeoutStopSec=300
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

### B4. Daily / Hourly / Enrichment как timer

`/etc/systemd/system/aegis-daily.service` (oneshot):

```ini
[Unit]
Description=Aegis daily ingest

[Service]
Type=oneshot
User=aegis
WorkingDirectory=/home/aegis/aegis
EnvironmentFile=/home/aegis/aegis/.env
ExecStart=/bin/bash scripts/run-daily.sh
```

`/etc/systemd/system/aegis-daily.timer`:

```ini
[Unit]
Description=Aegis daily ingest @ 04:00

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Аналогично создать `aegis-hourly.{service,timer}` (OnCalendar=hourly) и
`aegis-enrichment.{service,timer}` (OnCalendar=Sun 03:00:00).

### B5. Активация

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aegis-api.service aegis-ml.service aegis-replay-parse.service
sudo systemctl enable --now aegis-daily.timer aegis-hourly.timer aegis-enrichment.timer
sudo systemctl list-timers '*aegis*'
```

## Мониторинг

- `journalctl -u aegis-api -f` — live логи api-server
- `journalctl -u aegis-replay-parse -f` — replay loop
- `tail -f /tmp/ingest_logs/daily.log` — следить за последним прогоном daily
- В admin UI `/admin-web/workers` уже есть **WorkerFlagsPanel** с heartbeats
  (`liveWorker.lastTickAt`, `scheduler.lastTickAt`) — там видно, что LiveWorker
  и SchedulerWorker внутри api-server действительно пульсируют.

## Бэкап БД

Тривиально для PG:

```bash
# ежедневный dump в /var/backups/aegis/$(date +%F).sql.gz
0 5 * * * pg_dump -Fc aegis | gzip > /var/backups/aegis/$(date +\%F).sql.gz
# чистка старше 14 дней
30 5 * * * find /var/backups/aegis -name '*.sql.gz' -mtime +14 -delete
```

## Чек-лист «переезд завершён»

- [ ] PG поднят, `DATABASE_URL` указывает на ноут
- [ ] `pnpm install` прошёл, `pnpm run typecheck` зелёный
- [ ] `bash scripts/run-hourly.sh` отрабатывает standalone (smoke)
- [ ] api-server и ml-service крутятся как systemd-юниты (или pm2)
- [ ] Replay parse loop крутится как systemd-юнит и переживает рестарт
- [ ] Daily / Hourly / Enrichment timers активны (`systemctl list-timers`)
- [ ] В admin UI worker heartbeats показывают `ok` для обоих воркеров
- [ ] PG-бэкап в крон
- [ ] (опционально) Cloudflare Tunnel / Tailscale Funnel для публичного HTTPS
      доступа к api-server, если мобилка ходит снаружи

## Букмекеры — диагностика после переезда (важно)

На Replit-IP реально работала только **Bovada** (US, без ключа). Все 6 РФ-буков
заблокированы по DNS / Cloudflare / гео. Тест с datacenter РФ-прокси (proxy6.net,
2026-05-18) показал что прокси решает проблему только частично, см. ниже.

На РФ-IP ноута картина изменится — нужно **передиагностировать каждый источник**:

### 1. Сам факт переезда — Bovada сломается

Bovada (US-licensed) скорее всего вернёт **HTML/403 на РФ-IP** — то же что
proxy-тест показал когда мы пытались прогнать Bovada через РФ-прокси.

**Что делать:** либо отключить Bovada в `routes/bookmakers.ts` (убрать `bovada` из
`SOURCES_TO_PROBE`), либо использовать BroVPN со сплит-туннелингом (RU-трафик
напрямую, US-трафик через VPN). Второе сложнее, рекомендую первое — пока не
сделаем РФ-буков, букмекерский UI вообще пропадёт всё равно.

### 2. РФ-буки — 3 из 6 имеют устаревшие адаптеры (нужна починка в браузере)

Smoke 2026-05-18 (`artifacts/api-server/src/scripts/probe-bookmakers.ts`,
запуск: `pnpm --filter @workspace/scripts exec tsx /<абс_путь>/probe-bookmakers.ts`)
показал по адаптерам:

| Источник | Что отдаёт | Что чинить |
|---|---|---|
| **fonbet** `line34.fonbet.ru/api/v1/line/sport/events?sport=12` | DNS ENOTFOUND с Replit | Проверить на РФ-IP резолвится ли поддомен. Если нет — заменить на `https://line.fonbet.ru` или базовый домен |
| **ligastavok** `line.ligastavok.ru/lsbets/api/v3/...` | DNS ENOTFOUND | То же — открыть в браузере на ноуте, посмотреть реальный домен через DevTools → Network |
| **pari** `pari.ru/api/v3/line/events?sportId=33` | 200 **HTML** вместо JSON | Адаптер бьёт устаревший URL и получает фронт. Открыть `https://pari.ru/cybersport/dota-2`, DevTools → Network → XHR → найти запрос с list событий, прислать URL |
| **betboom** `betboom.ru/api/v3/sports/40/line` | **404 JSON** | Эндпоинт сменился. Тот же recipe — браузер + DevTools |
| **1xstavka** `1xstavka.ru/LineFeed/Get1x2_VZip?sports=1620` | 403 Cloudflare | Cloudflare палит даже datacenter РФ-IP. На residential / домашнем IP **может** пройти — проверить с ноута |
| **olimp** `olimp.bet/ru/api/lines/get_events` | 200 **HTML** вместо JSON | Тот же recipe что pari |

### 3. Recipe «починить адаптер» (3-5 минут на источник)

1. Открыть сайт буки на ноуте: например `https://pari.ru/cybersport/dota-2`.
2. F12 → **Network** → фильтр **XHR/Fetch** → перезагрузить страницу.
3. Найти запрос с JSON-ответом, содержащим события Dota 2 (обычно 10-50KB JSON).
4. Скопировать **URL** запроса (включая query params) и **Origin/Referer** headers.
5. Прислать мне в чат — обновлю `routes/bookmakers.ts::adapter*` функции.

### 4. Smoke-команда

После переезда первый прогон, чтобы зафиксировать baseline:

```bash
cd <repo>
pnpm --filter @workspace/scripts exec tsx \
  $(pwd)/artifacts/api-server/src/scripts/probe-bookmakers.ts
```

Сравни вывод с тестом 2026-05-18 — какие источники ожили на РФ-IP без правок,
какие требуют новый URL. Бери в работу только те, которые отдают **JSON**
(HTTP 200 + `ct=application/json`). HTML / 403 / 404 — отдельный пайплайн.

### 5. PROXY_URL — больше не используется

После теста shared РФ-прокси (2026-05-18) вся прокси-логика **убрана из кода**.
api-server ходит во все источники напрямую. `PROXY_URL` env var игнорируется
рантаймом (остаётся только в `scripts/src/scripts/probe-bookmakers.ts` для
сравнительного теста: если задан, скрипт дополнительно прогоняет РФ-источники
через прокси и сравнивает с direct-вызовами).

## Что НЕ переносим

- `parse:cycle` НЕ интегрируется в SchedulerWorker (см. user prefs в
  `replit.md`) — на ноуте `run-replay-parse-loop.sh` под systemd проще
  ребутить и логировать.
- `train:lightgbm` и `train:model` — на ноуте управляются через SchedulerWorker
  (фаза train в `runRetrainPipeline`). Защита от конфликтов с ingest-cron'ами —
  через `AUTO_RETRAIN_CRON_HOUR_UTC=4`: тренировка стартует только в указанный
  час UTC. На Replit оставляем `DISABLE_AUTO_RETRAIN=true`,
  пока пользователь явно не разрешит «да, можно автоматом».

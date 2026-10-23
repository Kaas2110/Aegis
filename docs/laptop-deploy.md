# Laptop deployment — переезд воркеров с Replit на ноут

> Контекст: пользователь планирует переехать с Replit на личный ноутбук. На
> Replit фоновые скрипты живут как **workflows**. На ноуте те же скрипты будут
> запускаться через **systemd timer / cron** (Linux/macOS) или **Task
> Scheduler** (Windows + WSL). Идея — никаких рефакторов, просто другой
> планировщик.

## Режим OpenDota: FREE (актуально с 2026-07)

Все ingest-скрипты и parse-пайплайн работают **без ключа OpenDota**:
троттл `odThrottleMs()` = 1100ms (≈54 req/min при лимите 60 req/min,
3000 req/day). Это уже учтено в интервалах ниже — ничего ускорять не надо.
Если пользователь купит premium, включается парой env-переменных
(`OPENDOTA_USE_PREMIUM=true` + `OPENDOTA_API_KEY`), тогда троттлы сами
ужмутся до premium-значений.

Бюджет free-дня (~3000 req): Hourly (24 × ~30 req) + Daily (~500-800 req) +
Replay Parse Loop (остаток). Если replay-парсинг упирается в 429 — увеличить
`TICK_SEC` в systemd-юните или снизить лимит матчей в `parse:request`.

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

## Шаг 0. Чистая установка ноута (каждый шаг и действие)

Предполагается Linux (Ubuntu/Debian) или WSL2 на Windows. Команды — от
обычного пользователя, `sudo` — где указано.

```bash
# 0.1 Базовые пакеты
sudo apt update && sudo apt install -y curl git build-essential

# 0.2 Node 24 через nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24 && nvm alias default 24
node -v            # v24.x

# 0.3 pnpm
corepack enable && corepack prepare pnpm@9 --activate
pnpm -v            # 9.x

# 0.4 Python 3.11+ и uv (для ml-service)
sudo apt install -y python3 python3-venv
curl -LsSf https://astral.sh/uv/install.sh | sh
uv --version

# 0.5 PostgreSQL 16
sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE USER aegis WITH PASSWORD 'ЗАМЕНИТЬ' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE aegis OWNER aegis;"
psql postgres://aegis:YOUR_DATABASE_PASSWORD@127.0.0.1:5432/aegis -c "SELECT 1;"   # должно ответить

# 0.6 Код: клонировать репо (GitHub-экспорт из Replit или zip)
git clone <URL-репо> ~/aegis && cd ~/aegis
pnpm install

# 0.7 Переменные окружения
cp .env.example .env
nano .env          # заполнить по комментариям внутри (DATABASE_URL, SESSION_SECRET, ...)
                   # значения секретов скопировать из Replit: Tools → Secrets

# 0.8 База: восстановить бэкап (части aegis-db.part-NN.gz ≤150MB из Replit)
#     ИЛИ начать с пустой схемы (тогда пропустить cat/gunzip/pg_restore)
cat aegis-db.part-*.gz > aegis-db.dump.gz   # склейка (валидный gzip только целиком)
gunzip aegis-db.dump.gz                     # → aegis-db.dump (формат pg_dump -Fc)
pg_restore --no-owner --no-privileges -d "postgres://aegis:YOUR_DATABASE_PASSWORD@127.0.0.1:5432/aegis" aegis-db.dump
set -a; source .env; set +a
pnpm --filter @workspace/db run push     # догнать схему до кода (идемпотентно)

# 0.9 ml-service: зависимости Python (venv + requirements.txt)
cd artifacts/ml-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cd ../..

# 0.10 Первый запуск руками (два терминала)
set -a; source .env; set +a
# терминал 1 — ml-service:
cd artifacts/ml-service && .venv/bin/python -m uvicorn src.main:app --host 127.0.0.1 --port 8090 --app-dir .
# терминал 2 — api-server:
PORT=8080 pnpm --filter @workspace/api-server run start
curl -s localhost:8080/api/healthz        # {"ok":true,...}

# 0.11 Публичный HTTPS для мобилки (выбрать одно):
#   A. Cloudflare Tunnel (бесплатно, рекомендуется):
#      cloudflared tunnel --url http://localhost:8080  → постоянный туннель по доке CF
#   B. Свой домен + VPS reverse-proxy → ноут по WireGuard
# Итоговый URL зашивается в мобилку как EXPO_PUBLIC_API_URL (docs/rustore-release.md)
```

После шага 0 переходите к smoke-test'ам ниже и затем к systemd (вариант B).

## Предусловия на ноуте (сводка)

1. **Node 24** + **pnpm 9** + **Python 3.11+ / uv** (для ml-service)
2. Локальный **PostgreSQL** (или удалённый — если хотим оставить prod-БД)
3. `.env` файл рядом с репо — полный шаблон с комментариями: **`.env.example`**
   в корне репо. Ключевые переменные:
   ```bash
   # обязательное
   DATABASE_URL=postgres://aegis:password@127.0.0.1:5432/aegis

   # опциональное (если есть)
   # OpenDota: FREE MODE по умолчанию (60 req/min, 3000 req/day, троттл 1100ms).
   # Ключ подключается ТОЛЬКО парой переменных (одного ключа недостаточно):
   #   OPENDOTA_USE_PREMIUM=true
   #   OPENDOTA_API_KEY=...
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
# ⚠️ ВРЕМЯ В CRON — ЛОКАЛЬНОЕ (TZ ноута = Europe/Moscow).
#     Проверить: `timedatectl` → "Time zone: Europe/Moscow (MSK, +0300)".
#     Если ноут на UTC — добавить `CRON_TZ=Europe/Moscow` первой строкой.
# .env подгружается per-job через bash -lc
PATH=/usr/local/bin:/usr/bin:/bin
AEGIS=/home/$USER/aegis
LOGDIR=/var/log/aegis

# ── Свежесть мобилки: ingest:matches 3 + recent-form + bo3 (~3-5 мин)
#    Mobile НЕ ходит в апстрим — она читает только нашу БД, поэтому БД должна
#    наполняться независимо от трафика мобилки. См. секцию «Polling мобилки» ниже.
# Hourly Live — каждые 60 минут на 5-й минуте
5 * * * *    cd $AEGIS && bash -lc 'set -a; source .env; set +a; bash scripts/run-hourly.sh >> $LOGDIR/hourly.log 2>&1'

# ── Ночная досборка БД за прошедший день (~25-40 мин)
#    12 шагов: teams, matches, hero-stats/matchups/synergy, recent-form, h2h,
#    player-glicko, team-extended (peerSynergy), bo3.
# Daily Ingest — 00:30 МСК ежедневно
30 0 * * *   cd $AEGIS && bash -lc 'set -a; source .env; set +a; bash scripts/run-daily.sh >> $LOGDIR/daily.log 2>&1'

# ── Тяжёлая weekly заливка (~2-3 ч): drafts, players-heroes, 8 E1 OD-скриптов.
#    Не пересекается с Daily; запускается через 1.5ч после её окончания.
# Weekly Enrichment — воскресенье 02:00 МСК
0 2 * * 0    cd $AEGIS && bash -lc 'set -a; source .env; set +a; bash scripts/run-enrichment-pipeline.sh >> $LOGDIR/enrichment.log 2>&1'

# ── Auto-retrain SchedulerWorker крутится внутри api-server (in-process,
#    интервал 24ч). Cron-задачи под него НЕ нужны — нужно только дать gate
#    в .env (см. ниже): DISABLE_AUTO_RETRAIN=false и AUTO_RETRAIN_CRON_HOUR_UTC=4.
#    Час «4 UTC» = 07:00 МСК — тихое окно, Daily + Enrichment уже закончились,
#    live-трафик минимальный. Триггеры обучения:
#      • новый патч (включая буквенные: 7.41 → 7.41a → 7.41b) + 7 дней
#      • плановый рефреш раз в 30 дней
```

## Polling мобилки (для справки — чтобы не путать с cron)

Mobile ходит **только** на наш api-server (`/api/matches/live`, `/upcoming`)
по простому таймеру:

```ts
// artifacts/mobile/app/(tabs)/index.tsx:20,101
const REFRESH_INTERVAL_MS = 60_000;
intervalRef.current = setInterval(() => loadData(true), REFRESH_INTERVAL_MS);
```

Это **flat 60s polling** — без адаптации «есть live / нет live». Пока экран
ленты открыт, мобилка раз в минуту тянет обогащённые матчи. Плюс pull-to-refresh.

API-server отвечает **только из БД и in-memory cache** (TTL 30s для `matches:live`,
60s для `matches:upcoming`). Никаких апстрим-вызовов в request-handler'ах.

Все апстрим-походы (OpenDota / Stratz / PandaScore) — это **фоновые воркеры**:

| Воркер | Где живёт | Когда | Что делает |
|---|---|---|---|
| `LiveWorker` | in-process в api-server | каждые 30s | опрашивает OD `/live` + PandaScore `/running` → пишет `live_snapshots` |
| `Hourly Live` | cron (этот файл) | каждый час | освежает `pro_matches` + recent-form |
| `Daily Ingest` | cron | 00:30 МСК | team-level фичи за день |
| `Data Enrichment` | cron | вс 02:00 МСК | E1/drafts/players-heroes (weekly) |
| `Replay Parse Loop` | systemd / screen | непрерывно (TICK_SEC=1800) | OD replay parse, post-mortem поля |
| `SchedulerWorker` | in-process | раз в 24ч | patch-check + auto-retrain (gated env) |

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
ExecStart=/home/aegis/aegis/artifacts/ml-service/.venv/bin/python -m uvicorn src.main:app --host 127.0.0.1 --port 8090 --app-dir .
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

`/etc/systemd/system/aegis-daily.timer` (⚠️ время — по финальному расписанию
из `replit.md`: Daily **00:30 МСК**, systemd берёт локальную TZ ноута):

```ini
[Unit]
Description=Aegis daily ingest @ 00:30 MSK

[Timer]
OnCalendar=*-*-* 00:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

Аналогично создать `aegis-hourly.{service,timer}` (`OnCalendar=*-*-* *:05:00`
— каждый час на 5-й минуте) и `aegis-enrichment.{service,timer}`
(`OnCalendar=Sun 02:00:00` — вс 02:00 МСК).

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
- [ ] Реферальные ссылки: `GET /r/<код>` отвечает 302 напрямую с api-server
      (роут смонтирован и как `/r/:code`, и как `/api/r/:code`). Если перед
      api-server стоит reverse-proxy — прокинуть путь `/r` тоже, не только `/api`
- [ ] В админке `/admin-web/sources` создан хотя бы один источник, CSV-экспорт
      скачивается, тумблер «Поле промокода при регистрации» работает
      (мобилка читает его из `GET /api/client-config`)
- [ ] Cloudflare Tunnel / домен для публичного HTTPS доступа к api-server
      (обязательно для мобилки из сторов, см. `docs/rustore-release.md`)
- [ ] **Проверка мобилки**: dev-сборка Expo с `EXPO_PUBLIC_API_URL=<прод-URL>` —
      лента матчей грузится, детали матча открываются, регистрация работает,
      алерт срабатывает на live-матче
- [ ] Букмекеры передиагностированы с РФ-IP (секция ниже), Bovada отключена
      если отдаёт HTML/403

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

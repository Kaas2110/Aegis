# Миграция на другой Replit-аккаунт (или чистое окружение)

> Как развернуть Aegis с нуля на новом Replit-аккаунте: что переносится
> автоматически, что нужно руками. Для переезда на ноут — см.
> `docs/laptop-deploy.md` (другой сценарий).

## Что переносится само, а что нет

| Компонент | Переносится импортом Repl? | Действие |
|---|---|---|
| Код + docs + конфиги workflows (`.replit`) | ✅ да | ничего |
| Секреты (env) | ❌ нет | внести заново по шаблону `.env.example` |
| PostgreSQL (данные, модели) | ❌ нет | восстановить из бэкапа (см. ниже) |
| Установленные пакеты | ✅ да (`pnpm install` при первом запуске) | проверить |
| Обученные модели | ✅ да — **модели лежат в БД** (таблица model registry), не в файлах | приезжают вместе с restore БД |

## Шаг 1. Перенос кода

Вариант A (рекомендуется): в старом аккаунте — «Share» / передача Repl,
либо экспорт в GitHub (Git-панель → connect to GitHub → push), в новом —
«Import from GitHub».

Вариант B: скачать zip проекта → Import from zip.

## Шаг 2. Секреты

В новом Repl: Tools → **Secrets** → внести все переменные из **`.env.example`**
(в корне репо — там каждая описана: что это и где взять значение).

Минимум для старта:

- `DATABASE_URL` — создастся сам при создании Replit PostgreSQL (шаг 3)
- `SESSION_SECRET` — `openssl rand -hex 32`
- `ADMIN_TOKEN` — `openssl rand -hex 24`
- `STRATZ_TOKEN`, `PANDASCORE_API_KEY` — из старого аккаунта или получить заново (бесплатно)
- **На Replit обязательно:** `DISABLE_AUTO_RETRAIN=true` (killswitch —
  тренировка не должна конкурировать с ingest-workflow'ами)

> ⚠️ Значения секретов **не хранятся в коде и недоступны агенту** — их
> скопировать может только владелец старого аккаунта: Tools → Secrets →
> глазик → скопировать значение.

## Шаг 3. База данных

1. В новом Repl: Tools → **PostgreSQL** → создать БД (появится `DATABASE_URL`).
2. Восстановить из бэкапа (части `aegis-db.part-NN.gz` ≤150MB, склейка):

```bash
cat aegis-db.part-*.gz > aegis-db.dump.gz   # валидный gzip только после склейки ВСЕХ частей
gunzip aegis-db.dump.gz                     # → aegis-db.dump (формат pg_dump -Fc)
pg_restore --no-owner --no-privileges -d "$DATABASE_URL" aegis-db.dump
```

3. Догнать схему до текущего кода (идемпотентно):

```bash
pnpm --filter @workspace/db run push
```

Без бэкапа (с пустой БД) тоже заведётся: `push` создаст схему, потом
прогнать `bash scripts/run-daily.sh` + `bash scripts/run-enrichment-pipeline.sh`
и переобучить модели (`train:model`, `train:lightgbm`, `train:market-models`,
`train:live-totals`, `train:series-model`) — но исторические данные
(prematch_outcomes, live_snapshots) будут утеряны, поэтому **бэкап сильно
предпочтительнее**.

## Шаг 4. Запуск и проверка

1. `pnpm install` (Replit запустит сам при первом открытии).
2. Запустить workflows: **API Server**, **ML Service**, web, expo — стартуют
   автоматически; фоновые (**Daily Ingest**, **Hourly Live**, **Replay Parse
   Loop**, **Data Enrichment**) запускаются вручную/по необходимости.
3. Смоук:

```bash
curl -s localhost:80/api/healthz            # {"ok":true,...}
curl -s localhost:80/api/matches/live | head -c 300
pnpm run typecheck                          # зелёный
pnpm --filter @workspace/scripts run test:stratz   # проверка Stratz-токена
```

4. Админка: `/admin-web/` → логин по `ADMIN_TOKEN` → вкладка Workers —
   heartbeats LiveWorker/Scheduler должны пульсировать.
5. Мобилка: workflow expo → QR → лента матчей грузится.

## Шаг 5. Что проверить особо (грабли)

- **Stratz на Replit**: Node fetch блокируется Cloudflare — клиент сам
  падает на curl-fallback, это норма (см. `replit.md`).
- **OpenDota FREE MODE**: без ключа 60 req/min / 3000 req/day, троттлы уже
  настроены. Premium — только парой `OPENDOTA_USE_PREMIUM=true` + ключ.
- **Букмекеры**: с Replit-IP работает только Bovada — это ожидаемо.
- **`DISABLE_AUTO_RETRAIN=true`** на Replit — не забыть (иначе SchedulerWorker
  начнёт тренировки в рабочие часы).

## Карта документации

| Файл | Что внутри |
|---|---|
| `replit.md` | главный обзор: стек, скрипты, prefs, roadmap |
| `.env.example` | шаблон ВСЕХ env-переменных с инструкциями |
| `docs/laptop-deploy.md` | переезд на ноут (systemd/cron, РФ-букмекеры) |
| `docs/rustore-release.md` | выкатка мобилки в RuStore |
| `docs/business.md` | бизнес-описание для не-инженеров |
| `docs/technical-overview.md` | тех-обзор для новых инженеров |
| `docs/system-map.md` | карта: источники → таблицы → фичи → модели |
| `docs/architecture.md` | полная архитектура, эндпоинты, log-тэги |
| `docs/ml-feature-audit.md` | аудит фичей и моделей по бакетам |
| `docs/changelog.md` | хронология изменений |

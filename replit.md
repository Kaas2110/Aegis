# Aegis — Dota 2 match analytics

Production-ready Dota 2 esports analytics mobile app. Russian UI. Live ML-driven
predictions across 15 bet markets, fed by OpenDota historical data.

Бренд: «Aegis». Внутренние пакеты по-прежнему называются `@workspace/mobile` /
`@workspace/api-server` (не переименовываем — миграция импортов не оправдана).

**Stack:** pnpm workspaces, Node 24, TypeScript 5.9, Express 5, PostgreSQL + Drizzle,
Expo (React Native), Zod (`zod/v4`), LightGBM 4.6 + sklearn IsotonicRegression в
Python-сервисе `artifacts/ml-service` (FastAPI/uvicorn). Pure-JS logistic regression
в `services/PredictionModel.ts` остаётся как fallback (60s circuit-breaker, 200ms timeout).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (`PORT`, served at `/api`)
- `pnpm --filter @workspace/mobile run dev` — Expo mobile app
- `pnpm --filter @workspace/db run push` — push DB schema (dev only)
- `pnpm run typecheck` — full typecheck (libs first via `typecheck:libs`)

**Ingest / compute / train скрипты, env-переменные, STRATZ_TOKEN / multi-token pool** —
полный справочник в **`docs/operations.md`** ⭐. Required env: `DATABASE_URL`;
шаблон всех переменных — `.env.example`.

## Product

Mobile (Expo) app для русскоязычных Dota 2 беттеров. Dark warm amber palette
(#080604 bg, #E8830A primary, #5DE8A0 radiant, #FF4433 dire). Detailed view как
основной режим (simple-режим закомментирован под будущий Lite/Premium gating),
глоссарий из 15 типов рынков. Backed by:

- **Live ML predictions** на текущих pro-матчах (обновление каждые 60s);
  live-винер модель обучена на `live_snapshots × prematch_outcomes`.
  ⚠️ Stratz live: DORMANT — детали в `docs/architecture.md` → Gotchas.
- **Match-winner model** — LightGBM v3 + LR fallback, маршрутизация по tier и
  наличию draft + account_ids. Метрики и фичи: `docs/ml-feature-audit.md`.
  ⚠️ Сравнения acc между retrain'ами некорректны без поправок — см. Gotchas.
- **15 mathematical models** для derivative markets (FB, total_kills,
  total_duration ± q25/q75 квантили).
- **Bookmaker odds aggregation** — Bovada работает с Replit-IP; 6 РФ-источников
  активируются автоматически с РФ-IP в проде.
- **Тоталы (kills/duration)** — ladder-UI (несколько линий ТБ/ТМ),
  `/api/analytics/totals-ladder`, компонент `components/TotalsLadder.tsx`.

**Полный контракт API endpoints** (matches/auth/admin/рефералки, формы ответов,
кэши) — `docs/architecture.md` → «API endpoints». Админка `/admin-web/` —
страницы и правила сессий там же → «Admin & settings».

## User preferences

- Язык интерфейса — русский
- Pinnacle парсим самостоятельно, без платного API (пользователь предупреждён про ToS)
- Не предлагать Reserved VM деплой пока пользователь не попросит
- **🖥️ КРИТИЧНО: прод будет на личном ноуте пользователя** (а не на Replit Autoscale).
  Это значит: все воркеры (Daily Ingest, Hourly Live, Replay Parse Loop, Data Enrichment,
  Drafts Backfill) должны запускаться как обычные cron/systemd-юниты на ноуте — точно так же,
  как сейчас крутятся как Replit workflows. **При переезде на ноут нужно: (а) убедиться что
  все 5 workflow-скриптов (`scripts/run-*.sh`) работают standalone с переменными окружения
  из `.env`; (б) задокументировать в `docs/laptop-deploy.md` как поднять cron на ноуте
  (crontab пример с интервалами TICK_SEC=1800 для parse-loop, ежечасно для hourly,
  раз в сутки для daily, раз в неделю для enrichment); (в) НЕ нужно переносить parse:cycle
  в SchedulerWorker (Фаза 4 B5) — на ноуте отдельные workflows проще ребутить и логировать.**
- **Финальное расписание ноута (TZ=Europe/Moscow, см. `docs/laptop-deploy.md`):**
  Hourly = `5 * * * *`, Daily = **`30 0 * * *`** (00:30 МСК — ночная досборка БД
  за прошедший день), Enrichment = `0 2 * * 0` (вс 02:00 МСК), Auto-retrain =
  in-process SchedulerWorker (24ч интервал, gate `AUTO_RETRAIN_CRON_HOUR_UTC=4`
  ≡ 07:00 МСК). Триггеры обучения уже в коде: новый патч (включая буквенные
  `7.41 → 7.41a → 7.41b` — сравнение по полной строке `patch.name`) + 7 дней,
  ИЛИ плановый рефреш раз в 30 дней. На Replit остаётся killswitch
  `DISABLE_AUTO_RETRAIN=true`.
- **Polling мобилки:** `artifacts/mobile/app/(tabs)/index.tsx` крутит flat
  `setInterval(loadData, 60_000)` — без адаптации «есть live / нет live».
  Mobile ходит ТОЛЬКО на наш api-server, api-server отвечает ТОЛЬКО из БД +
  in-memory cache (TTL 30s live / 60s upcoming). Все upstream-вызовы — в
  фоновых воркерах (LiveWorker 30s in-process; Hourly/Daily/Enrichment в cron).
- Не платить за The Odds API на этом этапе
- Букмекерский UI включён через **Bovada** (200 OK с Replit-IP, без ключа). Все 6 РФ-буков с
  Replit заблокированы (DNS / Cloudflare / 404), Pinnacle требует guest API key (нет).
  `BOOKMAKERS_ENABLED` дефолт = true. Маркеты Bovada: Moneyline (winner серии + Map 1/2),
  Total Maps, Under/Over Kills, Correct Score, Asian Handicap. НЕ покрыто Bovada:
  Total Duration, First Blood — для них только наш прогноз.
- Алерты — только по `minConfidence` модели; `minEdge`/`minOdds` вернутся вместе с букмекерским UI
- При проблемах с данными приоритет — показать актуальные матчи; ML-скоринг догружается
  сверху прогрессивно. Лимиты OpenDota тратим в первую очередь на то, что сейчас
  отображается у пользователя (live drafts), батчевые ingest'ы — фоном.
- **Никаких фейковых/stub данных в UI.** Если поле недоступно — показываем «Данные недоступны»
  или скрываем с прозрачным текстом «считается на бэке, для этого матча данные ещё не готовы».
- **ML retrain — только когда новые фичи реально наполнены в БД** (см. правило в активном плане:
  сначала ingest до ~100% покрытия, потом одна выборка 365d, потом обучение).

## Логи

Структурный JSON через pino; каждая запись имеет `tag` для фильтрации
(`req`/`res`, `bookmaker*`, `matched`, `cache`, `predict`, `admin`, `mobile`,
`upstream`). Полный реестр тэгов и примеры grep — `docs/architecture.md`.

## Pointers

- **`docs/operations.md`** — ⭐ справочник ingest/compute/train скриптов,
  env-переменных, STRATZ_TOKEN / multi-token pool.
- **`.env.example`** — ⭐ шаблон ВСЕХ env-переменных с инструкциями где взять
  значения (значения секретов агенту недоступны — копирует владелец из Tools → Secrets).
- **`docs/laptop-deploy.md`** — ⭐ инструкция переезда с Replit на ноут
  (Шаг 0 «чистая установка», systemd-юниты, crontab, чек-лист). Читать перед миграцией.
- **`docs/rustore-release.md`** — ⭐ выкатка мобилки в RuStore (keystore, EAS,
  модерация, чек-лист).
- **`docs/store-release-plan.md`** — ⭐ план Google Play / App Store + подписки
  во всех 4 сторах (RuStore/AppGallery/GP/AS): доработки БД/API/мобилки,
  ограничения РФ-аккаунтов, порядок работ.
- **`docs/migration-replit.md`** — перенос проекта на другой Replit-аккаунт
  (секреты, восстановление БД из `backups/aegis-db.part-*.gz`).
- **`docs/business.md`** — ⭐ бизнес-описание для не-инженеров.
- **`docs/technical-overview.md`** — ⭐ краткий тех-обзор для новых инженеров.
- **`docs/system-map.md`** — ⭐ системная карта связей: источники → таблицы → фичи →
  модели → рантайм. **Агент обязан читать перед любой архитектурной правкой.**
- **`docs/architecture.md`** — полная архитектура: API endpoints (контракт),
  admin & settings, Bookmakers roadmap, performance, decisions, gotchas
  (Stratz DORMANT, retrain-сравнения, quantile models), полный реестр log-тэгов.
- **`docs/ml-feature-audit.md`** — текущий аудит фичей и моделей по бакетам.
- **`docs/model-improvements-research.md`** — план улучшений ML.
- **`docs/changelog.md`** — историческая хронология крупных изменений (новые записи — В КОНЕЦ файла).
- **`threat_model.md`** — модель угроз для security-сканов.
- См. skill `pnpm-workspace` — структура монорепо, TypeScript, project references.

## Roadmap (active)

> Полная история (Phase 0-10, T0→T12 milestones, retrain'ы, mobile UI waves,
> infra, Фаза 9 баг-фиксы F1–F9 DONE) — `docs/changelog.md`. Здесь только PENDING.
> **Статус 2026-07-17:** финальный мега-пакет DONE (аудит + 4 ML-фикса +
> ретрейн series 87.6%* / live-totals 4/4 / market 10/10 + RuStore/миграция-доки
> + бэкап `backups/aegis-db.part-*.gz`). *С оговоркой об остаточной утечке
> двух фичей — см. `docs/changelog.md` 2026-07-17. TODO следующего ретрейна:
> time-cutoff drop_rate + as-of pick_strangeness в series-модели.

- **Mobile/UI без ML-зависимости:**
  - EV-merge на фронте — matching событий букмекеров к `pro_matches`, полный
    охват маркетов (winner/totals/firstBlood) для всех букмекеров.
  - Backtest UI скрыт (`href: null`) — раскроем когда `prematch_outcomes` ≥ 200
    и UX будет готов.
- **Live-winner на LightGBM** — перенести когда `live_snapshots × prematch_outcomes` ≥ 200.
- **Принципы каждой фазы:** ingest до ~100% покрытия → одна выборка 365d →
  обучение → активация. Никаких фейк-данных в UI. Каждая фаза — явный «да».

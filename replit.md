# Aegis — Dota 2 match analytics

Production-ready Dota 2 esports analytics mobile app. Russian UI. Live ML-driven predictions across 15 bet markets, fed by OpenDota historical data.

Бренд: «Aegis». Внутренние пакеты по-прежнему называются `@workspace/mobile`/`@workspace/api-server` (не переименовываем без необходимости — миграция импортов не оправдана).

Stack: pnpm workspaces, Node 24, TypeScript 5.9, Express 5, PostgreSQL + Drizzle, Expo (React Native), Zod (`zod/v4`), Wave 4 ML: LightGBM 4.6 + sklearn IsotonicRegression в Python-сервисе `artifacts/ml-service` (FastAPI/uvicorn, stateless — blob shipped per /predict), pure-JS logistic regression в `services/PredictionModel.ts` остаётся как fallback (60s circuit-breaker, 200ms timeout).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server (port from `PORT`, served at `/api`)
- `pnpm --filter @workspace/mobile run dev` — Expo mobile app
- `pnpm --filter @workspace/db run push` — push DB schema (dev only)
- `pnpm --filter @workspace/scripts run ingest:teams` — load OpenDota team ratings (~1000 teams)
- `pnpm --filter @workspace/scripts run ingest:matches [pages=20]` — load pro matches (~100/page, 1.1s/req)
- `pnpm --filter @workspace/scripts run ingest:leagues` — load OpenDota league names → `leagues` table (used to humanize tournament names in mobile lists)
- `pnpm --filter @workspace/scripts run ingest:hero-stats` — hero meta winrates / pickrates (current patch). **Stratz-supplemented** если `STRATZ_TOKEN` задан (CAPTAINS_MODE winrates точнее OpenDota pro_pick).
- `pnpm --filter @workspace/scripts run ingest:hero-matchups` — pairwise hero matchup matrix (incremental)
- `pnpm --filter @workspace/scripts run ingest:drafts [limit]` — picks/bans + radiant/dire account_ids (v2/v3-eligible only). `--backfill-accounts` re-fetches account_ids for pre-Wave-3 rows. **Stratz-primary** если `STRATZ_TOKEN` задан (250 req/min, ~4× быстрее OpenDota). `--no-stratz` форсирует OpenDota.
- `pnpm --filter @workspace/scripts run ingest:players-heroes` — per-player per-hero stats (7-day freshness). **Stratz-primary** если `STRATZ_TOKEN` задан (isLeague=true, ~4× быстрее).
- `pnpm --filter @workspace/scripts run compute:recent-form` — recompute `team_recent_form` (30/90-day)
- `pnpm --filter @workspace/scripts run compute:h2h` — recompute `team_h2h` (365-day)
- `pnpm --filter @workspace/scripts run compute:player-glicko` — пересчёт `player_ratings` (Glicko-1, c=63, period=30d). Идемпотентно; флаг `--reset` пересоздаёт с нуля. Запускать после `ingest:drafts`/`ingest:matches`.
- `pnpm --filter @workspace/scripts run compute:bo3-series [days=180]` — aggregate `bo3_series`
- `pnpm --filter @workspace/scripts run train:model` — atomic swap of all v1+v2+v3 active prematch models (live-winner trained back-to-back, non-fatal). Engine = logistic regression (fallback baseline).
- `pnpm --filter @workspace/scripts run train:lightgbm [-- --label v3/t1]` — Wave 4 gradient-boosted prematch models (LightGBM via `artifacts/ml-service`). Атомарный swap внутри `engine='lightgbm'`; LR-модели остаются как fallback. CLI `--label` (или env `LIGHTGBM_KINDS`) ограничивает набор бакетов для re-train. Inference: api-server идёт по HTTP в ml-service с 200ms timeout + 60s circuit-breaker; на любой сбой → LR.
- `pnpm --filter @workspace/scripts run train:market-models [-- --market first_blood|total_kills|total_duration|all]` — Wave 4 LightGBM derived-market models. `market_first_blood` (classification, label=radiantWin прокси), `market_total_kills`/`market_total_duration` (regression на log(value)). Все 5 фичей — team-rating-based. Атомарный per-market swap, engine='lightgbm'.
- `pnpm --filter @workspace/scripts run train:live-model` — train live-winner from `live_snapshots × prematch_outcomes`
- `pnpm run typecheck` — full typecheck (libs first via `typecheck:libs`)

Required env: `DATABASE_URL`. Optional: `ODDS_API_KEY`, `STRATZ_TOKEN`, `PANDASCORE_API_KEY`, `PINNACLE_GUEST_API_KEY`, `ADMIN_TOKEN`, `DISABLE_LIVE_WORKER`, `DISABLE_SCHEDULER`, `BOOKMAKERS_ENABLED` (default false), `PROXY_URL` (РФ-прокси для букмекеров с не-РФ IP).

**STRATZ_TOKEN** — бесплатный JWT с stratz.com/api (вход через Steam). Даёт 250 req/min / 20 000 req/day. На Replit Node.js fetch блокируется Cloudflare (TLS JA3); клиент автоматически падает на curl-fallback. На РФ-проде Node fetch работает напрямую. Клиент: `scripts/src/lib/stratz.ts`. Тест: `pnpm --filter @workspace/scripts run test:stratz`.

## Product

Mobile (Expo) app for Russian-speaking Dota 2 bettors. Dark warm amber palette (#080604 bg, #E8830A primary, #5DE8A0 radiant, #FF4433 dire). Detailed view как основной режим (simple-режим закомментирован под будущий Lite/Premium gating, см. Roadmap) и глоссарий из 15 типов рынков. Backed by:

- Live ML predictions on currently-running pro matches (updated every 60s)
- Match-winner model trained on OpenDota historical pro matches
- Bookmaker odds aggregation (when configured — currently hidden in UI, see Bookmakers roadmap in `docs/architecture.md`)
- 15 mathematical models for derivative markets
- Тоталы (kills/duration) показываются ladder-UI (несколько линий ТБ/ТМ как у буков). Эндпоинт `/api/analytics/totals-ladder?type=kills|duration&radiantTeamId=&direTeamId=&format=&liveCurrent=&liveMinute=&lineCount=` отдаёт массив линий с вероятностью модели, на live центрируется вокруг проекции текущего темпа. Компонент `components/TotalsLadder.tsx`, рендерится в `app/match/[id].tsx` для `total_kills`/`total_duration`.

## User preferences

- Язык интерфейса — русский
- Pinnacle парсим самостоятельно, без платного API (пользователь предупреждён про ToS)
- Не предлагать Reserved VM деплой пока пользователь не попросит
- Не платить за The Odds API на этом этапе
- В мобилке букмекерский UI скрыт до появления первых пользователей (бэкенд оставлен нетронутым, помечено `TODO(bookmakers)`)
- Алерты — только по `minConfidence` модели; `minEdge`/`minOdds` вернутся вместе с букмекерским UI

## Pointers

- **`docs/architecture.md`** — полная архитектура: где что лежит, все API-эндпоинты, admin & settings, Bookmakers roadmap, performance, architecture decisions, gotchas.
- **`threat_model.md`** — модель угроз для security-сканов.
- См. skill `pnpm-workspace` — структура монорепо, TypeScript, project references.

## Live-snapshot backfill + авто-обогащение (DONE 2026-05-12)

`live_snapshots` теперь имеет колонку `source` ('live' | 'backfill'). Backfill-снапшоты не прунятся автоматически.

- **`pnpm --filter @workspace/scripts run backfill:live-snapshots [-- --limit N --since-unix T --min-pairs N --force]`** — разовый или incremental backfill из OpenDota `/api/matches/{id}`. Для каждого матча с prematch_outcome, у которого нет backfill-снапшотов, фетчит `radiant_gold_adv[]` поминутно и вставляет синтетические строки. Rate-limit: 1200ms/req (~50 матчей/мин). Идемпотентен (пропускает уже обработанные match_id).
- **Авто-обогащение в SchedulerWorker**: Phase 4.5 — перед `train:live-model` считает distinct snapshot-outcome пары. Если < 100 матчей — запускает backfill автоматически (--limit 300, ~6 мин). Обеспечивает что live-модель всегда обучена на достаточном объёме данных.
- **`pruneLiveSnapshots`** обновлён — удаляет только `source='live'` строки (backfill не трогает).
- **`liveSnapshotPruneDays`** установлен в 365 дней.

## Patch-aware training dataset settings (DONE 2026-05-12)

`app_settings` хранит три настройки управления тренировочным окном:

- **`trainWindowDays`** (INT, default 365, 30–730) — макс. глубина истории матчей (календарных дней).
- **`trainMaxPatches`** (INT, default 4, 1–20) — макс. число последних патчей в датасете. Начало Nth патча вычисляется через OpenDota `/api/constants/patch`.
- **`trainMinSamples`** (INT, default 1000, 50–100 000) — минимум сэмплов для запуска обучения (если меньше — скрипт выходит чисто без тренировки).

Эффективная граница = `max(windowCutoff, patchCutoff)` — более строгое из двух. Вычисляется в `SchedulerWorker.computeTrainSinceUnix()` перед Phase 4, передаётся во все 4 train-скрипта как `--since-unix N --min-samples M`. Sliding-window prune в Phase 2 также использует `trainWindowDays` из БД. Все 4 скрипта (`train:model`, `train:lightgbm`, `train:market-models`, `train:live-model`) принимают `--since-unix` и `--min-samples` через CLI (fallback на константы, если не переданы). Whitelist в `TRAIN_SCRIPT_WHITELIST` расширен, так что per-model retrain из UI тоже принимает эти аргументы. Admin UI: `/settings` — секция «Тренировочный датасет» с тремя полями ввода.

## Production automation (Wave «C» — DONE 2026-05-11)

Цель: «развернул на сервер/ноут → всё само работает». Реализовано в `services/SchedulerWorker.ts` + `lib/ensureSchema.ts`:

- **Auto schema bootstrap** при старте api-server: `ensureSchema()` проверяет наличие `pro_matches`; если таблицы нет — спавнит `pnpm --filter @workspace/db run push`. Idempotent. Отключается `AUTO_DB_PUSH=false` (для CI-managed схемы).
- **Cold-start retrain**: первый tick шедулера (T+30s после старта) проверяет `count(pro_matches)`; если <100 → запускает full retrain pipeline сразу, не дожидаясь патча или 30-дневного цикла.
- **Full retrain pipeline (15 шагов)** запускается при новом патче (через 7 дней) или раз в 30 дней:
  1. `ingest:teams` (CRITICAL) → 2. `ingest:matches[15]` (CRITICAL) → 3. `ingest:drafts` → 4. `ingest:hero-stats` → 5. `ingest:hero-matchups` → 6. `ingest:players-heroes` → 7. `ingest:leagues` → 8. sliding window prune (>180d) → 9. `compute:recent-form` → 10. `compute:h2h` → 11. `compute:bo3-series` → 12. `compute:player-glicko` → 13. `train:model` (CRITICAL, hot-reload в память) → 14. `train:lightgbm` → 15. `train:market-models` + `train:live-model` (hot-reload).
  - Каждый non-critical шаг — в собственном `runScriptSafe`, ошибка/таймаут логируется, pipeline продолжается. Падает только при сбое `ingest:teams`/`ingest:matches`/`train:model`.
  - Все спавны имеют timeout (по умолчанию 30 мин, для compute — 10 мин), SIGTERM→SIGKILL escalation.
- **Daily refresh** (между full retrain'ами): лёгкий цикл раз в 24h — teams + matches[5] + drafts + players-heroes + recent-form + h2h + player-glicko. Все non-fatal. Не запускается, если pipeline уже идёт.
- **scheduler_state.notes.stepResults** — журнал успешности каждого шага в БД, видно из `/api/admin/scheduler/state`.
- **ENV управление**: `DISABLE_SCHEDULER=true` (выкл воркер целиком), `DISABLE_AUTO_RETRAIN=true` (только данные, без тренировок), `DISABLE_LIVE_WORKER`, `DISABLE_OUTCOME_TRACKER`, `AUTO_DB_PUSH=false`.

**Букмекеры (6 источников):** Fonbet, Лига Ставок, PARI, BetBoom, 1xStavka, Olimp.bet. Все — публичные мобильные/web JSON API без ключей. Гео-блочат не-РФ IP. Код в `routes/bookmakers.ts`: unified `UnifiedBookmakerEvent`, кэш 60s в памяти, rate-limit 1.5s/source, fail-soft внутри (HTTP-ошибка адаптера → пустые events + hint). Управляется ENV-флагом `BOOKMAKERS_ENABLED=true` (по умолчанию false на Replit). При выключенном флаге все эндпоинты честно возвращают **HTTP 503** с JSON-телом — клиенты отличают «фича выключена» от «временно упало». На РФ-проде включается без `PROXY_URL`; на зарубежном хостинге нужен `PROXY_URL` (любой РФ-прокси). Эндпоинты: `GET /api/bookmakers/status` (всегда 200), `GET /api/bookmakers/all/dota2`, `GET /api/bookmakers/{source}/dota2`. Пользователь предупреждён про ToS.

**Букмекеры — текущее покрытие маркетов (2026-05-11):**
- `winner` маппится у 4/6 (PARI, BetBoom, 1xStavka, Olimp.bet). Fonbet/Лига Ставок отдают только список событий — winner подтянем при добавлении per-event details fetch.
- `totalKills` / `totalDuration` / `firstBlood` — типы зарезервированы в `UnifiedBookmakerEvent`, маппинг **не реализован**. Будет вместе с EV-merge.

**Букмекеры — что осталось (отложено сознательно):**
1. **EV-merge на фронте** — matching events букмекеров к `pro_matches` по командам/времени, фактическое использование `filters.bookmaker` в `app/(tabs)/index.tsx::applyFilters` (сейчас фильтр в стейте есть, но в выборку не идёт), `BookmakerDropdown` подключить к header'у home-экрана (закомментирован), синхронизация набора опций между `FilterBar` (legacy: betfair) и `BookmakerDropdown` (новый: x1stavka/olimp).
2. **Полный охват маркетов** — fonbet/liga_stavok winner (через details endpoint), totals/firstBlood маппинг по всем 6.
3. **Возврат `minEdge`/`minOdds` в алерты** — UI и валидация в админ-настройках.
Все 3 пункта — отдельная сессия после Wave «B», когда понадобится показывать «модель vs кэф» в Premium-UI.

## Roadmap (после миграции в новый workspace, 2026-05-11)

- **Wave 3 «proper» (per-player Glicko — DONE для v3 LR).** Новая таблица `player_ratings` (account_id PK, rating, rd, games, wins, last_match_*). Скрипт `compute:player-glicko` крутит Glicko-1 multi-opponent batch updates по pro_matches × match_drafts (с RD time-decay c=63, period=30d). 5-я v3-extra фича — `player_glicko_diff = (avg(rad) − avg(dire)) / 200` (нейтрально 1500 при отсутствии записи). v3 dim 16 → **17**. Активно: LR v3 (`prematch_winner` + `prematch_winner_t2`). LightGBM v3 пока заблокирован объёмом данных (нужно ≥80 матчей с обоими полными account_ids — на 2026-05-11 в БД 68/60). Покрытие player_ratings: 107 игроков, 5 с ≥20 играми. Расширится по мере накопления `match_drafts.radiant/dire_account_ids`.
- **ML upgrade → gradient boosting (Wave 4 — DONE для prematch + derived markets).** Реализовано: `artifacts/ml-service` (FastAPI + LightGBM + sklearn IsotonicRegression, поддерживает `task_type=classification|regression` — для regression в bundle сохраняется `residual_std`, /predict отдаёт `{mean, std}`), `model_versions.engine` enum logreg|lightgbm + binary_blob bytea, partial unique index `(kind, fv, engine) WHERE is_active`. Тренировка: `scripts/src/train-lightgbm.ts` (12 prematch jobs: 3 fv × 4 buckets) + `scripts/src/train-market-models.ts` (3 market jobs, всё через ml-service). Inference: `services/PredictionModel.predictViaMlService` для prematch + `services/MarketLgbm.predictMarketsFor` для market_* (HTTP, 200ms timeout, 60s circuit-breaker per-domain, кеш blob в памяти api-server, фолбэк на logreg/heuristic при любой ошибке). Per-(rId,dId) кеш market-предсказаний 60s. Wired в `routes/analytics.ts::popular-markets` (override probTeam1 для FB/totals в карточках) и `routes/analytics.ts::totals-ladder` (override per-line через `probLogNormalOver` для kills/duration). **Осталось:** live-winner перенести на LightGBM (когда `live_snapshots × prematch_outcomes` ≥ 200).
- **Все модели — вероятностные.** Каждая активная модель (prematch_winner v1/v2/v3, prematch_winner_t2, live_winner, derived markets из `train:market-models`) выдаёт `p ∈ [0,1]` (или μ/σ для kills/duration с CDF-обёрткой). UI читает только `prediction.confidence` / `prediction.ev`.
- **Backtest UI скрыт.** `app/(tabs)/backtest.tsx` файл оставлен, маршрут спрятан (`href: null` / `hidden`). Эндпоинт `/api/analytics/backtest` доступен — UI вернётся, когда `prematch_outcomes` накопит ≥200 строк.
- **Detailed mode = primary на проде.** Simple-режим оставляем закомментированным под будущий gating Lite/Premium (RevenueCat). Все toggles `viewMode` пока ведут на `'detailed'`.
- **Admin → внешние API-интеграции с override (DONE 2026-05-11, расширено 2026-05-12).** Таблица `api_key_overrides (env_name PK, value, updated_at)` хранит overrides ENV-ключей. `services/ApiKeysService.ts` — единый `getApiKey(name)` с in-memory кешем (TTL 30s) и fallback ENV→override→none; `KNOWN_INTEGRATIONS` (11 записей: STRATZ_TOKEN, PANDASCORE_API_KEY, ODDS_API_KEY, PINNACLE_GUEST_API_KEY, **FONBET_API_KEY, LIGASTAVOK_API_KEY, PARI_API_KEY, BETBOOM_API_KEY, X1STAVKA_API_KEY, OLIMP_API_KEY** (category='bookmaker'), PROXY_URL) — у каждой запись `howToGet` (инструкция по-русски). Admin endpoints `GET/PUT /api/admin/integrations`. Maskированный preview для sensitive. UI: `artifacts/admin-web/src/pages/operations.tsx` — карточки с кнопкой **«Получить ключ ↗»** (ссылка на партнёрскую программу) и раскрываемой **«Инструкция»** (`howToGet`). Секция «Публичные источники без ключей» — только OpenDota; 6 букмекеров перенесены в KNOWN_INTEGRATIONS. openapi.yaml `AdminIntegrationStatus.howToGet` добавлено (не required), enum `category` расширен до `[data-source, odds-feed, network, bookmaker]`.
- **Per-model retrain UI (DONE 2026-05-11).** В `artifacts/admin-web/src/pages/operations.tsx` добавлена секция «Активные модели» — таблица всех активных `model_versions` с per-row кнопкой «Переобучить» (маппинг kind/engine → script + label/market) и кнопкой «Переобучить всё» в шапке (старый `/admin/retrain`). Бэкенд: `POST /api/admin/models/retrain` (operationId `triggerAdminModelRetrain`, body `{script, label?, market?}`) + `runTrainScriptManual` в `SchedulerWorker.ts` с whitelist'ом скриптов/флагов (`train:model | train:lightgbm | train:market-models | train:live-model`, value regex `^[a-zA-Z0-9_/-]+$`), shared mutex с full-pipeline. Hot-reload в память: `loadActiveModel` для prematch, `loadActiveMarketModels` для markets, `loadActiveLiveModel` для live.

- **Admin → отдельный web-артефакт (DONE 2026-05-11).** Inline `/api/admin-ui/` удалён вместе с `routes/adminUi.ts`. Активный admin-инструмент — артефакт `artifacts/admin-web` (React + Vite, slug `admin-web`, previewPath `/admin-web/`, путь в проксе `/admin-web`). Страницы: `/login`, `/` (дашборд: scheduler-state + активные модели + общие метрики), `/settings`, `/metrics`, `/operations` (ручной retrain + prune snapshots + odds-status). UI на русском, тёмная амбер-палитра (#080604 фон, #E8830A акцент, моноширинная типографика, sharp corners). **Auth.** `POST /api/admin/login { token }` сравнивает с `ADMIN_TOKEN` через `timingSafeEqual` (брутфорс-троттл 10 попыток / 15 мин на IP) и выставляет HttpOnly-cookie `aegis_admin_session` (24h, sameSite=lax, `secure` только в production). `GET /api/admin/whoami` возвращает `{authenticated, tokenConfigured}`. `POST /api/admin/logout` удаляет сессию и cookie. Все `/api/admin/*` и `POST /api/analytics/retrain` идут через `requireAdminSession` — **legacy `X-Admin-Token` header больше не принимается**. Сессии хранятся in-memory в одном процессе api-server (рестарт = relogin, для одного оператора достаточно). На фронте куки летят автоматически: в `lib/api-client-react/src/custom-fetch.ts` глобально выставлено `credentials: 'include'`. На любую 401-ошибку из защищённых хуков `QueryCache.onError` редиректит на `/admin-web/login`. Все вызовы из admin-web идут через сгенерированные хуки `@workspace/api-client-react` (OpenAPI-контракт в `lib/api-spec/openapi.yaml`, секция `admin-auth` + `admin`).

## Исторический инgest + retrain (DONE 2026-05-12)

Расширение тренировочной выборки инgestом исторических матчей (май–сент 2025, ранее отсутствовавший промежуток):

- **`ingest:matches -- --less-than <match_id>`** — параметр для обратного инgesta (добавлен в `ingest-matches.ts`). Безопасный батч = 30 страниц (~33s). Суммарно добавлено ≈25 000 матчей, заполнен пропуск май–авг 2025.
- **Итог**: 44 609 матчей в БД; **28 956 в 365-дневном обучающем окне** (было 18 974, **+52%**).
- **Retrain LR** (`train:model`): v3 logreg test_acc **83.6%** / brier 0.137 (было 81.5%).
- **Retrain LightGBM** (`train:lightgbm`): v3 LGB test_acc **81.5%** / brier 0.154 (было 80.5%).
- v2/v3 train_samples не изменились (нужны draft-данные для hero-фич); **2 743 матча без драфтов** — инgested в фоне через `ingest:drafts` (Stratz, ~12 мин). После завершения — следующий `train:model` + `train:lightgbm` даст полный прирост v2/v3.
- `train:model` получил флаги `--min-glicko N` и `--dry-run` (сравнение без сохранения).

## Миграция из старого workspace (2026-05-11)

- Старый Postgres (`helium/heliumdb`) был внутренним и недоступен — DB пересобрана с нуля через `pnpm --filter @workspace/db run push`.
- Код восстановлен из public GitHub repo (`Kaas2110/Market-Edge`) поверх scaffold'ов monorepo.
- `ADMIN_TOKEN` перевыпущен (старый, утёкший в чате, инвалидирован). `SESSION_SECRET` уже был в workspace.

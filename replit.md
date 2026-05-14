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

**Ingest / compute / train скрипты** (все в `@workspace/scripts`):

| Script | Назначение |
|---|---|
| `ingest:teams` | OpenDota team ratings (~1000 команд) |
| `ingest:matches [pages=20]` | Pro matches (~100/page, 1.1s/req) |
| `ingest:leagues` | Lague names → `leagues` table |
| `ingest:hero-stats` | Hero meta winrates / pickrates. Stratz-supplemented если есть `STRATZ_TOKEN` |
| `ingest:hero-matchups` | Hero-vs-hero матрица. Stratz-primary (1 запрос, ~3.5s, ~16k пар, бракет DIVINE_IMMORTAL) с OpenDota fallback (138 запросов, инкрементально). Флаги `--no-stratz` / `--no-fallback`. ⚠️ matchCount шкала ≠ OpenDota — после смены источника требует `train:lightgbm` |
| `ingest:drafts [limit]` | Picks/bans + radiant/dire account_ids. Stratz-primary с `STRATZ_TOKEN` (4× быстрее) |
| `ingest:players-heroes` | Per-player per-hero stats (7-day freshness). Stratz-primary с `STRATZ_TOKEN` |
| `compute:recent-form` | Recompute `team_recent_form` (30/90-day) |
| `compute:h2h` | Recompute `team_h2h` (365-day) |
| `compute:player-glicko` | Glicko-1 (c=63, period=30d). Идемпотентно; `--reset` пересоздаёт |
| `compute:bo3-series [days=180]` | Aggregate `bo3_series` |
| `train:model` | Atomic swap всех v1+v2+v3 prematch LR моделей (fallback baseline) |
| `train:lightgbm [-- --label v3/t1]` | Wave 4 LightGBM prematch (через ml-service). Атомарный per-bucket swap |
| `train:market-models [-- --market <name>]` | Wave 4/5 LightGBM derived-market (FB / total_kills / total_duration ± q25/q75). Alias `total_duration_quantiles` обучает оба квантиля |
| `train:live-model` | Live-winner из `live_snapshots × prematch_outcomes` |
| `backfill:live-snapshots [-- --limit N]` | Backfill из OpenDota `/api/matches/{id}` для пустых live-окон |

**Required env:** `DATABASE_URL`. **Optional:** `ODDS_API_KEY`, `STRATZ_TOKEN`,
`PANDASCORE_API_KEY`, `PINNACLE_GUEST_API_KEY`, `ADMIN_TOKEN`, `DISABLE_LIVE_WORKER`,
`DISABLE_SCHEDULER`, `DISABLE_AUTO_RETRAIN`, `BOOKMAKERS_ENABLED` (default false),
`PROXY_URL` (РФ-прокси для букмекеров с не-РФ IP), `AUTO_DB_PUSH=false`.

**STRATZ_TOKEN** — бесплатный JWT с stratz.com/api (вход через Steam). 250 req/min /
20 000 req/day **на токен**. На Replit Node fetch блокируется Cloudflare (TLS JA3); клиент
автоматически падает на curl-fallback. Тест: `pnpm --filter @workspace/scripts run test:stratz`.

**Multi-token pool:** `STRATZ_TOKEN=tok1,tok2,tok3` (через запятую) — клиент
(`scripts/src/lib/stratz.ts`) выбирает LRU доступный токен и при 429 уходит в
65s cooldown на конкретный токен, переключаясь на следующий. Лимиты на токен
суммируются (×N throughput). api-server использует round-robin (`getStratzToken()`
в `ApiKeysService`) для лёгкого `/League/live` каждые 60s. Серая зона ToS Stratz
(каждый токен — реальный Steam-аккаунт), но Stratz не атрибутирует пользователя.

## Product

Mobile (Expo) app для русскоязычных Dota 2 беттеров. Dark warm amber palette
(#080604 bg, #E8830A primary, #5DE8A0 radiant, #FF4433 dire). Detailed view как
основной режим (simple-режим закомментирован под будущий Lite/Premium gating) и
глоссарий из 15 типов рынков. Backed by:

- **Live ML predictions** на текущих pro-матчах (обновление каждые 60s).
  Live-винер модель обучена на `live_snapshots × prematch_outcomes`.
- **Match-winner model** обучен на OpenDota historical pro matches (LightGBM v3 +
  LR fallback, маршрутизация по tier и наличию draft + account_ids). Текущие
  метрики (2026-05-14, Stratz DIVINE_IMMORTAL matchups): LightGBM v3 fallback
  test_acc=72.5% brier=0.181; v3/t2 test_acc=71.0% brier=0.178. ⚠️ Заметное
  падение с 79.5%→72.5% по сравнению с OpenDota pro-only матчапами —
  возможно, ranked DIVINE_IMMORTAL matchups менее предсказуемы для про-матчей.
  LR v3 fallback acc=78.5% brier=0.162. Live-винер lr-live-v8: acc=70.5% vs
  прематч baseline 55.2% (Δ=+15.3 п.п.).
- **15 mathematical models** для derivative markets (FB, total_kills, total_duration
  ± q25/q75 квантили).
- **Bookmaker odds aggregation** (когда настроено — сейчас скрыто в UI, см.
  Bookmakers roadmap в `docs/architecture.md`).
- **Тоталы (kills/duration)** показываются ladder-UI (несколько линий ТБ/ТМ).
  Эндпоинт `/api/analytics/totals-ladder?type=kills|duration&radiantTeamId=&direTeamId=&...`
  отдаёт массив линий с вероятностью модели; на live центрируется вокруг проекции
  текущего темпа. Компонент `components/TotalsLadder.tsx`.
- **Quantile duration models** (LightGBM α=0.25/0.75) загружаются `MarketLgbm`
  параллельно с regression-моделями и экспонируются как `totalDurationLogQ25`/
  `totalDurationLogQ75` в `predictMarketsFor()` — непараметрический 50% interval
  для будущей калибровки ladder без допущения о log-нормали. Метаданные пишутся
  под каноническим ключом `task_type` (legacy `taskType` оставлен как алиас).

### UX поведение списка (DONE 2026-05-14)

`fetchLiveData(cbs)` поддерживает прогрессивную отрисовку:

1. **Сразу после `/api/matches/live` + `/api/matches/upcoming`** колбэк `onShellsReady`
   получает «скелеты» матчей — карточки появляются в UI мгновенно, без ожидания
   ML-предсказаний.
2. **Затем последовательно** (в порядке списка) для каждого live-матча зовётся
   `/api/analytics/predict`; колбэк `onMatchEnriched` обновляет конкретную карточку.

Это значит: даже если api-server холодный или OpenDota медленный, пользователь видит
актуальные матчи моментально, а ML-скоринг подтягивается прогрессивно. Первая карточка
в списке всегда обогащается первой.

## User preferences

- Язык интерфейса — русский
- Pinnacle парсим самостоятельно, без платного API (пользователь предупреждён про ToS)
- Не предлагать Reserved VM деплой пока пользователь не попросит
- Не платить за The Odds API на этом этапе
- В мобилке букмекерский UI скрыт до появления первых пользователей
  (бэкенд оставлен нетронутым, помечено `TODO(bookmakers)`)
- Алерты — только по `minConfidence` модели; `minEdge`/`minOdds` вернутся вместе с букмекерским UI
- При проблемах с данными приоритет — показать актуальные матчи; ML-скоринг догружается
  сверху прогрессивно. Лимиты OpenDota тратим в первую очередь на то, что сейчас
  отображается у пользователя (live drafts), батчевые ingest'ы — фоном.

## Pointers

- **`docs/architecture.md`** — полная архитектура: где что лежит, все API-эндпоинты,
  admin & settings, Bookmakers roadmap, performance, architecture decisions, gotchas.
- **`docs/changelog.md`** — историческая хронология крупных изменений (Wave 3/4/5,
  миграция, automation, admin-web и т.д.).
- **`threat_model.md`** — модель угроз для security-сканов.
- См. skill `pnpm-workspace` — структура монорепо, TypeScript, project references.

## Roadmap (active)

- **Backtest UI скрыт.** `app/(tabs)/backtest.tsx` оставлен, маршрут спрятан
  (`href: null`). Эндпоинт `/api/analytics/backtest` доступен — UI вернётся, когда
  `prematch_outcomes` накопит ≥200 строк.
- **Live-winner на LightGBM** — перенести когда `live_snapshots × prematch_outcomes` ≥ 200.
- **EV-merge на фронте** — matching events букмекеров к `pro_matches`, фактическое
  использование `filters.bookmaker` в `app/(tabs)/index.tsx::applyFilters`,
  `BookmakerDropdown` подключить к header'у. Полный охват маркетов
  (winner/totals/firstBlood) для всех 6 букмекеров.
- **Возврат `minEdge`/`minOdds` в алерты** — UI и валидация в админ-настройках.

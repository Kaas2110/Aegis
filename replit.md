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
- `pnpm --filter @workspace/scripts run ingest:hero-stats` — hero meta winrates / pickrates (current patch)
- `pnpm --filter @workspace/scripts run ingest:hero-matchups` — pairwise hero matchup matrix (incremental)
- `pnpm --filter @workspace/scripts run ingest:drafts [limit]` — picks/bans + radiant/dire account_ids (v2/v3-eligible only). `--backfill-accounts` re-fetches account_ids for pre-Wave-3 rows.
- `pnpm --filter @workspace/scripts run ingest:players-heroes` — per-player per-hero stats (7-day freshness)
- `pnpm --filter @workspace/scripts run compute:recent-form` — recompute `team_recent_form` (30/90-day)
- `pnpm --filter @workspace/scripts run compute:h2h` — recompute `team_h2h` (365-day)
- `pnpm --filter @workspace/scripts run compute:player-glicko` — пересчёт `player_ratings` (Glicko-1, c=63, period=30d). Идемпотентно; флаг `--reset` пересоздаёт с нуля. Запускать после `ingest:drafts`/`ingest:matches`.
- `pnpm --filter @workspace/scripts run compute:bo3-series [days=180]` — aggregate `bo3_series`
- `pnpm --filter @workspace/scripts run train:model` — atomic swap of all v1+v2+v3 active prematch models (live-winner trained back-to-back, non-fatal). Engine = logistic regression (fallback baseline).
- `pnpm --filter @workspace/scripts run train:lightgbm` — Wave 4 gradient-boosted prematch models (LightGBM via `artifacts/ml-service`). Атомарный swap внутри `engine='lightgbm'`; LR-модели остаются как fallback. Inference: api-server идёт по HTTP в ml-service с 200ms timeout + 60s circuit-breaker; на любой сбой → LR.
- `pnpm --filter @workspace/scripts run train:market-models` — Wave 3.D derived-market baselines (per-tier log-normal kills/duration, base-rate+logit first-blood)
- `pnpm --filter @workspace/scripts run train:live-model` — train live-winner from `live_snapshots × prematch_outcomes`
- `pnpm run typecheck` — full typecheck (libs first via `typecheck:libs`)

Required env: `DATABASE_URL`. Optional: `ODDS_API_KEY`, `STRATZ_TOKEN`, `PANDASCORE_API_KEY`, `PINNACLE_GUEST_API_KEY`, `ADMIN_TOKEN`, `DISABLE_LIVE_WORKER`, `DISABLE_SCHEDULER`.

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

## Roadmap (после миграции в новый workspace, 2026-05-11)

- **Wave 3 «proper» (per-player Glicko — DONE для v3 LR).** Новая таблица `player_ratings` (account_id PK, rating, rd, games, wins, last_match_*). Скрипт `compute:player-glicko` крутит Glicko-1 multi-opponent batch updates по pro_matches × match_drafts (с RD time-decay c=63, period=30d). 5-я v3-extra фича — `player_glicko_diff = (avg(rad) − avg(dire)) / 200` (нейтрально 1500 при отсутствии записи). v3 dim 16 → **17**. Активно: LR v3 (`prematch_winner` + `prematch_winner_t2`). LightGBM v3 пока заблокирован объёмом данных (нужно ≥80 матчей с обоими полными account_ids — на 2026-05-11 в БД 68/60). Покрытие player_ratings: 107 игроков, 5 с ≥20 играми. Расширится по мере накопления `match_drafts.radiant/dire_account_ids`.
- **ML upgrade → gradient boosting (Wave 4 — DONE для prematch).** Реализовано: `artifacts/ml-service` (FastAPI + LightGBM + sklearn IsotonicRegression), `model_versions.engine` enum logreg|lightgbm + binary_blob bytea, partial unique index `(kind, fv, engine) WHERE is_active`. Тренировка: `scripts/src/train-lightgbm.ts` (12 jobs: 3 fv × 4 buckets, исключая live). Inference: PredictionModel.predictViaMlService — HTTP, 200ms timeout, 60s circuit-breaker, кеш blob в памяти api-server, фолбэк на logreg при любой ошибке. **Осталось:** live-winner перенести на LightGBM (когда `live_snapshots × prematch_outcomes` ≥ 200); derived markets (`train:market-models`) пока на logit/log-normal.
- **Все модели — вероятностные.** Каждая активная модель (prematch_winner v1/v2/v3, prematch_winner_t2, live_winner, derived markets из `train:market-models`) выдаёт `p ∈ [0,1]` (или μ/σ для kills/duration с CDF-обёрткой). UI читает только `prediction.confidence` / `prediction.ev`.
- **Backtest UI скрыт.** `app/(tabs)/backtest.tsx` файл оставлен, маршрут спрятан (`href: null` / `hidden`). Эндпоинт `/api/analytics/backtest` доступен — UI вернётся, когда `prematch_outcomes` накопит ≥200 строк.
- **Detailed mode = primary на проде.** Simple-режим оставляем закомментированным под будущий gating Lite/Premium (RevenueCat). Все toggles `viewMode` пока ведут на `'detailed'`.
- **Admin → отдельный web-артефакт.** Текущий inline `/api/admin-ui/` оставлен для оперативного доступа. Новый `admin-web` (React + Vite, кладётся в `artifacts/admin-web`) будет управлять iOS/Android релизами, моделями, лигами и whitelist'ами; общается с тем же `/api/admin/*` через `X-Admin-Token` (хранится в HttpOnly-cookie, не localStorage).

## Миграция из старого workspace (2026-05-11)

- Старый Postgres (`helium/heliumdb`) был внутренним и недоступен — DB пересобрана с нуля через `pnpm --filter @workspace/db run push`.
- Код восстановлен из public GitHub repo (`Kaas2110/Market-Edge`) поверх scaffold'ов monorepo.
- Первая ingest-пробежка scheduler'а (после рестарта) загрузила 1000 команд + ~2000 матчей и обучила v1 prematch модель (acc≈73.7% на tier-1, brier≈0.18). v2/v3 ждут `ingest:drafts` + `ingest:players-heroes`. Live-модель ждёт ~1-2 недели накопления `live_snapshots × prematch_outcomes`.
- `ADMIN_TOKEN` перевыпущен (старый, утёкший в чате, инвалидирован). `SESSION_SECRET` уже был в workspace.

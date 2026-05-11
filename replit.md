# Aegis — Dota 2 match analytics

Production-ready Dota 2 esports analytics mobile app. Russian UI. Live ML-driven predictions across 15 bet markets, fed by OpenDota historical data.

Бренд: «Aegis». Внутренние пакеты по-прежнему называются `@workspace/mobile`/`@workspace/api-server` (не переименовываем без необходимости — миграция импортов не оправдана).

Stack: pnpm workspaces, Node 24, TypeScript 5.9, Express 5, PostgreSQL + Drizzle, Expo (React Native), Zod (`zod/v4`), in-process logistic regression (no native deps).

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
- `pnpm --filter @workspace/scripts run compute:bo3-series [days=180]` — aggregate `bo3_series`
- `pnpm --filter @workspace/scripts run train:model` — atomic swap of all v1+v2+v3 active prematch models (live-winner trained back-to-back, non-fatal)
- `pnpm --filter @workspace/scripts run train:market-models` — Wave 3.D derived-market baselines (per-tier log-normal kills/duration, base-rate+logit first-blood)
- `pnpm --filter @workspace/scripts run train:live-model` — train live-winner from `live_snapshots × prematch_outcomes`
- `pnpm run typecheck` — full typecheck (libs first via `typecheck:libs`)

Required env: `DATABASE_URL`. Optional: `ODDS_API_KEY`, `STRATZ_TOKEN`, `PANDASCORE_API_KEY`, `PINNACLE_GUEST_API_KEY`, `ADMIN_TOKEN`, `DISABLE_LIVE_WORKER`, `DISABLE_SCHEDULER`.

## Product

Mobile (Expo) app for Russian-speaking Dota 2 bettors. Dark warm amber palette (#080604 bg, #E8830A primary, #5DE8A0 radiant, #FF4433 dire). Two view modes (simple / detailed) and a glossary of 15 bet-market types. Backed by:

- Live ML predictions on currently-running pro matches (updated every 60s)
- Match-winner model trained on OpenDota historical pro matches
- Bookmaker odds aggregation (when configured — currently hidden in UI, see Bookmakers roadmap in `docs/architecture.md`)
- 15 mathematical models for derivative markets

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

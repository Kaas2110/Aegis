# Aegis — Dota 2 match analytics

Production-ready Dota 2 esports analytics mobile app. Russian UI. Live ML-driven predictions across 15 bet markets.

**Brand:** «Aegis». Internal packages remain `@workspace/mobile` / `@workspace/api-server`.

**Stack:** pnpm workspaces · Node 24 · TypeScript 5.9 · Express 5 · PostgreSQL + Drizzle · Expo (React Native) · Zod v4 · LightGBM 4.6 + sklearn IsotonicRegression (FastAPI `artifacts/ml-service`, stateless blob-per-predict) · pure-JS logistic regression as fallback (60s circuit-breaker, 200ms timeout) · **RevenueCat** (primary провайдер монетизации) + Adapty (альтернатива, оставлен в `lib/adapty.tsx` для возможного переключения на RU/СНГ-фокус).

## Run & Operate

```
pnpm --filter @workspace/api-server run dev       # API server (PORT env, /api)
pnpm --filter @workspace/mobile run dev           # Expo mobile app
pnpm --filter @workspace/db run push              # push DB schema (dev only)
pnpm run typecheck                                # full check (libs first)
```

**Ingest scripts** (`pnpm --filter @workspace/scripts run …`):

| Script | What it does |
|---|---|
| `ingest:teams` | OpenDota team ratings (~1000 teams) |
| `ingest:matches [pages=20]` | Pro matches (~100/page). `--less-than <id>` for backfill |
| `ingest:leagues` | League names → `leagues` table |
| `ingest:hero-stats` | Hero meta winrates/pickrates. Stratz-supplemented if `STRATZ_TOKEN` set |
| `ingest:hero-matchups` | Pairwise hero matchup matrix (incremental) |
| `ingest:drafts [limit]` | Picks/bans + account_ids. Stratz-primary if token set (4× faster). `--no-stratz` forces OpenDota |
| `ingest:players-heroes` | Per-player per-hero stats (7-day freshness). Stratz-primary if token set |
| `backfill:live-snapshots` | Synthetic live snapshots from OpenDota match history |

**Compute scripts:**

| Script | What it does |
|---|---|
| `compute:recent-form` | `team_recent_form` (30/90-day) |
| `compute:h2h` | `team_h2h` (365-day) |
| `compute:bo3-series [days=180]` | Aggregate `bo3_series` |
| `compute:player-glicko` | `player_ratings` Glicko-1 (c=63, period=30d). `--reset` rebuilds from scratch |

**Train scripts:**

| Script | What it does |
|---|---|
| `train:model` | All v1+v2+v3 LR prematch models (fallback baseline). `--dry-run` `--since-unix` `--min-samples` `--min-glicko` |
| `train:lightgbm [-- --label v3/t1]` | LGB prematch models (12 jobs: 3 fv × 4 buckets) |
| `train:market-models [-- --market first_blood\|total_kills\|total_duration\|all]` | LGB derived-market models |
| `train:live-model` | LGB + LR live-winner (dual, both saved to DB) |
| `train:live-model` (via scheduler) | Also runs after backfill if snapshot pairs < 100 |

**Env vars:** `DATABASE_URL` (required). Optional: `STRATZ_TOKEN` · `PANDASCORE_API_KEY` · `PINNACLE_GUEST_API_KEY` · `ADMIN_TOKEN` · `SESSION_SECRET` · `BOOKMAKERS_ENABLED` (default false) · `PROXY_URL` · `DISABLE_LIVE_WORKER` · `DISABLE_SCHEDULER` · `DISABLE_AUTO_RETRAIN` · `DISABLE_BACKGROUND_POLLER` · `POLL_UPCOMING_MIN` (default 30) · `AUTO_DB_PUSH=false`. **Note:** `ODDS_API_KEY` (The Odds API) больше не используется — продукт ориентирован на RU/СНГ, кэфы берутся только из локальных букмекеров. `/api/odds/dota2` и `/api/odds/sports` всегда возвращают 503.

**STRATZ_TOKEN** — free JWT from stratz.com/api (Steam login). 250 req/min / 20k req/day. On Replit: Node fetch blocked by Cloudflare TLS JA3 → auto-falls back to curl. Client: `scripts/src/lib/stratz.ts`. Test: `pnpm --filter @workspace/scripts run test:stratz`.

## Product

Mobile (Expo) app for Russian-speaking Dota 2 bettors. Dark warm amber palette (`#080604` bg · `#E8830A` primary · `#5DE8A0` radiant · `#FF4433` dire).

- **Detailed view** = primary mode (simple mode commented out, reserved for Lite/Premium gating)
- **15 market glossary** — winner, totals, first blood, etc.
- **Totals ladder UI** — multiple TB/TM lines like bookmakers. Endpoint: `/api/analytics/totals-ladder`. Component: `components/TotalsLadder.tsx`
- **Live predictions** — updated every 60s via LiveWorker polling OpenDota `/api/live`
- **Bookmaker UI hidden** — backend intact, toggled by `BOOKMAKERS_ENABLED`; all bookie endpoints return HTTP 503 when disabled

## User preferences

- Interface language: Russian
- Pinnacle scraped manually (user warned about ToS)
- Don't suggest Reserved VM deployment unless asked
- The Odds API отключён полностью (RU/СНГ-фокус, нет российских буков). Не возвращать без явного запроса
- Live snapshots prune window: 365 дней (default) — НЕ путать с задержкой авто-ретрейна
- Авто-ретрейн ML после нового патча: 10 дней (PATCH_DELAY_DAYS в SchedulerWorker)
- Bookmaker UI hidden until first users (backend untouched, marked `TODO(bookmakers)`)
- Alerts: `minConfidence` only; `minEdge`/`minOdds` return with bookmaker UI

## Architecture pointers

- **`docs/architecture.md`** — full architecture: endpoints, admin & settings, Bookmakers roadmap, performance, decisions, gotchas
- **`threat_model.md`** — security threat model
- **`lib/api-spec/openapi.yaml`** — OpenAPI contract; codegen: `pnpm --filter @workspace/api-spec run codegen`
- pnpm-workspace skill — monorepo structure, TypeScript, project references

## ML state (as of 2026-05-13, retrain #10 — v2/v3 version routing fix)

**Deep-research items shipped (retrain #8):** prematch fv 5→12 (radiant_side_logit, recency_days_norm, series_type_norm, map_no_norm, tier_t1/t2/t3) · live fv 7→8 (is_real_live, tower_diff_norm from `building_state` bitmap, has_draft, recency_days_norm) · chronological B6 split (1d gap train/test) · composite-score primary selection (brier-only when only one model has logloss; brier+0.3·logloss when both) · ml-service quantile task_type with proper pinball/coverage metrics · 3 quantile models (α=0.25/0.5/0.75) for `total_duration` market.

**Architecture redesign (retrain #10, 2026-05-13):** v2/v3 routing was broken — v2 needed draft picks (unavailable from PandaScore for upcoming matches), v3 needed picks + account_ids (also unavailable). 100% of upcoming predictions fell through to v1.

**New feature layout:**
- v1 = team(12) — ELO, winrate, experience, is_high_tier, side_logit, recency, series_type, map_no, tier_t1/t2/t3
- **v2 = team(12) + extra(7) = 19** — + recent_form_diff, h2h_advantage_radiant, side_advantage, avg_kills_diff, avg_duration_diff, sos_diff, roster_stability_diff. **No draft needed → fires for ALL upcoming matches.**
- **v3 = v2(19) + hero(7) = 26** — + pick/ban/matchup features. Fires when draft is known (live matches).
- Removed: player_skill_diff, player_glicko_diff (require account_ids from current match, unavailable in PandaScore)

**LiveWorker now persists `building_state` to live_snapshots** (was lost — only stored in raw_payload).

### Latest training results (retrain #10, 2026-05-13)

**Prematch winner — LR (18 models: v1/v2/v3 × winner/t1/t2):**
- v1/winner: 63.3% / brier 0.227 · v1/t1: 51.6% · v1/t2: 61.0%
- **v2/winner: 71.6% / brier 0.190** · v2/t1: 68.1% / brier 0.206 · **v2/t2: 71.2% / brier 0.187**
- **v3/winner: 81.0% / brier 0.146** · v3/t1: 72.5% / brier 0.184 · **v3/t2: 79.1% / brier 0.134**
- v2 train samples: 3262 (t1=909, t2=2353) — same as v1, no draft needed ✓
- v3 train samples: 3251 (t1=908, t2=2343) — only 11 dropped for unknown hero

**Prematch winner — LGB (9 models, LR is primary when LGB brier worse):**
- v2/winner: 66.4% / brier 0.199 · v2/t2: 69.5% / brier 0.196
- v3/winner: 74.2% / brier 0.153 · v3/t1: 75.8% / brier 0.174 · v3/t2: 79.6% / brier 0.144
- LR v2/v3 outperform LGB on calibrated brier → LR primary for v2/v3

**Inference routing (verified, 2026-05-13):** BackgroundPoller predicted 41/50 upcoming matches, **all 41 using v2** (was v1 = 100% before). v3 will fire automatically once live drafts are available.

**Market models (16-dim team features, unchanged from retrain #9):**
- first_blood (LGB clf): 61.9% / brier 0.231
- total_kills (LGB reg): R²=0.053, RMSE=0.270
- total_duration (LGB reg): R²=0.057, RMSE=0.270
- total_duration quantiles: q25 cov=0.227 (target 0.25 ✓) · q50 cov=0.469 (target 0.5 ✓) · q75 cov=0.716 (target 0.75 ✓)

**Live winner (fv=8, 20 features, retrained #9, 2026-05-12):**
- **LR primary** 71.82% / brier **0.1819** (lift +5.31pp over prematch baseline 66.51%)
- LGB secondary 69.05% / brier 0.2803 (train 99.5%, overfits on hero_advantage)
- Composite selection: `brier_only` mode → LR wins by lower brier
- LR weights top-5: `kill_diff_norm=3.11, kill_ratio=1.50, kill_diff_x_phase=0.66, elo_diff_norm=0.22, nw_lead_per_min=0.19`

**Data:** 28.9k matches in 365d window · 5727 drafts · 5505 snapshots (3-min bucket dedup) · prematch_logit sources: stored=1415, elo=22, neutral=4068.

**Training dataset settings** (stored in `app_settings`):
- `trainWindowDays` (default 365, range 30–730)
- `trainMaxPatches` (default 4, range 1–20)
- `trainMinSamples` (default 1000, range 50–100k)
Effective cutoff = `max(windowCutoff, patchCutoff)`. Admin UI: `/settings` → «Тренировочный датасет».

## Automation (SchedulerWorker)

Full retrain pipeline (triggered on new patch or every 30 days):
1. `ingest:teams` → 2. `ingest:matches[15]` → 3. `ingest:drafts` → 4. `ingest:hero-stats` → 5. `ingest:hero-matchups` → 6. `ingest:players-heroes` → 7. `ingest:leagues` → 8. prune → 9. `compute:recent-form` → 10. `compute:h2h` → 11. `compute:bo3-series` → 12. `compute:player-glicko` → 13. `train:model` → 14. `train:lightgbm` → 15. `train:market-models` + `train:live-model`

Daily refresh (between full retrains): teams + matches[5] + drafts + players-heroes + form + h2h + glicko.

Cold-start: if `count(pro_matches) < 100` → immediate full pipeline at T+30s.

## Bookmakers (6 sources)

Fonbet · Лига Ставок · PARI · BetBoom · 1xStavka · Olimp.bet — public mobile/web JSON APIs, no keys. Geo-blocked outside RU (use `PROXY_URL`). `winner` mapped for 4/6. `totalKills`/`totalDuration`/`firstBlood` reserved, mapping not yet implemented.

Remaining (deferred): EV-merge on frontend, full market coverage, `minEdge`/`minOdds` alerts.

## Roadmap

- **Wave 3 LGB** — blocked: need ≥80 matches with full `radiant/dire_account_ids` (currently ~68). Auto-unblocks as `match_drafts` accumulates
- **Backtest UI** — LIVE (2026-05-12). Tab visible, endpoint `/api/analytics/backtest` covers 7292 outcomes (backfilled). Will improve naturally as outcomes accumulate.
- **Bookmaker EV-merge** — matching bookie events to `pro_matches`, `BookmakerDropdown` in home header, `minEdge`/`minOdds` in alerts
- **Монетизация / Lite vs Premium** — RevenueCat primary (ключи `EXPO_PUBLIC_REVENUECAT_*`), Adapty оставлен как альтернатива (`EXPO_PUBLIC_ADAPTY_KEY`); feature gating через `app_settings.feature_flags` + per-tier matrix в `lib/featureFlags.tsx`. Переключение провайдера: импорт `SubscriptionProvider`/`useSubscription` в `app/_layout.tsx` и `lib/featureFlags.tsx`.
- **Live winner → full LGB** — auto when live trainSize > 10k snapshots

## Admin panel (`/admin-web/`)

Separate React+Vite SPA. Auth: `POST /api/admin/login` → HttpOnly cookie `aegis_admin_session` (24h). Brute-force throttle: 10 attempts/15min per IP. Pages: `/` dashboard · `/settings` · `/metrics` · `/operations` (retrain + prune + integrations).

All admin calls via generated hooks from `@workspace/api-client-react`. 401 → redirect to `/admin-web/login`.

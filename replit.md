# Aegis — Dota 2 match analytics

Production-ready Dota 2 esports analytics mobile app. Russian UI. Live ML-driven predictions across 15 bet markets.

**Brand:** «Aegis». Internal packages remain `@workspace/mobile` / `@workspace/api-server`.

**Stack:** pnpm workspaces · Node 24 · TypeScript 5.9 · Express 5 · PostgreSQL + Drizzle · Expo (React Native) · Zod v4 · LightGBM 4.6 + sklearn IsotonicRegression (FastAPI `artifacts/ml-service`, stateless blob-per-predict) · pure-JS logistic regression as fallback (60s circuit-breaker, 200ms timeout) · **Adapty** (монетизация, заменил RevenueCat — RU/СНГ фокус).

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

## ML state (as of 2026-05-12, retrain #9 — extra features wave)

**Deep-research items shipped (retrain #8):** prematch fv 5→12 (radiant_side_logit, recency_days_norm, series_type_norm, map_no_norm, tier_t1/t2/t3) · live fv 7→8 (is_real_live, tower_diff_norm from `building_state` bitmap, has_draft, recency_days_norm) · chronological B6 split (1d gap train/test) · composite-score primary selection (brier-only when only one model has logloss; brier+0.3·logloss when both) · ml-service quantile task_type with proper pinball/coverage metrics · 3 quantile models (α=0.25/0.5/0.75) for `total_duration` market.

**Extra features added (retrain #9):** EXTRA_FEATURE_NAMES 5→9 (v3 dim 24→28): `avg_kills_diff` (avgKillsFor 30d diff / 10) · `avg_duration_diff` (avgDurationSec 30d diff / 3600) · `sos_diff` (strength of schedule: avg opp elo diff / 200, 30d window) · `roster_stability_diff` (Jaccard overlap of last 10 lineups, radiant−dire). Prematch LR improved +3.4pp on winner, +0.5pp on t2.

**LiveWorker now persists `building_state` to live_snapshots** (was lost — only stored in raw_payload). New snapshots have tower data; old snapshots remain null until natural rotation.

### Latest training results (retrain #9, 2026-05-12)

**Prematch winner (fv=3, 12 team + 7 hero + 9 extra = 28 dim for v3):**
- LR best: v3/winner **79.8%/0.155** · v3/t2 **79.8%/0.153** (was 76.4%/0.157 · 79.3%/0.143)
- LGB best: v3/winner 78.5%/0.1528 · v3/t2 **81.7%/0.1497**

**Market models (16-dim team features, unchanged):**
- first_blood (LGB clf): 61.9% / brier 0.231
- total_kills (LGB reg): R²=0.053, RMSE=0.270
- total_duration (LGB reg): R²=0.057, RMSE=0.270
- total_duration quantiles: q25 cov=0.227 (target 0.25 ✓) · q50 cov=0.469 (target 0.5 ✓) · q75 cov=0.716 (target 0.75 ✓)

**Live winner (fv=8, 20 features, retrain #9):**
- **LR primary** 71.82% / brier **0.1819** (lift +5.31pp over prematch baseline 66.51%)
- LGB secondary 69.05% / brier 0.2803 (train 99.5%, overfits on hero_advantage)
- Composite selection: `brier_only` mode → LR wins by lower brier
- LR weights top-5: `kill_diff_norm=3.11, kill_ratio=1.50, kill_diff_x_phase=0.66, elo_diff_norm=0.22, nw_lead_per_min=0.19`
- LGB feature importance top-5: `hero_advantage=197, kill_ratio=194, form_diff=127, kill_pace_norm=126, recency_days_norm=123`

**Data:** 28.9k matches in 365d window · 5505 snapshots (3-min bucket dedup) · 4480 raw → 4294 balanced (50/50) train · 433 test · is_real_live=309/5505 · has_draft=5268/5505 (95.7%) · prematch_logit sources: stored=1415, elo=22, neutral=4068.

### LEGACY (2026-05-12, retrain #5)

**Training window:** 365d optimal for all model types (540d worse due to meta drift ~9pp).

**Active models (25 total, prematch/market retrained #4, live retrained #5):**
- Prematch winner: 9 LGB + 9 LR (v1/v2/v3 × winner/t1/t2) — all 18 active
  - Best LGB: v3/prematch_winner 78.5% / brier 0.1573 · v3/t2 78.9% / brier 0.1489
  - v3/t1 69.0% — overfits (train 94.5%, only 840 t1 samples)
  - Best LR: v3/winner 76.4% / brier 0.164 · v3/t2 77.0% / brier 0.156 · v3/t1 63.1%
  - LGB margin over LR: winner +2.1pp · t2 +1.9pp · t1 +5.9pp → LGB correctly primary
  - **Bug fix: train:model (LR) no longer deactivates LGB models** (added engine='logreg' filter to deactivation WHERE)
- Market v3 (retrained #4, 2026-05-12): 3 LGB — first_blood 58.8%, total_kills R²=0.059, total_duration R²=0.039
  - **Bug fix: `patch_kpm` was a global constant (importance=0 in all 3 models). Replaced with `expected_tempo_norm` = (avgKillsR + avgKillsD) / (2×GLOBAL_AVG_KILLS) — varies per matchup, non-zero importance.**
  - expected_tempo_norm: top-5 for total_duration (importance=32). total_kills top: elo_diff, winrate_diff, experience_diff, draft_aggression_r/d
- Live winner (fv=7, 16 features): 1 LGB + 1 LR — **retrained #7 (2026-05-12)**
  - **LR: 69.98% (+3.46pp over prematch baseline 66.51%), brier 0.1782. LR is primary (testAcc > LGB).**
  - LGB: 66.74% (+2.54pp, train 99.21%) — hero_advantage top feature (importance=250), overfitting; LGB secondary
  - Primary selection: auto by testAccuracy
  - `prematch_logit` sources: stored=1415, elo=22, neutral=4068
  - LR weights: `kill_diff_norm=3.061, kill_ratio=1.521, kill_diff_x_phase=0.618, kill_pace_norm=0.181, nw_lead_norm=0.193, elo_diff_norm=0.138, nw_lead_per_min=0.178, form_diff=-0.234, hero_advantage=0.112, power_spike_delta=0.005, spike_x_nw=0.009`
  - LGB feature importance top-5: `hero_advantage=250, kill_ratio=231, form_diff=188, kill_pace_norm=169, elo_diff_norm=54`
  - **Features (16, fv=7):** `bias, game_time_norm, nw_lead_norm, kill_diff_norm, prematch_logit, kill_pace_norm, game_phase, nw_x_phase, kill_diff_x_phase, hero_advantage, nw_lead_per_min, kill_ratio, elo_diff_norm, form_diff, power_spike_delta, spike_x_nw`
  - fv=6→7 changes: +power_spike_delta (Gaussian team spike score diff, σ=8min), +spike_x_nw (spike×nw interaction); power timing = avg winning game duration per hero from match history (127 heroes, global avg 39.0 min)
  - Late heroes (≥41 min): Spectre(68), Morphling(70), Terrorblade(135), Doom(69); early (≤36 min): Brewmaster(91), Juggernaut(8), Zeus(22), Clockwerk(14)
  - **Draft coverage: 100%** (95.7% from match_drafts after `ingest:drafts --live-backfill`; raw_payload fallback covers residual). power_spike_delta now fully active.
  - Note: retrain #7 LR accuracy -2.31pp vs #6 (72.29%→69.98%) — likely due to hero_advantage signal noise from newly ingested lower-quality matches (bypassed Glicko filter). Will improve naturally as draft data quality grows.
  - **50/50 train balance:** undersample majority class in train set only (test unbalanced = real distribution); raw 4480 → balanced 4294 (2147/class, dropped 186)
  - Group C: class_weight='balanced' in LGB retained
  - Root data: 519 training matches / 5505 bucketed snapshots

**Data:** 44.6k matches total · 28.9k in 365d window · 5237 drafts · 384 player_ratings · **7292 prematch_outcomes** (backfilled via `backfill:prematch-outcomes`) · 18.7k live snapshots (5505 after 3-min bucket dedup).

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
- **Adapty / Lite vs Premium** — монетизация (Adapty заменил RevenueCat 2026-05-13, ключ `EXPO_PUBLIC_ADAPTY_KEY`), feature gating
- **Live winner → full LGB** — auto when live trainSize > 10k snapshots

## Admin panel (`/admin-web/`)

Separate React+Vite SPA. Auth: `POST /api/admin/login` → HttpOnly cookie `aegis_admin_session` (24h). Brute-force throttle: 10 attempts/15min per IP. Pages: `/` dashboard · `/settings` · `/metrics` · `/operations` (retrain + prune + integrations).

All admin calls via generated hooks from `@workspace/api-client-react`. 401 → redirect to `/admin-web/login`.

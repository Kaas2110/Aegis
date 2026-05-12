# Aegis — Dota 2 match analytics

Production-ready Dota 2 esports analytics mobile app. Russian UI. Live ML-driven predictions across 15 bet markets.

**Brand:** «Aegis». Internal packages remain `@workspace/mobile` / `@workspace/api-server`.

**Stack:** pnpm workspaces · Node 24 · TypeScript 5.9 · Express 5 · PostgreSQL + Drizzle · Expo (React Native) · Zod v4 · LightGBM 4.6 + sklearn IsotonicRegression (FastAPI `artifacts/ml-service`, stateless blob-per-predict) · pure-JS logistic regression as fallback (60s circuit-breaker, 200ms timeout).

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

**Env vars:** `DATABASE_URL` (required). Optional: `STRATZ_TOKEN` · `PANDASCORE_API_KEY` · `ODDS_API_KEY` · `PINNACLE_GUEST_API_KEY` · `ADMIN_TOKEN` · `SESSION_SECRET` · `BOOKMAKERS_ENABLED` (default false) · `PROXY_URL` · `DISABLE_LIVE_WORKER` · `DISABLE_SCHEDULER` · `DISABLE_AUTO_RETRAIN` · `AUTO_DB_PUSH=false`.

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
- Don't pay for The Odds API at this stage
- Bookmaker UI hidden until first users (backend untouched, marked `TODO(bookmakers)`)
- Alerts: `minConfidence` only; `minEdge`/`minOdds` return with bookmaker UI

## Architecture pointers

- **`docs/architecture.md`** — full architecture: endpoints, admin & settings, Bookmakers roadmap, performance, decisions, gotchas
- **`threat_model.md`** — security threat model
- **`lib/api-spec/openapi.yaml`** — OpenAPI contract; codegen: `pnpm --filter @workspace/api-spec run codegen`
- pnpm-workspace skill — monorepo structure, TypeScript, project references

## ML state (as of 2026-05-12)

**Training window:** 365d optimal for all model types (540d worse due to meta drift ~9pp).

**Active models (23 total, retrained 2026-05-12):**
- Prematch winner: 9 LGB + 9 LR (v1/v2/v3 × winner/t1/t2)
  - Best LGB: v3/prematch_winner 78.8% / brier 0.155 · v3/t2 77.5% / brier 0.148
  - Best LR:  v3/prematch_winner 76.4% cal · v3/t2 77.0% cal
- Market: 3 LGB (first_blood 61.3%, total_kills R²=0.031, total_duration R²=0.004)
- Live winner: 1 LGB + 1 LR. **LR is primary** until trainSize > 10k (LGB overfits on correlated snapshots). Both models currently underperform vs prematch baseline (~69%) on holdout — live predictions stored as bonus signal only.

**Data:** 44.6k matches total · 28.9k in 365d window · 5225 drafts (all ingested) · 4884 with player account_ids · 384 player_ratings · 21 prematch_outcomes.

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
- **Backtest UI** — hidden (`href: null`). Endpoint `/api/analytics/backtest` ready. Un-hide when `prematch_outcomes ≥ 200`
- **Bookmaker EV-merge** — matching bookie events to `pro_matches`, `BookmakerDropdown` in home header, `minEdge`/`minOdds` in alerts
- **RevenueCat / Lite vs Premium** — monetization, feature gating
- **Live winner → full LGB** — auto when live trainSize > 10k snapshots

## Admin panel (`/admin-web/`)

Separate React+Vite SPA. Auth: `POST /api/admin/login` → HttpOnly cookie `aegis_admin_session` (24h). Brute-force throttle: 10 attempts/15min per IP. Pages: `/` dashboard · `/settings` · `/metrics` · `/operations` (retrain + prune + integrations).

All admin calls via generated hooks from `@workspace/api-client-react`. 401 → redirect to `/admin-web/login`.

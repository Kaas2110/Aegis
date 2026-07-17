# Operations — ingest/compute/train скрипты и env

Справочник по операционным скриптам (`@workspace/scripts`) и переменным
окружения. Высокоуровневый обзор — `replit.md`; архитектура — `docs/architecture.md`;
миграция на ноут — `docs/laptop-deploy.md`.

## Ingest / compute / train скрипты

Все в `@workspace/scripts`: `pnpm --filter @workspace/scripts run <script>`.

| Script | Назначение |
|---|---|
| `ingest:teams` | OpenDota team ratings (~1000 команд) |
| `ingest:matches [pages=20]` | Pro matches (~100/page, 1.1s/req) |
| `ingest:leagues` | League names → `leagues` table |
| `ingest:hero-stats` | Hero meta winrates / pickrates. Stratz-supplemented если есть `STRATZ_TOKEN` |
| `ingest:od-team-rosters` | E1: текущий ростер команды + games_played/wins per-player (`/teams/{id}/players`). 7d freshness. Активные команды (last_match_time<365d), ~3000 запросов |
| `ingest:od-team-hero-pools` | E1: hero pool команды (`/teams/{id}/heroes`). 7d freshness, ~3000 запросов |
| `ingest:od-hero-benchmarks` | E1: перцентили GPM/XPM/kills/LH/heroDmg/healing/tower (`/benchmarks?hero_id=`). 138 запросов, раз в неделю |
| `ingest:od-hero-item-popularity` | E1: start/early/mid/late game items per hero (`/heroes/{id}/itemPopularity`). 138 запросов, раз в неделю |
| `ingest:od-pro-players` | E1: справочник pro-аккаунтов с актуальным team_id (`/proPlayers`). 1 запрос, раз в неделю |
| `ingest:od-player-totals` | E1: долгосрочные суммы статов игрока (`/players/{id}/totals`). 14d freshness, ~3000 запросов |
| `ingest:od-player-counts` | E1: распределение по lane_role / game_mode / patch (`/players/{id}/counts`). 14d freshness |
| `ingest:od-player-wl-pro` | E1: pro-only win/loss за 180d (`/players/{id}/wl?date=180&significant=1`). 14d freshness |
| `ingest:hero-matchups` | Hero-vs-hero матрица. Stratz-primary (1 запрос, ~3.5s, ~16k пар, бракет DIVINE_IMMORTAL) с OpenDota fallback. Флаги `--no-stratz` / `--no-fallback`. ⚠️ matchCount шкала ≠ OpenDota — после смены источника требует `train:lightgbm` |
| `ingest:hero-synergy` | Hero pair synergy table |
| `ingest:drafts [limit]` | Picks/bans + radiant/dire account_ids. Stratz-primary с `STRATZ_TOKEN` (4× быстрее) |
| `ingest:players-heroes` | Per-player per-hero stats (7-day freshness). Stratz-primary с `STRATZ_TOKEN` |
| `compute:recent-form` | Recompute `team_recent_form` (30/90-day) |
| `compute:h2h` | Recompute `team_h2h` (365-day) |
| `compute:player-glicko` | Glicko-1 (c=63, period=30d). Идемпотентно; `--reset` пересоздаёт |
| `compute:bo3-series [days=180]` | Aggregate `bo3_series` |
| `compute:team-extended` | Team extended snapshot features (winStreak, restDays, matches30d, avgDuration, fbRate, sidePref, **peerSynergy** — средний попарный wr core-5 ростера из `player_peers`, 365d, top-5 по играм, мин. 3 пары × 10 совместных игр) |
| `train:model` | Atomic swap всех v1+v2+v3 prematch LR моделей (fallback baseline) |
| `train:lightgbm [LIGHTGBM_KINDS=v3/fallback,...]` | LightGBM prematch (через ml-service). Атомарный per-bucket swap. Лог печатает `IMPORTANCE top15`, `DRIFT (>10%)`, `LABEL train/test radiantWR` |
| `train:market-models [-- --market <name>]` | LightGBM derived-market (FB / total_kills / total_duration ± q25/q75) |
| `train:live-model` | Live-винер из `live_snapshots × prematch_outcomes` |
| `train:live-totals [-- --market kills\|duration\|all]` | LightGBM live-regression (T3.5): финальный total_kills / duration_sec из текущего снапшота. Feature view v1 (OD-only, 7 фич). Атомарный per-market swap |
| `backfill:live-snapshots [-- --limit N]` | Backfill из OpenDota `/api/matches/{id}` для пустых live-окон |
| `parse:request [-- --limit N --since-days D]` | T0.7 — `POST /api/request/{id}` ставит матчи в очередь OD replay-парсера. Идемпотентно через `match_parse_queue`. **OD FREE MODE (2026-07): 60 req/min, 3000 req/day, троттл 1100ms через `odThrottleMs()`. Premium включается парой `OPENDOTA_USE_PREMIUM=true` + `OPENDOTA_API_KEY` (тогл на дашборде админки).** Дефолт 500 матчей, окно 180d |
| `ingest:parsed [-- --limit N --timeout-hours H]` | T0.7 — для матчей в queue (status='queued', age>90s) тянет `/matches/{id}`, при `version!=null` сохраняет players/objectives/teamfights/draftTimings в `match_parsed`, отмечает `pro_matches.is_parsed=true`. **20 req/s (50ms throttle).** После 2h в queued → `status='timeout'` |

## Переменные окружения

Шаблон всех переменных с инструкциями где взять значения — **`.env.example`** ⭐.

**Required:** `DATABASE_URL`.

**Optional:**
- `ODDS_API_KEY`, `STRATZ_TOKEN`, `PANDASCORE_API_KEY`, `PINNACLE_GUEST_API_KEY`
- `ADMIN_TOKEN` — вход в админку; `SESSION_SECRET` — обязателен для admin + user-auth токенов
- `OPENDOTA_USE_PREMIUM=true` + `OPENDOTA_API_KEY` — premium-режим OpenDota (иначе free: 60 req/min, 3000/day)
- `DISABLE_LIVE_WORKER`, `DISABLE_SCHEDULER`
- `DISABLE_AUTO_RETRAIN` — killswitch для фазы тренировки. На Replit держим `true`;
  на ноуте killswitch снят + `AUTO_RETRAIN_CRON_HOUR_UTC=4` (~7 утра МСК)
- `AUTO_RETRAIN_CRON_HOUR_UTC` — P5 safety: целое 0..23 — обучение разрешено ТОЛЬКО
  в этот час UTC; если не задан — открыто всегда при снятом killswitch. Нужен чтобы
  тренировка не конкурировала с cron-workflow'ами ingest
- `BOOKMAKERS_ENABLED` (default true), `PROXY_URL` (РФ-прокси для букмекеров с не-РФ IP)
- `AUTO_DB_PUSH=false`
- `ML_SERVICE_URL` (default `http://localhost:8090`), `ML_SERVICE_TOKEN`
  (иначе ml-service пишет ephemeral в `/tmp/aegis_ml_token`)

## STRATZ_TOKEN

Бесплатный JWT с stratz.com/api (вход через Steam). 250 req/min / 20 000 req/day
**на токен**. На Replit Node fetch блокируется Cloudflare (TLS JA3); клиент
автоматически падает на curl-fallback. Тест: `pnpm --filter @workspace/scripts run test:stratz`.

**Multi-token pool:** `STRATZ_TOKEN=tok1,tok2,tok3` (через запятую) — клиент
(`scripts/src/lib/stratz.ts`) выбирает LRU доступный токен и при 429 уходит в
65s cooldown на конкретный токен, переключаясь на следующий. Лимиты на токен
суммируются (×N throughput). api-server использует round-robin (`getStratzToken()`
в `ApiKeysService`) для лёгкого `/League/live` каждые 60s. Серая зона ToS Stratz
(каждый токен — реальный Steam-аккаунт), но Stratz не атрибутирует пользователя.

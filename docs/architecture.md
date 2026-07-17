# Dota Edge Analyzer — Architecture

Подробная документация по архитектурным решениям, нюансам ML-стека, букмекерским источникам и оптимизациям.
Высокоуровневый обзор, команды и пользовательские предпочтения — в `replit.md`.

## Where things live

- DB schema — `lib/db/src/schema/dota.ts` (single source of truth). Wave 2 added: `match_drafts` (picks/bans per match), `hero_stats` (per-hero meta), `hero_matchups` (pairwise winrates), `model_versions.features_version` (1=team-only, 2=team+hero, 3=+player/form/h2h/side) with partial unique idx `(kind, features_version) WHERE is_active`. Wave 3 added: `players` (player meta), `player_hero_stats` (per-account per-hero), `team_recent_form` (30/90d), `team_h2h` (365d, canonical low/high pair), `bo3_series` (series rollup), `match_drafts.radiant_account_ids`/`dire_account_ids` (parallel to picks), `pro_matches.series_id`/`series_type`/`first_blood_time`/`barracks_status_*`/`tower_status_*`. Также добавлена таблица `leagues` (leagueId, name, tier) — обогащаем live/upcoming матчи названиями лиг.
- ML training scripts — `scripts/src/train-model.ts`, `train-market-models.ts`, `train-live-model.ts`, `ingest-teams.ts`, `ingest-matches.ts`, `ingest-hero-stats.ts`, `ingest-hero-matchups.ts`, `ingest-drafts.ts`, `ingest-players-heroes.ts`, `ingest-leagues.ts`, `compute-recent-form.ts`, `compute-h2h.ts`, `compute-bo3-series.ts`.
- ML inference (prematch) — `artifacts/api-server/src/services/PredictionModel.ts` (loads ALL active prematch models — `kind × features_version` — on startup; routes first by tier, then prefers **v3** when draft + hero data + at least one team's account_ids available, else falls back to v2, then v1, then global fallback). Hero stats + matchup matrix + Wave 3 caches (player_hero_stats, recent_form-30d, h2h-365d) refreshed in-memory with separate TTLs (60min hero, 30min wave3).
- Hero feature builder — `artifacts/api-server/src/lib/hero-features.ts` (mirrored in `scripts/src/lib/`). 7 hero-derived features (`buildHeroFeatures`) + 4 Wave 3 extras (`buildExtraFeatures`: player_skill_diff, recent_form_diff, h2h_advantage_radiant, side_advantage=1).
- Calibration + tier utils — `artifacts/api-server/src/lib/{isotonic,tier}.ts` (mirrored in `scripts/src/lib/` for the trainer).
- ML inference (live) — `artifacts/api-server/src/services/LiveWinnerModel.ts` (loads active `kind='live_winner'` model; takes a snapshot + the prematch prob as a prior and outputs an updated P(R win)).
- Live model training script — `scripts/src/train-live-model.ts`.
- Live worker — `artifacts/api-server/src/services/LiveWorker.ts`.
- Scheduler — `artifacts/api-server/src/services/SchedulerWorker.ts`.
- Pinnacle scraper — `artifacts/api-server/src/services/PinnacleScraper.ts` (best-effort).
- Math models for 15 bet types — `artifacts/api-server/src/services/BetTypeModels.ts`. Wave 3.B: stage-aware FeatureVector с `stage`/`seriesScore1/2`. Map-уровневые маркеты условные на текущем счёте серии.
- Analytics orchestrator — `artifacts/api-server/src/services/AnalyticsEngine.ts`.
- Гуманизированное объяснение — `artifacts/api-server/src/routes/analytics.ts` → GET `/api/analytics/explain` (factors на русском + ориентиры по тоталам).
- Бэктест по реальным данным — `artifacts/api-server/src/routes/analytics.ts` → POST `/api/analytics/backtest` (читает `prematch_outcomes`, считает KPI, equity-кривую, бакеты по уверенности).

## API endpoints (полный список, контракт)

Public:

- `GET /api/healthz`
- `GET /api/matches/live` (cache 30s) — OpenDota + Stratz `/League/live` + PandaScore `/running` параллельно с 5s timeout, обогащено названиями лиг. Перерыв между картами помечается `between_maps:true`. Форма ответа: `{sources:[{source,data:[…]}]}`.
- `GET /api/matches/upcoming` (cache 60s) — PandaScore, обогащено названиями лиг. Форма: `{noData,data}`.
- `GET /api/matches/series-drafts?team1Id=&team2Id=[&currentMatchId=&currentMapNumber=]` (cache 60s, пустой не кэшируется) — драфты сыгранных карт live BO3-серии: live_snapshots ∪ pro_matches (12ч, dedupe) → match_drafts → OD fallback. Мобилка зовёт с вкладки «Драфт».
- `GET /api/bookmakers/for-match?team1=&team2=[&team1Id=&team2Id=]` — in-memory lookup букмекерского кэша.
- `GET /api/odds/dota2` — The Odds API (требует `ODDS_API_KEY`)
- `GET /api/odds/pinnacle/dota2` — Pinnacle scraper (best-effort)
- `POST /api/analytics/predict` — прогнозы по 15 рынкам
- `GET /api/analytics/explain?radiantTeamId=&direTeamId=` — гуманизированный обзор + тоталы
- `GET /api/analytics/totals-ladder?type=kills|duration&radiantTeamId=&direTeamId=&...` — ladder-линии ТБ/ТМ с вероятностью модели; на live центрируется вокруг проекции текущего темпа. Компонент мобилки `components/TotalsLadder.tsx`.
- `POST /api/analytics/backtest` — реальный бэктест по `prematch_outcomes`
- `GET /api/analytics/model-status` — активная ML-модель + статистика live-worker
- `GET /api/analytics/ml-predict?radiantTeamId=X&direTeamId=Y` — прямой ML-инференс
- `GET /api/analytics/scheduler-status`
- `GET/POST /api/analytics/popular-markets`
- `GET /api/teams/tier1?limit=50`, `GET /api/teams/search?q=`, `GET /api/teams/:id`
- `GET /api/client-config` (public, cache 60s) — динамический конфиг мобилки (`pollLiveSec` / `pollIdleSec` / `promoFieldEnabled` / `version`). Меняется из админки без рестарта.
- `GET /r/:code` (и `/api/r/:code`) — рефералки: 302 на `app_settings.ref_redirect_url` + лог клика в `ref_clicks`.

User auth (public, per-IP throttle 20/15min):

- `POST /api/auth/register|login|logout` — email/password, scrypt N=16384, stateless токен с HMAC `SESSION_SECRET`, TTL 30 дней. register принимает опц. `promoCode` (валидируется по `ref_codes`, невалидный молча игнорируется). Ответы register/login/me содержат `isAdmin`.
- `GET /api/auth/me` — `Authorization: Bearer <token>`.

Admin auth (public): `POST /api/admin/login { token }`, `POST /api/admin/logout`, `GET /api/admin/whoami`.

Admin (cookie-сессия `aegis_admin_session`):

- `GET/POST /api/admin/settings`, `GET /api/admin/metrics`, `POST /api/admin/retrain`, `POST /api/analytics/retrain`, `POST /api/admin/prune-snapshots`, `GET /api/admin/odds-status`, `GET /api/admin/scheduler/state`, `GET /api/admin/models`
- `GET /api/admin/users?q=` + `POST /api/admin/users/:id/admin {isAdmin}` — выдача/отзыв «Режима админ» мобилки (страница «Пользователи» в админке; `app_users.is_admin`; мобилка гейтит секцию «РАЗРАБОТКА (АДМИН)» и экран `/admin` по `isAdmin`).
- `POST /api/admin/refresh-all` — сбрасывает все withCache (matches:live/upcoming/heroes), workaround для застрявшего TTL.
- Рефералки: CRUD `ref_codes` + статистика кликов/регистраций + CSV-экспорт (BOM+`;`) + тумблер промо-поля — страница `/admin-web/sources`. Связанные колонки: `app_users.tariff` (default `free`) + `app_users.ref_code`.

## Логи (структурный JSON через pino) — реестр тэгов

Каждая запись имеет `tag` для фильтрации (пример grep: `grep '"tag":"bookmaker"'`).

| tag | где |
|---|---|
| `req`/`res` | `pino-http` middleware |
| `bookmaker` / `bookmaker-worker` / `matched` | букмекерские пайплайны |
| `cache` | `lib/responseCache.ts::withCache` |
| `predict` | `services/PredictionModel.ts` |
| `admin` | `routes/admin.ts` |
| `mobile` | `POST /api/client-logs` (мобильные ивенты через `services/logging/EventLogger.ts`, очередь `@dea_log_upload_queue`, флаш каждые 30s, батч 50) |
| `upstream` | `lib/loggedFetch.ts` (helper для будущих fetch'ей) |

## Admin & settings

- Глобальные runtime-флаги хранятся в `app_settings` (single row). Кэш 5s в `AppSettings.ts`.
  - `useBookmakerOdds` — default `true` (букмекерский UI включён через Bovada, см. Bookmakers roadmap ниже).
  - `liveSnapshotPruneDays` — default 7. Scheduler чистит `live_snapshots` ежедневно.
- Все `/api/admin/*` (кроме `/login`/`/logout`/`/whoami`) и `POST /api/analytics/retrain` требуют HttpOnly-сессию `aegis_admin_session`, выдаваемую `POST /api/admin/login { token }` (`timingSafeEqual` против `ADMIN_TOKEN`, брутфорс-троттл 10 попыток / 15 мин на IP, TTL 24h, in-memory store). Реализация — `routes/adminAuth.ts` (`requireAdminSession`). Legacy `X-Admin-Token` header удалён. В dev (NODE_ENV≠production) сессии дополнительно персистятся в `/tmp/aegis_admin_sessions.json` (mode 0600) и переживают рестарт dev-сервера; в prod — чисто in-memory.
- Web admin panel — артефакт `artifacts/admin-web` (React + Vite, slug `admin-web`, путь `/admin-web/`). Страницы: `/login`, `/` (dashboard: scheduler-state + активные модели + общие метрики + тогл OpenDota free/premium), `/coverage`, `/settings`, `/metrics`, `/models`, `/operations` (manual retrain + prune snapshots + odds-status), `/workers`, `/sources` (рефералки), `/users` (выдача «Режима админ» мобилки). UI на русском, амбер на тёмном фоне. Все вызовы — через сгенерированные хуки `@workspace/api-client-react` (контракт в `lib/api-spec/openapi.yaml`); `customFetch` глобально шлёт `credentials: 'include'`. На 401 из любой защищённой query — редирект на `/admin-web/login` через `QueryCache.onError`.
- `prematch_outcomes` — постоянный леджер прогнозов vs реальности. Не чистится — питает /admin/metrics и /api/analytics/backtest.

## Bookmakers roadmap

> **Статус 2026-07: букмекерский UI ВКЛЮЧЁН через Bovada** (200 OK с Replit-IP, без ключа).
> `BOOKMAKERS_ENABLED` дефолт = true. Маркеты Bovada: Moneyline (winner серии + Map 1/2),
> Total Maps, Under/Over Kills, Correct Score, Asian Handicap. НЕ покрыто Bovada:
> Total Duration, First Blood — для них только наш прогноз. 6 РФ-источников написаны
> по документации, с Replit заблокированы (DNS / Cloudflare / 404) — активируются
> автоматически с РФ-IP в проде (`PROXY_URL` — РФ-прокси). Pinnacle требует guest API key (нет).
> Текст ниже — историческое решение до включения Bovada.

Архитектурное решение, согласованное с пользователем: **до появления первых пользователей букмекерские кэфы НЕ подтягиваем и пикер букмекера в мобильном UI скрыт.**

Причины:
- Бесплатные/нестабильные источники (Pinnacle guest API, скрапинг 1xBet/Bet365) либо нарушают ToS, либо периодически отдают пустоту.
- Платные источники не оправданы пока нет MAU.

Текущее состояние:
- В мобилке скрыты: `BookmakerDropdown` в `app/(tabs)/index.tsx` и пикер букмекера в `app/match/[id].tsx` (комментарии `TODO(bookmakers)`). Бэкенд-логика оставлена нетронутой — включение это раскомментировать блок.
- Из алертов убраны `minOdds` / `minEdge` — пуши только по `minConfidence` модели.
- Бэкенд: `/api/odds/dota2`, `/api/odds/pinnacle/dota2`, `/api/bookmakers/*` остаются доступны (отдают `isMock: true` при провале), `useBookmakerOdds` флаг в `app_settings` остаётся в админке для будущего.

Когда появятся первые активные пользователи (план):
1. Подключаем платный источник кэфов (вероятно The Odds API Pro для старта).
2. В мобилке возвращаем пикер букмекера (раскомментировать блоки `TODO(bookmakers)`).
3. Тянем кэфы только по тем рынкам, где у нас обучена модель.
4. Включаем `useBookmakerOdds=true` в `app_settings`.
5. В алертах возвращаем `minEdge` как опциональный фильтр поверх `minConfidence`.

## Performance

- **Upstream response cache** — `lib/responseCache.ts` (in-process, single-flight, FIFO-evict at 256, opt-out via `shouldCache`). `/api/matches/live` cached 30s (skips when `isMock=true`), `/api/matches/upcoming` 60s, `/api/matches/heroes` 1h.
- **gzip/brotli** — `compression()` middleware в `app.ts`.
- **Trigram search index** — `pg_trgm` + GIN на `teams.name`/`tag`.
- **Known follow-up**: `PredictionModel.refreshWave3Data` загружает полные таблицы в память (~13k строк). План — лениво загружать по teamIds/accountIds текущей пары.

## Architecture decisions

- **DB-backed model registry**: model weights в `model_versions` (jsonb), не в файлах. `is_active` flag выбирает прод-модель.
- **Tier-routed prematch models (Wave 1)**: 4 активные модели — `prematch_winner_t1` (avg Glicko ≥1400), `_t2` (1200–1400), `_t3` (<1200) и fallback `prematch_winner`. Тиринг в `lib/tier.ts`.
- **Isotonic calibration (Wave 1)**: PAV на 10% holdout, бины в `model_versions.metadata.calibration`. Применяется через `lib/isotonic.applyCalibration`.
- **Two model kinds in one table**: `model_versions.kind` различает `prematch_winner*` и `'live_winner'`. Каждая `(kind, features_version)` пара имеет свой active flag.
- **Wave 2 — hero/draft features (v2)**: features_version=2, dim=12. Тренируется только на матчах с полным драфтом.
- **Wave 3 — player/form/h2h/side features (v3)**: features_version=3, dim=16. Требует `player_hero_stats` + `team_recent_form` + `team_h2h` + `account_ids` в драфтах.
- **Wave 3.A — BO3 staging**: `bo3_series` агрегирует прогресс серии; `BetTypeModels` принимает `stage`/`seriesScore`.
- **Wave 3.B — stage-aware bet types**: `predictMapWinner` добавляет ±2.5% momentum-бонус лидеру серии. `predictCorrectScoreAsBet` возвращает истинно-условные вероятности. `predictMapHandicap` считает P(финальная разница ≥2 карт) для каждой стороны независимо (negative-binomial).
- **Wave 3.D — derived-market models (baseline)**: `train:market-models` фитит per-tier log-normal на total_kills и total_duration, плюс base-rate + elo logit на first_blood. Хранится в `model_versions`. Инференс ещё не зашит в `BetTypeModels`.
- **`ingest:drafts` is v2-yield-targeted**: фильтрует pro_matches по teams с avg Glicko ≥ MIN_AVG_GLICKO=1200.
- **Hero matchup matrix anti-symmetric**: `buildHeroFeatures` смотрит direct, иначе inverse pair с `winRate → 1-winRate`.
- **Live draft extraction defensive**: `LiveWorker.extractDraftFromLive` предпочитает `team`, fallback на `team_slot` (поддержка обоих форматов 0–4/5–9 и 0–4/128–132). Отвергает payloads ≠ 5 уникальных героев на сторону.
- **Live model uses prematch as a prior**: features = `[bias, gameTimeNorm, nwLeadNorm, killDiffNorm, towerDiffNorm, logit(prematchProb)]`.
- **Live worker as in-process interval**: проще очереди, отключается через `DISABLE_LIVE_WORKER=true`.
- **Pinnacle scraper deliberately fails silent**.
- **Logistic regression baseline, not LightGBM**: pure JS, no native deps, retrain <1s.
- **Sliding 6-month training window**: `train-model.ts` фильтрует pro_matches за 180 дней. Scheduler хард-удаляет старее перед каждым ретрейном.
- **Favorite-team push (client-side)**: `notifyFavoriteTeamMatchStart()` в мобильном `NotificationService.ts` следит за live-poll и шлёт локальный `expo-notifications` алерт. Без серверного push-токен реестра.
- **bigint columns use `mode: 'number'`** в Drizzle schema.

## Gotchas

- ⚠️ **Stratz live: DORMANT** — `fetchLiveMatchDetailBatch()` закомментирован в
  `services/LiveWorker.ts` (upstream пуст с 2026-05-16: `live.matches`=[],
  `live.match(id)`=null). Код сохранён в `lib/stratzLive.ts` целиком; 5 полей
  `live_snapshots.stratz_*` остаются null. **Вернуть: раскомментировать блок `// DORMANT`**
  в LiveWorker.ts когда Stratz восстановит live ingest. Buyback/aegis/vision/teamfights —
  только через OD replay-parse (T0.7, post-mortem).
- ⚠️ Сравнения accuracy между retrain'ами **некорректны без поправки** на
  (a) drift test split (по времени), (b) LightGBM run-to-run variance ±2-3 п.п.
  на маленьких bucket'ах.
- **Quantile duration models** (LightGBM α=0.25/0.75) загружаются `MarketLgbm`
  параллельно с regression-моделями и экспонируются как `totalDurationLogQ25`/
  `totalDurationLogQ75` в `predictMarketsFor()` — непараметрический 50% interval.
- После правок `lib/db/src/schema/*` — `pnpm run typecheck:libs` ДО `pnpm --filter @workspace/api-server run typecheck`.
- После правок схемы — `pnpm --filter @workspace/db run push`.
- OpenDota: premium key 3000 req/min (50 req/s), неограниченно/месяц, $0.0001/req. Без ключа — free 60/min, 3000/day. Ingest-скрипты держат 10–20 req/s, оставляя запас под параллельные воркеры и live-poll.
- Training filter strict: матчи без teams в OpenDota team-ratings (~1000 ranked) дропаются. Из 2873 матчей ~610 с usable features.
- Ingest больше pages не поможет без расширения team ratings.
- LiveWorker пишет snapshot per match per minute. Растёт быстро — настраивай prune.
- После Wave 1 первый `train:model` создаёт 4 prematch модели вместо 1.
- Per-tier metrics в admin UI классифицируют по *текущим* рейтингам, не на момент prediction.
- `train-model.ts` требует `MIN_SAMPLES_PER_TIER=50`.
- `MIN_AVG_GLICKO=1200` дропает T3 — `prematch_winner_t3` намеренно не тренируется.
- v2 нужен критмасс `match_drafts` + `hero_stats`/`hero_matchups`.
- v3 дополнительно нужны `player_hero_stats` (`ingest:players-heroes`), `team_recent_form` (`compute:recent-form`), `team_h2h` (`compute:h2h`), и `match_drafts.account_ids` (re-run `ingest:drafts --backfill-accounts` для старых).
- BO3 stage-aware bet-type math ждёт `MatchInput.seriesContext`. Без него — fallback на map1 = старт BO3.
- `train:market-models` ещё не питает `BetTypeModels`.
- `ingest:hero-matchups` и `ingest:drafts` оба DB-resumable.
- Live-model training требует RESOLVED `prematch_outcomes`. На свежей системе — 1-2 недели OutcomeTracker.
- `/api/analytics/backtest` отдаёт `numberOfBets=0` пока в `prematch_outcomes` нет resolved строк — это норма на старте, не баг.

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
| `train:live-model` | Live-winner из `live_snapshots × prematch_outcomes` |
| `train:live-totals [-- --market kills\|duration\|all]` | LightGBM live-regression (T3.5): финальный total_kills / duration_sec из текущего снапшота. Feature view v1 (OD-only, 7 фич). Атомарный per-market swap |
| `backfill:live-snapshots [-- --limit N]` | Backfill из OpenDota `/api/matches/{id}` для пустых live-окон |
| `parse:request [-- --limit N --since-days D]` | T0.7 — `POST /api/request/{id}` ставит матчи в очередь OD replay-парсера. Идемпотентно через `match_parse_queue`. **OD FREE MODE (2026-07): 60 req/min, 3000 req/day, троттл 1100ms через `odThrottleMs()`. Premium включается парой `OPENDOTA_USE_PREMIUM=true` + `OPENDOTA_API_KEY`.** Дефолт 500 матчей, окно 180d |
| `ingest:parsed [-- --limit N --timeout-hours H]` | T0.7 — для матчей в queue (status='queued', age>90s) тянет `/matches/{id}`, при `version!=null` сохраняет players/objectives/teamfights/draftTimings в `match_parsed`, отмечает `pro_matches.is_parsed=true`. **20 req/s (50ms throttle).** После 2h в queued → `status='timeout'` |

**Required env:** `DATABASE_URL`. **Optional:** `ODDS_API_KEY`, `STRATZ_TOKEN`,
`PANDASCORE_API_KEY`, `PINNACLE_GUEST_API_KEY`, `ADMIN_TOKEN`, `DISABLE_LIVE_WORKER`,
`DISABLE_SCHEDULER`, `DISABLE_AUTO_RETRAIN` (killswitch для фазы тренировки),
`AUTO_RETRAIN_CRON_HOUR_UTC` (P5 safety: целое 0..23 — обучение разрешено
ТОЛЬКО в этот час UTC; если не задан — открыто всегда при снятом killswitch.
На Replit оставляем `DISABLE_AUTO_RETRAIN=true`, на ноуте: kill снят +
`AUTO_RETRAIN_CRON_HOUR_UTC=4` (~7 утра МСК), чтобы тренировка не конкурировала
с cron-workflow'ами ingest), `BOOKMAKERS_ENABLED` (default true),
`PROXY_URL` (РФ-прокси для букмекеров с не-РФ IP), `AUTO_DB_PUSH=false`,
`SESSION_SECRET` (обязателен для admin + user-auth токенов),
`ML_SERVICE_URL` (default `http://localhost:8090`), `ML_SERVICE_TOKEN` (иначе ml-service пишет ephemeral в `/tmp/aegis_ml_token`).

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
  ⚠️ **Stratz live: DORMANT** — `fetchLiveMatchDetailBatch()` закомментирован в
  `services/LiveWorker.ts` (upstream пуст с 2026-05-16: `live.matches`=[],
  `live.match(id)`=null). Код сохранён в `lib/stratzLive.ts` целиком; 5 полей
  `live_snapshots.stratz_*` остаются null. **Вернуть: раскомментировать блок**
  `// DORMANT` в LiveWorker.ts когда Stratz восстановит live ingest.
  Buyback/aegis/vision/teamfights — только через OD replay-parse (T0.7, post-mortem).
- **Match-winner model** (LightGBM v3 + LR fallback, маршрутизация по tier и
  наличию draft + account_ids). Историческую метрику и обзор фичей см.
  `docs/ml-feature-audit.md` и `docs/changelog.md`. ⚠️ Сравнения acc между
  retrain'ами **некорректны без поправки** на (a) drift test split (по времени),
  (b) LightGBM run-to-run variance ±2-3 п.п. на маленьких bucket'ах.
- **15 mathematical models** для derivative markets (FB, total_kills, total_duration
  ± q25/q75 квантили).
- **Bookmaker odds aggregation** — Bovada работает с Replit-IP; 6 РФ-источников
  написаны по документации, активируются автоматически с РФ-IP в проде.
- **Тоталы (kills/duration)** показываются ladder-UI (несколько линий ТБ/ТМ).
  Эндпоинт `/api/analytics/totals-ladder?type=kills|duration&radiantTeamId=&direTeamId=&...`
  отдаёт массив линий с вероятностью модели; на live центрируется вокруг проекции
  текущего темпа. Компонент `components/TotalsLadder.tsx`.
- **Quantile duration models** (LightGBM α=0.25/0.75) загружаются `MarketLgbm`
  параллельно с regression-моделями и экспонируются как `totalDurationLogQ25`/
  `totalDurationLogQ75` в `predictMarketsFor()` — непараметрический 50% interval.

### API endpoints (контракт)

- `GET /api/matches/live` (cache 30s) — OpenDota + Stratz `/League/live` + PandaScore `/running` параллельно с 5s timeout. Перерыв между картами помечается `between_maps:true`.
- `GET /api/matches/upcoming` (cache 60s) — PandaScore.
- `GET /api/bookmakers/for-match?team1=&team2=[&team1Id=&team2Id=]` — in-memory lookup букмекерского кэша.
- `POST /api/auth/register|login|logout` (register принимает опц. `promoCode` — валидируется по `ref_codes`, невалидный молча игнорируется), `GET /api/auth/me Authorization: Bearer <token>` — email/password auth, scrypt N=16384, stateless токен с HMAC SESSION_SECRET, TTL 30 дней. Per-IP throttle 20/15min.
- `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/whoami` — HttpOnly session cookie `aegis_admin_session` против `ADMIN_TOKEN`. Все `/api/admin/*` и `POST /api/analytics/retrain` требуют этой сессии.
- `POST /api/admin/refresh-all` — сбрасывает все withCache (matches:live/upcoming/heroes), workaround для застрявшего TTL.
- `GET /api/client-config` (public, cache 60s) — динамический конфиг для мобилки (`pollLiveSec` / `pollIdleSec` / `promoFieldEnabled` / `version`). Меняется из админки без рестарта.
- **Рефералки (T005):** `GET /r/:code` (и `/api/r/:code`) — 302 на `app_settings.ref_redirect_url` + лог клика в `ref_clicks`. Админка `/admin-web/sources`: CRUD `ref_codes`, статистика кликов/регистраций, CSV-экспорт (BOM+`;`), тумблер промо-поля. `app_users.tariff` (default `free`) + `app_users.ref_code`.

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

## Логи (структурный JSON через pino)

Каждая запись имеет `tag` для фильтрации. Полный реестр тэгов и примеры grep —
`docs/architecture.md`. Краткая таблица:

| tag | где |
|---|---|
| `req`/`res` | `pino-http` middleware |
| `bookmaker` / `bookmaker-worker` / `matched` | букмекерские пайплайны |
| `cache` | `lib/responseCache.ts::withCache` |
| `predict` | `services/PredictionModel.ts` |
| `admin` | `routes/admin.ts` |
| `mobile` | `POST /api/client-logs` (мобильные ивенты через `services/logging/EventLogger.ts`, очередь `@dea_log_upload_queue`, флаш каждые 30s, батч 50) |
| `upstream` | `lib/loggedFetch.ts` (helper для будущих fetch'ей) |

## Pointers

- **`.env.example`** — ⭐ шаблон ВСЕХ env-переменных с инструкциями где взять
  значения (значения секретов агенту недоступны — копирует владелец из Tools → Secrets).
- **`docs/laptop-deploy.md`** — ⭐ инструкция переезда с Replit на ноут
  (Шаг 0 «чистая установка», systemd-юниты, crontab, чек-лист). Читать перед миграцией.
- **`docs/rustore-release.md`** — ⭐ выкатка мобилки в RuStore (keystore, EAS,
  модерация, чек-лист).
- **`docs/migration-replit.md`** — перенос проекта на другой Replit-аккаунт
  (секреты, восстановление БД из `backups/aegis-db.part-*.gz`).
- **`docs/business.md`** — ⭐ бизнес-описание для не-инженеров.
- **`docs/technical-overview.md`** — ⭐ краткий тех-обзор для новых инженеров.
- **`docs/system-map.md`** — ⭐ системная карта связей: источники → таблицы → фичи →
  модели → рантайм. **Агент обязан читать перед любой архитектурной правкой.**
- **`docs/architecture.md`** — полная архитектура: эндпоинты, admin & settings,
  Bookmakers roadmap, performance, decisions, gotchas, полный реестр log-тэгов.
- **`docs/ml-feature-audit.md`** — текущий аудит фичей и моделей по бакетам.
- **`docs/model-improvements-research.md`** — план улучшений ML.
- **`docs/changelog.md`** — историческая хронология крупных изменений.
- **`threat_model.md`** — модель угроз для security-сканов.
- См. skill `pnpm-workspace` — структура монорепо, TypeScript, project references.

## Roadmap (active)

> Полная история (Phase 0-10, T0→T12 milestones, retrain'ы, mobile UI waves,
> infra) — `docs/changelog.md`. Здесь только PENDING.

- **Фаза 9 баг-фиксы (in progress).** P0: F7 (Bovada events=0), F8 (e2e
  алертов). F1/F2/F3 уже в коде (см. комментарии «F1/F2 (Phase 9)» в
  `(tabs)/index.tsx` + `href: null` для backtest в `(tabs)/_layout.tsx`) —
  нужно прогнать e2e на эмуляторе. **F9 DONE 2026-05-19** — `MarketLgbm`
  timeout 200 → 1500ms + AbortError не trip'ает circuit (см. `docs/changelog.md`).
  Средние (P1): F4 (Сравнение коэф. рендерит имена вместо ТБ/ТМ), F5 (matchId
  не доходит до match-summary), F6 (team-compare все «—»).
- **Mobile/UI без ML-зависимости:**
  - EV-merge на фронте — matching событий букмекеров к `pro_matches`, полный
    охват маркетов (winner/totals/firstBlood) для всех букмекеров.
  - Backtest UI скрыт (`href: null`) — раскроем когда `prematch_outcomes` ≥ 200
    и UX будет готов.
- **Live-winner на LightGBM** — перенести когда `live_snapshots × prematch_outcomes` ≥ 200.
- **Принципы каждой фазы:** ingest до ~100% покрытия → одна выборка 365d →
  обучение → активация. Никаких фейк-данных в UI. Каждая фаза — явный «да».

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
  метрики (2026-05-14): LightGBM v3 fallback test_acc=79.5% brier=0.160; LR v3
  fallback acc=78.5% brier=0.162. Live-винер lr-live-v8: acc=70.5% vs прематч
  baseline 55.2% (Δ=+15.3 п.п.).
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

### UX поведение списка (DONE 2026-05-14, v2)

`fetchLiveData(cbs)` поддерживает прогрессивную отрисовку с параллельным
обогащением и ordered emission:

1. **Сразу после `/api/matches/live` + `/api/matches/upcoming`** колбэк `onShellsReady`
   получает «скелеты» матчей (live + prematch) — карточки появляются в UI мгновенно,
   без ожидания ML-предсказаний. Под карточками без прогноза `MatchCard.tsx` показывает
   плейсхолдер «Данные собираются, скоро выдадим прогноз» с ActivityIndicator.
2. **Bounded parallel pool (concurrency=3)** обогащает одновременно live + prematch.
   Воркеры берут jobs из общей очереди (live первыми, prematch следом). Прематч-предикты
   кэшируются на сервере 4 часа (`predict:prematch:${matchId}:${t1}:${t2}:${format}`),
   поэтому повторные refresh почти бесплатны.
3. **Ordered emission**: `onMatchEnriched(em, i)` вызывается строго в порядке index
   (через буфер `results[]` + `nextEmit`). Быстрые прематчи могут завершиться раньше
   медленного live, но UI обновляется сверху вниз — UX-инвариант «первая карточка
   обновляется первой» сохраняется.
4. **AbortSignal**: при новом `loadData` (interval / pull-to-refresh) старый цикл
   отменяется; внутри fetchAnalytics локальный 5s timeout + поддержка внешнего signal.

Сервер: `/api/matches/live` опрашивает OpenDota + Stratz `/League/live` + PandaScore
`/running` параллельно (5s timeout), кэш 30с. PandaScore работает как fallback, если
OpenDota упал. `/api/matches/upcoming` — PandaScore, кэш 60с.

**BookmakerWorker (DONE 2026-05-14, smart wake-up 2026-05-15):**
`services/BookmakerWorker.ts` — фоновый поллер букмекеров с тремя режимами,
выбираются на каждом tick'е:
- **live** — есть ≥1 live pro-матч → next tick через 3 мин
- **wake_for_start** — live=0, ближайший upcoming стартует <60 мин → next tick на
  `(begin_at + 30s)` (30s буфер на индексацию live API)
- **idle** — live=0 и нет upcoming в окне 60 мин → next tick через 60 мин

Воркер **полностью автономен** — не зависит от трафика клиентов. Делает loopback
`fetch` к `/api/matches/live` и `/api/matches/upcoming` (через withCache, так что
сам прогревает общий кэш для будущих запросов клиентов; никакой дублирующей
upstream-нагрузки). Первый tick через 5s после старта (Express должен подняться).
Per-source ошибки букмекеров скипаются silently (берём что собрали).

ENV: `DISABLE_BOOKMAKER_WORKER=true` отключает. `BOOKMAKERS_ENABLED=false`
тоже отключает. Stats: `GET /api/bookmakers/status` возвращает `worker: { startedAt,
lastTickAt, lastMode, lastIntervalMs, lastDurationMs, lastSources[], ticks, errors }`.
Лог: `[bookmaker-worker] tick complete` с mode/liveMatches/intervalMs/sources.

**Per-match lookup:** `GET /api/bookmakers/for-match?team1=X&team2=Y[&team1Id=&team2Id=]`
— один in-memory lookup из кэша воркера для конкретной пары команд, корректно
обрабатывает flip ориентации (winner / firstBlood). Skip silently: если ни один
источник не имеет события — `{ found:false, sources:[] }`. Мобилка может дёргать
параллельно для каждого отображаемого матча — нет апстрим-нагрузки. Когда РФ-IP
хотя бы один из 6 РФ-источников начнёт отвечать — данные автоматически
подтянутся для всех отображаемых пар без правок кода.

**Live-воркер dedup (DONE 2026-05-14):** `LiveWorker.pollOnce` хеширует
game_time + scores + radiant_lead + building_state + draft (sorted heroes/accounts)
и пропускает матчи, у которых хеш не изменился с прошлого poll'а — снапшот не
пишется, ML не считается (детерминистическая модель → тот же результат). In-memory
`Map<matchId,hash>` чистится от завершённых матчей каждый тик. Stat
`skippedUnchanged` в `getWorkerStats()`. Без этого на каждый 60s-tick OpenDota
со stale-данными (пауза в матче, апстрим лагает) тратили CPU и плодили дубликаты
в `live_snapshots` / `predictions`.

## User preferences

- Язык интерфейса — русский
- Pinnacle парсим самостоятельно, без платного API (пользователь предупреждён про ToS)
- Не предлагать Reserved VM деплой пока пользователь не попросит
- Не платить за The Odds API на этом этапе
- Букмекерский UI включён через **Bovada** (200 OK с Replit-IP, без ключа). Все 6 РФ-буков с
  Replit заблокированы (DNS / Cloudflare / 404), Pinnacle требует guest API key (нет).
  `BOOKMAKERS_ENABLED` дефолт = true (opt-out через `=false`). Маркеты Bovada: Moneyline
  (winner серии + Map 1/2), Total Maps, Under/Over Kills, Correct Score, Asian Handicap.
  НЕ покрыто Bovada: Total Duration, First Blood — для них только наш прогноз.
- `/api/bookmakers/matched/dota2` — fuzzy-match букмекерских ивентов с `teamsTable`
  (по нормализованному имени + tag), группировка по упорядоченной паре team_id.
- Admin кнопка «Обновить приложение» (`POST /api/admin/refresh-all`) сбрасывает
  все withCache (`matches:live`, `matches:upcoming`, `matches:heroes`) — workaround
  для dev/Replit-окружения, где TTL может «застрять» без live-нагрузки.
- Алерты — только по `minConfidence` модели; `minEdge`/`minOdds` вернутся вместе с букмекерским UI
- При проблемах с данными приоритет — показать актуальные матчи; ML-скоринг догружается
  сверху прогрессивно. Лимиты OpenDota тратим в первую очередь на то, что сейчас
  отображается у пользователя (live drafts), батчевые ingest'ы — фоном.

## Логи (для прод-дебага)

Сервер пишет structured JSON через pino. Каждая запись имеет `tag` для фильтрации:

| tag | где | поля |
|---|---|---|
| `req`/`res` | `pino-http` middleware | method, url, statusCode, responseTime |
| `bookmaker` | `routes/bookmakers.ts::fetchSource` | source, events, durationMs, err |
| `bookmaker-worker` | `services/BookmakerWorker.ts::tick` | mode, liveMatches, intervalMs, durationMs, totalEvents, sources[] |
| `matched` | `GET /api/bookmakers/matched/dota2` | groups, eventsTotal, matchedToTeams, teamsLoaded, sourcesPolled |
| `cache` | `lib/responseCache.ts::withCache` | key, ttlMs, durationMs, hit/miss/coalesced/filled/cleared |
| `predict` | `services/PredictionModel.ts` | reason, radiantTeamId, direTeamId (для skip) |
| `admin` | `routes/admin.ts` | action: refresh-all и др. |
| `mobile` | `POST /api/client-logs` | type, eventName, screenName, sessionId, anonymousId, appVersion, platform |
| `upstream` | `lib/loggedFetch.ts` | host, path, status, durationMs, bytes (новый helper, использовать для будущих fetch'ей) |

Mobile (`services/logging/EventLogger.ts`) сохраняет события в `AsyncStorage`
**и параллельно** ставит их в очередь `@dea_log_upload_queue`. Каждые 30s
`flushLogQueue` шлёт батчи (до 50) в `POST /api/client-logs` — все мобильные
ивенты приходят в общий поток server pino. Старт: `startLogUploader()` в
`AppContext.useEffect` после `initLogger()`. Если бэк недоступен — батч
возвращается в очередь.

Пример фильтрации прод-логов:
```bash
# все запросы букмекеров с длительностью
grep '"tag":"bookmaker"' logs.json | jq '{source, events, durationMs, err}'
# что мобилки делали в проде
grep '"tag":"mobile"' logs.json | jq '{eventName, screenName, sessionId}'
# проблемные кэши (часто miss)
grep '"\\[cache\\] miss"' logs.json | jq '.key' | sort | uniq -c
```

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

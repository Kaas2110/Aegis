# Aegis — Changelog

Историческая хронология крупных изменений. Свежее — сверху. Актуальный snapshot
проекта см. в `replit.md`. Подробная архитектура — `docs/architecture.md`.

## 2026-05-14 — Live drafts enrichment + icons

OpenDota `/api/live` пики/баны не отдаёт, но `/api/matches/{id}` возвращает
`picks_bans` уже на стадии драфта (до старта матча) и обновляет их по ходу.
В `routes/matches.ts` добавлен `enrichLiveMatchesWithDrafts`:

- Параллельный фетч (concurrency=4) `/matches/{id}` для всех pro-live с валидным `match_id`.
- Per-match in-memory cache 60s + bounded LRU 200 записей (~1MB макс).
- Hero names из `hero_stats` (lazy cache 1h, fallback `Hero #${id}`).
- Маппинг team=0→radiant, team=1→dire; раздельные массивы picks/bans.
- Fail-soft: упавший фетч → матч без `draft`, UI показывает «Драфт ещё не стартовал».
- На клиенте `LiveDataService.openDotaToMatch` собирает `Draft` объект; synergy/counter/scaling = 0.5.

**Icon fonts:** `@expo/vector-icons` (Feather/MaterialCommunityIcons/Ionicons) на вебе и
при первом старте на нативе нужно явно регистрировать через `useFonts({ ...Feather.font, ... })`
— без этого иконки рендерятся пустыми квадратами. Добавлено в `app/_layout.tsx`.

**Прогрессивная отрисовка списка матчей:** `fetchLiveData(cbs)` принимает колбэки
`onShellsReady` (карточки появляются мгновенно) и `onMatchEnriched` (ML-предсказания
прилетают по одному в порядке списка — первый матч обогащается первым).

## 2026-05-13 — Wave 5 ML quality

Реализованы 9 улучшений из deep-research-report. Все модели переобучены.

**Live-winner model fv=8:**
- Признаки расширены с 6 до 9: добавлены `is_real_live`, `has_draft`, `recency_days_norm`.
- Временно́й split с 1-day gap + composite score (brier + 0.3×logLoss) для champion selection.
- Test acc=80.2%, Δacc=+22.9pp vs prematch-only baseline, brier=0.145.
- LiveWinnerModel.ts: backward-compat с 6-весовыми моделями (dim-bounded dot product).
- LiveWorker.ts: передаёт `isRealLive=1`, `hasDraft`, `recencyDaysNorm=0`.

**Prematch team features 5→12 dim:**
- Новые: `radiant_side_logit` (logit(radiant WR), ≈+0.08), `recency_days_norm`,
  `series_type_norm` (BO1=0/BO3=0.5/BO5=1), `map_no_norm` (ROW_NUMBER по серии),
  `tier_t1`, `tier_t2`, `tier_t3` (OHE).
- Все 4 train-скрипта (train-model, train-lightgbm) и PredictionModel.ts обновлены.
- LightGBM v3 test: acc=78.5% brier=0.153; v3/t2: acc=78.9% brier=0.155.

**Quantile regression для total_duration:**
- ml-service: `task_type="quantile"` с `alpha` param (LGBMRegressor objective="quantile").
- 2 новые модели: `market_total_duration_q25` (α=0.25) и `market_total_duration_q75` (α=0.75).
- CLI alias `--market total_duration_quantiles` обучает оба за один вызов.

## 2026-05-12 — Live-snapshot backfill + patch-aware training

`live_snapshots` имеет колонку `source` ('live' | 'backfill'). Backfill-снапшоты не прунятся.

- **`backfill:live-snapshots`** — разовый/incremental backfill из OpenDota `/api/matches/{id}`.
  Rate-limit 1200ms/req (~50 матчей/мин). Идемпотентен.
- **Авто-обогащение в SchedulerWorker**: Phase 4.5 — перед `train:live-model` считает
  distinct snapshot-outcome пары. Если < 100 матчей — запускает backfill автоматически
  (--limit 300, ~6 мин).
- **`pruneLiveSnapshots`**: удаляет только `source='live'` строки.
- **`liveSnapshotPruneDays`** = 365 дней.

**Patch-aware training dataset:** `app_settings` хранит:
- `trainWindowDays` (default 365, 30–730) — макс. глубина истории.
- `trainMaxPatches` (default 4, 1–20) — макс. число последних патчей.
- `trainMinSamples` (default 1000, 50–100 000) — минимум для запуска обучения.
- Эффективная граница = `max(windowCutoff, patchCutoff)`. Передаётся во все 4 train-скрипта.

## 2026-05-11 — Production automation (Wave «C») + admin-web

**Auto schema bootstrap** при старте api-server: `ensureSchema()` спавнит
`pnpm --filter @workspace/db run push` если таблиц нет. Отключается `AUTO_DB_PUSH=false`.

**Cold-start retrain**: первый tick шедулера (T+30s) при `pro_matches < 100` запускает
full retrain pipeline сразу.

**Full retrain pipeline (15 шагов)** — при новом патче (через 7 дней) или раз в 30 дней.
Каждый non-critical шаг — в собственном `runScriptSafe`. Падает только при сбое
`ingest:teams`/`ingest:matches`/`train:model`. Все спавны имеют timeout (30 мин,
для compute — 10 мин), SIGTERM→SIGKILL escalation.

**Daily refresh** между full retrain'ами: teams + matches[5] + drafts + players-heroes
+ recent-form + h2h + player-glicko. Все non-fatal.

**Admin web:** артефакт `artifacts/admin-web` (React + Vite, slug `admin-web`,
previewPath `/admin-web/`). Страницы: `/login`, `/`, `/settings`, `/metrics`,
`/operations`. UI на русском, амбер-палитра.

**Admin auth:** `POST /api/admin/login { token }` сравнивает с `ADMIN_TOKEN` через
`timingSafeEqual` (троттл 10/15мин на IP) и выставляет HttpOnly-cookie
`aegis_admin_session` (24h). Все `/api/admin/*` через `requireAdminSession`.
Legacy `X-Admin-Token` header больше не принимается.

**Per-model retrain UI:** `POST /api/admin/models/retrain` (body `{script, label?, market?}`)
+ `runTrainScriptManual` с whitelist'ом скриптов/флагов. Hot-reload в память.

**Admin → внешние API-интеграции с override:** таблица `api_key_overrides (env_name PK, value)`.
`services/ApiKeysService.ts` — единый `getApiKey(name)` с in-memory кешем (TTL 30s) и fallback
ENV→override. `KNOWN_INTEGRATIONS` (11 записей с `howToGet` инструкциями).
Endpoints `GET/PUT /api/admin/integrations`.

**Букмекеры (6 источников):** Fonbet, Лига Ставок, PARI, BetBoom, 1xStavka, Olimp.bet.
Управляется ENV-флагом `BOOKMAKERS_ENABLED=true` (default false).
При выключенном флаге → HTTP 503. На РФ-проде включается без `PROXY_URL`.

## 2026-05-11 — Миграция из старого workspace

- Старый Postgres был внутренним и недоступен — DB пересобрана с нуля через
  `pnpm --filter @workspace/db run push`.
- Код восстановлен из public GitHub repo (`Kaas2110/Market-Edge`) поверх
  scaffold'ов monorepo.
- `ADMIN_TOKEN` перевыпущен (старый, утёкший в чате, инвалидирован).

## Wave 3 «proper» — per-player Glicko (DONE для v3 LR)

Таблица `player_ratings` (account_id PK, rating, rd, games, wins, last_match_*).
`compute:player-glicko` крутит Glicko-1 multi-opponent batch updates по
pro_matches × match_drafts (RD time-decay c=63, period=30d). 5-я v3-extra фича —
`player_glicko_diff = (avg(rad) − avg(dire)) / 200`. v3 dim 16 → **17**.

Активно: LR v3 (`prematch_winner` + `prematch_winner_t2`). LightGBM v3 пока
заблокирован объёмом данных (нужно ≥80 матчей с обоими полными account_ids).

## Wave 4 — ML upgrade → gradient boosting (DONE для prematch + derived markets)

- `artifacts/ml-service` (FastAPI + LightGBM + sklearn IsotonicRegression).
- `model_versions.engine` enum logreg|lightgbm + binary_blob bytea.
- Тренировка: 12 prematch jobs (3 fv × 4 buckets) + 3 market jobs.
- Inference: HTTP, 200ms timeout, 60s circuit-breaker per-domain, фолбэк на logreg.
- Per-(rId,dId) кеш market-предсказаний 60s.
- Wired в `routes/analytics.ts::popular-markets` (FB/totals override) и `totals-ladder`
  (per-line override через `probLogNormalOver`).

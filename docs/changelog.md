# Aegis — Changelog

Историческая хронология крупных изменений. Свежее — сверху. Актуальный snapshot
проекта см. в `replit.md`. Подробная архитектура — `docs/architecture.md`.

## 2026-05-16 — T0+T8 mini retrain после обогащения БД

Большая ML-итерация T0→T12. Сегодня закрыты T0 (audit), T1 (`ml-contract.md`),
T2 (`data-availability-rules.md`), T3-T7 spec (`ml-features-spec.md`), T12
(`replit.md` trim 313→168), параллельный трек обогащения БД (drafts 4017→5634,
players-heroes +24%, glicko 893→1093, recent-form/h2h/team-extended пересчитаны),
mini retrain всех 18 bucket'ов (LR×fv×tier + LGBM×fv×tier) с 5 новыми фичами:
`synergy_diff`, `early_game_score_diff`, `late_game_score_diff`,
`counter_bans_diff`, `player_hero_recency_diff` (HERO_DIM=11, EXTRA_DIM=6).

**SOTA после retrain:** `v3/prematch_winner` LGBM **76.8%** (baseline 57.9%),
`v3/prematch_winner_t2` LGBM **79.6%** (baseline 57.9%). Все новые фичи в
importance top-15 — ROI подтверждён.

**Знакомые риски:** `v3/t1` LGBM 60.5% vs LR 71.6% — overfit на 646 примерах,
маршрутизация сейчас предпочитает LGBM (−11 п.п. на t1). `v2/t1` LGBM 51.1% ниже
baseline 56.8% (overfit + drift). Для T8 (large retrain после T0.5/T0.7/T3-T7)
нужен bucket-level switch LGBM↔LR по cross-validated acc или отказ от LGBM на
маленьких bucket'ах. Полная таблица retrain — `docs/ml-feature-audit.md` §T8.

**Новые API хелперы (T2 §8):** `lib/availability.ts` на сервере и в mobile с
едиными константами `FRESH_MS/STALE_SOFT_MS/STALE_HARD_MS/LIKELY_ENDED_MS`
(90s/3min/25min/5min) и `getFieldState()` для 7-state UI. `_field_meta` и
between_maps timeout отложены до CL с T0.5 (одна сетевая правка).

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

## 2026-05-16 — T12: trim replit.md → changelog

В рамках большой ML-итерации (план T0→T12) сжали `replit.md` со 313 до ~140 строк.
Перенесены сюда DONE-блоки 2026-05-14 и 2026-05-15. В `replit.md` остался только
живой контракт: stack, скрипты, env, API-эндпоинты, user preferences, pointers,
активный roadmap.

## 2026-05-15 — Email-аутентификация (User-auth)

Добавлен User-auth (email + password) для мобильного клиента — Apple/Google
Sign-In появятся только после публикации в App Store / Play.

**Server (`routes/userAuth.ts`):**
- `POST /api/auth/register` { email, password } → 201 `{ token, user }`
- `POST /api/auth/login` { email, password } → 200 `{ token, user }`
- `POST /api/auth/logout` → 200 `{ ok: true }` (stateless, для логирования)
- `GET /api/auth/me` `Authorization: Bearer <token>` → `{ user }`

Пароли: `scrypt(N=16384, keylen=64)` из `node:crypto`, хранение `${salt}$${hash}`.
Токен: `${userId}.${expiresAtMs}.${hmacSha256(SESSION_SECRET)}` — stateless,
TTL 30 дней. Login защищён от timing side-channel (всегда тратим время на verify).
Per-IP throttle 20 попыток / 15 мин.

**DB (`lib/db/src/schema/users.ts`):** таблица `app_users` (id, email,
password_hash, created_at, last_login_at). Уникальный индекс по `lower(email)`.

**Mobile:** `services/AuthService.ts` (AsyncStorage обёртка), `context/AuthContext.tsx`
(`useAuth()` hook, гидратация токена + фоновый `/me` для проверки), `app/auth.tsx`
(login/register с переключателем mode), `app/index.tsx` (роутинг
`onboarding → auth → (tabs)`), карточка «Аккаунт» в `app/(tabs)/settings.tsx`
с email и кнопкой «Выйти».

ENV: `SESSION_SECRET` обязателен (используется и для admin-сессий).

## 2026-05-15 — Перерыв между картами + честные прогнозы

Серия BO3/BO5 после конца карты висит в "перерыве" 1–5 мин до старта следующей.
В это окно OD и PandaScore рассинхронизированы: OD ещё помнит прошлую карту
(может вернуть `game_time>0` и старый draft), PandaScore уже показывает новую
(`begin_at` будущее). Раньше UI видел "ЛАЙВ N:NN" со старыми героями и 50/50
прогнозом — пользователь не понимал, что происходит.

**Server (`routes/matches.ts`):** `enrichWithPandaScoreRunning` сравнивает OD live +
PS running с tolerance 60s. Если PS считает матч начавшимся, а OD ещё показывает
старую карту — ставим `between_maps: true` на OD-объекте. `psRunningToLiveShape`
(PS-only fallback) тоже проставляет `between_maps` если `begin_at > now`.
`enrichLiveMatchesWithDrafts` пропускает `between_maps:true` матчи (OD-драфт
принадлежит прошлой карте).

**Mobile:** `MatchStatus = 'live' | 'between_maps' | ...`. `MatchCard` рисует
пилюлю «ПЕРЕРЫВ» вместо «ЛАЙВ N:NN», скрывает counter. Detail header показывает
«ПЕРЕРЫВ» + score по картам (не по убийствам). Detail tab «Прогнозы» — «Прогноз
недоступен — перерыв». HomeScreen фильтр «Live» включает `between_maps`.
`NotificationService.isLiveLike` тоже включает `between_maps`.

## 2026-05-15 — Map_winner labelRu + честный draft

Три связанных бага: (1) на 3-й карте серии 1-1 рынок назывался «Победитель карты 1»
(сервер хардкодил mapNumber=1); (2) match_winner регулярно был 50/50 даже когда
ELO команд явно разный; (3) Draft Score block был полностью скрыт.

**Root cause 50/50:** `openDotaToMatch` в LiveDataService строил `draftFromOd` со
**stub-значениями 0.5/0.5** для synergy/counter/scaling/early. Мобилка слала их
в `/api/analytics/predict` как `draft.synergy1=0.5,...`, и
`BetTypeModels.predictMatchWinner` тянул вероятность к 50/50.

**Fixes:** `AnalyticsEngine.MatchInput.seriesContext` принимает `currentMapNumber`,
дефолт `s1+s2+1`. Мобилка шлёт `seriesContext` с `seriesScore1/2 + currentMapNumber`.
Мобилка **НЕ шлёт stub-draft**: если все 8 значений === 0.5, поле опускается → сервер
падает на чистый ELO + form + h2h. Detail screen: блок Draft Score показывает
ActivityIndicator + текст «Синергия и контрпики считаются на бэкенде — для этого
матча данные ещё не готовы».

TODO (future): реальные synergy/counter/scaling/early считать на бэке из
`hero_matchups` + `hero_stats` + draft picks (есть в схеме, не используется в
`/predict`). Тогда блок будет наполняться автоматически.

## 2026-05-14 — UX поведение списка (v2): прогрессивная отрисовка + ordered emission

`fetchLiveData(cbs)` поддерживает прогрессивную отрисовку с параллельным
обогащением и ordered emission:

1. После `/api/matches/live` + `/api/matches/upcoming` колбэк `onShellsReady`
   получает скелеты — карточки появляются мгновенно, без ML. Под карточками
   `MatchCard.tsx` показывает «Данные собираются, скоро выдадим прогноз».
2. Bounded parallel pool (concurrency=3) обогащает live + prematch одновременно.
   Прематч-предикты кэшируются на сервере 4 часа
   (`predict:prematch:${matchId}:${t1}:${t2}:${format}`).
3. Ordered emission: `onMatchEnriched(em, i)` вызывается строго в порядке index
   через буфер. UX-инвариант «первая карточка обновляется первой» сохраняется.
4. AbortSignal: новый `loadData` отменяет старый цикл; внутри fetchAnalytics
   локальный 5s timeout + поддержка внешнего signal.

## 2026-05-14 — BookmakerWorker (smart wake-up 2026-05-15)

`services/BookmakerWorker.ts` — фоновый поллер букмекеров с тремя режимами:
- **live** — есть ≥1 live pro-матч → next tick через 3 мин
- **wake_for_start** — live=0, ближайший upcoming <60 мин → next tick на `(begin_at + 30s)`
- **idle** — live=0 и нет upcoming в окне 60 мин → next tick через 60 мин

Воркер автономен, делает loopback `fetch` к `/api/matches/live` и `/upcoming` через
withCache. Первый tick через 5s после старта. Per-source ошибки скипаются silently.

ENV: `DISABLE_BOOKMAKER_WORKER=true` или `BOOKMAKERS_ENABLED=false` отключают.
Stats: `GET /api/bookmakers/status`. Лог: `[bookmaker-worker] tick complete`.

**Per-match lookup:** `GET /api/bookmakers/for-match?team1=X&team2=Y[&team1Id=&team2Id=]`
— in-memory lookup из кэша воркера, корректно flip ориентации (winner/firstBlood).
Когда РФ-IP — 6 РФ-источников начнут отдавать данные автоматически без правок кода.

## 2026-05-14 — Live-воркер dedup (skippedUnchanged)

`LiveWorker.pollOnce` хеширует game_time + scores + radiant_lead + building_state +
draft (sorted heroes/accounts) и пропускает матчи с неизменившимся хешем. In-memory
`Map<matchId,hash>` чистится от завершённых матчей каждый тик. Stat
`skippedUnchanged` в `getWorkerStats()`. Без этого на каждый 60s-tick OpenDota
со stale-данными плодились дубликаты в `live_snapshots` / `predictions`.

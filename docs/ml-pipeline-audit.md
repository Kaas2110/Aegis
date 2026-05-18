# ML Pipeline Audit — Aegis (2026-05-18)

> **Назначение:** единая карта «что у нас за ML живёт в проде, какие фичи он
> на входе получает, откуда они приходят, с какой частотой всё это
> срабатывает, где есть дыры». Документ — фотография на 2026-05-18 14:20 UTC.
> При любом изменении контракта моделей (новая фича, новый рынок, смена
> источника) — обновлять этот файл первым, до правки кода.
>
> **Главный принцип, ради которого этот документ написан:**
> **никогда не добавляем фичу в trainer, если в проде она не доступна на
> inference.** Любая фича в векторе модели должна иметь живой loader в
> `artifacts/api-server/src/lib/*` и реальное покрытие в БД ≥ X% активных
> команд / матчей. Иначе модель в проде получает нули и обучение «впустую».

---

## 0. TL;DR

| Что | Статус |
|---|---|
| Моделей в проде | **8** (4 prematch buckets, live_winner, 4 market'а) |
| Trainer ↔ Inference parity для текущего набора фичей | ✅ соблюдён (28 prematch + 9 live + 5 market + 7 live_totals) |
| LightGBM-сервис здоров | ✅ 200 OK на каждом /predict (~1 ms ответ из логов) |
| LiveWorker pulse | ✅ 30s tick, в последние 60 мин 29 snapshots / 4 матча |
| Stratz live | ⚠️ **DORMANT** — 0 stratz_* полей за час, как и ожидалось |
| Mobile polling | ✅ 60s на главном экране (`REFRESH_INTERVAL_MS = 60_000`) |
| prematch_winner_t3 (низкий tier) | ❌ **0 предиктов за 24h** — либо нет матчей t3, либо классификатор tier не размечает |
| E1 Stage 1 (36 новых фичей) | ✅ написано, **❌ wiring в prod НЕ выполнен** (правильно, ждём данных) |
| E1 покрытие team-level (`team_rosters` / `team_hero_pool`) | ⚠️ **70/286 активных команд = 24%** — критический gap |
| E1 покрытие player-level | 🟡 в процессе ingest'а (`player_counts` 70%, `player_wl_pro` 0%) |
| L-фичи (Phase 3) | ❌ не написаны ни в trainer, ни в inference |
| feature_X_missing_rate метрика | ❌ нет — нужно добавить до Stage 2 wiring |

**Самый серьёзный риск прямо сейчас:** если запустим E1 Stage 2 wiring до того
как добьём покрытие `team_rosters` + `team_hero_pool` до ≥80% активных команд,
то 76% prematch-инференсов будут содержать E1-фичи как **нули с тихим
fallback'ом**. Trainer обучится «нули = норма», и модель станет хуже текущей.

---

## 1. Inventory моделей (что физически крутится в проде)

Источник: `predictions` table за последние 24h, агрегация по model_version.

| Bucket | Engine (prod) | Где вызывается | Частота вызова | Использований за 24h | Статус |
|---|---|---|---|---|---|
| `prematch_winner_t1` | LightGBM (LR fallback) | `LiveWorker.ts:328` (по матчу) + `routes/analytics.ts:468` `/api/analytics/predict` | live worker 30s, route cache 4h | ~70 (mix lgbm+lr) | ✅ работает |
| `prematch_winner_t2` | LightGBM (LR fallback) | то же | то же | ~70 | ✅ работает |
| `prematch_winner_t3` | LightGBM (LR fallback) | то же | то же | **0** | ⚠️ не вызывался |
| `prematch_winner` (general) | LightGBM (LR fallback) | то же | то же | 0 | tier-bucket routing работает, общий не нужен |
| `live_winner` (v8) | LR (pure-JS) — LightGBM пока нет | `LiveWorker.ts:348` | 30s tick, только при game_time ≥ 60s | 199 | ✅ работает |
| `market_first_blood` | LightGBM | `MarketLgbm.predictMarketsFor()` через `PopularMarkets.ts` | по запросу `/api/analytics/popular-markets` | 0 предиктов отдельно (включён в общий ответ) | ✅ есть на бэке, на фронте таб FB |
| `market_total_kills` | LightGBM | то же | то же | ~190 (mix) | ✅ работает |
| `market_total_duration` (+q25, +q75) | LightGBM (3 модели) | то же | то же | в составе же | ✅ работает |
| `live_total_kills` | LightGBM | `LiveWorker.ts:284` per live snapshot | 30s tick | **369** | ✅ работает |
| `live_total_duration` | LightGBM | то же | то же | **369** | ✅ работает |

**Что НЕ существует** (важно для будущих фаз):
- LightGBM для live_winner (только LR) — L8 в Phase 3 plan.
- ML-модели для First Tower / First Roshan (только эвристики в `PopularMarkets.ts`).
- E1 wiring во всех 7 типах моделей (Stage 2, PENDING).

**`prematch_winner_t3` не вызывался за 24h** — нужно проверить:
1. Действительно ли в last 24h не было t3-матчей (низкий рейтинг команд)? `lib/tier.ts::classifyTier` смотрит средний Glicko, порог t3 — проверить какой.
2. Или классификатор всегда возвращает t1/t2 (баг)?
3. Action item: один SQL на агрегацию по tier'у за неделю + ревью `classifyTier()`.

---

## 2. Feature contracts (полная таблица)

### 2.1 Текущий prematch_winner v3 — 28 фичей

Источник истины:
- trainer: `scripts/src/lib/hero-features.ts` (`TEAM_FEATURE_NAMES`, `HERO_FEATURE_NAMES`, `EXTRA_FEATURE_NAMES`)
- trainer: `scripts/src/lib/team-extended.ts` (`EXTENDED_TEAM_FEATURE_NAMES`)
- inference mirror: `artifacts/api-server/src/lib/hero-features.ts` + `team-extended.ts` (✅ существуют, проверено)

| # | Имя фичи | Группа | Источник в БД | Inference fallback | Покрытие БД сейчас |
|---|---|---|---|---|---|
| 1 | `bias` | TEAM base | константа 1 | — | 100% |
| 2 | `winrate_diff` | TEAM base | `teams.wins / (wins+losses)` | skip predict если team нет / <5 игр | 100% (1013 teams) |
| 3 | `experience_diff` | TEAM base | `log(teams.wins+losses)` diff | skip | 100% |
| 4 | `is_high_tier` | TEAM base | derived из ratings | skip | 100% |
| 5 | `radiant_side_logit` | TEAM base | bias-derived (от тира) | 0 | 100% |
| 6 | `recency_days_norm` | TEAM base | `now − match.start_time` | 0 | 100% |
| 7 | `series_type_norm` | TEAM base | `match.series_type / 3` | 0.5 | 100% |
| 8 | `map_no_norm` | TEAM base | bo3_series lookup | 0 | 100% |
| 9-11 | `tier_t1/t2/t3` | TEAM base | one-hot из classifyTier | t2=1 | 100% |
| 12 | `streak_diff` (extended) | TEAM ext | `team_extended_features.win_streak` | 0 | **100%** (286/286 active) ✅ |
| 13 | `rest_days_diff` (extended) | TEAM ext | `team_extended_features.days_since_last_match` | 0 | 100% ✅ |
| 14 | `matches_30d_diff` | TEAM ext | `team_extended_features.matches_30d` | 0 | 100% ✅ |
| 15 | `avg_duration_30d_diff` | TEAM ext | `team_extended_features.avg_duration_sec_30d` | 0 | 100% ✅ |
| 16 | `fb_rate_30d_diff` | TEAM ext | `team_extended_features.first_blood_rate_30d` | **0.5 (mean)** | 100% ✅ |
| 17 | `side_pref_diff` | TEAM ext | `team_extended_features.radiant_winrate − dire_winrate` | 0 | 100% ✅ |
| 18 | `peer_synergy_diff` | TEAM ext | `team_extended_features.peer_synergy` | **0.5 (mean)** | 100% ✅ ⚠️ training-time leakage (см. 4.1) |
| 19 | `radiant_pick_strength` | HERO | `hero_stats.pro_win_rate` × 5 picks | 0 если нет драфта → v3 fallback to v1 | 100% (127 героев) ✅ |
| 20 | `dire_pick_strength` | HERO | то же | то же | 100% ✅ |
| 21 | `pick_strength_diff` | HERO | derived | — | 100% ✅ |
| 22 | `matchup_advantage` | HERO | `hero_matchups.win_rate` × 25 пар | 0 | 100% (16002 пар) ✅ |
| 23 | `radiant_meta_score` | HERO | `hero_stats.pro_pick_rate` × 5 | 0 | 100% ✅ |
| 24 | `dire_meta_score` | HERO | то же | то же | 100% ✅ |
| 25 | `ban_priority_diff` | HERO | `hero_stats.pro_pick_rate` × 14 банов | 0 | 100% ✅ |
| 26 | `synergy_diff` | HERO | `hero_synergy.win_rate` × 10 пар | 0 | 100% (15992 пар) ✅ |
| 27 | `early_game_score_diff` | HERO | `hero_stats.early_game_score` | 0 | 100% ✅ |
| 28 | `late_game_score_diff` | HERO | `hero_stats.late_game_score` | 0 | 100% ✅ |
| (29) | `counter_bans_diff` | HERO v2+ | `hero_matchups` фильтр | 0 | 100% ✅ |

**Покрытие на 286 командах last 30d:** 100% по всем фичам. Текущий prematch v3
в проде нормально получает все 28 фичей для актуальных матчей. Это здоровый baseline.

### 2.2 Текущий live_winner v8 — 9 фичей

| # | Имя | Источник | Inference fallback |
|---|---|---|---|
| 1 | `bias` | const 1 | — |
| 2 | `game_time_norm` | `live_snapshots.game_time_sec / 3600` | skip if <60s |
| 3 | `nw_lead_norm` | `live_snapshots.radiant_lead / 20000` | 0 |
| 4 | `kill_diff_norm` | `radiant_score − dire_score` | 0 |
| 5 | `tower_diff_norm` | popcount(`building_state` bitmask) | 0 (= 11-11) |
| 6 | `prematch_logit` | результат prematch_winner для этого матча | skip if prematch null |
| 7 | `is_real_live` | `source == 'opendota'` бул | 0 (мы всегда OD сейчас) |
| 8 | `has_draft` | бул, есть ли драфт в `match_drafts` | 0 |
| 9 | `recency_days_norm` | `now − start_time` | 0 |

**Покрытие:** все 9 фичей доступны при наличии живого OD-снапшота. Stratz live
поля (`xp_advantage`, `networth_advantage`) в текущем v8 **не используются**
(они есть в схеме, но 0 строк за час, и trainer их не включал) — это правильно
для DORMANT режима.

### 2.3 Market модели (FB / total_kills / total_duration ± q25/q75) — 5 team фичей

| # | Имя | Источник | Fallback |
|---|---|---|---|
| 1 | `bias` | const 1 | — |
| 2 | `elo_diff_norm` | `teams.rating` | **skip predict** если <5 игр |
| 3 | `winrate_diff` | `teams.wins/losses` | skip |
| 4 | `experience_diff` | `teams.wins/losses` | skip |
| 5 | `is_high_tier` | derived | skip |

**Покрытие:** 100% — все 286 active teams есть в `teams` (1013 шт. всего).
**Ограничение:** market модели «слепые» к драфту и к стилю команд — это и есть
точки роста через E1 wiring и L-фичи.

### 2.4 Live totals (live_total_kills, live_total_duration) — 7 фичей

| # | Имя | Источник | Fallback |
|---|---|---|---|
| 1 | `bias` | const 1 | — |
| 2 | `game_min` | `game_time_sec / 60` | skip |
| 3 | `kills_so_far` | `radiant_score + dire_score` | 0 |
| 4 | `kill_rate_per_min` | derived | 0 |
| 5 | `kill_diff_abs` | abs(radiant_score − dire_score) | 0 |
| 6 | `nw_lead_kgold` | `radiant_lead / 1000` | 0 |
| 7 | `building_state_norm` | popcount(building_state) / 22 | 0 |

**Покрытие:** 100% при наличии live snapshot. Работает.

### 2.5 E1 Stage 1 — **написано, НЕ подключено** (36 новых фичей)

Источник: `scripts/src/lib/e1-features.ts`. Зеркала в api-server **нет**
(`artifacts/api-server/src/lib/e1-features.ts` отсутствует).

| Builder | Где предлагается подключить | Размер вектора | Coverage gate (см. §3) |
|---|---|---|---|
| `buildE1PrematchFeatures` | prematch_winner v4 (как продолжение v3 → 28+18=46) | 18 | ⚠️ 24% команд имеют roster + hero_pool |
| `buildE1LiveWinnerFeatures` | live_winner v9 | 8 | ⚠️ зависит от roster |
| `buildE1KillsFeatures` | market_total_kills v2 | 2 | ⚠️ зависит от hero_benchmarks (100%) + roster (24%) |
| `buildE1DurationFeatures` | market_total_duration v2 | 4 | ⚠️ то же |
| `buildE1FbFeatures` | market_first_blood v2 | 2 | ⚠️ зависит от hero_item_popularity (100%) + roster (24%) |
| `buildE1LiveTotalsFeatures` | live_totals v2 | 2 | ⚠️ |

E1-таблицы (источники, см. `scripts/src/lib/e1-features.ts` imports):

| Таблица | Строк сейчас | Distinct keys | Coverage active teams/players (last 30d) | Freshness gate |
|---|---|---|---|---|
| `team_rosters` | 4 040 | 70 командных roster'ов | **70/286 = 24%** ⚠️ | 7d, 100% fresh |
| `team_hero_pool` | 13 836 | 70 команд × ~200 героев | **70/286 = 24%** ⚠️ | 7d, 100% fresh |
| `hero_benchmarks` | 127 | 127 героев × ~6 метрик | 100% (138 героев в игре) ✅ | weekly |
| `hero_item_popularity` | 127 | 127 героев | 100% ✅ | weekly |
| `pro_players` | 3 565 | 3 565 аккаунтов | n/a | weekly |
| `player_totals` | 146 925 | 5 203 аккаунта × ~28 метрик | покрытие зависит от roster | 14d |
| `player_counts` | 5 176 (растёт) | ~70% от 7406 | то же | 14d |
| `player_wl_pro` | **0** | 0 | **0%** ❌ | 14d, идёт STEP 17 |

**Главный вывод:** E1 готов на уровне «hero-level» (benchmarks, item_popularity)
сразу, но **player-level и team-level фичи зависят от ростера**, который есть
только у 70 из 286 активных команд. Если подключить wiring сейчас, 76% prematch
матчей получат для E1-компонентов вектор из нулей.

### 2.6 L-фичи Phase 3 — **не написаны** (ни в trainer, ни в inference)

| Тэг | Описание | Источник данных | Готов источник? | Кандидаты на bucket |
|---|---|---|---|---|
| L1 | Team Styles (агрессия, темп, объективы) | `match_parsed.teamfights/objectives` | ✅ 25k parsed | prematch v5, market_FB |
| L2 | Dynamic Form (exp-decay по recency) | `pro_matches` | ✅ | prematch v5 |
| L3 | Elo по фазам (lane/mid/late) | `match_parsed.players/objectives` | ✅ 25k parsed | prematch v5 |
| L4 | Hero pool/side bias | `team_hero_pool`, derived | ⚠️ только 70 команд | prematch v5 |
| L5 | Quantile live kills | `live_snapshots × pro_matches` | ✅ 33k snapshots | live_total_kills v2 |
| L6 | First Tower ML | `match_parsed.objectives` | ✅ | новая модель market_first_tower |
| L7 | Feature parity test | (диагностика, не фича) | n/a | — |
| L8 | Live-winner LightGBM | `live_snapshots × prematch_outcomes` | ✅ 33k × 7399 | новая live_winner LGBM |
| L9 | Stratz live recovery | Stratz API | ❌ DORMANT | live_winner / live_totals enrich |

---

## 3. Coverage в БД (живые числа на 2026-05-18 14:20 UTC)

### 3.1 Базовые таблицы фичей

| Таблица | Строк | Distinct entities | Active 30d coverage |
|---|---|---|---|
| `teams` | 1 013 | 1 013 | 286/286 (100%) ✅ |
| `team_extended_features` | 2 924 | 2 924 | **286/286 (100%)** ✅ |
| `team_recent_form` | 985 | 985 (period 30d only) | **286/286 (100%)** ✅ |
| `team_h2h` | 6 063 | пары | n/a |
| `hero_stats` | 127 | 127 героев | ≈100% (138 в игре) ✅ |
| `hero_matchups` | 16 002 | 138×138 ≈ 19k | 84% ✅ |
| `hero_synergy` | 15 992 | то же | 84% ✅ |
| `player_ratings` (Glicko) | 4 525 | 4 525 аккаунтов | зависит от account_ids в драфтах |
| `player_peers` | 429 271 | пары | хорошо |
| `player_hero_stats` | 295 279 | aggr | хорошо |

### 3.2 Активные матчи / парсинг

| Метрика | Значение |
|---|---|
| `pro_matches` total | 28 978 |
| `pro_matches` last 30d | (см. через SQL — но `team_extended_features.matches_30d_diff` уже покрыт 100%) |
| `pro_matches.is_parsed = true` | **25 341 (87%)** ✅ |
| `match_parse_queue` queued | 3 833 (выгребается) |
| `match_drafts` | 31 539 |
| `prematch_outcomes` | 7 399 (все resolved) ✅ |
| `live_snapshots` | 33 756 (last 1h: 29 для 4 матчей, all OD) |
| `predictions` last 24h | 1 154 (16 model versions × 4 markets) |

### 3.3 Свежесть E1 источников

| Источник | Fresh window | Свежих строк |
|---|---|---|
| `team_rosters` | 7d | 4 040 (100% свежие) |
| `team_hero_pool` | 7d | 13 836 (100%) |
| `player_totals` | 14d | 146 925 (100%) |
| `player_counts` | 14d | 5 176 (70%, идёт) |
| `player_wl_pro` | 14d | **0** (STEP 17 не запустился) |

---

## 4. Trainer ↔ Inference parity

### 4.1 Известная проблема: `peer_synergy` data leakage

**Где:** `train-lightgbm.ts:428` использует *текущий* `team_extended_features.peer_synergy`
для исторических матчей. Per-match roster tracking признан «слишком дорогим».

**Эффект на inference:** **нет**, в проде эта фича корректно читается из текущего
снапшота `team_extended_features`. **Эффект на обучение:** небольшое завышение
важности фичи (модель видит «синергию из будущего»), но т.к. ростеры команд
top-tier меняются медленно, эффект ограничен.

**Решение:** оставить как есть. Документировать в model_metadata.

### 4.2 Что НЕ протекает (хорошие новости)

- `recency_days_norm` — считается as-of-time правильно и в trainer, и в inference.
- Hero features — статичные по матчу (драфт фиксирован), нет leakage.
- live_winner.prematch_logit — корректно: live-модель видит результат prematch
  предикта как априорное, prematch не видит будущего live.

### 4.3 Mirror статус (api-server vs scripts)

| Файл в `scripts/src/lib/` | Mirror в `artifacts/api-server/src/lib/` | Статус |
|---|---|---|
| `hero-features.ts` | `hero-features.ts` | ✅ есть, идентичен (проверено diff'ом фич) |
| `team-extended.ts` | `team-extended.ts` | ✅ есть, идентичен (`peerSynergy` + `EXTENDED_TEAM_FEATURE_NAMES` совпадают) |
| `tier.ts` | `tier.ts` | ✅ есть |
| `isotonic.ts` | `isotonic.ts` | ✅ есть |
| `openDotaUrl.ts` | `openDotaUrl.ts` | ✅ есть |
| `e1-features.ts` | **отсутствует** | ❌ Stage 2 wiring PENDING |
| `odPace.ts` | отсутствует | n/a (используется только в ingest скриптах) |
| `stratz.ts` | `stratzLive.ts` (другое API) | n/a |

**Вывод:** для текущего набора фичей (28 prematch + 9 live + 5 market + 7 live_totals)
parity соблюдён, нет фич которые «есть в trainer и нет в inference».

### 4.4 prematch ↔ live изоляция (твоё главное опасение)

Проверено: **нет** фич, которые:
- считались бы из live-данных в trainer prematch модели → в проде получали бы 0.
- считались бы из prematch-only в trainer live модели → в проде ломались бы.

Единственная «кросс-модельная» связка: live_winner получает `prematch_logit` —
это **корректно** (live видит итог prematch как априорное знание).

---

## 5. Частоты и кэширование (полная карта пульса)

### 5.1 Воркеры (фоновые)

| Воркер | Файл | Интервал | Что делает | Пишет в БД |
|---|---|---|---|---|
| **LiveWorker** | `services/LiveWorker.ts:41` | **30s** (POLL_INTERVAL_MS) | Опрашивает OD `/live`, для каждого матча: snapshot → predict (winner+live_winner+live_totals) | `live_snapshots` + `predictions` |
| **BookmakerWorker** | `services/BookmakerWorker.ts:26` | **3 min** live / 60 min idle | Bovada + РФ-буки (РФ down) | `odds_snapshots` (сейчас 0) |
| **SchedulerWorker** | `services/SchedulerWorker.ts` | по cron (DISABLE_AUTO_RETRAIN=true в Replit) | retrain | `model_metadata` |
| **OutcomeTracker** | `services/OutcomeTracker.ts` | ~hourly | резолвит `prematch_outcomes.actual_*` | `prematch_outcomes` |

### 5.2 Mobile polling

| Экран | Файл | Интервал | Endpoint | Cache TTL |
|---|---|---|---|---|
| Главный (Лайв/Прогнозы) | `app/(tabs)/index.tsx:20` | **60s** | `/api/matches/live` + `/api/analytics/predict` × N | 30s / 4h |
| Прочие экраны | — | по пользователю (pull-to-refresh) | `/team-compare`, `/match-summary`, `/totals-ladder` | 60s / 30s / нет |

### 5.3 Cache TTL карта (полная)

| Ключ кэша | TTL | Где |
|---|---|---|
| `matches:live` | 30s | `routes/matches.ts:676` |
| `matches:upcoming` | 60s | `routes/matches.ts:846` |
| `matches:heroes` | 1h | `routes/matches.ts:895` |
| `match-summary:{id}` | 30s | `routes/analytics.ts:1445` |
| `team-profile:{id}` | 60s | `routes/analytics.ts:1360` |
| `team-compare:{a}:{b}` | 60s | `routes/analytics.ts:1383` |
| prematch predict | **4h** ⚠️ | `routes/analytics.ts:306` `PREMATCH_PREDICT_TTL_MS` |
| MarketLgbm internal | 60s | `services/MarketLgbm.ts:35` |
| Team data in PredictionModel | 15min | `PredictionModel.ts:160` |
| Hero data in PredictionModel | 60min | `PredictionModel.ts:161` |
| Wave3 (player ratings) | 30min | `PredictionModel.ts:174` |

**⚠️ Точка для внимания:** `PREMATCH_PREDICT_TTL_MS = 4h`. То есть если на матч
вышел драфт в 18:00, prematch предикт **зафризится до 22:00**. На фронте
пользователь увидит «устаревшую» вероятность. На live-моделях это не сказывается
(они считают каждые 30s). Решение для будущего: invalidate кэша по событию
«драфт изменился».

---

## 6. Mobile → API → DB поток (per-экран)

### 6.1 Главный экран (`/app/(tabs)/index.tsx`)

```
Mobile (60s tick)
  → GET /api/matches/live              [cache 30s]
       → in-memory cache HIT 95% случаев
       → MISS: параллельно OpenDota+Stratz+PandaScore /live (5s timeout)
            → merge + dedupe → cache → respond
  → для каждого матча параллельно:
       → POST /api/analytics/predict   [cache 4h per matchId]
            → PredictionModel.predict()
                 → loadTeam(r) loadTeam(d)          [15min cache]
                 → loadHeroes()                     [60min cache]
                 → loadExtended(r) loadExtended(d)  [15min cache]
                 → loadPlayerRatings (если account_ids) [30min cache]
                 → buildExtendedTeamFeatures(...)
                 → buildHeroFeatures(...)
                 → tier-classifier → bucket
                 → POST http://localhost:8090/predict (ml-service)
                      → LightGBM .predict → prob
                      → fallback к LR если timeout 200ms или circuit-breaker
                 → isotonic calibration
                 → INSERT predictions (+prematch_outcomes если первый раз)
            → return {prob, confidence, model_version}
       → GET /api/bookmakers/for-match  [in-memory lookup]
       → GET /api/analytics/popular-markets  [нет TTL, считает MarketLgbm]
       → GET /api/analytics/totals-ladder    [⚠️ баг F9: пустой массив]
```

### 6.2 Экран матча (`/match/[id]`)

```
Mobile (по тапу)
  → GET /api/analytics/match-summary?matchId=N  [cache 30s]   ← баг F5: id=undefined
  → GET /api/analytics/team-compare?...         [cache 60s]   ← баг F6: прочерки
  → GET /api/analytics/totals-ladder?...        [⚠️ баг F9]
  → GET /api/analytics/popular-markets?...
```

### 6.3 Live tick (бэк-сторона)

```
LiveWorker (30s tick)
  → fetch OD /live (5s timeout)
  → для каждого матча:
       → diff vs prev snapshot
       → INSERT live_snapshots (29 строк за час сейчас)
       → if isPrematch: PredictionModel.predictMatchWinner()
       → if game_time ≥ 60s: LiveWinnerModel.predict()
       → MarketLgbm.predictLiveTotalsFor() (live_total_kills + duration)
  → ❌ DORMANT: Stratz live enrich закомментирован
  → ❌ Stratz API recovery? — нужен ручной anti-DORMANT тест раз в неделю
```

---

## 7. Главный risk map (по приоритету)

### 🔴 RISK-1: Если запустим E1 Stage 2 wiring сейчас — модель деградирует

**Корень:** `team_rosters` / `team_hero_pool` = 70 из 286 активных команд (24%).
E1 `buildE1PrematchFeatures` для 76% матчей вернёт **18-мерный вектор нулей**
(потому что `TeamRostersMap.get(teamId)` вернёт `undefined` → loaders падают
в fallback 0). Trainer обучится «у этих 76% всё нули = норма», и предсказания
ухудшатся.

**Решение перед wiring'ом:**
1. **Догнать `team_rosters` / `team_hero_pool` до ≥80%** активных команд.
   Сейчас skрипт `ingest:od-team-rosters` фильтрует по `last_match_time < 365d`
   и делает ~3000 запросов. Проверить: почему только 70/286? Скорее всего
   фильтр слишком жёсткий (мелкие tier-3 команды отсечены).
2. **Или принять 76% gap осознанно** — но добавить отдельную фичу-флаг
   `has_e1_roster_data` (0/1), чтобы LightGBM сам решил «когда E1=0 — это
   "нет данных", а когда E1≠0 — реальный сигнал». Это технически правильнее
   чем тупо нули.
3. **Метрика `feature_X_missing_rate` обязательна перед wiring'ом** — иначе
   мы не увидим деградации в проде.

### 🔴 RISK-2: `player_wl_pro` = 0, STEP 17 не запустился

E1 player-level фичи частично зависят от `player_wl_pro` (pro-only WR за 180d).
Сейчас таблица пустая, STEP 17 в `Data Enrichment` ещё не дошёл (`player_counts`
бежит 70%, потом стартует wl_pro). После DONE — ещё 14d freshness gate.

**Решение:** дождаться окончания Data Enrichment workflow (~40 мин), потом
проверить покрытие. Если <50% активных pro-аккаунтов — расследовать.

### 🟡 RISK-3: `prematch_winner_t3` не вызывался за 24h

Либо нет t3-матчей (все Glicko < какого-то порога — норма для tier-1 турниров),
либо классификатор всегда отдаёт t1/t2. Проверить:

```sql
SELECT classify_tier_avg_glicko_for_each_match…  -- нужен код из tier.ts
```

Action: один прогон script'а `tsx -e "import {classifyTier}…"` на свежих 1k матчах.

### 🟡 RISK-4: Нет метрики «фича в N% инференсов = fallback»

Сейчас если у команды нет `team_extended_features`, мы тихо подставляем
`fb_rate_30d_diff = 0.5`, `peer_synergy_diff = 0.5`. В логах есть отдельные
`logger.info({ used: 'player-glicko-fallback' })`, но **нет агрегата**.

**Что добавить:** `services/FeatureCoverageMetrics.ts` — счётчики per-feature,
per-bucket, экспонируются в `/api/admin/metrics`. Это нужно сделать **до** E1
Stage 2 wiring, чтобы видеть деградацию сразу.

### 🟡 RISK-5: `PREMATCH_PREDICT_TTL_MS = 4h` — слишком долго

Драфт может закрыться через 5 минут после открытия лобби, и за это время
вероятность сместится с 50/50 на 70/30. Текущий кэш заморозит первый предикт
на 4h.

**Решение:** уменьшить до 5-10 минут, или сделать ключ кэша зависимым от
`draftHash` (если есть драфт — другой ключ).

### 🟢 NO-RISK: Stratz live DORMANT

Подтверждено: 0 stratz_xp/stratz_nw за час, 0 строк с `source='stratz'` в
last_1h live_snapshots. Текущая live_winner v8 их не использует. **Безопасно.**

### 🟢 NO-RISK: Trainer/Inference parity для текущего набора

28 prematch + 9 live + 5 market + 7 live_totals = все 49 фичей текущего prod
имеют валидный mirror в api-server. Никаких «фантомных» фич, которые трейнер
видит, а inference нет.

---

## 8. Action items (приоритезированный список ДО запуска Фазы 3 ML)

### P0 — обязательно перед любым retrain'ом
1. **Добавить `services/FeatureCoverageMetrics.ts`** — счётчики per-feature
   per-bucket. Экспонировать в `/api/admin/metrics/feature-coverage`. Бэз этого
   мы Stage 2 wiring запускаем вслепую.
2. **Расширить ingest `od-team-rosters` / `od-team-hero-pool`** или ослабить
   фильтр `last_match_time < 365d` → разобраться почему 70/286 покрытие.
3. **Дождаться STEP 17 `ingest:od-player-wl-pro`** (≤ 40 мин), пересчитать
   покрытие.
4. **Проверить `prematch_winner_t3`** — один SQL по tier'у активных матчей.

### P1 — желательно до Stage 2 wiring
5. **Уменьшить `PREMATCH_PREDICT_TTL_MS` до 5-10 минут** или сделать
   `draftHash`-зависимый ключ.
6. **Добавить admin endpoint `/api/admin/pipeline-health`** — единая точка
   видеть: «LiveWorker last tick ago=X, live_snapshots last_1h=Y, predictions
   last_1h=Z, feature_coverage_per_bucket={...}». Альтернатива — расширить
   существующий `/api/admin/workers`.

### P2 — после wiring
7. **L7 (feature parity test)** — diagnostic script сравнивает вектор фичей
   trainer vs inference на 100 рандомных матчах. Падает если расхождение > 1e-6.
8. **Регулярный anti-DORMANT тест Stratz** раз в неделю (cron) — пинг
   `live.matches` + `live.match(id)`, при ненулевом ответе шлёт алерт.

---

## 9. Что НЕ нужно делать прямо сейчас

- **НЕ запускать `train:lightgbm` / `train:market-models` / `train:live-*`** до
  выполнения P0 + явного «да» от пользователя.
- **НЕ подключать E1 Stage 2 wiring** до выполнения P0.1 (метрики) + P0.2
  (покрытие roster) + P0.3 (wl_pro).
- **НЕ раскомментировать Stratz live в `LiveWorker.ts`** до anti-DORMANT
  recovery (текущая проверка: ответ Stratz `live.matches` пустой).
- **НЕ менять `peer_synergy` логику** — задокументированная training-time
  leakage, в inference корректна.

---

## 10. Ссылки

- `replit.md` → секция «E1 OD-расширение» (карта датасетов моделей)
- `docs/ml-feature-audit.md` (T0 фотография, исторический контекст)
- `docs/changelog.md` (история retrain'ов)
- `scripts/src/lib/e1-features.ts` (Stage 1 implementation)
- `scripts/src/lib/hero-features.ts` (источник истины HERO/EXTRA dim)
- `scripts/src/lib/team-extended.ts` (источник истины EXTENDED_TEAM dim)
- `lib/db/src/feature-view.ts` (FEATURE_VIEW constants)
- `artifacts/api-server/src/services/{PredictionModel,LiveWinnerModel,MarketLgbm,LiveWorker}.ts`

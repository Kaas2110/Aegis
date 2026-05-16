# ML Feature Audit — Aegis (T0)

Документ-фотография текущего состояния ML на 2026-05-16. Это фундамент для всех
последующих фаз (T0.5 Stratz live → T0.7 OpenDota parse → T1 ml-contract →
T3 series momentum → T4 form → T5 ELO-decomposition → T6 styles → T7 hero
pool/side → T8 train A/B → T9 results).

> **Главное открытие:** маршрутизация моделей сейчас **не «v1/v2/v3 по доступности
данных»**, как было в моей голове, а **«по тиру турнира» (t1/t2/t3 + общий
fallback)**. Версии v1/v2/v3 — это **версии feature-set'а** (base / +draft /
+extra), и на проде везде используется v3 с graceful degradation полей при их
отсутствии (например, если account_ids неизвестны — соответствующие фичи NaN,
LightGBM сам справляется).

---

## 1. Маршрутизация моделей (как сейчас)

### Match-winner (prematch)

```
inbound match → classifyTier(team1, team2) → t1 | t2 | t3 → выбор bucket'а:
  prematch_winner_t1 / prematch_winner_t2 / prematch_winner_t3
fallback bucket: prematch_winner (общий, если конкретного тира нет)

в каждом bucket'е:
  primary  = LightGBM (через ml-service)
  fallback = LogReg ("spare tire", если ml-service down / 200ms timeout / 60s circuit-breaker)
```

**Tier classifier** (`lib/tier.ts`): по среднему Glicko-рейтингу команд.

| Bucket | Primary | Fallback | Train scripts | Feature names |
|---|---|---|---|---|
| `prematch_winner_t1` | LightGBM | LR | `train-lightgbm.ts`, `train-model.ts` | TEAM + HERO + EXTRA |
| `prematch_winner_t2` | LightGBM | LR | те же | те же |
| `prematch_winner_t3` | LightGBM | LR | те же | те же |
| `prematch_winner` (general) | LightGBM | LR | те же | те же |

✅ **Паритет LR vs LightGBM соблюдён** — одинаковый набор фичей, одинаковый порядок (константы `TEAM_FEATURE_NAMES + HERO_FEATURE_NAMES + EXTRA_FEATURE_NAMES`). Это ровно то, чего ты хотел («каждая версия должна содержать одинаковое кол-во фичей»). Хорошо что я не сломал — был риск.

### Match-winner (live)

| Модель | Где | Engine | Fallback |
|---|---|---|---|
| `live_winner` (v8) | `LiveWinnerModel.ts` | LogReg только | нет (LightGBM live-варианта **нет**) |

Фичи v8 (9 штук): `bias`, `game_time_norm`, `nw_lead_norm`, `kill_diff_norm`, `tower_diff_norm`, **`prematch_logit`** (использует прематч-вероятность как априорное знание), `is_real_live`, `has_draft`, `recency_days_norm`.

❗ **Gap 1:** для live-winner нет LightGBM. Добавить когда `live_snapshots × prematch_outcomes` накопит ≥200 строк (сейчас может уже накопил — проверим в T8).

### Total Kills / Total Duration

| Рынок | Prematch | Live |
|---|---|---|
| `total_kills` | LightGBM regression (`market_total_kills`) | ❌ **Нет live-модели**. Экстраполяция в `PopularMarkets.ts`: `projectedKills = kills_so_far + (kills_per_min * remaining_time)` |
| `total_duration` | LightGBM regression + квантили α=0.25/α=0.75 (`market_total_duration`, `market_total_duration_q25`, `market_total_duration_q75`) | ❌ **Нет live-модели**. Также экстраполяция темпа |

❗ **Gap 2 (главный для тебя):** на live диапазоны ТБ/ТМ — это **наивная экстраполяция текущего темпа**, а не отдельная ML-модель. Это значит:
- Прематч-модель видит ELO+form+h2h+draft, на 0-й минуте даёт диапазон
- На 25-й минуте мы тупо умножаем kills/min на оставшееся время, без учёта building_state, networth_diff, фазы игры (mid → late shifts)

Это **точно надо чинить** — твой пример «прематч 35-45, live на 25-й мин 60-70» — именно отсюда. **План T3.5 — натренировать `live_total_kills` и `live_total_duration` с богатыми live-фичами.**

### First Blood, First Tower, First Roshan

| Рынок | Метод | Фичи |
|---|---|---|
| `first_blood` | LightGBM (`market_first_blood`) prematch only | 5 базовых team features |
| `first_tower` | Math heuristic | early score + draft synergy + radiant bias |
| `first_roshan` | Math heuristic | то же |

❗ **Gap 3:** First Tower / First Roshan — **только эвристика**, не ML. Кандидаты на тренировку отдельных моделей в фазе T6/T7 (когда будут стили команд и точная aggression-метрика из parsed данных).

### Остальные derived markets

| Рынок | Метод | Replace ML? |
|---|---|---|
| Map Handicap | Math (Binomial от p(win)) | Нет, формульно правильно |
| Correct Score | Math (Conditional от p(win) + текущий счёт) | Нет, формульно правильно |
| Comeback (live) | Math (Sigmoid от NW gap + time + aegis) | Возможно — если нашлёпаем live данных, тренируем |

---

## 2. Текущий полный feature view (что реально летит в модели)

### TEAM_FEATURE_NAMES (базовые, есть везде)
```
bias, winrate_diff, experience_diff, is_high_tier,
radiant_side_logit, recency_days_norm,
series_type_norm, map_no_norm,
tier_t1, tier_t2, tier_t3,
+ extended team features (6):
  streak_diff, days_since_last_match_diff,
  matches_30d_diff, avg_kills_per_min_30d_diff,
  avg_duration_30d_diff, win_streak_score
```

### HERO_FEATURE_NAMES (драфт, в v2/v3) — **HERO_FEATURE_DIM = 11**
Источник истины: `scripts/src/lib/hero-features.ts` и зеркало
`artifacts/api-server/src/lib/hero-features.ts`. Порядок фиксирован
(меняешь — обязан переобучить все bucket'ы).

| # | имя | смысл | источник |
|---|---|---|---|
| 1 | `radiant_pick_strength` | Σ `proWinRate` по 5 пикам radiant | `hero_stats` |
| 2 | `dire_pick_strength` | то же для dire | `hero_stats` |
| 3 | `pick_strength_diff` | (1) − (2) | derived |
| 4 | `matchup_advantage` | Σ по 25 парам (r,d) `(wr−0.5)·log(games+1)`, симметричный fallback (d→r инвертируется) | `hero_matchups` |
| 5 | `radiant_meta_score` | Σ `proPickRate` радианта (популярность героев) | `hero_stats` |
| 6 | `dire_meta_score` | то же для dire | `hero_stats` |
| 7 | `ban_priority_diff` | Σ pickrate банов radiant − dire (умные баны бьют по топ-меты) | `hero_stats` |
| 8 | `synergy_diff` (T0) | Σ по 10 внутрикомандным парам `(wr−0.5)·log(g+1)` для radiant − то же для dire | `hero_synergy` (Stratz DIVINE_IMMORTAL) |
| 9 | `early_game_score_diff` (T0) | Σ `earlyGameScore` радианта − dire (сила пиков в первые 25 мин) | `hero_stats.early_game_score` |
| 10 | `late_game_score_diff` (T0) | то же для late_game (>40 мин) | `hero_stats.late_game_score` |
| 11 | `counter_bans_diff` (T0 v2) | «защитный» counter-ban: команда забанила b, который контрил бы свои пики (winRate(b,p)>0.5). Суммируется `(wr−0.5)·log(g+1)` только по положительным | `hero_matchups` |

### EXTRA_FEATURE_NAMES (v3 only) — **EXTRA_FEATURE_DIM = 6**

| # | имя | смысл | источник |
|---|---|---|---|
| 1 | `player_skill_diff` | Σ (winrate_on_hero − global_winrate_on_hero)·log(g+1), radiant − dire | `player_hero_stats` |
| 2 | `recent_form_diff` | form30.winRate(radiant) − form30.winRate(dire) | `team_recent_form` |
| 3 | `h2h_advantage_radiant` | P(radiant выигр в h2h)−0.5, шкала log(g+1) | `team_h2h` |
| 4 | `side_advantage` | константа 1 (radiant всегда radiant) — модель учит side-вес | derived |
| 5 | `player_glicko_diff` | (avg(radiant glicko) − avg(dire glicko)) / 200 | `player_ratings` |
| 6 | `player_hero_recency_diff` (T0 v2) | avg «свежести» (last_played) по 5 пикам radiant − dire | `player_hero_stats.last_played` |

⚠️ **Удалено относительно ранней версии этого аудита:** `player_glicko_uncertainty_diff` —
в коде нет, не путать с другими `_diff` полями.

**Полный prematch feature view = TEAM_FEATURE_DIM (17) + HERO_FEATURE_DIM (11) + EXTRA_FEATURE_DIM (6) = 34 фичи в v3 bucket'е.**

---

## 3. Что в БД ЕСТЬ, но в моделях НЕ используется

| Данные | Где живёт | Почему gap |
|---|---|---|
| **`hero_synergy`** (15 929 пар, мы только что заингестили!) | `hero_synergy` table | `buildHeroFeatures` использует только `hero_matchups` (counter) и `hero_stats` (winrate). Synergy игнорируется. |
| **`hero_stats.early_game_score` / `late_game_score`** (мы только что добавили) | `hero_stats` columns | Нигде не используется в тренировке. Используется только в `/draft-score` endpoint для UI. |
| **Индивидуальные баны** (drafts.bans) | `match_drafts` | Только `ban_priority_diff` (сумма). Не учитывается «кого именно забанили» (например, сильный спец-бан против ключевой механики). |
| **`player_hero_stats.last_played`** | `player_hero_stats` | Только агрегат (games, wins). Не «насколько недавно играл». |
| **building_state деталями** (какие конкретно башни упали) | `live_snapshots.building_state` | Декодируется в `towersRadiant/Dire`, но **не разбивается на t1/t2/t3 эшелоны** — а это сильный сигнал live-модели (потеря t3 = почти проигрыш базы) |
| **Networth swing last 5 min** | вычислимо из `live_snapshots` | В `BaselineModel` хардкод `8200` ❗ — мёртвая константа |
| **Roster tenure / последняя замена игрока** | нет таблицы | План T6 — нужен snapshotter |
| **OpenDota parsed данные** (kill positions, ward density, item builds) | `parse_status=2` не запрашиваем | План T0.7 |

---

## 4. Что хочу добавить во все модели — карта по фазам

| Фаза | Фичи | Куда применимо |
|---|---|---|
| **T0.5 Stratz live** | per-hero gold/xp, точный roshan_state, real buybacks, real aegis_holder | live_winner, live_total_kills, live_total_duration, comeback |
| **T0.7 OpenDota parse** | early/mid/late kill density, ward density per minute, smoke usage, gank frequency | team_styles → влияет на ВСЕ модели через стилевые фичи |
| **T3 series momentum** | map_number, series_score_diff, is_decider, prev_map_kill_diff, prev_map_duration | ВСЕ prematch + live |
| **T3.5 live total models** | game_time, current kills/min, current networth_diff, building tier_lost, draft, prematch фичи | НОВЫЕ модели live_total_kills / live_total_duration (с квантилями) |
| **T4 динамическая форма** | win_streak_signed, rolling_elo_14d, elo_growth_60d, σ_of_results, days_since_last, unverified_hot flag | ВСЕ |
| **T5 ELO decomposition** | elo_early (winrate <25 мин), elo_mid (25-40), elo_late (>40), expected_duration_weighted_elo | ВСЕ |
| **T6 styles** | team_style_aggression, team_style_farming, team_style_pace, team_style_late, team_style_vision, + стиль×стиль cross-features | ВСЕ |
| **T7 hero pool / side** | hero_pool_entropy, side_winrate_diff, patch_adaptation_score | ВСЕ prematch |
| **+ исправление gap'ов из секции 3** | hero_synergy в фичи, building_state по эшелонам, индивидуальные баны (top-N признаков), убрать хардкод `8200` | где применимо |

---

## 5. Конкретные дыры которые надо чинить КАК БАГИ

1. **`hero_synergy` лежит в БД, не используется** — добавить `synergy_v2_diff` фичу из `hero_synergy` (Stratz DIVINE_IMMORTAL, 15929 пар) рядом с существующим `synergy_diff` (из matchups). LR/LGBM натренировать заново.

2. **`hero_stats.early/late_game_score` не используется в моделях** — добавить как `team_early_score_diff`, `team_late_score_diff` (агрегаты по 5 героям стороны). Применимо для total_duration (много late-героев → длинные игры) и для match_winner (стиль драфта).

3. **`BaselineModel.netWorthSwingLast5 = 8200` хардкод** — посчитать из `live_snapshots` за последние 5 мин (есть таймстемпы).

4. **`building_state` обрезан до tower count** — добавить `tier_3_towers_radiant/dire`, `mid_lane_t3_radiant/dire` etc. в live-фичи.

5. **No live-LightGBM для match_winner** — натренировать когда данных хватит (T8).

---

## 6. Маршрутизация tier — а правильно ли?

Сейчас `classifyTier` смотрит на средний Glicko команд и делит на t1/t2/t3. Это разумно — топ-команды играют качественно (мало вариативности), низкие тиры более хаотичны.

**НО:** разные модели для разных тиров = делим обучающую выборку на 3 части. На t3 может быть мало данных для LightGBM. Стоит проверить (T8) — может быть **общая модель + tier как фича** даст лучше чем 3 отдельные. Это и есть твой эксперимент A vs B на другом срезе.

---

## 7. Что предлагаю сделать СРАЗУ в T0 (ещё до T1+)

Эти правки безопасны и не зависят от новых данных:

- [x] **A.** `synergy_diff` из `hero_synergy` (Stratz DIVINE_IMMORTAL). **CODE DONE 2026-05-16.**
- [x] **B.** `early_game_score_diff` + `late_game_score_diff` из `hero_stats.early/late_game_score`. **CODE DONE 2026-05-16.**
- [x] **C.** Убран хардкод `netWorthSwingLast5 = 8200` в BaselineModel → 0 + TODO для server-side rolling window. **DONE 2026-05-16.**
- [x] **D (v2).** `counter_bans_diff` — защитный counter-ban (см. секцию 2, фича 11). **CODE DONE 2026-05-16.**
- [x] **E (v2).** `player_hero_recency_diff` — средняя свежесть `player_hero_stats.last_played`. **CODE DONE 2026-05-16.**

### T0 mini-fix — детали (2026-05-16, обновлено)

**Что сделано в коде** (typecheck ✅ во всех 6 пакетах):

1. `scripts/src/lib/hero-features.ts` + `artifacts/api-server/src/lib/hero-features.ts` (зеркала):
   - `HeroStat` расширен опциональными `earlyGameScore` / `lateGameScore` (default 0.5).
   - Новый тип `HeroSynergyMap` с симметричным lookup (a→b ИЛИ b→a).
   - `HERO_FEATURE_NAMES`: **+4 в конец** (порядок старых 7 не меняется). Итог `HERO_FEATURE_DIM = 11`:
     `synergy_diff`, `early_game_score_diff`, `late_game_score_diff`, `counter_bans_diff`.
   - `PlayerHeroStat.lastPlayed?: number|null` (Unix sec) добавлен.
   - `EXTRA_FEATURE_NAMES`: **+1 в конец** (`player_hero_recency_diff`). Итог `EXTRA_FEATURE_DIM = 6`.
   - `buildHeroFeatures` принимает optional `synergy`; если не передан — `synergy_diff=0` (BC-safe).
2. `scripts/src/train-model.ts` (LR) и `scripts/src/train-lightgbm.ts` (LightGBM):
   - Загружают `heroSynergyTable` целиком в `Map`.
   - SELECT по `heroStatsTable` расширен на `earlyGameScore`/`lateGameScore`.
   - SELECT по `playerHeroStats` расширен на `lastPlayed`.
   - Передают `heroSynergy` в `buildHeroFeatures` для v2/v3.
3. `artifacts/api-server/src/services/PredictionModel.ts`:
   - Новый `heroSynergyCache` с TTL 60 мин.
   - `refreshHeroData` параллелит 3-й SELECT (synergy) и обогащает heroStats полями early/late.
   - `buildHeroFeatures` вызывается с `heroSynergyCache`.
4. `artifacts/mobile/services/model/BaselineModel.ts:72`: убран хардкод 8200.

**Состояние БД на 2026-05-16 (после `ingest:teams` + `ingest:hero-stats` + `ingest:hero-matchups` + `ingest:hero-synergy`):**
- `hero_stats` = 127 (Stratz-supplemented, есть early/late_game_score) ✅
- `hero_matchups` = 15 993 (Stratz DIVINE_IMMORTAL, ⚠️ matchCount шкала ≠ OpenDota — после ingest нужен retrain) ✅
- `hero_synergy` = 15 942 ✅
- `pro_matches_365d` = 28 904; `match_drafts_365d` = 4 016
- Pipeline-в-фоне: `ingest:matches 100` (≈10k свежих pro × 1.1с ≈ 3ч) → drafts → players-heroes → compute:player-glicko/recent-form/h2h/team-extended.

**Что НЕ сделано — БЛОКИРОВКА RETRAIN:**

- ⚠️ **Retrain LR + LightGBM** — ОБЯЗАТЕЛЕН до того как новые 5 фичей начнут реально работать. До retrain активные модели в БД имеют **featureDim=7 hero + 5 extra**, а инференс теперь вычисляет **11+6=17**. `featureDim` mismatch гарантирует **fallback на v1 (team-only)** для всех матчей с draft. То есть **сейчас система временно работает без draft-вклада** (-3..-5 п.п. accuracy на drafted матчах).
- ⚠️ **Не запускаем retrain пока pipeline не отработает.** Принцип: «новые фичи не катим в прод сразу — сначала наполняем БД до ~100%, потом одна выборка 365d, потом обучение» (см. roadmap в `replit.md`). Pipeline в фоне (~4-5 ч wall-time) → потом одна команда `train:model` + `train:lightgbm` атомарно подменяет все bucket'ы.

Для retrain (после окончания pipeline):
```bash
pnpm --filter @workspace/scripts run train:model
pnpm --filter @workspace/scripts run train:lightgbm
```

**Регресс-инвариант (для будущих правок hero-features / extra-features):**
Меняешь `HERO_FEATURE_NAMES` или `EXTRA_FEATURE_NAMES` — обязан в одной CL'е выполнить retrain ВСЕХ активных моделей. `featureDim` в БД и в коде должны совпадать, иначе `PredictionModel` молча упадёт на нижестоящий fallback (логи `predict tag` покажут, что v3 не загрузился) и качество просядет без видимой ошибки.

**Ожидаемый эффект retrain:** +1-2 п.п. accuracy сразу, и закрывает 5 gap'ов до наслаивания T3+ фаз.

---

## T0 ИТОГИ — DONE 2026-05-16

- ✅ Маршрутизация моделей разобрана и зафиксирована (секция 1).
- ✅ Полный feature view промаркирован поимённо (секция 2, 34 фичи в v3).
- ✅ Зафиксированы 3 главных gap'а: live LightGBM нет, live total-моделей нет (экстраполяция темпа), first_tower/first_roshan только эвристики (секция 1).
- ✅ Зафиксированы 5 фичей из БД, которые ещё не дотащены в модели (секция 3).
- ✅ T0 mini-fix v1+v2 (5 новых фичей) выкачены в код, retrain отложен до окончания pipeline обогащения.

**Что разблокировано T0:** T1 (`ml-contract.md`), T3 (series momentum), T3.5 (live total-модели — теперь точно знаем, что их надо писать с нуля, а не патчить prematch), T8 (после обогащения и retrain).

---

## 8. Список TODO для финального ML-контракта (T1)

В `docs/ml-contract.md` нужно будет описать:

1. Жизненный цикл фичи (где собирается → где кэшируется → когда обновляется → как попадает в feature view)
2. Версия feature_view как явная константа в коде (сейчас имена фичей в TEAM_FEATURE_NAMES — это и есть версия, но нет explicit версионирования)
3. Правило `train:lightgbm` всегда тренируется на ровно том же feature_view что и `train:model` — формализовать тестом
4. Регистр data-availability для UI (см. T2)
5. Контракт ml-service: какие модели регистрируются, как роутится bucket
6. Когда нужно retrain (изменили фичи / накопили данных / прошёл патч Dota)

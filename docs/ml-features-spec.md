# ML Features Spec — Aegis (T3 + T4 + T5 + T6 + T7)

Спецификация **новых фичей** для следующего поколения prematch-модели.
Это **проектный документ ДО реализации**. Менять до начала кода, чтобы потом не
рефакторить `lib/hero-features.ts` и `train-*.ts`.

Контракт жизненного цикла фичи — `docs/ml-contract.md` §1.
Текущий аудит — `docs/ml-feature-audit.md`.

**Принцип:** добавление фичи = (1) проверить что данные есть в БД, (2) дописать
в `*_FEATURE_NAMES` константу и `buildXxxFeatures` чистую функцию, (3) retrain
LR + LightGBM обоих, (4) обновить `ml-feature-audit.md`. Никаких частичных
коммитов.

---

## T3. Series Momentum

**Гипотеза:** в BO3/BO5 победа в Map 1 даёт измеримый прирост шансов на победу
в Map 2 (помимо текущей силы команд). Источники: psychological momentum,
adaptation to opponent's strategy, draft confidence.

**Фича:** `series_momentum_diff ∈ [−1, 1]`

```
score(team) = w1 * (maps_won_in_series_so_far) +
              w2 * (1 if won_last_map else 0) +
              w3 * (avg_gold_lead_in_won_maps - avg_gold_deficit_in_lost_maps) / 10000

series_momentum_diff = tanh((score(radiant) - score(dire)) / NORM)
```

Параметры: `w1=0.5, w2=0.3, w3=0.2, NORM=2.0`. Подбираются после первой
тренировки (grid search на validation set).

**Permanent_unavailable:** Map 1 серии (нет предыдущих карт). Значение = 0.

**Источник:** `bo3_series` table (есть с `compute:bo3-series`) + новая колонка
`map_results jsonb` (массив `{ map_no, winner, gold_lead }`). Нужна правка
`compute-bo3-series.ts`.

**Where:** `EXTRA_FEATURE_NAMES` (v3), `EXTRA_FEATURE_DIM=6 → 7`.

**Зависимость:** требует чтобы Map N+1 был связан с серией в `pro_matches.series_id`.
Это **уже есть** для ~85% live матчей через PandaScore.

---

## T4. Dynamic Form (hot/cold с защитой от unverified)

**Гипотеза:** простой 30/90-day winrate усредняет всё — горячий roster выглядит
как средний, новый roster (без истории) выглядит как 0.5 (нейтрально), хотя
оба — экстремумы.

**Три фичи:**

### T4.1 `weighted_recency_form_diff ∈ [−0.5, 0.5]`

Winrate с экспоненциальным затуханием:

```
score = Σ (1 if won else 0) * exp(-age_days / TAU)  /  Σ exp(-age_days / TAU)
```

`TAU = 14 days`. Свежий матч весит x10 от 90-дневного. Формула стабильна
при малом количестве матчей через regularization: если суммарный вес < 3,
смешиваем с командным глобальным winrate (`teams.rating_proxy_wr`).

### T4.2 `hot_cold_streak_diff ∈ [−1, 1]`

Знаковая длина текущей серии: +N подряд побед, −N подряд поражений.
Нормализуем через `tanh(streak / 4)`.

**Анти-шум:** учитываем только серии **из ≥3 одинаковых исходов**. Иначе 0.

### T4.3 `unverified_hot_flag ∈ {0, 1}`

Маркер «горячий, но недоверенный»:

```
unverified_hot = 1, если:
  - last_match within 14 days
  - 14-day winrate > 0.65
  - roster (5 игроков из match_drafts) изменился ≥40% за последние 30 дней
    ИЛИ team.total_pro_matches < 15
```

Иначе 0. Модель должна научиться, что `weighted_recency_form_diff = +0.3` с
флагом `unverified_hot=1` слабее чем без флага.

**Permanent_unavailable:** свежесозданная команда без истории — все три = 0,
флаг = 0. Это валидное состояние «нейтрально».

**Источник:**
- T4.1, T4.2: `pro_matches` сырая выборка за 90 дней, без новой таблицы.
- T4.3: `match_drafts.radiant_account_ids` / `dire_account_ids` (есть для 90% после pipeline).

**Where:** все три в `EXTRA_FEATURE_NAMES` (v3, требует account_ids для T4.3).
`EXTRA_FEATURE_DIM=6 → 10` (с T3 = 11).

**Замечание:** T4.1 заменяет старый `recent_form_diff` (простой 30-day wr из
`team_recent_form`). Старая фича удаляется из `HERO_FEATURE_NAMES`,
`HERO_FEATURE_DIM=11 → 10`. Это **breaking** — обязательный retrain LR+LGBM.

---

## T5. ELO Decomposition (early / mid / late)

**Гипотеза:** Glicko усредняет силу по всей игре. Но команды с тяжёлым лейтом
систематически проигрывают агрессивным early-game командам, даже когда обычный
Glicko diff ≈ 0. Раскладываем силу команды на фазы.

**Три фичи:**

```
early_strength(team) = avg over last 90d matches:
    (gold_at_10min_diff > 1500) ? 1 : (gold_at_10min_diff < -1500) ? 0 : 0.5
mid_strength(team)  = avg over last 90d matches:
    (gold_at_20min_diff > 3000) ? 1 : ... : 0.5
late_strength(team) = avg over last 90d matches:
    (won AND duration > 40min) - (lost AND duration > 40min)
```

Нормализуем каждую в `[0, 1]` через bayesian smoothing (prior=0.5, n_prior=10).

```
elo_early_diff = early_strength(radiant) - early_strength(dire)
elo_mid_diff   = mid_strength(radiant) - mid_strength(dire)
elo_late_diff  = late_strength(radiant) - late_strength(dire)
```

**Cross-feature (главное):**

```
phase_mismatch = elo_early_diff * (-elo_late_diff)
```

Большое положительное значение = radiant сильнее в early **и** dire сильнее
в late → конфликтный матч, модель учится что преимущество в early здесь весит
больше (доминирует tempo).

**Permanent_unavailable:** команды без 10 матчей за 90 дней — все 4 фичи = 0.

**Источник:** **gold_at_10/20min** — это **post-match parse**, есть только в
`pro_matches.duration` и `radiant_score`/`dire_score` (агрегат). Реальный
`gold_at_10min` требует **OpenDota replay parse (T0.7)** или Stratz post-match.

**Если parse-данных нет к моменту T5:** fallback на `early_game_score` /
`late_game_score` (которые мы уже считаем из hero pool в `hero-features.ts`).
Это слабее (heroes ≠ team execution), но лучше нуля.

**Where:** `EXTRA_FEATURE_NAMES` (v3), `EXTRA_FEATURE_DIM` +4.

---

## T6. Team Styles + Style×Style Cross-features

**Гипотеза:** есть архетипы команд (fight-heavy / farm-heavy / push / scaling),
и матчапы между архетипами имеют не-аддитивный эффект (rock-paper-scissors).

### T6.1 Базовый стиль (3 непрерывные фичи)

```
fight_intensity(team) = avg over 90d: (kills_for + kills_against) / duration_min
farm_efficiency(team) = avg over 90d: (avg_gpm_per_player) / 600
push_focus(team)      = avg over 90d: (num_towers_destroyed_at_25min) / 11
```

Все нормализованы в `[0, 1]` через перцентили по pro-сцене.

```
fight_intensity_diff = fight_intensity(radiant) - fight_intensity(dire)
farm_efficiency_diff = farm_efficiency(radiant) - farm_efficiency(dire)
push_focus_diff      = push_focus(radiant)      - push_focus(dire)
```

### T6.2 Cross-features (главное)

```
style_clash = fight_intensity_diff * (-fight_intensity(dire))
                                     ↑ если dire тоже fight-heavy, clash отрицательный (взаимокомпенсация)

farm_vs_fight = farm_efficiency(radiant) * fight_intensity(dire)
                ↑ radiant farming, dire pressing — классический rock-paper-scissors
```

### T6.3 Storage

Новая колонка в `team_extended_features`:
```sql
ALTER TABLE team_extended_features ADD COLUMN style_jsonb jsonb;
-- { fight_intensity: 0.62, farm_efficiency: 0.71, push_focus: 0.48,
--   computed_at: '...', sample_size: 24 }
```

Заполнение — новый скрипт `compute:team-styles` (читает `pro_matches` за 90д,
агрегирует). Запускать после `compute:team-extended`.

**Источник:**
- `fight_intensity`: `radiant_score + dire_score` (есть в `pro_matches`).
- `farm_efficiency`: требует **post-match data**. До T0.7 — fallback на
  отношение `radiant_lead / duration` при победе.
- `push_focus`: требует **building_state по таймлайну**. До T0.7 — fallback
  на бинарный `building_state_at_end` (легко из `pro_matches`).

**Where:** 3 base + 2 cross = 5 фичей в `EXTRA_FEATURE_NAMES` (v3).
`EXTRA_FEATURE_DIM` +5.

**Permanent_unavailable:** команды без 5 матчей за 90д → все 5 = 0.

---

## T7. Hero Pool Entropy + Side Preference

**Гипотеза:** команды с узким hero pool (всегда играют одних героев) более
предсказуемы — соперник может банить ключевых. Команды с side preference
(сильнее на radiant или dire) сейчас не моделируются.

### T7.1 `hero_pool_entropy_diff`

Shannon entropy выбираемых героев за 30 дней:

```
P_h = picks_of_hero_h / total_picks
H(team) = -Σ P_h * log2(P_h)  // в битах
normalized = H / log2(N_unique_heroes_pro_scene) ∈ [0, 1]
```

Высокая entropy = разнообразный pool (труднее банить), низкая = узкий.

```
hero_pool_entropy_diff = normalized(radiant) - normalized(dire)
```

### T7.2 `side_preference_diff`

```
side_pref(team) = (radiant_winrate - dire_winrate)  // знаковое отклонение
                  weighted by Σ matches на каждой стороне за 365d
                  с bayesian smoothing (prior=0, n_prior=20)
```

Если team играет на **radiant** в текущем матче:

```
side_advantage(team) = +side_pref(team)
```

И симметрично для dire.

```
side_preference_diff = side_advantage(radiant_team) - side_advantage(dire_team)
```

**Источник:** только `match_drafts` + `pro_matches.radiant_team_id` / `dire_team_id`
(есть всё).

**Where:** оба в `EXTRA_FEATURE_NAMES` (v3). `EXTRA_FEATURE_DIM` +2.

**Permanent_unavailable:** <10 матчей за 30/365 дней → 0.

---

## Сводная таблица новых фичей

| Фаза | Фича | Версия | dim | Источник | Зависимость |
|---|---|---|---|---|---|
| T3 | series_momentum_diff | EXTRA v3 | +1 | bo3_series (правка) | series_id в pro_matches |
| T4.1 | weighted_recency_form_diff | EXTRA v3 | +1 | pro_matches | заменяет recent_form_diff (-1) |
| T4.2 | hot_cold_streak_diff | EXTRA v3 | +1 | pro_matches | — |
| T4.3 | unverified_hot_flag | EXTRA v3 | +1 | match_drafts | account_ids |
| T5 | elo_early_diff | EXTRA v3 | +1 | T0.7 replay-parse | OD parse, иначе hero fallback |
| T5 | elo_mid_diff | EXTRA v3 | +1 | T0.7 replay-parse | OD parse, иначе hero fallback |
| T5 | elo_late_diff | EXTRA v3 | +1 | T0.7 replay-parse | OD parse, иначе hero fallback |
| T5 | phase_mismatch | EXTRA v3 | +1 | cross | — |
| T6 | fight_intensity_diff | EXTRA v3 | +1 | team_extended (нов. колонка) | compute:team-styles |
| T6 | farm_efficiency_diff | EXTRA v3 | +1 | team_extended (нов. колонка) | compute:team-styles |
| T6 | push_focus_diff | EXTRA v3 | +1 | team_extended (нов. колонка) | compute:team-styles |
| T6 | style_clash | EXTRA v3 | +1 | cross | — |
| T6 | farm_vs_fight | EXTRA v3 | +1 | cross | — |
| T7 | hero_pool_entropy_diff | EXTRA v3 | +1 | match_drafts | — |
| T7 | side_preference_diff | EXTRA v3 | +1 | pro_matches | — |

**Итого:** EXTRA: 6 → **20** (+15, минус 1 из HERO recent_form_diff = +14 net).
HERO: 11 → **10**.
TEAM: **17** (без изменений).

**Полная размерность v3:** 17 + 10 + 20 = **47 фичей**.

---

## Порядок реализации (рекомендованный)

Сначала те, что **не зависят от T0.7 replay-parse** — они работают сразу
после ingest pipeline:

1. **T3** series_momentum — 1 SQL миграция (`bo3_series.map_results`), правка `compute-bo3-series`, 1 фича.
2. **T4** form (3 фичи) — без миграций, чистый код в `hero-features.ts`.
3. **T7** entropy + side — без миграций, чистый код.

Это даёт **+10 фичей** (T3 +1, T4 +3 minus 1, T7 +2 + bookkeeping). Retrain
LR+LGBM, измеряем дельту.

Потом, **после T0.7**:

4. **T5** ELO-decomp (с реальным parse) — 4 фичи.
5. **T6** styles — миграция `team_extended_features.style_jsonb`, новый скрипт `compute:team-styles`, 5 фичей.

Финальный retrain — **T8 A vs B**.

---

## Контракт «эта фича существует»

Каждая фича из этого документа в момент добавления:

1. Имеет строчку в таблице выше — иначе **не добавляется**.
2. Имеет константу в `*_FEATURE_NAMES` **в обоих** `lib/hero-features.ts`
   (api-server + scripts) — иначе **train script упадёт с явной ошибкой**,
   а не молча подсунет ноль.
3. Имеет тест `scripts/src/test-feature-parity.ts` (когда будет написан) —
   возвращает одинаковый вектор на одинаковом input.
4. Имеет строчку в `docs/ml-feature-audit.md` §2 с указанием источника и
   permanent_unavailable условия.
5. Обновляет `docs/data-availability-rules.md` §4 если может быть permanent
   для каких-то контекстов.

---

## Что НЕ делаем сейчас

Параметры (`TAU`, `NORM`, `n_prior`, веса) — **первая итерация = разумные
дефолты**. Grid search **после** того как фичи окажутся в проде и накопится
тестовый set. Преждевременная оптимизация — анти-паттерн.

Никаких ансамблей моделей, никакого stacking, никакого neural net. Это
итеративная работа на месяцы — сначала линейка фичей × LightGBM, потом
смотрим где предел.

# Aegis — Описание всех ML-моделей

**Состояние:** ретрейн #4, 2026-05-12  
**Всего активных моделей:** 25 (9 LGB prematch + 9 LR prematch + 3 market LGB + 2 live)

---

## 1. Prematch Winner — LightGBM (9 моделей)

**Задача:** бинарная классификация (radiant win = 1)  
**Скрипт:** `train:lightgbm` (`scripts/src/train-lightgbm.ts`)  
**Калибровка:** Isotonic Regression на calib-сплите (в ml-service FastAPI)

### Структура: 3 feature versions × 3 tier buckets

| Версия | Tier | Test acc | Brier |
|--------|------|----------|-------|
| v1 | all (fallback) | ~72% | — |
| v1 | t1 (топ лиги) | — | — |
| v1 | t2 | — | — |
| v2 | all | ~74% | — |
| v2 | t1 | — | — |
| v2 | t2 | — | — |
| **v3** | **all** | **78.5%** | **0.1573** |
| v3 | t1 | 69.0% | — |
| **v3** | **t2** | **78.9%** | **0.1489** |

Обучение: 28.9k матчей в 365-дневном окне (28.9k train + calib/test сплиты).

### Гиперпараметры

```
num_leaves    = 31
learning_rate = 0.05
n_estimators  = 200
(остальное — LightGBM defaults)
```

### Фичи

**v1 — Team features (5 фич):**

| Фича | Описание |
|------|----------|
| `bias` | = 1 |
| `elo_diff_norm` | (ELO_r − ELO_d) / 200 |
| `winrate_diff` | wins/games radiant − wins/games dire |
| `experience_diff` | log(gamesR+1) − log(gamesD+1) |
| `is_high_tier` | 1 если обе команды имеют ≥50 матчей |

**v2 = v1 + Hero features (7 фич):**

| Фича | Описание |
|------|----------|
| `radiant_pick_strength` | Σ proWinRate по 5 пикам radiant |
| `dire_pick_strength` | Σ proWinRate по 5 пикам dire |
| `pick_strength_diff` | radiant − dire |
| `matchup_advantage` | Σ по 25 парам (5×5 героев): (winRate − 0.5) × log(games+1), симметричный fallback |
| `radiant_meta_score` | Σ proPickRate radiant |
| `dire_meta_score` | Σ proPickRate dire |
| `ban_priority_diff` | Σ pickRate забаненных radiant − dire |

**v3 = v2 + Extra features (5 фич):**

| Фича | Описание |
|------|----------|
| `player_skill_diff` | Σ (winrate_on_hero − global_hero_wr) × log(games+1), radiant − dire (из player_heroes) |
| `recent_form_diff` | form30.winRate(rad) − form30.winRate(dir) |
| `h2h_advantage_radiant` | (P(rad wins h2h) − 0.5) × log(h2h_games+1) |
| `side_advantage` | константа 1 (модель выучит вес сама) |
| `player_glicko_diff` | (avg_glicko_rad − avg_glicko_dir) / 200 |

**Инференс:** выбирается наиболее специфичная модель — v3/t1 → v3/t2 → v3/all → v2/... → v1/all. LGB первичен над LR.

### Текущие проблемы

- **v3/t1 оверфит:** 69.0% test при train 94.5% — всего ~840 t1-сэмплов, недостаточно для 12 фич LGB без тюнинга регуляризации.
- **Hero features = null** если у команды нет полных данных пиков/банов → модель падает на v1 (без draft).

---

## 2. Prematch Winner — Logistic Regression (9 моделей)

**Задача:** то же, что LGB  
**Скрипт:** `train:model` (`scripts/src/train-model.ts`)  
**Алгоритм:** pure-JS SGD с L2-регуляризацией, sigmoid activation

### Результаты

| Версия | Tier | Test acc | Brier |
|--------|------|----------|-------|
| v3 | all | **76.4%** | 0.164 |
| v3 | t2 | **77.0%** | 0.156 |
| v3 | t1 | 63.1% | — |

### Гиперпараметры

```
EPOCHS        = 200
learning_rate = 0.05
L2            = 0.001
optimizer     = SGD (полный проход = 1 epoch)
```

**Фичи:** идентичны LGB (v1/v2/v3, те же 5+7+5 = 17 фич для v3)

**Роль:** запасная модель (fallback) когда ml-service недоступен. Circuit-breaker 60s, timeout 200ms на запрос к LGB.

**Исправленный баг (ретрейн #4):** ранее `train:model` деактивировал все модели текущего kind, включая LGB. Добавлен фильтр `engine='logreg'` в WHERE деактивации — LGB-модели теперь не затрагиваются.

---

## 3. Market Models — LightGBM (3 модели)

**Скрипт:** `train:market-models` (`scripts/src/train-market-models.ts`)  
**fv = 3**  
**Данные:** 28.9k матчей в 365d окне, split 80/10/10 (3941 train / 493 calib / 493 test)

### Результаты

| Модель | Задача | Test метрика | Значение |
|--------|--------|--------------|---------|
| `first_blood` | классификация | accuracy | **58.8%** |
| `total_kills` | регрессия (log-space) | R² | **0.059** |
| `total_duration` | регрессия (log-space) | R² | **0.039** |

`total_kills` и `total_duration` обучаются предсказывать `log(kills)` / `log(duration)` → на инференсе `exp(pred)`.

### Гиперпараметры

Используются дефолты LightGBM (явно не заданы в скрипте):

```
num_leaves    = 31    (LGB default)
learning_rate = 0.1   (LGB default)
n_estimators  = 100   (LGB default)
```

### 16 фич (одинаковые для всех трёх моделей)

| Фича | Описание |
|------|----------|
| `bias` | = 1 |
| `elo_diff_norm` | (ELO_r − ELO_d) / 200 |
| `winrate_diff` | wins/games radiant − wins/games dire |
| `experience_diff` | log(gamesR+1) − log(gamesD+1) |
| `is_high_tier` | 1 если обе команды имеют ≥50 матчей |
| `avg_kills_r` | средние убийства за radiant / 60 |
| `avg_kills_d` | средние убийства за dire / 60 |
| `avg_dur_h_r` | средняя длительность matчей radiant (в часах) |
| `avg_dur_h_d` | средняя длительность матчей dire (в часах) |
| `expected_tempo_norm` | (avgKillsR + avgKillsD) / (2 × 52) — ожидаемый темп убийств конкретного матчапа |
| `draft_aggression_r` | агрессивность драфта radiant (из pick meta) |
| `draft_aggression_d` | агрессивность драфта dire |
| `radiant_pick_strength` | Σ proWinRate по 5 пикам radiant |
| `dire_pick_strength` | Σ proWinRate по 5 пикам dire |
| `matchup_advantage` | matchup matrix advantage (25 пар) |
| `radiant_meta_score` | Σ proPickRate radiant |

### Top-5 важности фич

- `total_kills`: elo_diff_norm, winrate_diff, experience_diff, draft_aggression_r, draft_aggression_d
- `total_duration`: winrate_diff, elo_diff_norm, experience_diff, **expected_tempo_norm (32)**, avg_dur_h_r

### Исправленный баг (ретрейн #4)

`patch_kpm` был глобальной константой = 0.4 для всех матчей → importance=0 во всех 3 моделях. Заменён на `expected_tempo_norm = (avgKillsR + avgKillsD) / (2 × GLOBAL_AVG_KILLS)` — варьируется по матчапу.

### Текущие проблемы

- R² очень низкий (0.04–0.06) — задача сложная, матч-контекст (патч, стиль команд) слабо покрывается доступными фичами.
- Только 3941 тренировочных сэмплов с draft-данными из ~28.9k матчей.

---

## 4. Live Winner — LightGBM + Logistic Regression (2 модели, 1 активный набор)

**Скрипт:** `train:live-model` (`scripts/src/train-live-model.ts`)  
**fv = 5**, **12 фич**  
**Данные:** 18.7k raw snapshots → 5505 после дедупликации (bucket 180 секунд на матч)  
**Match split:** train 415 / calib 52 / test 52 матчей → 4480 / 592 / 433 snapshot-сэмплов  
**Label:** radiant wins = 1  
**Дисбаланс:** train radiant=52.1%, test radiant=64.2% (temporal shift)

### Результаты

| Модель | Test acc | Brier | Lift над baseline |
|--------|----------|-------|-------------------|
| **LR (primary)** | **71.36%** | **0.1802** | **+4.85pp** |
| LGB | 64.90% | 0.3107 | +0.69pp |
| Baseline (prematch only) | 66.51% | 0.2215 | — |

Primary выбирается автоматически по `testAccuracy`. Сейчас LR > LGB.

### Гиперпараметры

**LGB:**

```
class_weight      = 'balanced'    ← компенсирует radiant-перекос в test
num_leaves        = 15
max_depth         = 4
learning_rate     = 0.05
n_estimators      = 80
min_child_samples = 20
reg_alpha         = 0.5
reg_lambda        = 1.0
feature_fraction  = 0.8
bagging_fraction  = 0.8
bagging_freq      = 5
```

**LR (pure JS SGD):**

```
EPOCHS        = 300
learning_rate = 0.03
L2            = 0.01
```

### 12 фич (порядок = индекс в feature vector)

| # | Фича | Описание |
|---|------|----------|
| 0 | `bias` | = 1 |
| 1 | `game_time_norm` | elapsed_sec / 3600 |
| 2 | `nw_lead_norm` | (networth_r − networth_d) / 10000 |
| 3 | `kill_diff_norm` | (kills_r − kills_d) / 20 |
| 4 | `r_towers_lost_ratio` | башни radiant lost / 11 (0 если buildingState=null) |
| 5 | `d_towers_lost_ratio` | башни dire lost / 11 (0 если null) |
| 6 | `prematch_logit` | logit(p_radiant) из prematch-модели |
| 7 | `kill_pace_norm` | total_kills / elapsed_min / GLOBAL_KPM |
| 8 | `game_phase` | 0=early / 0.5=mid / 1=late (по времени) |
| 9 | `nw_x_phase` | nw_lead_norm × game_phase |
| 10 | `kill_diff_x_phase` | kill_diff_norm × game_phase |
| 11 | `hero_advantage` | Σ matchup matrix (5×5 пар) взвешенный по log(games+1) |

### Важность фич (LGB)

```
kill_pace_norm=201 > kill_diff_norm=194 > game_time_norm=103 > nw_lead_norm=81 > hero_advantage=71
```

### Веса LR

```
kill_diff_norm=3.365, kill_diff_x_phase=0.679, prematch_logit=0.236,
nw_lead_norm=0.108, kill_pace_norm=−0.076, hero_advantage=0.013
(остальные ≈ 0)
```

### Откуда берётся prematch_logit

| Источник | Кол-во матчей |
|----------|--------------|
| Stored в `prematch_outcomes` | 1415 |
| ELO-based расчёт | 22 |
| Neutral (0.5, нет данных) | 4068 |

### Текущие проблемы

- **LGB оверфит:** train=95.83% vs test=64.90%. `class_weight='balanced'` уменьшил gap (+3pp к test acc), но не устранил. Основная причина — temporal shift: распределение radiant wins в test (64.2%) сильно отличается от train (52.1%).
- **Башни разреженные:** `r_towers_lost_ratio` / `d_towers_lost_ratio` importance=0. 68.4% snapshot'ов имеют `buildingState=null` (OpenDota не возвращает данные в первые минуты). Фичи корректно обнуляются, но слишком разреженные для значимого signal.
- **hero_advantage редкий:** доступен только в 1049/5505 сэмплах (где есть draft в `match_drafts`). В остальных = 0. На инференсе вычисляется из `extractDraftFromLive` picks.
- **Мало матчей:** 519 уникальных тренировочных матчей — LGB не хватает данных, LR выигрывает.
- **Следующий порог:** авто-переключение на LGB как primary когда live trainSize > 10k snapshots.

---

## Общие параметры обучения

| Параметр | Значение | Диапазон (admin UI) |
|----------|----------|---------------------|
| `trainWindowDays` | 365 | 30–730 |
| `trainMaxPatches` | 4 | 1–20 |
| `trainMinSamples` | 1000 | 50–100k |

Эффективный cutoff = `max(windowCutoff, patchCutoff)`.  
Оптимальное окно 365d (540d хуже на ~9pp из-за meta drift).

---

## Итог по точности

| Модель | Тип | Лучшая точность |
|--------|-----|----------------|
| LGB prematch v3/t2 | классификация | **78.9%** |
| LGB prematch v3/all | классификация | **78.5%** |
| LR prematch v3/t2 | классификация | 77.0% |
| LR prematch v3/all | классификация | 76.4% |
| LR live winner (primary) | классификация | 71.36% (+4.85pp) |
| LGB live winner | классификация | 64.90% (+0.69pp) |
| Market first_blood | классификация | 58.8% |
| Market total_kills | регрессия | R²=0.059 |
| Market total_duration | регрессия | R²=0.039 |

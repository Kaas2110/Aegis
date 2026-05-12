# Aegis — Описание всех ML-моделей

**Состояние:** ретрейн #4, 2026-05-12  
**Всего активных моделей:** 25 (9 LGB prematch + 9 LR prematch + 3 market LGB + 2 live)

---

## 0. Данные в базе и периоды обучения

### Общий объём данных (на 2026-05-12)

| Таблица | Всего | В окне 365 дней | Период в БД |
|---------|-------|-----------------|-------------|
| `pro_matches` | 44 947 | 28 939 | 2017-09-06 — 2026-05-12 |
| `match_drafts` (с пиками) | 5 237 | 3 511 | — |
| `prematch_outcomes` | 7 267 | 4 927 | 2024-10-17 — 2026-05-12 |
| `live_snapshots` (raw) | 22 125 | — | 2025-09-15 — 2026-05-12 |
| `live_snapshots` (после 3-мин дедупл.) | ~5 505 | — | — |

### Почему 365 дней

Экспериментально установлено: обучающее окно 365 дней даёт наилучшие метрики для всех типов моделей. Окно 540 дней ухудшает точность на ~9 pp из-за meta drift — в Dota 2 баланс героев и тактики меняются с каждым патчем, данные старше года слишком устарели.

Кроме окна по времени, ещё учитывается количество патчей (`trainMaxPatches = 4` по умолчанию): берётся более строгий из двух cutoff'ов — `max(windowCutoff, patchCutoff)`.

---

## 1. Prematch Winner — LightGBM (9 моделей)

### Данные и период

| Параметр | Значение |
|----------|----------|
| Источник | `pro_matches` JOIN `team_ratings` JOIN `match_drafts` JOIN `player_heroes` JOIN `team_recent_form` JOIN `team_h2h` JOIN `player_ratings` |
| Период обучения | **365 дней** (с 2025-05-12 по 2026-05-12) |
| Пул матчей (с командами) | **28 939** |
| Из них с данными драфта (для v2/v3) | **3 511** |
| Из них с данными игроков (для v3) | подмножество от 3 511 |
| Фильтр | `radiant_team_id IS NOT NULL AND dire_team_id IS NOT NULL` |
| Сплит | матч-ориентированный 80/10/10 (по уникальным match_id, не по строкам) |

**Tier-разбивка** определяется средним рейтингом пары `(rating_r + rating_d) / 2`:

| Tier | Порог | Описание |
|------|-------|----------|
| **T1** | avg ≥ 1400 | топ-команды (TI-контендеры, DPC Major) |
| **T2** | 1200 ≤ avg < 1400 | мид-тир, региональные лиги |
| **T3** | avg < 1200 | низший тир, открытые квалификации |
| **fallback** | нет рейтинга | команды без рейтинга → общая модель |

Tier-модели (t1/t2/t3) обучаются на **подмножестве** из 28 939 матчей. t3-модели в базе есть, но не используются в инференсе активно.

**Задача:** бинарная классификация (radiant win = 1)  
**Скрипт:** `train:lightgbm` (`scripts/src/train-lightgbm.ts`)  
**Калибровка:** Isotonic Regression на calib-сплите (в ml-service FastAPI)

### Результаты

| Версия | Tier | Test acc | Brier |
|--------|------|----------|-------|
| v1 | all (fallback) | ~72% | — |
| v1 | t1 | — | — |
| v1 | t2 | — | — |
| v2 | all | ~74% | — |
| v2 | t1 | — | — |
| v2 | t2 | — | — |
| **v3** | **all** | **78.5%** | **0.1573** |
| v3 | t1 | 69.0% | — |
| **v3** | **t2** | **78.9%** | **0.1489** |

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
| `player_skill_diff` | Σ (winrate_on_hero − global_hero_wr) × log(games+1), radiant − dire (из `player_heroes`) |
| `recent_form_diff` | form30.winRate(rad) − form30.winRate(dir) (из `team_recent_form`) |
| `h2h_advantage_radiant` | (P(rad wins h2h) − 0.5) × log(h2h_games+1) (из `team_h2h`, окно 365 дней) |
| `side_advantage` | константа 1 (модель выучит вес сама) |
| `player_glicko_diff` | (avg_glicko_rad − avg_glicko_dir) / 200 (из `player_ratings`) |

**Инференс:** наиболее специфичная модель — v3/t1 → v3/t2 → v3/all → v2/... → v1/all. LGB первичен над LR.

### Текущие проблемы

- **v3/t1 оверфит:** 69.0% test при train 94.5% — всего ~840 t1-сэмплов, недостаточно для 12 фич LGB.
- **Hero features = null** если у команды нет полных данных пиков/банов → модель падает на v1.

---

## 2. Prematch Winner — Logistic Regression (9 моделей)

### Данные и период

Идентичны LGB: **28 939 матчей за 365 дней**, те же источники и сплит.

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

**Роль:** fallback когда ml-service недоступен. Circuit-breaker 60s, timeout 200ms.

**Исправленный баг (ретрейн #4):** `train:model` деактивировал все модели текущего kind, включая LGB. Добавлен фильтр `engine='logreg'` в WHERE — LGB-модели теперь не затрагиваются.

---

## 3. Market Models — LightGBM (3 модели)

### Данные и период

| Параметр | Значение |
|----------|----------|
| Источник | `pro_matches` JOIN `team_ratings` JOIN `match_drafts` JOIN `team_recent_form` |
| Период обучения | **365 дней** (с 2025-05-12 по 2026-05-12) |
| Пул матчей | 28 939 |
| Фильтр | `duration IS NOT NULL` (только завершённые матчи) |
| Дополнительно | матчи с драфтом: 3 511 (используются для draft-фич; при отсутствии — нулевые значения) |
| Итоговые сэмплы | **3 941 train / 493 calib / 493 test** |
| Сплит | случайный 80/10/10 (не матч-ориентированный) |

**Скрипт:** `train:market-models` (`scripts/src/train-market-models.ts`)  
**fv = 3**

### Результаты

| Модель | Задача | Test метрика | Значение |
|--------|--------|--------------|---------|
| `first_blood` | классификация | accuracy | **58.8%** |
| `total_kills` | регрессия (log-space) | R² | **0.059** |
| `total_duration` | регрессия (log-space) | R² | **0.039** |

`total_kills` и `total_duration` обучаются на `log(kills)` / `log(duration)` → на инференсе `exp(pred)`.

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
| `avg_kills_r` | средние убийства за matч radiant / 60 |
| `avg_kills_d` | средние убийства за матч dire / 60 |
| `avg_dur_h_r` | средняя длительность матчей radiant (в часах) |
| `avg_dur_h_d` | средняя длительность матчей dire (в часах) |
| `expected_tempo_norm` | (avgKillsR + avgKillsD) / (2 × 52) — ожидаемый темп убийств конкретного матчапа |
| `draft_aggression_r` | агрессивность драфта radiant (из `match_drafts`) |
| `draft_aggression_d` | агрессивность драфта dire |
| `radiant_pick_strength` | Σ proWinRate по 5 пикам radiant |
| `dire_pick_strength` | Σ proWinRate по 5 пикам dire |
| `matchup_advantage` | matchup matrix advantage (25 пар 5×5) |
| `radiant_meta_score` | Σ proPickRate radiant |

### Top-5 важности фич

- `total_kills`: elo_diff_norm, winrate_diff, experience_diff, draft_aggression_r, draft_aggression_d
- `total_duration`: winrate_diff, elo_diff_norm, experience_diff, **expected_tempo_norm (32)**, avg_dur_h_r

### Исправленный баг (ретрейн #4)

`patch_kpm` был глобальной константой = 0.4 для всех матчей → importance=0. Заменён на `expected_tempo_norm = (avgKillsR + avgKillsD) / (2 × 52)` — варьируется по матчапу.

### Текущие проблемы

- R² очень низкий (0.04–0.06) — задача сложная, матч-контекст слабо покрывается доступными фичами.
- Только 3 941 тренировочных сэмпл с draft-данными из 28 939 матчей.

---

## 4. Live Winner — LightGBM + Logistic Regression (2 модели, 1 активный набор)

### Данные и период

| Параметр | Значение |
|----------|----------|
| Источник снапшотов | `live_snapshots` JOIN `pro_matches` JOIN `prematch_outcomes` JOIN `match_drafts` |
| Период сбора снапшотов | **2025-09-15 — 2026-05-12** (~8 месяцев) |
| Источник сбора | LiveWorker (polling OpenDota `/api/live` каждые 60s) + `backfill:live-snapshots` (синтетические снапшоты из истории матчей) |
| Сырых снапшотов | **22 125** (583 уникальных матча) |
| После дедупликации | **5 505** (bucket 180 секунд на матч — один снапшот каждые 3 минуты) |
| Матч-сплит (train/calib/test) | **415 / 52 / 52** матчей |
| Сэмпл-сплит | **4 480 / 592 / 433** снапшотов |
| Из них с данными драфта | 1 049 / 5 505 (19%) |
| Label | radiant wins = 1 (из `prematch_outcomes` или `pro_matches.radiant_win`) |

**Период доступности `prematch_logit`** (источник для фичи #6):

| Источник | Кол-во | Период |
|----------|--------|--------|
| Stored в `prematch_outcomes` | 1 415 матчей | 2024-10-17 — 2026-05-12 |
| ELO-based расчёт | 22 матча | — |
| Neutral (0.5) | 4 068 матчей | нет данных |

**Дисбаланс лейблов:**  
Train: radiant wins = 52.1% (сбалансировано)  
Test: radiant wins = **64.2%** (temporal shift — реальный перекос в последних месяцах данных)

**Скрипт:** `train:live-model` (`scripts/src/train-live-model.ts`)  
**fv = 5**, **12 фич**

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
| 11 | `hero_advantage` | Σ matchup matrix (25 пар 5×5) × log(games+1), из `hero_matchups` |

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

### Текущие проблемы

- **LGB оверфит:** train=95.83% vs test=64.90%. `class_weight='balanced'` частично помог (+3pp к test acc).
- **Башни разреженные:** 68.4% снапшотов имеют `buildingState=null` (OpenDota не отдаёт данные в первые минуты матча). Фичи 4 и 5 importance=0 у обеих моделей.
- **hero_advantage редкий:** только 1 049 / 5 505 снапшотов (19%) имеют данные драфта.
- **Мало матчей:** 519 уникальных тренировочных матчей. LR выигрывает у LGB из-за ограниченного размера.
- **Следующий порог:** авто-переключение на LGB как primary ожидается при live trainSize > 10k снапшотов.

---

## Общие параметры обучения (admin UI)

| Параметр | Значение по умолчанию | Диапазон |
|----------|-----------------------|----------|
| `trainWindowDays` | **365** | 30–730 |
| `trainMaxPatches` | **4** | 1–20 |
| `trainMinSamples` | **1000** | 50–100k |

Эффективный cutoff = `max(windowCutoff, patchCutoff)`.

---

## Итог по точности

| Модель | Тип | Лучшая точность | Train размер |
|--------|-----|----------------|--------------|
| LGB prematch v3/t2 | классификация | **78.9%** | ~5k (t2) из 28 939 |
| LGB prematch v3/all | классификация | **78.5%** | 28 939 |
| LR prematch v3/t2 | классификация | 77.0% | ~5k (t2) из 28 939 |
| LR prematch v3/all | классификация | 76.4% | 28 939 |
| LR live winner (primary) | классификация | 71.36% (+4.85pp) | 4 480 снапшотов / 415 матчей |
| LGB live winner | классификация | 64.90% (+0.69pp) | 4 480 снапшотов / 415 матчей |
| Market first_blood | классификация | 58.8% | 3 941 |
| Market total_kills | регрессия | R²=0.059 | 3 941 |
| Market total_duration | регрессия | R²=0.039 | 3 941 |

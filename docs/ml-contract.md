# ML Contract — Aegis (T1)

Единый контракт ML-системы. **Это нормативный документ** — если код расходится
с тем, что написано здесь, чините код или обновляйте контракт явной правкой.
Обновляется одновременно с любой структурной правкой моделей/фичей.

Сопутствующие документы:
- `docs/ml-feature-audit.md` (T0) — текущий аудит фичей, маршрутизация, gap'ы.
- `docs/system-map.md` — карта связей источники → таблицы → фичи → модели.
- `docs/data-availability-rules.md` (T2) — правила «временно vs навсегда» для UI.

---

## 1. Жизненный цикл одной фичи

```
┌────────────┐   ingest    ┌──────────────┐   train     ┌──────────────┐
│ Источник   │ ─────────▶ │ Таблица БД   │ ─────────▶ │ Модель в БД  │
│ (Stratz /  │   (script)  │ (lib/db)     │  (script)   │ (modelVer-   │
│ OpenDota / │             │              │             │  sionsTable) │
│ live API)  │             │              │             │              │
└────────────┘             └──────────────┘             └──────────────┘
                                  │                            │
                                  │ refresh (cache TTL)        │ load (every restart
                                  ▼                            ▼  + on retrain)
                          ┌──────────────────────┐    ┌──────────────────┐
                          │ services/PredictionM │◀───│ ml-service       │
                          │ refreshXxxCache()    │    │ (FastAPI :8090)  │
                          │ TTL: 15/60 min       │    │ predict() HTTP   │
                          └──────────────────────┘    └──────────────────┘
                                  │
                                  ▼
                          ┌──────────────────────┐
                          │ buildXxxFeatures()   │ ← pure function
                          │ → vector(float)      │   (lib/hero-features)
                          └──────────────────────┘
                                  │
                                  ▼
                          ┌──────────────────────┐
                          │ predictMatch()       │ ← HTTP → ml-service (lightgbm)
                          │ + fallback к LR      │   ← in-proc (logreg)
                          └──────────────────────┘
                                  │
                                  ▼
                                 API → mobile
```

**Инварианты:**

1. Любая фича — **pure function** от данных в БД на момент инференса.
   Никаких external fetch в `buildXxxFeatures()`. Все fetch'и происходят в
   `refreshXxxCache()` с явным TTL.
2. Если данных нет — фича либо имеет нейтральное значение (0 / 0.5), либо
   модель fallback'ится на нижестоящую feature-version (см. §4).
3. Имена и **порядок** фичей в `*_FEATURE_NAMES` — это **версия feature view**.
   Менять порядок = ломать сериализованные модели в БД.

---

## 2. Версионирование feature view

**Сейчас:** версия неявная, фиксируется константой `featuresVersion: 1 | 2 | 3`
в `modelVersionsTable.features_version` (integer).

| `featuresVersion` | Что входит | Где |
|---|---|---|
| 1 | TEAM (17) | Базовый, всегда есть |
| 2 | TEAM (17) + HERO (11) = 28 | Когда драфт известен |
| 3 | TEAM (17) + HERO (11) + EXTRA (6) = 34 | Когда драфт + account_ids известны |

Полные имена — `docs/ml-feature-audit.md` §2.

**Контракт:** `LoadedModel.featureDim` обязан совпадать с **константой в коде
на момент load**. Если не совпадает (увеличили `HERO_FEATURE_DIM` без retrain) —
модель помечается *not loaded*, инференс fallback'ится на нижестоящую версию,
лог `predict tag` это печатает.

**TODO (future):** ввести `FEATURE_VIEW_VERSION = 'fv-2026.05.16'` явной
строкой рядом с `HERO_FEATURE_NAMES`, и `model_versions.feature_view_version`
text-колонку. Тогда mismatch будет ловиться явно, а не через `featureDim`.
Пока — `featureDim` рабочая защита, но лог должен явно говорить
«featureDim mismatch (got X, expected Y), skipping model».

---

## 3. Контракт «LR ↔ LightGBM bucket-паритет»

**Цель:** LR и LightGBM одного `(kind, featuresVersion)` обучены на **одном и
том же feature view**, поэтому LR — корректный fallback при сбое ml-service.

**Источник истины:** `scripts/src/lib/hero-features.ts` + зеркало
`artifacts/api-server/src/lib/hero-features.ts`. Эти два файла **обязаны
быть побайтово идентичными** в части `*_FEATURE_NAMES`, `*_FEATURE_DIM`,
`buildHeroFeatures`, `buildExtraFeatures` (только импорты могут отличаться).

**Train scripts:**
- `scripts/src/train-model.ts` — LR (`train:model`) — все bucket'ы LR.
- `scripts/src/train-lightgbm.ts` — LightGBM (`train:lightgbm`) — через ml-service.

Оба читают одни и те же таблицы (`pro_matches`, `match_drafts`,
`team_recent_form`, `team_h2h`, `team_extended_features`, `hero_stats`,
`hero_matchups`, `hero_synergy`, `player_hero_stats`, `player_ratings`).

**Контракт-инвариант (надо тест):** для случайной выборки из 10 матчей
из обучающей таблицы — `buildExampleFeatures()` в `train-model.ts` и в
`train-lightgbm.ts` дают **байтово одинаковый** float-вектор. Сейчас этот
инвариант поддерживается ручной дисциплиной — в T1.future надо добавить
`scripts/src/test-feature-parity.ts`.

**Атомарный swap (`train-lightgbm.ts:585`):**
```sql
BEGIN;
  UPDATE model_versions
     SET is_active = false
   WHERE kind IN ('prematch_winner', 'prematch_winner_t1', ...)
     AND is_active = true
     AND engine = 'lightgbm';        -- ВАЖНО: LR не трогаем
  INSERT INTO model_versions (...) VALUES (...);  -- batch новых LightGBM
COMMIT;
```

Partial unique index `model_versions_one_active_per_kind_engine_idx ON
(kind, features_version, engine) WHERE is_active` гарантирует, что после
коммита не может остаться двух активных моделей одного `(kind, fv, engine)`.

**LR ↔ LightGBM swap независимы:** retrain `train:model` дезактивирует только
активные `engine='logreg'`, `train:lightgbm` — только `engine='lightgbm'`.
Это позволяет переобучать движки независимо (например, добавил фичу — retrain
LR за 30 сек чтобы поднять fallback, потом LightGBM за 10 мин чтобы поднять
primary).

---

## 4. Маршрутизация инференса (fallback-цепочка)

Полностью реализовано в `PredictionModel.predictMatch()`. Псевдокод:

```
tier      = classifyTier(team1.rating, team2.rating)  // t1 | t2 | t3
kind_pref = tierKind(tier)  // prematch_winner_t1 / _t2 / _t3
kind_fb   = 'prematch_winner'  // tier-agnostic fallback

fv_pref = (есть draft && все 10 героев в hero_stats)
            ? (есть account_ids для 10 игроков ? 3 : 2)
            : 1

for kind in [kind_pref, kind_fb]:
  for fv in [fv_pref, 2, 1]:        // прыгаем вниз до v1
    for engine in ['lightgbm', 'logreg']:
      m = cachedModels.get(modelKey(kind, fv, engine))
      if not m: continue
      if engine == 'lightgbm' and not lightgbmAvailable(): continue
      feats = buildFeatures(fv)     // pure function, нейтральные значения если нет данных
      raw   = m.predict(feats)      // HTTP к ml-service ИЛИ in-proc LR
      if raw == null: continue       // ml-service упал → tripLightgbm() + LR того же fv
      return applyCalibration(raw, m.calibration)
return null  // полный отказ системы
```

**Circuit-breaker LightGBM:** 60 сек cooldown (`LIGHTGBM_BACKOFF_MS`) после
любого сбоя ml-service. В течение cooldown все запросы сразу идут на LR того
же `(kind, fv)`. Timeout per-request 200 мс.

**Логирование (`predict` tag):** каждый predict печатает выбранную модель
(`kind`, `fv`, `engine`, `version`) + raw → calibrated probability + время
инференса. Если был fallback — пишется причина (`featureDim mismatch`,
`ml-service timeout`, `tripped`, ...).

---

## 5. Контракт ml-service

Внутренний HTTP-сервис на FastAPI (`artifacts/ml-service/src/main.py`),
порт `:8090` (env `PORT`). Аутентификация по `x-ml-token` header.

### Эндпоинты

- `POST /predict` — `{ blob_b64, features: number[] }` →
  `{ raw_prob: number, calibrated_prob: number }`. Inference single LightGBM
  модели, blob распаковывается и кэшируется per-blob hash.
- `POST /train` — JSON с обучающей выборкой → `{ blob_b64, test_metrics,
  calib_metrics, feature_importance, ... }`. Используется только в
  `train-lightgbm.ts`. Calibration (`IsotonicRegression`) делается тут же
  и упаковывается в blob.
- `GET /health` — для readiness.

### Контракт по моделям

- ml-service не хранит state между запросами кроме LRU-кэша блобов.
- Все модели **живут в БД** (`model_versions.binary_blob`). ml-service —
  чистый pure-function engine.
- Если ml-service перезапущен — никакой потери: api-server при следующем
  `/predict` отправит blob, тот распакуется заново.

### Жизненный цикл

- ml-service workflow рестартуется автоматически после `pnpm install` или
  изменения python кода. api-server должен это пережить через circuit-breaker.
- Атомарный swap моделей в БД (см. §3) не требует рестарта ml-service —
  api-server подтянет новый блоб при следующем `loadActiveModel()` (после
  `POST /api/admin/refresh-models` или периодической перезагрузки).

---

## 6. Когда нужен retrain

**Триггеры (любой → retrain):**

1. **Изменили фичи** (`*_FEATURE_NAMES`, `*_FEATURE_DIM`, или семантику
   `buildXxxFeatures`) — ОБЯЗАТЕЛЬНО retrain LR + LightGBM в одной CL'е.
   Иначе `featureDim mismatch` → fallback на нижестоящую fv (тихая просадка
   качества).
2. **Накопилось ≥1000 новых строк** в обучающей таблице с прошлого retrain
   (для маленьких bucket'ов — ≥200).
3. **Прошёл патч Dota 2** — меняются hero winrates, item builds, meta. Меняем
   `hero_matchups`, `hero_stats`, потом retrain.
4. **Сменили источник** для фичи (например, hero_matchups OpenDota →
   Stratz DIVINE_IMMORTAL — другая matchCount шкала, см. `replit.md`).
5. **Drift на test split >10 п.п.** — `train-lightgbm.ts` печатает
   `DRIFT (>10%)` строкой; если drift большой — модель учится на одном
   распределении, инференс на другом, retrain должен повторяться.

**Триггеры НЕ для retrain:**

- Поменяли hero portrait в UI.
- Поменяли формулу calibration display (не саму калибровку, а её
  представление в API).
- Добавили endpoint, который не использует модель.

### Команды

```bash
# 1. (опционально) обогатить БД
pnpm --filter @workspace/scripts run ingest:teams
pnpm --filter @workspace/scripts run ingest:drafts
pnpm --filter @workspace/scripts run compute:recent-form
pnpm --filter @workspace/scripts run compute:h2h
pnpm --filter @workspace/scripts run compute:team-extended

# 2. retrain (порядок: LR быстро для fallback, потом LightGBM)
pnpm --filter @workspace/scripts run train:model        # ~30 сек, все LR bucket'ы
pnpm --filter @workspace/scripts run train:lightgbm     # ~10 мин, все LGBM bucket'ы

# 3. (если меняли derived markets)
pnpm --filter @workspace/scripts run train:market-models

# 4. (если live-фичи поменялись)
pnpm --filter @workspace/scripts run train:live-model
```

### Сравнение моделей между retrain'ами

⚠️ **Не сравнивай `test_accuracy` двух retrain'ов в лоб.** Источники
шума:

- **Train split по времени** (80/10/10 = train/calib/test) — разные retrain'ы
  имеют разные test sets (свежие матчи). Если новый патч изменил мета —
  test acc нового retrain может быть ниже, хотя модель сама лучше.
- **LightGBM run-to-run variance ±2-3 п.п.** на маленьких bucket'ах
  (типичный t3 < 2000 примеров).
- **Hard-match accuracy** (`hard_match_accuracy`, ELO close matches) —
  более стабильная метрика для сравнения качества.

Правильное сравнение: **A vs B на одном и том же test set** (как в T8
эксперименте — две модели тренируются на одном split, сравниваются
acc/brier/hard_acc).

---

## 7. Контракт с UI (мост к T2)

`model_versions` строка сериализуется через
`GET /api/admin/models/active` (admin) и `GET /api/analytics/model-status`
(public, без чувствительных полей).

```jsonc
{
  "version": "lgbm-prematch-winner-v3-t1-2026-05-16T13:00:00Z",
  "kind": "prematch_winner_t1",
  "engine": "lightgbm",
  "featuresVersion": 3,
  "createdAt": "2026-05-16T13:00:00Z",
  "testAccuracy": 0.612,
  "hardMatchAccuracy": 0.561,
  "trainSampleSize": 12500,
  "metadata": {
    "windowDays": 365,
    "featureImportance": [["player_glicko_diff", 0.18], ["matchup_advantage", 0.12], ...],
    "drift": { "team_glicko_diff": 0.07, ... }
  }
}
```

Mobile parses `version` как opaque строку (для отображения), `metadata` не
парсится клиентом (служебное для admin).

**Контракт ответа `/predict`:** `{ probability, confidence, source }` где:
- `probability ∈ [0, 1]` — вероятность победы radiant.
- `confidence` — категория `low | medium | high`, считается на api-server от
  `hardMatchAccuracy` × объём обучения × соответствие фичей (если v1 fallback —
  `low` даже если acc высокий).
- `source` — `"lightgbm-v3-t1"` или `"logreg-v1-fallback"` — opaque строка
  для UI badge.

---

## 8. Что НЕ покрыто контрактом (TODO)

1. **Feature parity test** между `train-model.ts` и `train-lightgbm.ts` —
   сейчас ручная дисциплина (см. §3).
2. **Explicit FEATURE_VIEW_VERSION** строка — сейчас `featureDim` рабочая
   защита, но недостаточная при добавлении взаимокомпенсирующих фичей
   (одну убрали, другую добавили, dim тот же).
3. **Drift alarm** — `train-lightgbm.ts` печатает в лог, но нет email/slack
   уведомления при drift >X%.
4. **Live-модель LightGBM** — сейчас только LR (см. `ml-feature-audit.md`
   gap 1). Добавится в T8.
5. **Live total_kills / total_duration модели** — сейчас экстраполяция
   темпа, не ML. Добавится в T3.5.
6. **A/B-эксперимент в проде** — две активные модели одного `(kind, fv,
   engine)` не разрешены индексом `oneActivePerKindEngineIdx`. Если захотим
   честный A/B — нужно расширить ключ (например, добавить `experiment_id`).

# ML Roadmap — Dota Edge Analyzer

План улучшения точности предсказаний прематч-модели. Четыре волны, каждая — самостоятельная завершённая итерация с метриками в админке.

**Текущая база (модель `lr-v2026-05-08-09-55-54`):**
- Логистическая регрессия, 5 фичей (bias + ELO diff + WR diff + experience diff + recent form diff)
- Test accuracy: ~55% (vs always-radiant baseline 54%)
- Brier score: 0.205
- Тренировочное окно: скользящие 180 дней, ~610 матчей с полными фичами
- Переобучение: каждые 30 дней либо сразу через 7 дней после нового патча

**Целевая метрика после всех 4 волн:** accuracy 65-70%, Brier 0.17-0.18.

---

## Волна 1 — Калибровка + раздельные модели по тирам

**Цель:** взять «бесплатный» прирост качества вероятностей и точности, не трогая фичи и не доингеcтя ничего нового.

**Ожидаемый эффект:** Brier ↓0.01–0.02, accuracy +1–3 п.п. (особенно на T1 матчах).

**Оценка работы:** 3–4 часа.

### 1.1 Бакетирование команд по тирам

Тир определяется по среднему Glicko-рейтингу пары команд (radiant + dire) / 2:

- **T1**: avg ≥ 1400 (топ-команды, чёткие фавориты не всегда работают)
- **T2**: 1200 ≤ avg < 1400 (мид-тир, много апсетов)
- **T3**: avg < 1200 (низший тир, шум доминирует)

Пороги — стартовые, после первого прогона смотрим распределение и подкручиваем (цель: ~33/33/33% матчей в каждом).

### 1.2 Изменения в БД

Расширить `model_versions.kind` enum (текстовое поле, без миграции):

- `prematch_winner_t1`
- `prematch_winner_t2`
- `prematch_winner_t3`
- `prematch_winner` — **оставляем для fallback**, когда тир не определяется (нет рейтинга у команды)
- `live_winner` — без изменений

В `metadata.tier` сохраняем bucket границы, count матчей в трейне, accuracy/Brier по этому тиру.

### 1.3 Изменения в скриптах

`scripts/src/train-model.ts`:
- После загрузки матчей — разбить на 3 бакета по тиру
- Натренировать 3 модели параллельно
- Сохранить с разными `kind`, каждая с `is_active=true` в своём kind
- Применить изотоническую калибровку (см. 1.4) поверх каждой и сохранить bins в `metadata.calibration`

`scripts/src/lib/isotonic.ts` (новый файл):
- Изотоническая регрессия методом Pool Adjacent Violators (PAV) — ~50 строк pure TS
- Вход: массив `(predictedProb, actualOutcome)` на out-of-fold предсказаниях
- Выход: монотонные bins для последующего маппинга `rawProb → calibratedProb`

### 1.4 Изменения в инференсе

`artifacts/api-server/src/services/PredictionModel.ts`:
- При загрузке грузить все 3 модели + fallback
- В `predict()`: вычислить тир пары → выбрать модель → применить `applyCalibration(rawProb, model.metadata.calibration)`
- Если у одной из команд нет Glicko рейтинга → fallback на `prematch_winner`

### 1.5 Метрики в админке

Расширить `/api/admin/metrics`: возвращать accuracy + Brier отдельно по `prematch_winner_t1/t2/t3` за последние 30/90 дней (`prematch_outcomes` уже хранит matchId → можно посчитать тир задним числом).

Web admin UI (`routes/adminUi.ts`): добавить таблицу «Точность по тирам».

### 1.6 Acceptance criteria

- [ ] `pnpm --filter @workspace/scripts run train:model` тренирует 4 модели (3 тира + fallback) и записывает их в БД
- [ ] API отдаёт калиброванную вероятность через `/api/analytics/ml-predict`, в ответе появляется поле `tier` и `rawProb`
- [ ] Admin → Метрики показывает accuracy/Brier отдельно по T1/T2/T3
- [ ] Brier на тестовой выборке улучшен хотя бы на 0.005 хотя бы для одного тира
- [ ] `replit.md` обновлён: новые модели, поле `tier`, изокалибровка

---

## Волна 2 — Hero / draft фичи

**Цель:** добавить самый сильный сигнал в прематч-модели — пики и баны героев. В Dota 2 драфт даёт 30–50% исхода матча.

**Ожидаемый эффект:** accuracy +5–10 п.п. (самый жирный буст).

**Оценка работы:** 1–2 дня. Самая длительная часть — ингест.

### 2.1 Источники данных

OpenDota:
- `GET /api/matches/{match_id}` — отдаёт `picks_bans[]` (10 пиков + 10–14 банов с порядком)
- Для каждого героя: `hero_id` (1–138), `team` (radiant/dire), `is_pick`, `order`
- `GET /api/heroStats` — агрегированная статистика по героям (win-rate в нашем патче, pro_pick/pro_ban счётчики)
- `GET /api/constants/heroes` — справочник 138 героев (имена, роли, primary_attr)

### 2.2 Новая схема

`lib/db/src/schema/dota.ts`:

```ts
export const matchDrafts = pgTable('match_drafts', {
  matchId: bigint('match_id', { mode: 'number' }).primaryKey(),
  radiantPicks: jsonb('radiant_picks').$type<number[]>().notNull(),  // [hero_id, ...] длина 5
  direPicks: jsonb('dire_picks').$type<number[]>().notNull(),
  radiantBans: jsonb('radiant_bans').$type<number[]>().notNull(),
  direBans: jsonb('dire_bans').$type<number[]>().notNull(),
  fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
});

export const heroStats = pgTable('hero_stats', {
  heroId: integer('hero_id').primaryKey(),
  name: text('name').notNull(),
  proPickRate: real('pro_pick_rate').notNull(),
  proBanRate: real('pro_ban_rate').notNull(),
  proWinRate: real('pro_win_rate').notNull(),
  patch: text('patch').notNull(),  // напр. "7.37c"
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const heroMatchups = pgTable('hero_matchups', {
  heroId: integer('hero_id').notNull(),
  vsHeroId: integer('vs_hero_id').notNull(),
  games: integer('games').notNull(),
  winRate: real('win_rate').notNull(),
  // PK: (heroId, vsHeroId)
});
```

### 2.3 Новые ингест-скрипты

- `scripts/src/ingest-drafts.ts` — берёт `pro_matches` без записи в `match_drafts`, идёт по 1.1 с/запрос, парсит `picks_bans`, складывает. Для 2873 матчей: ~52 минуты.
- `scripts/src/ingest-hero-stats.ts` — раз в неделю, забирает `/api/heroStats` (1 запрос).
- `scripts/src/ingest-hero-matchups.ts` — самое сложное: для каждой пары героев (138×137/2 = 9453 пары) делает `/api/heroes/{id}/matchups`. Это **138 запросов** на сторону одного героя × 60 сек/мин = ~3 минуты с rate limit.

### 2.4 Новые фичи в трейне

`scripts/src/train-model.ts` — добавить к фичевектору:

| Фича | Описание |
|---|---|
| `radiant_pick_strength` | Σ pro_win_rate пяти радиант-героев (нормализовано) |
| `dire_pick_strength` | то же для дайра |
| `pick_strength_diff` | radiant − dire |
| `matchup_advantage` | Σ по всем 25 парам radiant_hero × dire_hero `(winRate − 0.5) × log(games)` (взвешенное среднее матчапов) |
| `radiant_meta_score` | Σ pro_pick_rate (насколько драфт «в мете») |
| `dire_meta_score` | то же для дайра |
| `ban_priority_diff` | сколько high pick-rate героев каждая команда забанила сопернику |

Это +7 фичей к существующим 5 → 12 фичей.

### 2.5 Изменения в инференсе

Прематч-инференс получает hero_ids из live-матча (OpenDota `/api/live` отдаёт текущий драфт).

Для **upcoming** матчей до драфта — драфт ещё не сделан, поэтому:
- Если есть драфт → используем модель v2 (12 фич)
- Если нет драфта → fallback на v1 (5 фич)

Сохраняем **обе модели активными** (дискриминатор `metadata.featuresVersion`).

### 2.6 Acceptance criteria

- [ ] 90% существующих `pro_matches` имеют запись в `match_drafts`
- [ ] `hero_stats` обновляется при ингесте
- [ ] Trained model v2 (12 фич) показывает test accuracy на 5+ п.п. выше v1 на одном и том же held-out сете
- [ ] API роутит на v2 если драфт известен, на v1 иначе — без перебоев
- [ ] LiveWorker умеет дёргать v2 на live матчах

### 2.7 Риски

- OpenDota rate limit: premium key $0.0001/req, 3000 req/min (50 req/s), без дневного/месячного лимита. Бэкфилл идёт в `Replay Parse Loop` workflow на 20 req/s.
- Hero pool обновляется каждый патч → `hero_stats` нужно перетягивать при каждом новом патче (scheduler уже отслеживает патчи).
- В `picks_bans` иногда null для очень старых матчей → дропать при трейне.

---

## Волна 3 — Player position features (5 ролей)

**Цель:** добавить индивидуальную силу игроков по позициям. Команда — это не средний рейтинг, а конкретные люди в конкретных ролях. Замена керри в команде делает прогноз радикально другим.

**Ожидаемый эффект:** accuracy +2–5 п.п., но самый хрупкий пункт по данным.

**Оценка работы:** 3–5 дней.

### 3.1 Главная сложность: позиция игрока не в API

Dota 2 не маркирует позицию (1–5) в API. Стандартный способ её определить — эвристика по in-game метрикам:

- **Pos 1 (safe lane carry)**: max gold/min, max XP/min, играет в safe lane (radiant=bot, dire=top)
- **Pos 2 (mid)**: middle lane, второй по net worth, обычно высокий KDA
- **Pos 3 (offlane)**: hard lane, средний фарм, много гибов в среднем
- **Pos 4 (roaming support)**: низкий gold/min, много варды/смок, отсутствие на линии в первые 10 мин
- **Pos 5 (hard support)**: самый низкий gold/min, безлайнер с керри, max ward count

OpenDota отдаёт `lane_role` (1=safe, 2=mid, 3=off, 4=jungle), но это плохо различает 4/5. Используем композитную эвристику:

```ts
// scripts/src/lib/position-classifier.ts
function classifyPosition(player: PlayerInMatch): 1 | 2 | 3 | 4 | 5 {
  // 1. mid lane → pos 2
  if (player.lane_role === 2) return 2;
  // 2. сортируем 4 оставшихся по net worth: top → 1, второй → 3, третий → 4, нижний → 5
  // (с учётом lane_role: safe=1, off=3)
  // ...
}
```

### 3.2 Источники данных

OpenDota:
- `GET /api/teams/{team_id}/players` — топ-7 игроков команды по матчам с её юниформой за последний год. Это наш **roster proxy** (точного ростера нет).
- `GET /api/players/{account_id}` — профиль игрока (mmr_estimate, country, name).
- `GET /api/players/{account_id}/heroes` — статистика по героям (для будущих расширений).
- `GET /api/players/{account_id}/wl?date=180&significant=1` — win/loss за 180 дней по pro-играм.
- `GET /api/players/{account_id}/matches?date=180&significant=1&limit=100` — список матчей с GPM/XPM/KDA/lane_role для классификации позиций.

### 3.3 Новая схема

```ts
export const teamRosters = pgTable('team_rosters', {
  teamId: bigint('team_id', { mode: 'number' }).notNull(),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  position: integer('position'),  // 1..5, nullable если не удалось классифицировать
  gamesWithTeam: integer('games_with_team').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  // PK: (teamId, accountId)
});

export const playerStats = pgTable('player_stats', {
  accountId: bigint('account_id', { mode: 'number' }).primaryKey(),
  name: text('name'),
  mmrEstimate: integer('mmr_estimate'),
  position: integer('position'),  // основная позиция за последние 180 дней
  proWinsLast180d: integer('pro_wins_last_180d').notNull(),
  proLossesLast180d: integer('pro_losses_last_180d').notNull(),
  avgGpm: real('avg_gpm').notNull(),
  avgXpm: real('avg_xpm').notNull(),
  avgKda: real('avg_kda').notNull(),
  // Glicko-подобный персональный рейтинг, см. 3.4
  individualRating: real('individual_rating').notNull().default(1200),
  ratingDeviation: real('rating_deviation').notNull().default(350),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
```

### 3.4 Per-player «сила» (отдельная мини-модель)

Для каждого игрока считаем **позиция-aware Glicko-подобный рейтинг**:

- Каждый pro-матч игрока — это парный поединок «он vs соперник на той же позиции»
- Обновляем рейтинг по результату матча с учётом RD соперника
- Это даёт `individualRating` per player в диапазоне ~800–1800

**Почему отдельная модель, а не фичи в основной:** игроков ~3000, матчей ~600 — основная модель не выучит индивидуальные веса напрямую (overfitting). Сначала отдельный rater строит per-player скор, потом основная модель использует только агрегированные 5 чисел на команду.

### 3.5 Новые фичи в основной модели

К существующим 12 фичам (после волны 2) добавляем 7:

| Фича | Описание |
|---|---|
| `radiant_pos1_rating` | individualRating керри |
| `radiant_pos2_rating` | individualRating мидера |
| `radiant_pos3_rating` | individualRating оффлейнера |
| `radiant_pos4_rating` | individualRating сапа 4 |
| `radiant_pos5_rating` | individualRating сапа 5 |
| `dire_pos1..5_rating` | то же для дайра (5 фичей) |
| `roster_diff_total` | Σ радиант − Σ дайр |
| `weakest_link_diff` | min(radiant 5 рейтингов) − min(dire 5 рейтингов) — слабое звено часто решает |

Финальный фичевектор: 12 (волна 2) + 12 индивидуальных + 1 weakest-link = **~25 фичей**.

Здесь линейная регрессия начинает захлёбываться → переход на LightGBM (волна 4) становится оправдан.

### 3.6 Новые ингест-скрипты

- `scripts/src/ingest-rosters.ts` — раз в неделю, для всех команд из `team_ratings`: GET roster, классификация позиций, апсёрт в `team_rosters`. Только активная top-5 (по games).
- `scripts/src/ingest-player-stats.ts` — раз в неделю, для всех игроков из `team_rosters`: GET wl + последние 100 матчей, агрегация stats.
- `scripts/src/train-player-rater.ts` — раз в неделю после ингеста: проходит по всем pro-матчам с известными ростерами, обновляет individualRating по парным дуэлям.

Объём: ~1000 команд × 5 игроков × 2 запроса = 10000 запросов = ~3 часа с rate limit. Делать ночью раз в неделю.

### 3.7 Изменения в инференсе

Для матча: `radiantTeamId`, `direTeamId` → достаём top-5 активных игроков каждой → их `individualRating` по позициям → 12 фичей в модель.

Если у команды < 5 известных игроков (фарм-команда без истории) → fallback на модель без player фичей (модель v2 из волны 2).

### 3.8 Acceptance criteria

- [ ] `team_rosters` имеет хотя бы 5 игроков для top-200 команд по Glicko
- [ ] Позиции классифицированы для 80%+ игроков (остальные nullable)
- [ ] `individualRating` обучен на ≥1000 матчах
- [ ] Trained model v3 (25 фич, всё ещё LR) показывает test accuracy на 2+ п.п. выше v2
- [ ] API корректно роутит v3/v2/v1 в зависимости от доступности данных
- [ ] Admin показывает coverage: % матчей предсказанных с какой версией

### 3.9 Риски

- OpenDota не отдаёт текущий roster — только последние частые игроки команды. Реальные замены отслеживать сложно.
- Эвристика позиций ошибается на support-керри свапах в высоком тире (Tundra, Liquid любят).
- Для T3-команд (волна 1) данных по игрокам почти нет → они так и будут предсказываться по командному рейтингу.

---

## Волна 4 — LightGBM через REST + интерактивная инференс-калибровка

**Цель:** заменить логистическую регрессию на градиентный бустинг, чтобы модель могла поймать нелинейные взаимодействия между фичами (особенно hero matchup × player position × tier).

**Ожидаемый эффект:** сам по себе +0–2 п.п., но **раскрывает потенциал волн 2 и 3** — без него все эти фичи дают линейный сигнал.

**Оценка работы:** 1–2 дня.

### 4.1 Архитектура

Не пытаемся встроить LightGBM в Node — это native deps, кошмар на Replit. Вместо этого — отдельный лёгкий Python-сервис.

```
┌─────────────────┐  HTTP   ┌──────────────────────┐
│  api-server     │ ──────► │  ml-service (Python) │
│  (Express, Node)│         │  FastAPI + LightGBM  │
└─────────────────┘         └──────────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │  PostgreSQL     │
                              │  (model blobs)  │
                              └─────────────────┘
```

`ml-service`:
- FastAPI на uvicorn, отдельный artifact (`artifacts/ml-service`)
- Endpoint `POST /predict { features: number[] }` → `{ prob: number, model_id: string }`
- Endpoint `POST /train` (admin only) → блокирующий, тренирует и пишет в БД
- Модели хранятся в `model_versions` как pickled bytes в bytea поле (новое: `binary_blob`)
- Кеш модели в памяти, hot-reload при обновлении `is_active`

### 4.2 Изменения в БД

Расширить `model_versions`:
- `engine` text not null default 'logreg' — `'logreg' | 'lightgbm' | 'xgboost'`
- `binary_blob` bytea null — для не-JSON моделей
- Существующие LR модели работают как раньше через `weights` jsonb

### 4.3 Изменения в node-инференсе

`PredictionModel.ts`:
- Если `engine === 'logreg'` → считаем сами (как сейчас)
- Иначе → HTTP запрос в `ml-service` (timeout 200ms, fallback на LR)

Это даёт graceful degradation: если Python-сервис упал, LR-модель остаётся доступна.

### 4.4 Изменения в трейн-пайплайне

`scheduler` теперь триггерит:
1. ingest:teams (Node)
2. ingest:matches (Node)
3. ingest:drafts (Node, волна 2)
4. ingest:rosters + ingest:player-stats (Node, волна 3)
5. train:player-rater (Node, волна 3)
6. **train:lightgbm** (POST в ml-service, волна 4)
7. train:logreg (Node, fallback всегда есть)
8. train:live-model (Node)

### 4.5 Гиперпараметры

Стартовые для LightGBM (без heavy tuning, потом можно добавить Optuna):
- `num_leaves: 31`
- `learning_rate: 0.05`
- `n_estimators: 200`
- `min_data_in_leaf: 20`
- `feature_fraction: 0.8`
- Early stopping на валидации (20% holdout по matchId, без leakage)

Калибровка — `sklearn.calibration.CalibratedClassifierCV(method='isotonic', cv=5)`.

### 4.6 Acceptance criteria

- [ ] `artifacts/ml-service` поднимается, отвечает на `/healthz`
- [ ] `train:lightgbm` тренирует модели по тирам (волна 1) с фичами всех волн (2+3)
- [ ] Test accuracy LightGBM ≥ LR на тех же фичах
- [ ] Node-сервер корректно ходит в Python и graceful fallback при таймауте
- [ ] Метрики в админке показывают accuracy/Brier для каждого engine

### 4.7 Риски

- Python deps на Replit: проверить что lightgbm + sklearn встают через uv
- Сериализация моделей в БД (bytea) — pickle небезопасен при загрузке кода другой версии. Закрепить версию sklearn/lightgbm.
- Cross-process инференс добавляет ~5–20ms latency. Для live-предиктов (раз в 60с на матч) это ОК.

---

## Сводная таблица

| Волна | Что | Время | Δ accuracy | Δ Brier | Сложность данных | Риск |
|---|---|---|---|---|---|---|
| 1 | Калибровка + тиры | 3–4 ч | +1–3 пп | −0.01–0.02 | низкая | низкий |
| 2 | Hero / draft фичи | 1–2 дня | +5–10 пп | −0.02–0.04 | средняя | средний (rate limit) |
| 3 | Player position фичи | 3–5 дней | +2–5 пп | −0.01–0.02 | высокая | высокий (эвристика позиций) |
| 4 | LightGBM | 1–2 дня | +0–2 пп | −0.005–0.015 | низкая | средний (новый сервис) |
| **Итого** | | **6–10 раб. дней** | **+8–20 пп** | **−0.04–0.10** | | |

**Реалистичная конечная цель:** accuracy ~62–65% (vs текущие 55%), Brier ~0.18 (vs текущий 0.205).

---

## Зависимости между волнами

```
Волна 1 (тиры + калибровка) ──┐
                              ├──► Волна 4 (LightGBM использует всё)
Волна 2 (hero/draft) ─────────┤
                              │
Волна 3 (player positions) ───┘ (требует завершённую Волну 2 для согласованности фичей)
```

Можно делать 1, 2, 3 последовательно или 1+2 параллельно. Волна 4 — только в конце.

## Что делаем дальше

После утверждения этого плана:
1. Создаём проектную задачу под каждую волну (через `project_tasks` skill)
2. Каждая волна — отдельный чекпоинт, с метриками до/после в админке
3. Между волнами — пауза на наблюдение в проде (минимум неделя, чтобы накопить новые `prematch_outcomes` и измерить честную дельту)

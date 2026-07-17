# Aegis — Системная карта

> **Назначение этого документа.** Перед любой правкой я (агент) обязан
> прочитать соответствующий раздел и проверить, что моё изменение не ломает
> описанные здесь связи. При изменении архитектуры — обновлять этот файл
> в той же правке.

---

## 0. Слои системы (одна картинка)

```
                ВНЕШНИЕ ИСТОЧНИКИ
                       │
   ┌───────────┬───────┼─────────┬────────────┐
 OpenDota    Stratz  PandaScore Bookmakers  (The Odds API)
   │           │        │           │
   └─────┬─────┴────┬───┘           │
         │          │ live          │
         ▼          ▼               ▼
   scripts/         api-server      api-server
   ingest:* /       routes/         routes/
   compute:* /      matches.ts      bookmakers.ts
   train:*          live worker     bookmaker worker
         │              │                 │
         ▼              ▼                 ▼
            ┌──────  PostgreSQL  ──────┐
            │  teams, pro_matches,    │
            │  team_recent_form,      │
            │  team_h2h, ...          │
            │  model_versions         │
            │  predictions            │
            └────────────┬────────────┘
                         │
                  ┌──────┴───────┐
                  │ AnalyticsEngine
                  │ PredictionModel
                  │ MarketLgbm    │
                  │ (api-server)  │
                  └──────┬────────┘
                         │
                  ┌──────┴────────┐
                  │ ml-service     │
                  │ FastAPI/LGBM   │
                  └────────────────┘
                         │
                ┌────────┴─────────┐
              MOBILE (Expo)    ADMIN-WEB (Vite)
```

---

## 1. Внешние источники → таблицы БД

| Источник | Какие endpoints | Что вытаскивает | Куда пишет (таблицы) | Какой скрипт/сервис |
|---|---|---|---|---|
| **OpenDota** | `/api/teams` | рейтинг (ELO-like), name, tag | `teams` | `ingest:teams` |
| OpenDota | `/api/leagues` | название лиги | `leagues` | `ingest:leagues` |
| OpenDota | `/api/proMatches` | список pro-матчей | `pro_matches` | `ingest:matches` |
| OpenDota | `/api/matches/{id}` | picks/bans + accountId radiant/dire | `match_drafts`, `players` | `ingest:drafts` |
| OpenDota | `/api/players/{id}/heroes` | per-player hero winrate | `player_hero_stats` | `ingest:players-heroes` (если нет Stratz) |
| OpenDota | `/api/heroStats` | hero meta winrate / pickrate | `hero_stats` | `ingest:hero-stats` |
| OpenDota | `/api/heroes/{id}/matchups` | hero-vs-hero | `hero_matchups` | `ingest:hero-matchups` (fallback) |
| OpenDota | `/api/live` | живой game state, draft, scores | `live_snapshots` (через LiveWorker) | `LiveWorker.ts`, `routes/matches.ts::/live` |
| **Stratz** | GraphQL `match.players.heroDetails` | per-player per-hero stats | `player_hero_stats` | `ingest:players-heroes` (primary) |
| Stratz | GraphQL `heroStats.matchUp` | hero-vs-hero (DIVINE+) | `hero_matchups` | `ingest:hero-matchups` (primary) |
| Stratz | `/League/live` | дополнительный live-фид | (in-mem, прямо в `/api/matches/live`) | `routes/matches.ts` |
| **PandaScore** | `/dota2/matches/upcoming` | upcoming-расписание | (in-mem, прямо в `/api/matches/upcoming`) | `routes/matches.ts::/upcoming` |
| PandaScore | `/dota2/matches/running` | live fallback с официальными именами | (in-mem) | `routes/matches.ts::/live` |
| **Bookmakers** | Bovada + 6 РФ | odds события | `odds_snapshots` (опционально), in-mem кэш `BookmakerWorker` | `services/BookmakerWorker.ts` |

> ⚠️ **PandaScore НЕ пишет в БД.** Он только рантайм — мерджится в ответ
> `/api/matches/upcoming` и `/api/matches/live`. **Проблема №1 (50/50):**
> PandaScore возвращает СВОИ team_id (137588), а ML-модель училась на
> OpenDota team_id (9964962). Резолвер по имени из `teams` (см. §6) — это
> мост между PandaScore и OpenDota id'шниками.

---

## 2. БД-схема (полная) — что где лежит

| Таблица | Ключевые поля | Кто пишет | Кто читает (predict-time) |
|---|---|---|---|
| `teams` | `team_id` (OpenDota), `name`, `tag`, `rating`, `wins`, `losses`, `last_match_time` | `ingest:teams` | **AnalyticsEngine, PredictionModel (буквально каждый предикт)** |
| `leagues` | `league_id`, `name`, `tier` | `ingest:leagues` | `routes/matches.ts` (enrichment) |
| `pro_matches` | `match_id`, `radiant_team_id`, `dire_team_id`, `radiant_win`, `start_time`, `duration`, `series_type`, `league_id` | `ingest:matches` | все compute:* и train:* скрипты |
| `match_drafts` | `match_id`, `radiant_picks[]`, `dire_picks[]`, `radiant_account_ids[]`, `dire_account_ids[]` | `ingest:drafts` | train:lightgbm (v2/v3), `LiveWorker` (через draft hash) |
| `players` | `account_id`, `personaname`, `last_seen` | `ingest:players-heroes` | косвенно через `player_hero_stats` |
| `player_hero_stats` | `account_id`, `hero_id`, `games`, `winrate` | `ingest:players-heroes` | `PredictionModel.buildExtraFeatures` (v3 фича player_hero_skill_diff) |
| `player_ratings` | `account_id`, `rating`, `rd`, `last_updated` (Glicko-1) | `compute:player-glicko` | `PredictionModel.buildExtraFeatures` (v3 фича player_glicko_diff) |
| `team_recent_form` | `team_id`, `period_days`, `wins`, `losses`, `avg_kills`, `avg_duration` | `compute:recent-form` | `PredictionModel`, `AnalyticsEngine` (фича recent_form_diff) |
| `team_h2h` | `team1_id`, `team2_id`, `period_days`, `wins1`, `wins2` | `compute:h2h` | `PredictionModel.buildExtraFeatures` (v3 фича h2h_diff) |
| `team_extended_features` | `team_id`, `win_streak`, `days_since_last`, `fb_rate_30d`, `avg_duration_30d` | `compute:team-extended` | `PredictionModel.buildTeamFeatures` (v1+ фичи) |
| `hero_stats` | `hero_id`, `pick_rate`, `win_rate`, `pro_pick`, `pro_win` | `ingest:hero-stats` | `PredictionModel.buildHeroFeatures` (v2+ pick_strength) |
| `hero_matchups` | `hero_id`, `against_hero_id`, `games`, `wins` | `ingest:hero-matchups` | `PredictionModel.buildHeroFeatures` (v2+ matchup_advantage) |
| `bo3_series` | `series_id`, `match_ids[]`, `radiant_team_id`, `dire_team_id`, `radiant_wins`, `dire_wins` | `compute:bo3-series` | series-level aggregations, train:* |
| `live_snapshots` | `match_id`, `game_time`, `radiant_score`, `dire_score`, `nw_lead`, `building_state`, `picks_bans`, `taken_at` | `LiveWorker.pollOnce` | `train:live-model`, live-винер runtime |
| `predictions` | `match_id`, `bet_type`, `prob_team1`, `confidence`, `model_version`, `created_at` | `routes/analytics.ts::/predict` (history log) | `prematch_outcomes` join, history view |
| `prematch_outcomes` | `match_id`, `predicted_winner`, `actual_winner`, `confidence`, `created_at` | `OutcomeTracker` | `train:live-model` (live × outcomes), backtest |
| `model_versions` | `kind`, `version`, `engine`, `features_version`, `is_active`, `train_accuracy`, `test_accuracy`, `brier_score`, `train_sample_size`, `test_sample_size`, `hard_match_accuracy`, `hard_match_brier`, `hard_match_count` | `train:*` скрипты (atomic per-bucket swap) | `MarketLgbm.loadActive`, `PredictionModel.loadActive` |
| `odds_snapshots` | `match_id`, `bookmaker`, `market`, `odds_team1`, `odds_team2`, `taken_at` | `BookmakerWorker` (опционально) | history queries |
| `app_settings` | global config (alert thresholds и т.д.) | admin-web | runtime |
| `api_key_overrides` | env override map (intercept `getApiKey()`) | admin-web settings | `lib/ApiKeysService` |
| `scheduler_state` | `last_ingest_at`, `last_train_at`, `last_patch_seen`, `last_error`, `notes (jsonb)` | `SchedulerWorker` | dashboard.tsx |
| `server_subscriptions` | push tokens (mobile) | mobile alerts | alert worker |

---

## 3. Версии фич (features_version)

Модели обучаются под фиксированную версию фичей. Версия пишется в
`model_versions.features_version`. **При предикте подгружается активная
модель ТОЙ версии, фичи которой реально удалось собрать.**

| FV | Что добавляется поверх предыдущей | Зависит от данных |
|---|---|---|
| **v1** Базовая | `bias`, `elo_diff_norm`, `winrate_diff`, `experience_diff`, `is_high_tier`, `radiant_side_logit`, `recency_days_norm`, `series_type_norm`, `map_no_norm`, `tier_t1/t2/t3`, + 6 фич `team_extended_features` | `teams`, `team_recent_form`, `team_extended_features` |
| **v2** Draft | v1 + 7 фич: `matchup_advantage`, `pick_strength_diff`, `ban_priority_diff`, ... | + `match_drafts`, `hero_stats`, `hero_matchups` |
| **v3** Full | v2 + `player_glicko_diff`, `player_hero_skill_diff`, `recent_form_diff`, `h2h_diff` | + `players`, `player_hero_stats`, `player_ratings`, `team_h2h` |

**Маршрутизация на predict-time:**
- если у матча НЕТ драфта (прематч задолго до игры) → выбираем v1
- если есть draft, но нет account_ids → v2
- если есть всё → v3

Внутри каждой FV ещё разрезаемся по тиру (`t1`/`t2`/`t3`/`fallback`) — у топовых
матчей своя модель.

---

## 4. Двигатели предсказания

### 4.1 `services/AnalyticsEngine.ts` — математический baseline

`runAnalytics(input, bookmakerOdds?)` — детерминированный «учительский»
расчёт **всех 15 рынков** на основе ELO/формы/heuristics. Возвращает
`PredictionResult[]`. Используется как fallback и как основа для рынков,
где нет ML.

`MatchInput`:
```ts
{
  matchId: string;
  format: 'bo1'|'bo3'|'bo5';
  team1: { name; teamId?; elo?; form?; region? };
  team2: { name; teamId?; elo?; form?; region? };
  liveSnapshot?: { gameTime, radiantScore, ... };
  draft?: { radiantPicks[], direPicks[] };
}
```

Если `team*.elo` не передан — берёт `1700` (нейтральный fallback). Это
причина проблемы №1: с PandaScore-id'шниками enrichment в `/predict`
не видел рейтинг → 1700 vs 1700 → ELO impact = 0 → 50/50 во всех рынках.

### 4.2 `services/PredictionModel.ts` — ML match-winner

`mlPredictMatchWinner(radiantTeamId, direTeamId)`:
1. По обоим OpenDota team_id выбирает FV (v1/v2/v3) по доступности данных.
2. `buildTeamFeatures` → читает `teams`, `team_recent_form`, `team_extended_features`.
3. `buildHeroFeatures` (если v2+) → читает `match_drafts`, `hero_stats`, `hero_matchups`.
4. `buildExtraFeatures` (если v3) → читает `player_ratings`, `player_hero_stats`, `team_h2h`.
5. Шлёт фичи в `ml-service` (LightGBM, 200ms timeout). Если 401/timeout/circuit-breaker — fallback на pure-JS LR из `model_versions` (engine=`logreg`).

**Все 4 builder'а используют OpenDota `team_id` как ключ.** PandaScore-id
здесь = промах кэша = nullable feature = усреднение к baseline.

### 4.3 `services/MarketLgbm.ts` — derived markets

15 рынков в `BetTypeModels.ts`. Часть имеет ML-модель в `model_versions`
(kind=`market_*`):
- `market_first_blood` (LGBM classifier)
- `market_total_kills` (LGBM regression)
- `market_total_duration` + `_q25` + `_q75` (LGBM regression + quantile)

Остальное — чистая математика на `runAnalytics`:
map_winner, correct_score, map_handicap, comeback_live, first_tower,
first_roshan, networth_lead, first_barracks, over_under_maps,
kills_handicap, draft_advantage.

### 4.4 `services/LiveWorker.ts` + live_winner

LiveWorker каждые 60s опрашивает OpenDota `/api/live`, дедуплицирует по хешу
(game_time + scores + nw_lead + building_state + draft) — если ничего не
изменилось, **снапшот не пишется**. Сохраняет в `live_snapshots`.

`LiveWinnerModel` (kind=`live_winner`) — 9-мерная LR:
`game_time_norm, nw_lead_norm, kill_diff_norm, tower_diff_norm,
prematch_logit (как prior), is_real_live, has_draft, ...`. Live-винер ОТДЕЛЬНО
от prematch ML и НЕ заменяет его — он переоценивает с учётом game state.

---

## 5. Рантайм-кэши (in-memory, на api-server)

| Кэш | TTL | Где |
|---|---|---|
| `teamRatings` | 60 мин | `PredictionModel` (Map<team_id, rating>) |
| `teamExtendedCache` | 30 мин | `PredictionModel` |
| `heroStatsCache` | 60 мин | `PredictionModel` |
| `heroMatchupsCache` | 60 мин | `PredictionModel` |
| `playerHeroStatsCache` | 30 мин | `PredictionModel` |
| `playerGlickoCache` | 30 мин | `PredictionModel` |
| `recentFormCache` | 15 мин | `PredictionModel` |
| `h2hCache` | 30 мин | `PredictionModel` |
| `cachedModels` | до retrain | `PredictionModel` (LR/LGBM blob) |
| `withCache('matches:live')` | 30s | `lib/responseCache` |
| `withCache('matches:upcoming')` | 60s | `lib/responseCache` |
| `withCache('predict:prematch:...')` | 4 часа | `routes/analytics.ts::/predict` |
| `teamResolveCache` | 30 мин, max 2000 entries (LRU) | `routes/analytics.ts` (новый, для §6) |
| `BookmakerWorker.cache` | переписывается каждый tick | `services/BookmakerWorker` |

**Сброс всех кэшей:** admin-web кнопка «Обновить приложение» →
`POST /api/admin/refresh-all`. Используется когда стрим встал и TTL «застрял».

---

## 6. КАК РАБОТАЕТ /api/analytics/predict ПОСЛЕ ФИКСА 50/50

```
mobile отправляет POST /predict с {
  matchId: "ps-12345",
  team1: { name: "GamerLegion", teamId: 137588 },   ← PandaScore id
  team2: { name: "Team Spirit",  teamId: 1001 },     ← тоже PS
  format: "bo3"
}
                │
                ▼
       enrichInputWithRealTeams(input)
       ─ для каждой команды:
         1. resolveOpenDotaTeam(name, providedId)
         2. сначала пробует providedId → SELECT teams WHERE team_id=137588 → null
         3. fallback по имени: SELECT teams WHERE name ILIKE '%gamerlegion%'
            → находит (9964962, "GamerLegion", rating=1623)
         4. экзакт-матч после нормализации (убираем регистр/пунктуацию)
         5. подменяет teamId на 9964962, проставляет elo=1623
         (LRU кэш на 30 мин, max 2000 entries)
                │
                ▼
       runAnalytics(input, bookmakerOdds)
       ─ 15 рынков с реальными ELO/формами вместо 1700-default
                │
                ▼
       applyMlMatchWinner(input)
       ─ если оба teamId валидны → mlPredictMatchWinner(9964962, 1001)
       ─ читает teams/recent_form/extended → строит фичи v1/v2/v3
       ─ инференс через ml-service (LightGBM) или LR fallback
       ─ ПЕРЕОПРЕДЕЛЯЕТ prediction для match_winner
                │
                ▼
       writePredictionToDB(predictions[])
                │
                ▼
       cache 4 часа, return JSON
```

**Что фикс гарантирует:**
- ✅ ELO/форма теперь подтягиваются по реальным OpenDota id для команд из PandaScore-фида.
- ✅ ML-модель перестаёт получать null рейтинги → фичи real-valued → выходит из «50/50»-зоны.
- ✅ Если резолв не нашёл команду (новая команда без матчей в OpenDota) — старое поведение: математика с elo=1700, ML просто не вызывается. Не хуже чем было.

**Что фикс НЕ ломает:**
- ❌ Не меняет ни одну схему БД.
- ❌ Не трогает обучение моделей — они продолжают учиться на OpenDota team_id из `pro_matches`.
- ❌ Не меняет live-пайплайн (LiveWorker сразу работает с OpenDota id из `/api/live`).
- ❌ Не меняет input-формат для мобилы.

**Чего фикс НЕ покрывает:**
- Если у команды в `teams` несколько строк под одним именем (например, у Virtus.pro 4 разных team_id — VP-эпохи разных лет), резолвер берёт ту с **максимальным rating**. Это статистически правильно (текущий VP), но в редких случаях может промахнуться.
- Если у команды в `teams` имя записано иначе чем в PandaScore (например, "BetBoom Team" vs "BB Team") — нужно расширять normalize: уже убираем регистр/пунктуацию, но не ловим аббревиатуры.

---

## 7. /api/matches/live и /api/matches/upcoming — как мерджатся источники

### `/live`
1. Параллельно (5s timeout каждый): OpenDota `/api/live`, Stratz `/League/live`, PandaScore `/running`.
2. OpenDota фильтруется: только `league_id > 0` или `team_id_*radiant/dire > 0` (выкидываем паблики).
3. Дедуп по паре team_id (одна серия не должна показаться дважды).
4. Если PandaScore есть — обогащаем OD данные счётом серии и `current_map`.
5. Подмешиваем picks/bans через `enrichLiveMatchesWithDrafts` (per-match cache 60s).
6. **Fallback:** если OpenDota вернул 0 матчей → берём из PandaScore `running` (без real game state, только команды + турнир).
7. Кэш 30s, не кэшируется если `noData=true`.

### `/upcoming`
1. PandaScore `/dota2/matches/upcoming`.
2. Маппится в унифицированный shape `{matchId, team1, team2, scheduledStart, league}`.
3. Кэш 60s.

---

## 8. Как фронт получает прогноз

`mobile/services/LiveDataService.ts::fetchLiveData(cbs)`:
1. `/api/matches/live` + `/api/matches/upcoming` параллельно → колбэк `onShellsReady` рисует «скелеты».
2. Bounded pool concurrency=3 — для каждого матча (live первыми, upcoming следом):
   - `POST /api/analytics/predict` с `{matchId, team1, team2, format, liveSnapshot?, draft?}`
   - cache: для прематча 4 часа, для live не кэшируется
3. `onMatchEnriched(em, i)` строго в порядке i (через буфер). Первая карточка обновляется первой.
4. AbortSignal: при новом `loadData` (refresh / interval) старый цикл отменяется.

---

## 9. Что я (агент) обязан проверять перед изменением

| Меняю код в … | Что обязательно перепроверить |
|---|---|
| `routes/analytics.ts::/predict` | Не сломал ли team-resolver. Не изменил ли формат cache key (старые cache miss-нутся, это ОК). Bookmaker odds preserved? |
| `routes/matches.ts::/live` | Дедуп по паре team_id, fallback на PS, picks/bans обогащение. Не убрал ли filter `league_id > 0`. |
| `routes/matches.ts::/upcoming` | Кэш 60s, маппинг shape. |
| `PredictionModel.ts` | Не сломал ли feature builders (порядок фич ВАЖЕН — модель обучена на конкретном порядке). Все 4 builder'а должны вызываться в той же последовательности. Кэши не tightened ли (TTL не уменьшен). |
| `AnalyticsEngine.ts` | `MatchInput` shape (если меняешь — проверь все места где создаётся, особенно мобилку). Defaults `elo=1700`. |
| `MarketLgbm.ts` | Только market_* модели, не трогать prematch_winner. |
| `LiveWorker.ts` | Дедуп-хеш (если поменял — все live-матчи перезапишут снапшоты). |
| `lib/db/src/schema/dota.ts` | ОБЯЗАТЕЛЬНО `pnpm --filter @workspace/db run push` после правки. Все новые поля должны быть nullable, иначе ingest сломается. |
| `model_versions.feature_version` | Если добавил фичу — старые модели НЕ должны её получать. Для каждой FV свой набор фич, builder проверяет FV. |
| `lib/api-spec/openapi.yaml` | После правки — `pnpm --filter @workspace/api-spec run codegen`. |
| Любой ingest/compute/train скрипт | Идемпотентность (повторный запуск не должен задвоить). Atomic swap для моделей (`is_active=true` ставится одной транзакцией). |
| admin-web | `pnpm --filter @workspace/admin-web run typecheck` после правки. Кэши React Query инвалидируются после мутаций (см. примеры в operations.tsx). |
| mobile | НЕ меняй `MatchInput` shape без правки `LiveDataService.ts`. UI русский. |

---

## 10. Известные хрупкие места

1. **PandaScore team_id ≠ OpenDota team_id.** Резолвер по имени (см. §6) — единственный мост. Если PS поменяет имя команды или у нас в `teams` будет старое — снова 50/50 для этой пары. Мониторинг: смотреть логи `[predict] reason=feature_missing`.
2. **Stratz Cloudflare.** Node fetch блокируется по TLS JA3, клиент падает на curl. Смена среды Replit может сломать fallback.
3. **OpenDota /api/live иногда возвращает stale data.** LiveWorker дедуп по хешу частично решает, но новый snapshot всё равно может быть тем же. Stat `skippedUnchanged` в `getWorkerStats()`.
4. **Прематч-кэш 4 часа.** Если поменял ML-модель — кнопкой «Обновить приложение» сбросить, иначе мобила 4 часа будет видеть старые предикты.
5. **PandaScore `/running` может показывать только что закончившиеся матчи** ещё минуту-две. Сейчас фильтра по `winner !== null` нет — TODO.
6. **Атомарность train-swap.** `train:lightgbm` обновляет per-bucket (FV × tier), не полностью все 12 ячеек одновременно. Между swap'ами система может временно mix'ить старую и новую FV-маршрутизацию, но это безопасно — каждая модель сама согласована.

---

## 11. Pointers

- `replit.md` — high-level overview + user preferences.
- `docs/operations.md` — справочник ingest/compute/train скриптов, env-переменных, STRATZ multi-token pool.
- `docs/architecture.md` — API endpoints (контракт), admin & settings, bookmakers, gotchas, реестр log-тэгов.
- `docs/changelog.md` — хронология крупных изменений.
- `threat_model.md` — модель угроз для security-сканов.
- Эта карта (`docs/system-map.md`) — **источник правды по связям сервисов**. Обновлять при каждом архитектурном изменении.

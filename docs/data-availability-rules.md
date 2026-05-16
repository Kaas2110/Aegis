# Data Availability Rules — Aegis (T2)

Контракт «когда показывать данные / спиннер / "перерыв" / "недоступно"».
Это **нормативный документ для UI и API**. Если поле приходит с бэка —
mobile **обязан** обработать его по этим правилам, без молчаливых fallback'ов.

Сопутствующие:
- `docs/ml-contract.md` (T1) §7 — формат `/predict` и `model-status`.
- `docs/system-map.md` — источники → таблицы → фичи.
- `replit.md` → «User preferences» — «никаких фейк-данных, либо реальное, либо
  явный текст "данные недоступны"».

---

## 1. Семь временных корзин (универсальная шкала)

Используется для **любого** поля, у которого есть `capturedAt` или `updatedAt`.
Возраст считается от **server-now** на момент рендера.

| Возраст | Состояние | UI правило |
|---|---|---|
| 0-90 сек | **fresh** | Показываем как есть |
| 90 сек - 3 мин | **stale-soft** | Показываем, но добавляем мини-спиннер / «обновляется…» рядом |
| 3 - 25 мин | **stale-hard** | Скрываем числовое значение, рендерим плашку **«ПЕРЕРЫВ / данные обновляются»** (не путать с `between_maps`, см. §3) |
| 25 мин - 6 час | **likely-ended** | Поле скрыто. Если это live-матч — карточка матча уходит из «live» в «архив» |
| > 6 час | **historical** | Поле обрабатывается как историческое (берём из `pro_matches` если есть, иначе скрываем) |
| **permanent_unavailable** | особый | Поле **никогда не появится** для этого матча/контекста (см. §4). Скрываем навсегда, никаких спиннеров. |
| **between_maps** | особый | Не возраст, а явный флаг с бэка (см. §3). Все live-поля заменяются плашкой «между картами». |

**Реализация на mobile:** хелпер `getFieldState(capturedAt, permanent?)` →
union type, единая точка истины. **Запрещено** компонентам самим сравнивать
`Date.now() - x`.

---

## 2. Источники данных и их обновление

### 2.1 OpenDota `/api/live` (60 сек кэш api-server)

**Даёт:** `match_id`, `game_time`, `radiant_lead`, `radiant_score`,
`dire_score`, `building_state`, `players[].{hero_id, gold, last_hits, denies,
net_worth}`, `activate_time`.

**НЕ даёт (permanent_unavailable для этого источника):**
- `xp_per_min`, `xp_total`
- `buyback_state` (cooldown / charges)
- `aegis_holder`
- `roshan_state` (alive / dead time / spawn window)
- `per-hero gold` (только агрегатный team gold доступен)
- `picks_bans`

Эти поля **существуют объективно** в матче, но OpenDota их не публикует.
Получим через Stratz live (T0.5) или OpenDota post-match `/api/matches/{id}`
после конца карты.

### 2.2 OpenDota `/api/matches/{match_id}` (live-draft enrichment)

**Даёт во время матча:** `picks_bans` (как только драфт стартовал), team_ids,
league_id.

**Свежесть:** запрос делается раз в 60 сек параллельно с `/api/live`.
Драфт **появляется** в OpenDota обычно через 30-90 сек после старта пика.

### 2.3 PandaScore `/dota2/matches/running` (60 сек кэш)

**Даёт:** счёт серии (`radiant_series_wins` / `dire_series_wins`),
`current_map`, `number_of_games`, ID карты в PandaScore, `between_maps` флаг.

**Назначение:** PandaScore — источник истины для **состояния серии**.
OpenDota /live кэширует данные предыдущей карты ещё минуту после её конца —
PandaScore это ловит и помечает `between_maps: true`.

### 2.4 Stratz `/League/live` (60 сек кэш, round-robin токен)

**Даёт сейчас:** league/match presence, server steam ID.

**Даст после T0.5:** xp_per_min, buyback_state, aegis_holder, roshan_state,
per-hero gold/xp/lh/dn, kill timeline.

### 2.5 `live_snapshots` (запись каждые 60 сек LiveWorker'ом)

Снапшот в БД для ML и backtest. Только для матчей, которые `between_maps:false`.
Если `source='backfill'` — снапшот синтезирован из OpenDota post-match.

---

## 3. Флаг `between_maps`

**Источник истины:** `enrichWithPandaScoreRunning()` в
`routes/matches.ts`. Признаки:

- PS вернул серию с `finished.length > 0` но без `running` игры, **или**
- `running.begin_at > opendota.activate_time + 60 сек` (OD ещё показывает
  прошлую карту).

**Что делает бэк при `between_maps:true`:**
- `game_time = 0`, `radiant_score = 0`, `dire_score = 0`, `radiant_lead = 0`,
  `draft = undefined`.
- **Не пишет live snapshot.**
- **Не вызывает live-винер модель** (она бы получила нули и выдала мусор).

**Что обязан делать mobile при `between_maps:true`:**
- Скрыть: game_time, score, NW lead, building_state, draft, live-винер
  prediction, любые live-totals.
- Показать: «Серия N:M, готовится Map X/Y», прематч-прогноз остаётся видим
  (он не зависит от live).
- Series момент (после T3) **сохраняется** — он считается от завершённых карт.

**`between_maps` ≠ stale-hard.** Это явный валидный state «карта закончилась,
следующая в драфте», обычно длится 3-15 мин. **Никакого спиннера** —
понятная плашка «ПЕРЕРЫВ МЕЖДУ КАРТАМИ».

---

## 4. Permanent_unavailable — таблица решений

Поле помечается permanent_unavailable если **известно, что данное поле для
данного матча/контекста не появится**. UI скрывает его **без плашки**.

| Поле | Когда permanent_unavailable | Причина |
|---|---|---|
| `xp_per_min`, `buyback`, `aegis`, `roshan`, per-hero gold | live-матч **без** Stratz live (до T0.5 — всегда) | OD /live не отдаёт |
| `picks_bans` | live-матч в **первые 30 сек** после начала | Драфт ещё не начался — это **временно**, НЕ permanent. Стрим спиннер. |
| `picks_bans` | live-матч с `between_maps:true` | На карте идёт пауза. Появится когда стартует новый драфт. |
| `account_ids` для игроков | приватные lobby / без Steam binding | Permanent. v3 фичи (player_glicko, player_hero_recency) не рассчитываются. |
| `team1Id` или `team2Id` (rating) | команда вне топ-1000 OpenDota | Permanent для этого матча — модель уходит на v1/v2 без `is_high_tier`. |
| `hero_matchups` / `hero_synergy` для пары | пара не встречалась ни разу за окно | Permanent. Используем нейтральное 0.5. |
| `series_momentum` (после T3) | первая карта серии | Permanent для Map 1. Показываем «—». |
| Live-винер prediction | `between_maps:true` ИЛИ нет live snapshot | Временно: появится когда стартует новая карта. |
| Bookmaker odds | букмекер заблокирован для Replit-IP **в деве** | В проде с РФ-IP появится. На деве — permanent. |
| `first_blood_time` для live-матча | до момента первого килла | Временно (stale-soft → fresh когда случится). |

**Реализация:** API возвращает `{ value, source, permanent_unavailable: boolean,
captured_at?: ISO }`. Mobile-хелпер `getFieldState()` смотрит сначала
`permanent_unavailable`, потом `captured_at`.

---

## 5. Контракт состояния матча

Матч имеет один из четырёх ярлыков `match_state`. Бэк его проставляет
явно, mobile **не вычисляет**.

| `match_state` | Признаки | Что показываем |
|---|---|---|
| `pre_match` | start_time в будущем, нет live snapshot | Только прематч-прогноз, draft TBD |
| `live` | в OD /live, не `between_maps`, last snapshot < 90с | Полный live-режим |
| `between_maps` | флаг с PandaScore (см. §3) | Плашка «ПЕРЕРЫВ» + серия + прематч |
| `archived` | last snapshot > 25 мин ИЛИ есть финальный счёт в pro_matches | Карточка уходит в «архив», live-данные скрыты, прогноз остаётся как «исторический» |

**Переходы:**
- `pre_match → live`: первый live snapshot записан, `between_maps=false`.
- `live → between_maps`: PandaScore сказал так.
- `between_maps → live`: новый draft стартовал (PS running game появилась),
  будет новый live snapshot.
- `live → archived`: 25 мин без snapshot ИЛИ pro_match запись появилась.
- `between_maps → archived`: серия закончилась (PS вернул `winner` на серию).

---

## 6. Контракт ответа от API

### 6.1 `/api/matches/live`

```jsonc
{
  "match_id": 8123456789,
  "match_state": "live",                 // pre_match | live | between_maps | archived
  "between_maps": false,                 // legacy, дублирует match_state == 'between_maps'
  "captured_at": "2026-05-16T14:23:11Z", // когда снапшот записан в live_snapshots
  "game_time": 1234,                     // null если between_maps или pre_match
  "radiant_score": 18,
  "dire_score": 12,
  "radiant_lead": 4500,                  // gold lead
  "building_state": 2097151,
  "draft": { /* picks_bans или null */ },
  "live_fields": {
    "xp_per_min": null,                  // permanent_unavailable до T0.5
    "buyback_state": null,
    "aegis_holder": null,
    "roshan_state": null
  },
  "_field_meta": {
    "xp_per_min": { "permanent_unavailable": true, "reason": "od_live_no_stratz" },
    "draft": { "captured_at": "2026-05-16T14:22:50Z" }
  }
}
```

### 6.2 `/api/matches/upcoming`

`match_state = pre_match`, нет live полей, только teams + start_time + draft (если уже опубликован).

### 6.3 `/api/predict?match_id=…`

См. T1 §7. Контракт `{ probability, confidence, source, model_run }`.
Если live-винер недоступен (`between_maps`, нет snapshot, model отсутствует) —
возвращается прематч-прогноз с `source` начинающимся с `"prematch-"` и
mobile **не показывает** «Live» badge.

---

## 7. UI правила (mobile)

### 7.1 Числовое значение

```
state         | render
--------------+--------------------------------------------------
fresh         | "1234"
stale-soft    | "1234 ⟳"   (мини-спиннер inline)
stale-hard    | "—"        (плашка-overlay над секцией: «обновляется»)
likely-ended  | (скрыто)
historical    | "1234"     (без спиннера, без «live» бейджа)
between_maps  | (скрыто)   (общая плашка «ПЕРЕРЫВ» на карточке)
permanent     | (скрыто)   (никакой плашки, никакого "—")
```

### 7.2 Прогноз модели

- `confidence = high` → нормальный рендер.
- `confidence = medium` → значение + примечание «низкая уверенность».
- `confidence = low` (v1 fallback, malo data) → значение в сером, текст
  «прогноз ориентировочный».
- `source` начинается с `"prematch-"` и `match_state = live` → badge
  «Прематч-прогноз» (не «Live»), потому что live-модель недоступна.

### 7.3 Запрещено

- ❌ Подставлять `0` вместо null/permanent (например, `xp_per_min = 0`
  выглядит как «игроки не получают опыт»).
- ❌ Показывать stale-hard как fresh.
- ❌ Показывать **числовое** значение для permanent_unavailable поля
  (даже "—" — лучше скрыть весь блок).
- ❌ Mobile считает `Date.now() - captured_at` сам. Только через
  `getFieldState()`.
- ❌ Делать вид что live-винер работает на `between_maps`-данных.

---

## 8. Что НЕ покрыто этим контрактом (TODO)

1. **`_field_meta` ещё не реализован в API** — сейчас mobile получает
   `null` и не знает, временно или permanent. Нужна правка
   `routes/matches.ts` и `routes/predict.ts`.
2. **`match_state` ещё не сериализуется явно** — есть `between_maps`, но
   нет `pre_match | live | archived` enum. Сейчас mobile вычисляет
   эвристикой. Унифицировать после T0.5.
3. **`getFieldState()` хелпер ещё не написан** на mobile — поля
   распарсиваются ad-hoc в компонентах.
4. **Порог 25 мин для likely-ended** не зашит в server constant — нужен
   `LIVE_STALE_HARD_MS = 25*60*1000` в общей либе и использовать в
   prune-job и в mobile.
5. **Stratz live (T0.5)** уберёт permanent_unavailable для xp/buyback/
   aegis/roshan — тогда таблица §4 обновится.
6. **between_maps duration timeout** — если `between_maps:true` держится
   >20 мин, скорее всего серия закончилась без обновления PS. Логика
   таймаута должна перевести в `archived`.

Изменения в этом документе **обязаны** проходить через CL вместе с
правками `routes/matches.ts` и mobile-хелперов.

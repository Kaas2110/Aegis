# Aegis — операционный гайд

Документ для оператора (не разработчика). Что и когда запускать в консоли,
что собирается фоном, как проверить что данные реально текут.

---

## 1. Базовая модель работы Replit

**Главное правило:** workspace = виртуальный компьютер, который **спит когда
вкладка закрыта**.

| Что | Когда работает |
|---|---|
| API server, ML service, Mobile dev (workflows) | Только пока workspace открыт у вас в браузере |
| LiveWorker (опрос live-матчей каждые 60с) | Только пока workspace открыт |
| SchedulerWorker (авто-ретрейн) | Только пока workspace открыт |
| Production deploy (`suggest_deploy`) | 24/7, но это отдельный платный контейнер |

**Поэтому:** если вы хотите чтобы база наполнялась 24/7 — нужен deploy. Иначе
накопление идёт только в часы, когда workspace открыт.

### Подвопрос: «А если ноут не уходит в спящий режим, нонстопом?»

**ДА, есть смысл.** Пока браузер активен и вкладка с Replit открыта — workflows
крутятся. Если у вас экран горит 24/7 и вкладка с проектом открыта — фактически
получаете эффект 24/7 worker'а **бесплатно**. Это легальный workaround Reserved VM.

**Нюансы:**
- Если ноут уйдёт в спящий режим (sleep / hibernate) — Replit потеряет соединение,
  workspace через 5-10 минут засыпает.
- Если вкладку закрыть или браузер выгрузит её из памяти (на телефоне/iPad бывает) —
  то же самое.
- WiFi обрыв >5 мин = workspace уснул.
- Лучше всего: десктоп с настройками «не спать», подключённый к питанию.

### Как проверить что воркеры реально работают сейчас

```bash
# 1. Есть ли свежие снапшоты (за последние 10 минут)
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) snaps_10min, MAX(captured_at) last,
         NOW() - MAX(captured_at) AS age
  FROM live_snapshots
  WHERE captured_at > NOW() - INTERVAL '10 minutes';"

# 2. Есть ли свежие предсказания
psql "$DATABASE_URL" -c "
  SELECT market_type, COUNT(*), MAX(predicted_at)
  FROM predictions
  WHERE predicted_at > NOW() - INTERVAL '10 minutes'
  GROUP BY market_type;"

# 3. Что говорит LiveWorker (workflow логи)
# В консоли:
tail -100 /tmp/logs/artifacts_api-server*.log | grep -i "live-worker\|stratz"
```

Если `age` < 2 минут — всё ок, воркер крутится. Если 30+ минут — workspace
заснул либо OpenDota вернул 429 и worker в backoff.

---

## 2. Daily операции

### Что собирается АВТОМАТИЧЕСКИ (пока workspace открыт)

| Что | Кем | Частота |
|---|---|---|
| `live_snapshots` (live-матчи + ML предсказания) | LiveWorker | каждые 60с |
| `match_winner` predictions | LiveWorker | при каждом изменении матча |
| `live_match_winner` predictions | LiveWorker | game_time ≥ 60с |
| `live_total_kills` / `live_total_duration` | LiveWorker (T3.5) | каждый снапшот |
| `pro_matches` финиш (outcomes) | OutcomeTracker | каждые ~5 мин |
| Авто-ретрейн моделей | SchedulerWorker | по триггеру патча или 7 дней |

### Что НЕ собирается автоматически (нужен ручной запуск)

| Что | Как запустить | Сколько занимает |
|---|---|---|
| Лёгкий daily батч (teams, matches, hero-stats, recent-form, h2h, bo3) | `bash scripts/run-daily.sh` | ~10-15 мин |
| Полная enrichment-пачка (drafts + glicko + всё) | workflow `Data Enrichment` (▶️ в боковой панели) | ~1.7 часа |
| Тренировка LightGBM prematch winner | `pnpm --filter @workspace/scripts run train:lightgbm` | ~5-10 мин (через ml-service) |
| Тренировка market-моделей (FB / total_kills / duration) | `pnpm --filter @workspace/scripts run train:market-models` | ~5 мин |
| Тренировка live-winner | `pnpm --filter @workspace/scripts run train:live-model` | ~2 мин |
| Тренировка live-totals (T3.5) | `pnpm --filter @workspace/scripts run train:live-totals` | ~2 мин |
| Backfill пустых live-окон из OD | `pnpm --filter @workspace/scripts run backfill:live-snapshots -- --limit 200` | переменно (OD rate-limit) |

### Рекомендуемая daily-рутина (для оператора)

**Утром (или раз в день когда открываете workspace):**

```bash
# 1. Запустить лёгкий daily батч (15 мин)
bash scripts/run-daily.sh

# 2. Пока он крутится — проверить вчерашние результаты в админ-панели
#    (открыть iframe Aegis Admin)

# 3. Когда daily закончится — посмотреть лог
tail -50 /tmp/ingest_logs/daily.log
```

**Раз в неделю (или когда видите новый патч Dota 2):**

```bash
# Полный enrichment pipeline (1.7 ч, можно фоном пока работаете)
# Запускаем через workflow:
# В боковой панели Replit → Workflows → ▶️ Data Enrichment
```

**Перед обучением модели:**

```bash
# 1. Проверить покрытие фичей в БД (drafts, hero_matchups, player_glicko)
psql "$DATABASE_URL" -c "
  SELECT
    (SELECT COUNT(*) FROM pro_matches WHERE start_time > EXTRACT(EPOCH FROM NOW() - INTERVAL '365 days')) AS matches_365d,
    (SELECT COUNT(*) FROM match_drafts WHERE radiant_picks IS NOT NULL) AS drafts_with_picks,
    (SELECT COUNT(*) FROM hero_matchups) AS matchups,
    (SELECT COUNT(*) FROM player_glicko) AS players_glicko;"

# 2. Если покрытие хорошее → обучить
pnpm --filter @workspace/scripts run train:lightgbm
```

---

## 3. Stratz live (важное ограничение)

На **2026-05-16** Stratz live API (`live.match(id)` и `live.matches`) **возвращает
пустые данные** для всех протестированных id. Причина не у нас:
- `live.matches` → `[]` (Stratz не индексирует ни одного live матча)
- `live.match(id)` → `null` (вообще для любого id)

**Что это значит для приложения:**
- `live_snapshots.stratz_match_meta` остаётся NULL → накопление v2 фичей для
  live-totals **не идёт**.
- LiveWorker уже **fail-soft**: пишет снапшоты без Stratz полей, ничего не ломается.
- Добавлен **circuit breaker** (после 20 подряд null → 30-минутная пауза), чтобы
  не выжигать квоту.

**Что делать:**
- Не ждать v2 live-totals пока Stratz не восстановит live ingest.
- Время от времени проверять руками:
  ```bash
  curl -s -X POST https://api.stratz.com/graphql \
    -H "Authorization: Bearer $STRATZ_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Origin: https://stratz.com" \
    --data-raw '{"query":"query{live{matches{matchId}}}"}'
  ```
  Если в ответе `matches:[...]` непустой массив — Stratz live ожил, enrichment
  начнёт работать автоматически.

**Альтернатива:** T0.7 — OpenDota `/api/matches/{id}` replay-parse (post-mortem,
не live). Это другой пайплайн, обсуждается отдельно.

---

## 4. Что НЕ делать (типичные грабли)

❌ **Не запускать `pnpm dev` в корне проекта.** Workflows сами это делают.
   В корне нет `dev` скрипта.

❌ **Не делать `git push --force` / `git reset --hard` без бэкапа.** Используйте
   чекпоинты Replit.

❌ **Не запускать `pnpm --filter @workspace/db run push` если drizzle хочет
   удалить колонки.** Прервите (`No, abort`), сообщите разработчику.
   Это значит что схема и БД разошлись и нужно осмысленное решение.

❌ **Не задавать `STRATZ_TOKEN` с пробелами / кавычками.** Несколько токенов —
   через запятую без пробелов: `tok1,tok2,tok3`.

❌ **Не закрывать workspace во время `Data Enrichment` workflow.** Прервётся
   на полпути.

---

## 5. Когда обучать модели

**Правило:** новые фичи не катим в прод сразу. Сначала ingest до полного покрытия,
потом одна выборка 365d, потом обучение.

**Чек-лист «можно обучать?»:**

1. `pro_matches` за 365д ≥ 5000 (тир-1/тир-2 микс)
2. `match_drafts.radiant_picks` IS NOT NULL для ≥ 80% этих матчей
3. `hero_matchups` есть строки с `matchCount > 100` для топ-героев
4. `player_glicko` есть строки для топ-200 игроков
5. После каких-то крупных изменений (новые фичи / новый патч) — `Data Enrichment`
   workflow прогнан за последние 7 дней

Если все 5 — можно. Иначе сначала прогнать `Data Enrichment` и подождать.

---

## 6. Где смотреть логи

| Что | Где |
|---|---|
| Workflow logs (live) | Боковая панель Replit → Workflows → клик на workflow |
| Daily batch | `/tmp/ingest_logs/daily.log` |
| Data Enrichment pipeline | `/tmp/ingest_logs/pipeline.log` |
| API server (последние 100 строк) | `tail -100 /tmp/logs/artifacts_api-server*.log` |
| Browser console mobile | в iframe «Dota Edge Analyzer» через девтулзы |

**Полезные фильтры:**
```bash
# Только Stratz live события
tail -200 /tmp/logs/artifacts_api-server*.log | grep stratz-live

# Только LiveWorker
tail -200 /tmp/logs/artifacts_api-server*.log | grep LiveWorker

# Только ошибки
tail -500 /tmp/logs/artifacts_api-server*.log | grep -i 'error\|failed'
```

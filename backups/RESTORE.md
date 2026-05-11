# Aegis — полное восстановление (код + БД + модели)

Этот бэкап содержит **всё**, что было сделано в текущей Replit-сессии: исходники, схему БД, исторические данные (pro_matches, drafts, hero stats), и все обученные модели (LR + LightGBM весами в `model_versions`).

## Что в папке `backups/`

| Файл | Что | Размер |
|---|---|---|
| `aegis-db-YYYY-MM-DD_HHMMSS.dump` | PostgreSQL **custom-format** дамп (для `pg_restore`) | ~1.5 MB |
| `aegis-db-YYYY-MM-DD_HHMMSS.sql.gz` | Plain SQL дамп (для `psql`, можно посмотреть глазами) | ~1.5 MB |
| `aegis-code-YYYY-MM-DD_HHMMSS.bundle` | Полный git-репозиторий со всей историей (запасной канал, если GitHub недоступен) | ~10 MB |

> Берите **последний по дате** файл (или нужный конкретный, если делали несколько бэкапов).

Дамп **включает** модели — таблица `model_versions` хранит:
- `weights jsonb` — веса LR-моделей (prematch_winner v1/v2/v3, t1/t2, live_winner)
- `binary_blob bytea` — LightGBM-блобы (по 30KB на модель)

После restore модели подхватятся автоматически при старте api-server (`PredictionModel.loadActiveModel()`).

---

## Сценарий A: новый Replit (рекомендованный)

### 1. Залить код

Самый простой вариант — fork с GitHub:
- Открыть Replit → Create → Import from GitHub → `https://github.com/Kaas2110/Market-Edge` (или ваш форк).
- Replit сам подтянет `replit.md`, monorepo-структуру и workflows.

Если GitHub недоступен:
- В новом Replit shell: `git clone backups/aegis-code-XXXX.bundle aegis-restored && cd aegis-restored && git remote remove origin`

### 2. Установить зависимости

```bash
pnpm install
```

### 3. Поднять PostgreSQL

В Replit: вкладка **Database** → **Create database** → PostgreSQL. Replit автоматически выставит `DATABASE_URL` в env.

Локально (на ноуте/сервере): любая Postgres ≥ 14, экспортировать `DATABASE_URL=postgres://user:pass@host:5432/aegis`.

### 4. Восстановить данные из дампа

**Custom формат (быстрее, рекомендуется):**
```bash
# Дроп существующей схемы (если push уже прошёл)
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Restore
pg_restore --no-owner --no-privileges --dbname="$DATABASE_URL" backups/aegis-db-XXXX.dump
```

**Plain SQL (если нет pg_restore):**
```bash
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
gunzip -c backups/aegis-db-XXXX.sql.gz | psql "$DATABASE_URL"
```

### 5. Выставить секреты

В Replit Secrets (или `.env` локально):

| Secret | Обязательный | Где взять |
|---|---|---|
| `DATABASE_URL` | да | автоматически от Replit DB |
| `PORT` | да (для api-server) | автоматически от Replit |
| `ADMIN_TOKEN` | да | сгенерировать новый: `openssl rand -hex 32` |
| `SESSION_SECRET` | да | сгенерировать новый: `openssl rand -hex 32` |
| `PANDASCORE_API_KEY` | опц. | https://pandascore.co — для расширенного покрытия live |
| `STRATZ_TOKEN` | опц. | https://stratz.com/api — альтернатива OpenDota |
| `ODDS_API_KEY` | опц. | the-odds-api.com — отключено в UI |
| `PINNACLE_GUEST_API_KEY` | опц. | публичный гость-ключ Pinnacle |
| `PROXY_URL` | опц. | для скраперов Fonbet/Лига Ставок с зарубежного IP |

> **Важно:** не переноси старые `ADMIN_TOKEN`/`SESSION_SECRET` — генерируй новые.

### 6. Запустить workflows

Все 4 workflow конфигурируются автоматически из `artifact.toml`:
- `artifacts/api-server: API Server`
- `artifacts/ml-service: ML Service`
- `artifacts/mobile: expo`
- `artifacts/mockup-sandbox: Component Preview Server`

В Replit они стартуют сами. Локально:
```bash
pnpm --filter @workspace/api-server run dev   # API
pnpm --filter @workspace/ml-service run dev   # ML LightGBM service
pnpm --filter @workspace/mobile run dev       # Expo
```

### 7. Проверка

```bash
curl http://localhost:80/api/healthz
curl http://localhost:80/api/admin/scheduler/state -H "X-Admin-Token: $ADMIN_TOKEN"
```

В логах api-server должно быть:
```
[ensureSchema] все критичные таблицы на месте, tables: 7
[PredictionModel] Active models loaded loaded: [...14 моделей...]
[LiveWinnerModel] Active live model loaded
```

---

## Сценарий B: восстановление поверх существующего инстанса

Если сервер уже работает и нужно откатить БД к моменту бэкапа:

```bash
# Остановить workflows (LiveWorker не должен писать во время restore)
# Через Replit UI или kill процессов

# Сбросить схему
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Restore
pg_restore --no-owner --no-privileges --dbname="$DATABASE_URL" backups/aegis-db-XXXX.dump

# Перезапустить api-server — модели подхватятся
```

---

## Что произойдёт после restore (автоматика)

`SchedulerWorker` сам разберётся:
- Если БД свежая (`pro_matches < 100`) → cold-start triggers full retrain pipeline через 30 сек
- Если данные есть → daily refresh раз в 24h, full retrain через 30 дней или по новому патчу
- `ensureSchema` на каждом boot проверяет 7 критичных таблиц и сам гонит `drizzle-kit push` если чего-то нет

Ничего вручную дотренировывать не нужно.

---

## Создание свежего бэкапа

В любой момент:
```bash
TS=$(date -u +%Y-%m-%d_%H%M%S)
pg_dump "$DATABASE_URL" --no-owner --no-privileges --format=custom --file="backups/aegis-db-${TS}.dump"
pg_dump "$DATABASE_URL" --no-owner --no-privileges --format=plain | gzip -9 > "backups/aegis-db-${TS}.sql.gz"
git --no-optional-locks bundle create "backups/aegis-code-${TS}.bundle" --all
```

Скачать с Replit: правый клик на файле в Files panel → Download.

---

## Проверка целостности дампа (опционально)

```bash
# Список таблиц в дампе
pg_restore --list backups/aegis-db-XXXX.dump | head -30

# Размер каждой таблицы после restore
psql "$DATABASE_URL" -c "
  SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
  ORDER BY pg_total_relation_size(c.oid) DESC;
"

# Активные модели
psql "$DATABASE_URL" -c "SELECT kind, fv, engine, version, is_active FROM model_versions WHERE is_active ORDER BY kind, fv, engine;"
```

Должно быть:
- ~14 активных моделей (8 logreg + 6 lightgbm) для prematch
- 1 активная live модель
- ~2000 pro_matches
- ~1000 teams
- 127 hero_stats
- ~16k hero_matchups

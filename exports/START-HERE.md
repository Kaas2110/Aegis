# Aegis — с чего начать (контекст-пакет, 2026-07-17)

Этот архив — полный контекст проекта Aegis (Dota 2 аналитика для беттеров,
RU UI) для продолжения работы под новым профилем Replit или на другом окружении.

## Порядок чтения

1. **`replit.md`** — обзор проекта, стек, команды, **User preferences (обязательны к соблюдению)**, активный roadmap.
2. **`docs/business.md`** — что это за продукт (для не-инженеров).
3. **`docs/technical-overview.md`** — краткий тех-обзор для нового инженера.
4. **`docs/system-map.md`** — карта связей источники → таблицы → фичи → модели → рантайм. **Читать перед любой архитектурной правкой.**
5. **`docs/architecture.md`** — полный контракт API endpoints, админка, букмекеры, gotchas, log-тэги.
6. **`docs/operations.md`** — все ingest/compute/train скрипты, env-переменные, STRATZ multi-token pool.
7. **`docs/changelog.md`** — хронология (свежие записи В КОНЦЕ файла).

## Восстановление проекта с нуля

- **Код** — репозиторий проекта (git). Конфиг workflows — файл `.replit` (в этом архиве).
- **База данных** — дамп из 3 частей `aegis-db.part-00/01/02.gz` (17.07.2026, ~400 МБ,
  НЕ в этом архиве — переносится отдельно). Инструкция — `backups/RESTORE.md`
  и `docs/migration-replit.md`.
- **Секреты** — значения в архиве отсутствуют. Список и откуда взять — `.env.example`.
  Нужны: DATABASE_URL, ADMIN_TOKEN, SESSION_SECRET, STRATZ_TOKEN, PANDASCORE_API_KEY,
  OPENDOTA_API_KEY (опц.), PROXY_URL (опц.).
- **Переезд на другой Replit-аккаунт** — `docs/migration-replit.md`.
- **Переезд на ноут (план прода!)** — `docs/laptop-deploy.md` (cron/systemd, расписание — в `replit.md`).

## Что ещё в архиве

- `threat_model.md` — модель угроз (для security-ревью).
- `lib/api-spec/openapi.yaml` — контракт API (source of truth, из него генерятся клиенты).
- `scripts/run-*.sh` — 5 воркер-скриптов (Daily/Hourly/Enrichment/Replay-parse/Drafts-backfill), на ноуте становятся cron-юнитами.
- `.replit` — определения workflows на Replit.
- `.agents/memory/` — память агента: накопленные уроки и грабли проекта (MEMORY.md — индекс).
- `docs/ml-contract.md`, `docs/ml-features-spec.md`, `docs/data-availability-rules.md` — нормативные ML/UI контракты.
- `docs/rustore-release.md`, `docs/store-release-plan.md` — выкатка в сторы.
- `DEPLOYMENT.md`, `DEPLOYMENT_PLAN.md`, `ML_ROADMAP.md`, `docs/self-hosting-guide.md` — **легаси** (помечены баннерами), оставлены для истории.

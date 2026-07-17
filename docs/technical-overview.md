# Aegis — Technical Overview

> Краткий обзор для новых инженеров. Полные детали — в
> [`replit.md`](../replit.md), [`docs/architecture.md`](./architecture.md),
> [`docs/system-map.md`](./system-map.md), [`threat_model.md`](../threat_model.md).

## Стек

| Слой           | Что                                                              |
|---------------|------------------------------------------------------------------|
| Mobile        | Expo SDK 54 + React Native (web + iOS + Android), expo-router    |
| API           | Node 24 + TypeScript 5.9 + Express 5, pino-http логирование      |
| ML scoring    | Python FastAPI + LightGBM 4.6 + sklearn IsotonicRegression       |
| ML fallback   | Pure-JS Logistic Regression в TypeScript (60s circuit-breaker)   |
| DB            | PostgreSQL + Drizzle ORM                                         |
| Admin UI      | React + Vite + TanStack Query + OpenAPI codegen                  |
| Monorepo      | pnpm workspaces (`artifacts/*`, `lib/*`, `scripts/`)             |

## Структура монорепо

```
artifacts/
├── api-server/     # Express API (порт через PORT, путь /api)
├── admin-web/      # Admin SPA (React + Vite, путь /admin-web)
├── ml-service/     # FastAPI ML (LightGBM)
├── mobile/         # Expo приложение (web preview + native)
└── mockup-sandbox/ # Dev-only прототипирование

lib/
├── db/             # Drizzle schema + клиент
├── api-spec/       # OpenAPI spec → codegen для admin-web
└── ...

scripts/            # Ингест/трейн скрипты (одиночный пакет)
```

## Аутентификация

**Двухконтурная — admin и user — раздельные сессии:**

### Admin (cookie-based, для admin-web)
- `POST /api/admin/login` { token } → устанавливает HttpOnly cookie
  `aegis_admin_session`. Token сравнивается с `ADMIN_TOKEN` env через
  constant-time compare.
- Сессии in-memory (24h TTL). В dev (NODE_ENV≠production) дополнительно
  персистятся в `/tmp/aegis_admin_sessions.json` (mode 0600) и переживают
  рестарт dev-сервера; в prod — чисто in-memory.
- Защита: throttle 10/15min на IP.
- `GET /api/admin/users?q=` + `POST /api/admin/users/:id/admin {isAdmin}` —
  выдача/отзыв «Режима админ» мобилки (`app_users.is_admin`); мобилка гейтит
  секцию «РАЗРАБОТКА (АДМИН)» и экран `/admin` по `isAdmin` из auth-ответов.

### User (bearer-token, для mobile)
- `POST /api/auth/register` { email, password } → 201, `{ token, user }`
- `POST /api/auth/login` { email, password } → 200, `{ token, user }`
- `GET /api/auth/me` → требует `Authorization: Bearer <token>`
- `POST /api/auth/logout` → fire-and-forget (stateless)

**Token формат:** `${userId}.${expiresAtMs}.${hmacSha256}` подписан
`SESSION_SECRET`. Сервер не хранит сессии в БД — токен self-contained.
TTL 30 дней, мобилка хранит в AsyncStorage и автоматически очищает на logout
или 401.

**Пароли:** scrypt(N=16384, keylen=64) из `node:crypto` (без bcrypt-зависимости),
хранятся как `${saltHex}$${hashHex}` в `app_users.password_hash`.

**Защита от утечки факта существования email:** при login для несуществующего
email тратим то же время на dummy-hash, чтобы не было timing-side-channel.

## Маршруты API (live + upcoming)

| Endpoint                        | Что делает                                                |
|---------------------------------|----------------------------------------------------------|
| `GET /api/healthz`              | Liveness check                                           |
| `GET /api/matches/live`         | OD + Stratz + PS параллельно, кэш 30s, dedup по hash'у   |
| `GET /api/matches/upcoming`     | PandaScore /running + scheduled, кэш 60s                 |
| `POST /api/analytics/predict`   | ML-прогноз для команд (LightGBM v3 → LR fallback)        |
| `GET /api/bookmakers/status`    | Состояние всех 7 источников + воркер метрики             |
| `GET /api/bookmakers/matched/dota2` | Fuzzy-match букмекерских ивентов с our upcoming      |
| `GET /api/teams/tier1`          | Tier-1 команды по Glicko-рейтингу (для favorite picker)  |
| `POST /api/auth/{register,login,logout,me}` | User auth                                  |
| `POST /api/admin/{login,refresh-all,...}`   | Admin (требует cookie session)              |
| `POST /api/client-logs`         | Mobile-events ingest (батчами)                          |

## Кэширование

`lib/responseCache.ts` — единый `withCache(key, ttlMs, factory)` с
**single-flight coalescing** (если два запроса одновременно — апстрим
дёргается один раз). Логи каждого hit/miss/coalesced/cleared под
`tag: 'cache'`.

Ключи кэша:
- `matches:live` (TTL 30s)
- `matches:upcoming` (TTL 60s)
- `matches:heroes` (TTL 1h)
- `predict:prematch:${matchId}:${t1}:${t2}:${format}` (TTL 4h)
- `bookmakers:${source}` (TTL 65min, обновляется воркером)

Админ может очистить все кэши одной кнопкой через `POST /api/admin/refresh-all`.

## Фоновые воркеры (in-process)

| Worker             | Период | Что делает                                          |
|-------------------|--------|-----------------------------------------------------|
| LiveWorker        | 60s    | Опрос OD на ход всех live-матчей, dedup по hash'у   |
| BookmakerWorker   | 3min/60min/30s | Адаптивный — live/idle/wake_for_start       |
| SchedulerWorker   | hourly | Auto-retrain если есть новые `prematch_outcomes`    |
| OutcomeTracker    | 60s    | Подбирает финальные результаты, пишет outcomes     |

Все воркеры можно отключить env'ом (`DISABLE_LIVE_WORKER=true`, ...).

## Mobile архитектура

```
app/
├── _layout.tsx        # Stack navigator + контексты
├── index.tsx          # Routing: onboarding | auth | tabs
├── onboarding.tsx     # Возрастной gate, дисклеймер, дефолты
├── auth.tsx           # Email/password login + register
└── (tabs)/
    ├── index.tsx      # Список матчей (live + upcoming)
    ├── alerts.tsx     # Алерты + правила + настройки порога
    └── settings.tsx   # Профиль, фильтры, аккаунт, выход

context/
├── AppContext.tsx     # Settings, filters, isOnboarded
└── AuthContext.tsx    # User, login/register/logout, isAuthenticated

services/
├── AuthService.ts     # AsyncStorage + fetch /api/auth/*
├── LiveDataService.ts # Прогрессивный fetch live + enrichment
├── notifications/     # NotificationService (правила + триггер)
└── logging/           # EventLogger + uploader → /api/client-logs
```

## Логирование

Сервер пишет structured JSON через pino. Каждая запись имеет `tag` для фильтрации
(см. таблицу в `replit.md`). Mobile-события сохраняются в AsyncStorage и каждые
30s батчами шлются в `/api/client-logs` (`tag: 'mobile'`), что даёт unified
прод-наблюдаемость.

## Безопасность (highlights)

- `SESSION_SECRET` обязателен; user-токены подписаны им (HMAC-SHA256).
- `ADMIN_TOKEN` — единственный путь к admin endpoints; сравнение
  constant-time.
- CORS — credentialed запросы только с same-origin / явных origin'ов.
- `cookie-parser` + `aegis_admin_session` — HttpOnly, sameSite=lax,
  `secure` в production.
- Per-IP throttle на login и register (20/15min).
- Все роуты валидируются (zod в openapi-генерируемых routes; ручные
  валидаторы в auth-routes).

Полная модель угроз — [`threat_model.md`](../threat_model.md).

## Команды разработчика

```bash
# Полный typecheck (libs first, потом артефакты)
pnpm run typecheck

# Push DB schema (dev)
pnpm --filter @workspace/db run push-force

# Запуск отдельного артефакта (через workflow!)
restart_workflow "artifacts/api-server: API Server"

# Codegen из OpenAPI
pnpm --filter @workspace/api-spec run codegen

# Ручной ретрейн
curl -X POST localhost:80/api/admin/login -d '{"token":"..."}'
curl -X POST localhost:80/api/analytics/retrain --cookie ...
```

## Schema БД (highlights)

| Таблица              | Назначение                                         |
|---------------------|---------------------------------------------------|
| `app_users`         | **Зарегистрированные пользователи мобилки** (`is_admin` — «Режим админ», `tariff` default `free`, `ref_code`) |
| `teams`             | OpenDota team ratings (~1000 команд)               |
| `pro_matches`       | Исторические pro matches для трейна               |
| `live_snapshots`    | Полные снимки live-матчей (для live-винера)        |
| `prematch_outcomes` | Финальные исходы (для калибровки моделей)          |
| `model_registry`    | Веса моделей (LightGBM blob + LR weights)          |
| `team_recent_form`  | 30/90-day form для прогнозов                      |
| `team_h2h`          | 365-day head-to-head                              |
| `bo3_series`        | Aggregate BO3-серий                               |

# Aegis — Шпаргалка по развёртыванию

## Требования к железу

| | Минимум | Комфортно |
|---|---|---|
| RAM | 8 ГБ | 16 ГБ |
| CPU | 4 ядра | 6+ ядер |
| Диск | 15 ГБ | 30 ГБ SSD |
| Сеть | 10 Мбит/с | любой стабильный |

---

## Шаг 1 — Установи необходимый софт

### Node.js 20+
- Windows/Mac: [nodejs.org](https://nodejs.org) → кнопка **LTS**

### Python 3.11
- Windows: [python.org/downloads](https://python.org/downloads) → **обязательно** поставь галочку **"Add to PATH"**
- Mac: `brew install python@3.11`

### PostgreSQL 16
- Windows: [postgresql.org/download/windows](https://postgresql.org/download/windows)
  - При установке запомни пароль пользователя `postgres`
- Mac: `brew install postgresql@16 && brew services start postgresql@16`
- Ubuntu: `sudo apt install postgresql-16`

### pnpm и PM2 (менеджер процессов)
```bash
npm install -g pnpm pm2
```

---

## Шаг 2 — Скачай проект с GitHub

```bash
git clone https://github.com/Kaas2110/Aegis.git aegis
cd aegis
```

---

## Шаг 3 — Создай базу данных

**Windows** (через pgAdmin или SQL Shell):
```sql
CREATE DATABASE aegis;
```

**Mac/Linux:**
```bash
createdb aegis
# или
psql -U postgres -c "CREATE DATABASE aegis;"
```

---

## Шаг 4 — Создай файл .env

В папке проекта создай файл `.env` (скопируй из `.env.example`):

```bash
cp .env.example .env
```

Заполни обязательные поля:

```env
DATABASE_URL=postgresql://postgres:ТВОЙ_ПАРОЛЬ@localhost:5432/aegis
ADMIN_TOKEN=придумай-длинный-случайный-токен-32-символа
SESSION_SECRET=ещё-один-длинный-случайный-токен
```

Опциональные (для полной работы):
```env
STRATZ_TOKEN=       # JWT с stratz.com/api (Steam логин), бесплатно
PANDASCORE_API_KEY= # ключ с pandascore.co, бесплатный тир
```

---

## Шаг 5 — Первый запуск

```bash
# Mac/Linux:
bash scripts/laptop/start.sh

# Windows:
scripts\laptop\start.bat
```

Скрипт автоматически:
1. Проверит что все зависимости установлены
2. Установит npm-пакеты (`pnpm install`)
3. Накатит схему БД (`db push`)
4. Запустит все три сервиса через PM2

**После запуска:**
- Админка: http://localhost:24276/admin-web/
- API: http://localhost:8080/api/healthz
- Лендинг: http://localhost:8080/landing

**Войти в админку:** используй `ADMIN_TOKEN` из `.env` в качестве пароля.

---

## Шаг 6 — Первичная загрузка данных (один раз)

Выполни по порядку (занимает 30-60 минут):

```bash
# Сбор данных
pnpm --filter @workspace/scripts run ingest:teams
pnpm --filter @workspace/scripts run ingest:matches
pnpm --filter @workspace/scripts run ingest:drafts
pnpm --filter @workspace/scripts run ingest:hero-stats
pnpm --filter @workspace/scripts run ingest:hero-matchups
pnpm --filter @workspace/scripts run ingest:players-heroes

# Вычисление статистики
pnpm --filter @workspace/scripts run compute:recent-form
pnpm --filter @workspace/scripts run compute:h2h
pnpm --filter @workspace/scripts run compute:bo3-series
pnpm --filter @workspace/scripts run compute:player-glicko

# Обучение моделей (~20-30 минут, нагрузит CPU)
pnpm --filter @workspace/scripts run train:lightgbm
pnpm --filter @workspace/scripts run train:market-models
pnpm --filter @workspace/scripts run train:live-model
```

После этого всё работает **автоматически** — scheduler сам обновляет данные каждый день и переобучает модели раз в 30 дней.

---

## Шаг 7 — Автозапуск при включении ноутбука

```bash
pm2 startup
# Выполни команду которую он выведет (начинается с sudo на Linux/Mac)

pm2 save
# Сохраняет список текущих процессов
```

После этого при каждом включении ноутбука все три сервиса стартуют автоматически.

---

## Обновления кода

Когда что-то изменится в проекте — одна команда:

```bash
# Mac/Linux:
bash scripts/laptop/update.sh

# Windows:
scripts\laptop\update.bat
```

Скрипт сам: `git pull` → `pnpm install` (если новые пакеты) → `db push` (если изменилась схема) → перезапуск PM2.

---

## Резервная копия базы данных

### Через кнопку в админке
Админка → **Операции** → «База данных — резервная копия» → кнопка **«Скачать БД (.sql)»**

### Через скрипт
```bash
bash scripts/laptop/export-data.sh
# Создаёт: aegis-backup-YYYY-MM-DD.tar.gz
```

### Через одну команду
```bash
pg_dump $DATABASE_URL --no-owner --no-acl > aegis-backup.sql
```

### Восстановление
```bash
psql $DATABASE_URL < aegis-backup.sql
```

---

## Полезные команды PM2

```bash
pm2 status          # статус всех сервисов
pm2 logs            # логи в реальном времени (все сервисы)
pm2 logs aegis-api  # логи только API
pm2 restart all     # перезапустить всё
pm2 stop all        # остановить всё
pm2 delete all      # удалить все процессы из PM2
```

---

## Сборка APK для RuStore

### Шаг 1 — Зарегистрируйся на expo.dev (бесплатно)

### Шаг 2 — Установи EAS CLI
```bash
npm install -g eas-cli
```

### Шаг 3 — Войди в аккаунт
```bash
cd artifacts/mobile
eas login
```

### Шаг 4 — Собери APK
```bash
eas build --platform android --profile production-android
```

EAS соберёт APK в облаке Expo (~10-15 минут). Даст ссылку скачать `.apk` файл.

### Шаг 5 — Загрузи в RuStore консоль
1. console.rustore.ru → твоё приложение → **Версии** → **Загрузить версию**
2. Загрузи `.apk` файл
3. Заполни описание, скриншоты
4. Политика конфиденциальности: `https://твой-домен/api/legal/privacy`
5. Отправь на модерацию (3-7 рабочих дней)

---

## Данные приложения

| Параметр | Значение |
|---|---|
| Package name | `com.aegis.dota` |
| Scheme | `aegis` |
| API base | `/api` |
| Admin panel | `/admin-web/` |
| Landing | `/landing` |
| Privacy policy | `/api/legal/privacy` |
| Terms | `/api/legal/terms` |

---

## Структура портов (локально)

| Сервис | Порт | URL |
|---|---|---|
| API-сервер | 8080 | http://localhost:8080 |
| ML-сервис | 8090 | http://localhost:8090 |
| Админка | 24276 | http://localhost:24276/admin-web/ |

---

## Иконка на рабочем столе (для админки)

**Windows:**
1. ПКМ на рабочем столе → Создать ярлык
2. Путь: `C:\Program Files\Google\Chrome\Application\chrome.exe --app=http://localhost:24276/admin-web/`
3. Имя: `Aegis Admin`

**Mac:**
1. Открой `http://localhost:24276/admin-web/` в Chrome
2. Меню Chrome → Файл → **Сохранить как приложение...**

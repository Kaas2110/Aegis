> ⚠️ **ЧАСТИЧНО УСТАРЕЛ (2026-05-13).** Актуальные версии: переезд на ноут — `docs/laptop-deploy.md`, RuStore — `docs/rustore-release.md`, восстановление БД — `docs/migration-replit.md` + `backups/RESTORE.md`.

# Aegis — Полная шпаргалка развёртывания и публикации в RuStore
## Для начинающих. Ничего не пропущено.

---

## 🗺 Что у тебя есть и как это работает

**Что у тебя есть:**
- Код проекта на GitHub: https://github.com/Kaas2110/Aegis
- Файл резервной копии базы данных: `aegis-backup-ДАТА.sql` (скачан через кнопку в админке)
- Зарегистрированный аккаунт в RuStore с созданным приложением «Aegis dota 2 analytics»

**Как работает система (три части):**
```
┌─────────────────────────────────────────────────────┐
│  НОУТБУК                                            │
│                                                     │
│  ┌───────────────┐   ┌───────────────┐              │
│  │  API-сервер   │   │  ML-сервис    │              │
│  │  (порт 8080)  │──▶│  (порт 8090)  │              │
│  └───────┬───────┘   └───────────────┘              │
│          │                                          │
│  ┌───────▼───────┐   ┌───────────────┐              │
│  │  PostgreSQL   │   │  Админ-панель │              │
│  │  (база данных)│   │  (порт 24276) │              │
│  └───────────────┘   └───────────────┘              │
└─────────────────────────────────────────────────────┘
          │
          │ ngrok (туннель в интернет)
          ▼
┌─────────────────────┐
│  ТЕЛЕФОН            │
│  Приложение Aegis   │ ◀── Скачано из RuStore
│  (APK)              │
└─────────────────────┘
```

**Важно понять:** API-сервер должен быть доступен из интернета, чтобы приложение на телефоне могло к нему обращаться. Для этого используется ngrok — бесплатная программа которая создаёт туннель.

---

## 📦 ЧАСТЬ 1: Установка необходимого софта

### 1.1 Node.js (движок для API-сервера)

- Зайди на: **https://nodejs.org**
- Нажми большую зелёную кнопку **«LTS»** (не Current!)
- Скачай и установи (все галочки оставь по умолчанию)
- Проверь установку: открой командную строку (Win+R → `cmd`) и напиши:
  ```
  node --version
  ```
  Должно показать что-то вроде `v20.17.0` или новее

### 1.2 Python 3.11 (нужен для ML-моделей)

**Windows:**
- Зайди на: **https://www.python.org/downloads/release/python-3118/**
- Прокрути вниз до раздела «Files», скачай **Windows installer (64-bit)**
- ⚠️ **ВАЖНО:** При установке поставь галочку **«Add Python to PATH»** — без неё ничего не работает!
- Проверь:
  ```
  python --version
  ```
  Должно показать `Python 3.11.x`

**Mac:**
- Установи Homebrew если нет: скопируй команду с **https://brew.sh** и вставь в Терминал
- Затем:
  ```
  brew install python@3.11
  ```

### 1.3 PostgreSQL 16 (база данных)

**Windows:**
- Зайди на: **https://www.enterprisedb.com/downloads/postgres-postgresql-downloads**
- Скачай версию **16.x** для Windows x86-64
- При установке:
  - Пароль для пользователя postgres: придумай и **ЗАПИШИ** — он понадобится!
  - Порт: оставь **5432**
  - Locale: оставь по умолчанию
- Проверь (введи пароль когда спросит):
  ```
  psql -U postgres -c "SELECT version();"
  ```

**Mac:**
```bash
brew install postgresql@16
brew services start postgresql@16
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Ubuntu/Debian Linux:**
```bash
sudo apt install postgresql-16 postgresql-client-16
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

### 1.4 Git (скачивание кода)

**Windows:** Скачай с **https://git-scm.com/download/win** → установи с настройками по умолчанию

**Mac:** Уже встроен, или `brew install git`

**Linux:** `sudo apt install git`

### 1.5 pnpm и PM2 (менеджер пакетов и процессов)

```bash
npm install -g pnpm pm2
```

Проверь:
```bash
pnpm --version
pm2 --version
```

### 1.6 ngrok (туннель для доступа из интернета)

- Зайди на: **https://ngrok.com**
- Нажми **«Sign up for free»** — зарегистрируйся
- После входа перейди в раздел **«Your Authtoken»** и скопируй токен
- Скачай ngrok:
  - Windows: https://ngrok.com/download → скачай zip → распакуй `ngrok.exe` в папку `C:\ngrok\`
  - Mac: `brew install ngrok/ngrok/ngrok`
  - Linux: скачай zip с сайта → `unzip ngrok-linux-amd64.tgz` → `sudo mv ngrok /usr/local/bin/`
- Настрой токен (вставь свой вместо `ТВОЙ_ТОКЕН`):
  ```bash
  ngrok config add-authtoken ТВОЙ_ТОКЕН
  ```

---

## 💾 ЧАСТЬ 2: Скачивание кода и настройка

### 2.1 Скачай код с GitHub

Открой командную строку/терминал и выполни:

```bash
git clone https://github.com/Kaas2110/Aegis.git aegis
cd aegis
```

Папка `aegis` появится там где была командная строка. Все следующие команды выполняй **в этой папке**.

### 2.2 Установи зависимости

```bash
pnpm install
```

Займёт 2-5 минут. Скачает все необходимые библиотеки.

### 2.3 Создай базу данных

**Windows** (открой отдельно «SQL Shell (psql)» из меню Пуск):
```sql
CREATE DATABASE aegis;
\q
```

**Mac/Linux** (в обычном терминале):
```bash
createdb aegis
# если не работает:
psql -U postgres -c "CREATE DATABASE aegis;"
```

### 2.4 Создай файл настроек (.env)

В папке `aegis` создай файл с именем `.env` (именно так, с точкой в начале).

**Windows:** Открой Блокнот → Сохрани как → в имени файла напиши `.env` → тип файла «Все файлы»

**Mac/Linux:**
```bash
cp .env.example .env
```

**Содержимое файла `.env`** (заполни своими данными):

```env
# ────────── ОБЯЗАТЕЛЬНО ЗАПОЛНИТЬ ──────────────────────────────────────────

# Строка подключения к PostgreSQL
# Замени PASSWORD на свой пароль PostgreSQL из шага 1.3
DATABASE_URL=postgresql://postgres:PASSWORD@localhost:5432/aegis

# Пароль для входа в админ-панель — придумай любой сложный
ADMIN_TOKEN=придумай-длинный-пароль-минимум-20-символов

# Случайная строка для защиты сессий — придумай другой
SESSION_SECRET=ещё-одна-случайная-строка-другая

# ────────── ОПЦИОНАЛЬНО (но улучшают работу) ───────────────────────────────

# Токен STRATZ — нужен для данных о героях и матчах
# Как получить: зайди на https://stratz.com/api → войди через Steam → скопируй JWT токен
# STRATZ_TOKEN=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Ключ PandaScore — для данных об esports матчах
# Как получить: зарегистрируйся на https://pandascore.co → бесплатный план
# PANDASCORE_API_KEY=ваш_ключ_здесь

# ────────── URL твоего API (заполнишь на шаге 3.2) ─────────────────────────
# EXPO_PUBLIC_API_URL=https://xxxx-xxx-xxx.ngrok-free.app
```

---

## 🗄 ЧАСТЬ 3: Восстановление базы данных из резервной копии

У тебя есть файл `aegis-backup-ДАТА.sql`. Это **вся база данных**: все матчи, команды, предсказания, обученные ML-модели, настройки.

### 3.1 Найди свой backup-файл

Он у тебя скачан на компьютер. Запомни путь к нему, например:
- Windows: `C:\Users\ТвоёИмя\Downloads\aegis-backup-2026-05-13.sql`
- Mac: `/Users/ТвоёИмя/Downloads/aegis-backup-2026-05-13.sql`

### 3.2 Накати схему базы данных

Сначала создай структуру таблиц:

```bash
pnpm --filter @workspace/db run push
```

### 3.3 Восстанови данные из backup

Замени путь на свой:

**Windows** (в командной строке):
```bash
psql -U postgres -d aegis -f "C:\Users\ТвоёИмя\Downloads\aegis-backup-2026-05-13.sql"
```

**Mac/Linux:**
```bash
psql postgresql://postgres:PASSWORD@localhost:5432/aegis < /Users/ТвоёИмя/Downloads/aegis-backup-2026-05-13.sql
```

Процесс займёт 1-5 минут. Появится много строк — это нормально. Если видишь `ERROR: relation already exists` — это тоже нормально, данные всё равно восстановятся.

Проверь что данные есть:
```bash
psql -U postgres -d aegis -c "SELECT count(*) FROM pro_matches;"
```
Должно показать несколько тысяч строк.

---

## 🚀 ЧАСТЬ 4: Первый запуск

### 4.1 Запусти все сервисы

```bash
# Mac/Linux:
bash scripts/laptop/start.sh

# Windows:
scripts\laptop\start.bat
```

Скрипт сам:
1. Проверит что всё установлено
2. Запустит API-сервер, ML-сервис и админ-панель через PM2

### 4.2 Проверь что всё работает

Открой браузер и зайди:
- **Админка:** http://localhost:24276/admin-web/
  - Логин: `admin` (или любое имя)
  - Пароль: значение `ADMIN_TOKEN` из файла `.env`
- **API:** http://localhost:8080/api/healthz
  - Должно показать `{"status":"ok"}`
- **Лендинг:** http://localhost:8080/landing

### 4.3 Настрой автозапуск при включении ноутбука

```bash
pm2 startup
```

Выполни команду которую он выведет (она начинается с `sudo` на Mac/Linux). Затем:

```bash
pm2 save
```

Теперь при каждом включении ноутбука всё стартует автоматически.

---

## 🌐 ЧАСТЬ 5: Открытие доступа из интернета (ngrok)

Чтобы мобильное приложение на телефоне могло обращаться к твоему серверу, нужен туннель.

### 5.1 Запусти ngrok

**Открой НОВОЕ окно** командной строки/терминала (не закрывай старое с запущенными сервисами!):

```bash
ngrok http 8080
```

Ты увидишь что-то вроде:
```
Session Status    online
Account           твой@email.com
Forwarding        https://abc123-456.ngrok-free.app -> http://localhost:8080
```

**Скопируй строку `https://abc123-456.ngrok-free.app`** — это твой публичный URL API.

### 5.2 Запиши URL

Вставь его в файл `.env` (раскомментируй и замени):
```env
EXPO_PUBLIC_API_URL=https://abc123-456.ngrok-free.app
```

⚠️ **Важно:** На бесплатном тарифе ngrok URL меняется каждый раз при перезапуске. Для постоянного URL нужен платный план ngrok (~$10/мес) или VPS-сервер.

---

## 📱 ЧАСТЬ 6: Сборка APK для RuStore

### 6.1 Зарегистрируйся на expo.dev

- Зайди на: **https://expo.dev**
- Нажми «Sign up» → зарегистрируйся (бесплатно)
- Запомни email и пароль

### 6.2 Установи EAS CLI

**В новой командной строке в папке проекта:**

```bash
npm install -g eas-cli
```

### 6.3 Войди в Expo аккаунт

```bash
eas login
```

Введёт твой email и пароль от expo.dev.

### 6.4 Свяжи проект с Expo

```bash
cd artifacts/mobile
eas init --id new
```

Это создаст проект на expo.dev и привяжет его к коду.

### 6.5 Добавь URL API в конфиг сборки

Открой файл `artifacts/mobile/eas.json` в любом текстовом редакторе и замени `ТВОЙ_NGROK_URL` в секции `production-android`:

```json
"production-android": {
  "distribution": "internal",
  "android": {
    "buildType": "apk"
  },
  "env": {
    "EXPO_PUBLIC_PAYMENT_CHANNEL": "rustore",
    "EXPO_PUBLIC_API_URL": "https://ТВОЙ_NGROK_URL_ИЛИ_ПОСТОЯННЫЙ_URL"
  }
}
```

### 6.6 Запусти сборку APK

```bash
eas build --platform android --profile production-android
```

EAS спросит:
- «Generate a new Android Keystore?» → нажми **Y** (да, создать)
- Ключ сохранится в облаке Expo — не потеряется

Сборка займёт **10-20 минут** (происходит в облаке, ноутбук не нагружается).

### 6.7 Скачай APK

После завершения EAS выведет ссылку вида:
```
✓ Build finished
Download: https://expo.dev/artifacts/eas/xxxxx.apk
```

Скачай APK по этой ссылке.

---

## 🏪 ЧАСТЬ 7: Публикация в RuStore

### 7.1 Зайди в консоль RuStore

- **https://console.rustore.ru**
- Войди в свой аккаунт
- Нажми на приложение «Aegis dota 2 analytics»

### 7.2 Загрузи APK

1. В левом меню нажми **«Версии»**
2. Нажми **«Загрузить версию»**
3. Перетащи или выбери скачанный `.apk` файл
4. Нажми **«Продолжить»**

### 7.3 Заполни страницу приложения

**Раздел «Страница приложения» → вкладка «Страница»:**

- **Название:** Aegis — аналитика Dota 2
- **Краткое описание (80 символов):** Прогнозы и аналитика матчей Dota 2 для ставок
- **Подробное описание:**
  ```
  Aegis — профессиональный инструмент аналитики Dota 2 для ставок.
  
  Возможности:
  • Прогнозы исходов матчей на основе ML-моделей
  • 15 рынков ставок: победитель, тоталы, первая кровь и другие
  • Live-прогнозы в реальном времени
  • Статистика команд и героев
  • Анализ исторических данных
  
  Данные обновляются автоматически. Используй информацию ответственно.
  ```
- **Категория:** Утилиты (или Спорт)
- **Возрастной рейтинг:** 18+

### 7.4 Скриншоты (обязательно минимум 4)

Нужны скриншоты с телефона или эмулятора с размером **1080×1920** (портретная ориентация).

Если нет скриншотов — можно временно использовать скриншоты с Replit Expo preview.

### 7.5 Иконка приложения

- Размер: **512×512 пикселей**, формат PNG
- Иконка находится в папке `artifacts/mobile/assets/images/icon.png`
- Загрузи её в RuStore

### 7.6 Политика конфиденциальности

В поле «Политика конфиденциальности» вставь ссылку на лендинг:
```
https://твой-домен/api/legal/privacy
```

Если запускаешь локально с ngrok:
```
https://abc123-456.ngrok-free.app/api/legal/privacy
```

### 7.7 Отправь на модерацию

1. Нажми **«Продолжить»** → **«Отправить на проверку»**
2. Модерация занимает **3-7 рабочих дней**
3. На email придёт уведомление об одобрении или замечаниях

---

## 🔄 ЧАСТЬ 8: Обновления (как обновлять потом)

### Обновить сервер на ноутбуке

```bash
# В папке aegis:
bash scripts/laptop/update.sh   # Mac/Linux
scripts\laptop\update.bat        # Windows
```

Скрипт сам: `git pull` → обновит пакеты → накатит изменения БД → перезапустит сервисы.

### Собрать новую версию APK

Обнови версию в `artifacts/mobile/app.json`:
```json
"version": "1.0.1",
"android": {
  "versionCode": 2
}
```

Затем:
```bash
eas build --platform android --profile production-android
```

Загрузи новый APK в RuStore консоль → пройдёт быстрая повторная модерация.

---

## 🛠 ЧАСТЬ 9: Полезные команды — быстрая шпаргалка

### PM2 (управление сервисами)

```bash
pm2 status          # посмотреть статус всех сервисов
pm2 logs            # логи в реальном времени (Ctrl+C для выхода)
pm2 logs aegis-api  # логи только API-сервера
pm2 logs aegis-ml   # логи ML-сервиса
pm2 restart all     # перезапустить всё
pm2 stop all        # остановить всё
pm2 start scripts/laptop/ecosystem.config.cjs  # запустить снова
```

### База данных

```bash
# Резервная копия
pg_dump postgresql://postgres:PASSWORD@localhost:5432/aegis > backup.sql

# Восстановление
psql postgresql://postgres:PASSWORD@localhost:5432/aegis < backup.sql

# Войти в консоль БД
psql postgresql://postgres:PASSWORD@localhost:5432/aegis

# Посмотреть количество матчей
psql -U postgres -d aegis -c "SELECT count(*) FROM pro_matches;"
```

### Скрипты данных (если нужно обновить вручную)

```bash
pnpm --filter @workspace/scripts run ingest:matches    # загрузить новые матчи
pnpm --filter @workspace/scripts run ingest:teams      # обновить команды
pnpm --filter @workspace/scripts run compute:recent-form  # пересчитать форму
pnpm --filter @workspace/scripts run train:lightgbm   # переобучить модели
```

### ngrok

```bash
ngrok http 8080              # открыть туннель (запускай в отдельном окне!)
ngrok http 8080 --log=stdout  # с логами
```

---

## 📊 Справочник: все данные системы

| Параметр | Значение |
|---|---|
| GitHub репозиторий | https://github.com/Kaas2110/Aegis |
| Package name (Android) | `com.aegis.dota` |
| URL схема (deeplinks) | `aegis://` |
| API порт | `8080` |
| ML-сервис порт | `8090` |
| Админка порт | `24276` |
| Политика конфиденциальности | `/api/legal/privacy` |
| Пользовательское соглашение | `/api/legal/terms` |

### Адреса после запуска на ноутбуке

| Что | Адрес |
|---|---|
| Админ-панель | http://localhost:24276/admin-web/ |
| API healthcheck | http://localhost:8080/api/healthz |
| Лендинг | http://localhost:8080/landing |
| ML-сервис | http://localhost:8090/health |

### Что хранится в базе данных

- `pro_matches` — все профессиональные матчи (~28 тысяч)
- `pro_teams` — команды с рейтингом ELO
- `match_drafts` — пики и баны героев
- `model_versions` — обученные ML-модели (включая LightGBM веса)
- `predictions` — все прогнозы системы
- `app_settings` — настройки приложения
- `live_snapshots` — снимки живых матчей для обучения

---

## ❓ Частые проблемы

### «node не найден» / «python не найден»
→ Перезапусти командную строку после установки. На Windows возможно нужно перезагрузить компьютер.

### «psql: FATAL: password authentication failed»
→ Неправильный пароль PostgreSQL. Проверь что в DATABASE_URL правильный пароль который задал при установке.

### «Port 8080 already in use»
→ Сервис уже запущен. Выполни `pm2 stop all` и снова `pm2 start`.

### «eas: command not found»
→ Выполни `npm install -g eas-cli` заново, перезапусти терминал.

### ngrok «session expired»
→ На бесплатном тарифе ngrok сессия живёт 8 часов. Перезапусти `ngrok http 8080` — получишь новый URL. Обнови URL в eas.json и пересобери APK.

### Приложение не подключается к серверу
→ Проверь что ngrok запущен и URL в `eas.json → EXPO_PUBLIC_API_URL` совпадает с текущим ngrok URL.

# RuStore release — план выкатки Aegis

> Цель: опубликовать Android-сборку мобилки (`artifacts/mobile`) в RuStore.
> Конфиг уже подготовлен: `app.json` (package `com.aegis.dota`, versionCode 1),
> `eas.json` (профиль `production-android`: APK + `EXPO_PUBLIC_PAYMENT_CHANNEL=rustore`).

## 0. Предусловия (без них не начинать)

| # | Что | Статус / где взять |
|---|-----|--------------------|
| 1 | **Прод-бэкенд с публичным HTTPS** | api-server должен быть доступен извне (ноут + Cloudflare Tunnel / домен, см. `docs/laptop-deploy.md`). Мобилка в сторе не может ходить на Replit dev-URL |
| 2 | **Аккаунт разработчика RuStore** | [console.rustore.ru](https://console.rustore.ru) — вход через VK ID; физлицо подтверждается через Госуслуги, ИП/юрлицо — по ИНН. Бесплатно |
| 3 | **Keystore для подписи** | генерируем один раз и храним вечно (потеря = невозможность обновлять приложение) |
| 4 | **Privacy policy URL** | обязательное поле RuStore. Разместить страницу политики (можно на том же домене, что api) |
| 5 | **Ассеты** | иконка 512×512 PNG, скриншоты ≥ 3 шт. (1080×1920), короткое (до 80 симв.) и полное (до 4000 симв.) описание на русском |

## 1. Прод-URL API в сборке

`EXPO_PUBLIC_API_URL` зашивается в JS-бандл **на этапе сборки**:

```bash
# добавить в eas.json → build.production-android.env:
"EXPO_PUBLIC_API_URL": "https://api.ваш-домен.ru"
```

Проверка: собрать превью-сборку и убедиться, что лента матчей грузится
с прод-бэкенда (не с Replit).

## 2. Подпись (keystore)

### Вариант A — EAS-managed (рекомендуется, проще)

EAS сам создаёт и хранит keystore в облаке Expo:

```bash
npx eas credentials --platform android   # посмотреть/создать
```

Скачать резервную копию: `eas credentials` → Android → Download credentials.
**Сохранить `.jks` + пароли в надёжном месте** (менеджер паролей).

### Вариант B — свой keystore (полный контроль)

```bash
keytool -genkeypair -v -keystore aegis-release.jks \
  -alias aegis -keyalg RSA -keysize 2048 -validity 10000
```

Подключить в `eas.json` через `credentialsSource: "local"` + `credentials.json`.

> RuStore не перепечатывает подпись (в отличие от Google Play App Signing) —
> APK попадает к пользователям с вашей подписью. Потеря keystore = новая
> регистрация приложения с новым package id.

## 3. Сборка релизного APK

RuStore принимает **APK и AAB**; профиль уже настроен на APK (проще для
RuStore, не нужен bundletool):

```bash
cd artifacts/mobile
npx eas build --platform android --profile production-android
```

Результат — ссылка на `.apk` в Expo dashboard. Скачиваем.

**Альтернатива без EAS** (локальная сборка, нужен Android SDK + JDK 17):

```bash
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk (подписать своим keystore)
```

## 4. Публикация в консоли RuStore

1. [console.rustore.ru](https://console.rustore.ru) → «Приложения» → «Добавить приложение».
2. Package name: `com.aegis.dota` (должен совпадать с app.json — менять нельзя после первой публикации).
3. Категория: «Спорт» или «Инструменты». Возрастной рейтинг: **18+**
   (аналитика для ставок; в приложении уже есть 18+ gate и дисклеймер).
4. Загрузить APK, описание, иконку, скриншоты, privacy policy URL.
5. **Анкета модерации** — ключевые формулировки (важно для прохождения):
   - приложение **не принимает ставки и не проводит платежи**;
   - это **аналитика и статистика** киберспортивных матчей;
   - нет интеграции с букмекерами на уровне транзакций — только публичные коэффициенты для сравнения;
   - есть возрастное ограничение 18+ и дисклеймер.
6. Отправить на модерацию (обычно 1-3 рабочих дня).

## 5. Обновления версий

Перед каждой новой загрузкой в `app.json`:

- `expo.android.versionCode` — **+1 обязательно** (2, 3, 4...);
- `expo.version` — человекочитаемая версия («1.0.1»).

## 6. После публикации (roadmap-хвосты)

- **Крэш-репорты**: RuStore не даёт своих — подключить Sentry
  (`sentry-expo`) отдельной задачей.
- **Push-уведомления**: серверные пуши на устройствах без Google-сервисов
  требуют RuStore Push SDK (нативный модуль, вне Expo Go). Отложено —
  алерты сейчас локальные, работают без пушей.
- **Платежи Premium**: `EXPO_PUBLIC_PAYMENT_CHANNEL=rustore` уже зашит в
  профиль — при внедрении тарифов использовать RuStore Payments SDK
  (не Google Billing).
- **Google Play позже**: тот же keystore и package id можно переиспользовать;
  профиль `production` в eas.json уже собирает AAB.

## Чек-лист релиза

- [ ] Прод-бэкенд доступен по HTTPS извне, `/api/healthz` отвечает
- [ ] `EXPO_PUBLIC_API_URL` в `eas.json` указывает на прод
- [ ] Keystore создан и забэкаплен (пароли в менеджере паролей)
- [ ] APK собран профилем `production-android`, установлен на реальный телефон, смоук пройден (лента, детали матча, регистрация, алерты)
- [ ] Аккаунт RuStore подтверждён
- [ ] Privacy policy опубликована по постоянному URL
- [ ] Ассеты готовы (иконка, ≥3 скриншота, описания)
- [ ] Анкета модерации заполнена с формулировками из §4.5
- [ ] После аппрува: ссылка на стор добавлена в рефералки (`/admin-web/sources`)

# 🚀 Dota Edge Analyzer — План публикации в App Store и Google Play

> Этот документ написан для человека **без опыта мобильного деплоя**. Каждый шаг детальный, с командами и тем, что вы должны увидеть.

---

## 📋 КРАТКИЙ ОБЗОР

**Что у вас есть:** Готовое Expo (React Native) приложение `artifacts/mobile/`.
**Что нужно:** опубликовать его в Google Play Store (Android) и App Store (iOS).
**Чем будем собирать:** **EAS Build** — облачный сервис от Expo, который собирает `.aab` (Android) и `.ipa` (iOS) **без вашего Mac**.

**Что заранее настроено в проекте:**
- ✅ `app.json` → `bundleIdentifier: com.dotaedge.analyzer` (iOS)
- ✅ `app.json` → `package: com.dotaedge.analyzer` (Android)
- ✅ `version: 1.0.0`, `versionCode: 1`, `buildNumber: "1"`
- ✅ Темная тема, splash, адаптивная иконка
- ✅ Конфиг push-уведомлений
- ✅ Подтверждение возраста 18+ и дисклеймер

**Сколько времени и денег:**
| Этап | Время | Стоимость |
|---|---|---|
| Регистрация Apple Developer | 1–7 дней (одобрение) | **$99/год** |
| Регистрация Google Play Console | 1–2 дня (верификация) | **$25 одноразово** |
| Регистрация Expo + EAS | 10 минут | бесплатно (Free план хватает на старте) |
| Настройка проекта | 1–2 часа | бесплатно |
| Первая сборка iOS + Android | 30–60 минут | бесплатно (30 сборок/мес на Free) |
| Первая публикация (review Apple) | 1–3 дня | — |
| Первая публикация (Google) | от 7 дней до 2 недель (для нового аккаунта) | — |

---

## 🔧 ЧАСТЬ 1. ПОДГОТОВИТЕЛЬНЫЕ АККАУНТЫ (сделать сразу)

### 1.1. Apple Developer Program (для iOS)
1. Откройте https://developer.apple.com/programs/enroll/
2. Войдите в свой Apple ID (или создайте, если нет).
3. Выберите тип: **Individual** (физлицо) — проще; либо **Organization** (нужен D-U-N-S номер, дольше).
4. Оплатите **$99/год** картой.
5. Дождитесь письма-подтверждения (обычно 24–48 часов, иногда до недели).

> ⚠️ Для **Individual** аккаунта приложение будет публиковаться от вашего имени (видно в App Store).

### 1.2. Google Play Console (для Android)
1. Откройте https://play.google.com/console/signup
2. Войдите через Google-аккаунт.
3. Выберите тип: **Personal** (физлицо).
4. Оплатите **$25 одноразово**.
5. Заполните профиль разработчика (имя, страна, контакты).
6. **С 2024 года Google требует от новых аккаунтов протестировать приложение с минимум 12 закрытыми тестировщиками в течение 14 дней до публикации.** Это новое правило, заложите в план.

### 1.3. Expo Account
1. Откройте https://expo.dev/signup
2. Зарегистрируйтесь (email + пароль или GitHub).
3. Запомните логин — он понадобится для `eas login` ниже.

---

## 🛠 ЧАСТЬ 2. ПОДГОТОВКА ПРОЕКТА К СБОРКЕ (~1 час)

> Все команды выполняются **в Replit Shell** или локально из папки `artifacts/mobile/`.

### 2.1. Установка EAS CLI
В Replit Shell:
```bash
npm install -g eas-cli
eas --version
```
Должна появиться версия (например `eas-cli/15.x.x`).

### 2.2. Логин в Expo
```bash
eas login
```
Введите email и пароль от Expo. Должно написать `Logged in as <ваш-username>`.

### 2.3. Привязка проекта к Expo-аккаунту
```bash
cd artifacts/mobile
eas init
```
- Согласитесь создать новый проект на Expo (`y`).
- В `app.json` автоматически добавится `extra.eas.projectId` — **это нормально, не удаляйте**.

### 2.4. Создание `eas.json` (конфиг сборок)
В папке `artifacts/mobile/` создайте файл `eas.json`:
```json
{
  "cli": {
    "version": ">= 15.0.0",
    "appVersionSource": "remote"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "ios": { "simulator": false }
    },
    "production": {
      "autoIncrement": true,
      "android": { "buildType": "app-bundle" },
      "ios": {}
    }
  },
  "submit": {
    "production": {}
  }
}
```
- `preview` — `.apk` для Android (можно установить вручную для теста).
- `production` — `.aab` для Google Play и стандартный `.ipa` для App Store.

### 2.5. Готовые иконки и сплеш
Проверьте, что в `artifacts/mobile/assets/images/` есть:
- `icon.png` — **1024×1024 PNG**, без прозрачности (иначе Apple отклонит).
- `splash.png` — рекомендуется 1284×2778 PNG.

Если файлы есть → ничего делать не нужно (`app.json` уже настроен).

### 2.6. Production-режим API
По умолчанию мобильное приложение обращается к API через `EXPO_PUBLIC_DOMAIN`. Когда соберёте production-бинарник, нужно прописать **публичный URL API**.

В Replit опубликуйте сначала **API-сервер** (artifact `api-server`) → получите URL вида `https://dota-edge-api.replit.app`. Затем:

В `artifacts/mobile/eas.json` добавьте в секцию `build.production`:
```json
"production": {
  "autoIncrement": true,
  "env": {
    "EXPO_PUBLIC_DOMAIN": "dota-edge-api.replit.app"
  },
  "android": { "buildType": "app-bundle" },
  "ios": {}
}
```

---

## 📦 ЧАСТЬ 3. ПЕРВАЯ ТЕСТОВАЯ СБОРКА (Android, 20 мин)

Самый простой способ убедиться, что всё работает — собрать `.apk` и установить на свой Android-телефон.

```bash
cd artifacts/mobile
eas build --profile preview --platform android
```

Что произойдёт:
1. EAS спросит несколько вопросов — соглашайтесь со значениями по умолчанию.
2. EAS автоматически создаст **Android keystore** (ключ подписи). Согласитесь — **EAS сохранит его за вас**, потерять нельзя.
3. Сборка запустится в облаке (видно прогресс на https://expo.dev/accounts/<ваш-username>/projects/mobile/builds).
4. Через 10–15 минут появится ссылка на `.apk` и QR-код.
5. Откройте ссылку с телефона → скачайте → установите (нужно разрешить «установка из неизвестных источников»).

**Если приложение запустилось и работает** → переходите к части 4. Если нет — смотрите логи сборки в Expo Dashboard.

---

## 🤖 ЧАСТЬ 4. ПУБЛИКАЦИЯ В GOOGLE PLAY

### 4.1. Подготовка стора
1. Войдите в https://play.google.com/console
2. Нажмите **Create app**.
3. Заполните:
   - **App name:** Dota Edge Analyzer
   - **Default language:** Русский (Россия)
   - **App or game:** App
   - **Free or paid:** Free
4. Подтвердите политики (declarations).

### 4.2. Заполнение store listing
В разделе **Main store listing**:
- **Short description (80 символов):** `Аналитика Dota 2 esports: live-данные OpenDota, прогнозы и расхождения с рынком`
- **Full description:** опишите функции (live-матчи, 15 типов рынков, бэктест, алерты на высокое ОЦ, fully Russian).
- **App icon:** загрузите `icon.png` (512×512).
- **Feature graphic:** 1024×500 PNG (сделать в Figma/Canva).
- **Screenshots:** минимум 2 штуки 1080×1920 (снимите с эмулятора или телефона).

### 4.3. Content rating, target audience, privacy
- **Content rating:** заполните анкету. Так как приложение **показывает коэффициенты, но не принимает ставки**, выберите *Reference / Educational / Esports analytics*. Возрастной рейтинг — **18+** (соответствует вашему age gate).
- **Target audience:** **18 and over** (важно — иначе Google потребует дополнительные ограничения).
- **Privacy Policy URL:** обязательно. Создайте простую страницу (можно на GitHub Pages/Notion) с текстом:
  - Какие данные собираете (только аналитика и настройки локально в AsyncStorage).
  - Что не передаёте никому.
  - Контакт для запросов на удаление.
- **Data safety form:** отметьте, что собираете только локально (analytics consent), без передачи на сервер.

### 4.4. Отдельный пункт: Real-money gambling declaration
Google **строго запрещает** приложения, помогающие делать ставки в странах, где это нелегально. Поскольку ваше приложение **только показывает аналитику** и не интегрируется с букмекерами:
- В декларации укажите: **«App does not facilitate real-money gambling»**.
- В описании явно подчеркните: **«Приложение не принимает ставки и не является букмекером»**.
- Дисклеймер 18+ внутри приложения и в описании Google Play.

### 4.5. Production сборка для Google
```bash
cd artifacts/mobile
eas build --profile production --platform android
```
Через 15–20 минут получите `.aab` файл.

### 4.6. Закрытое тестирование (обязательно для новых аккаунтов!)
1. В Play Console → **Testing → Closed testing → Create new release**.
2. Загрузите `.aab` (либо через сайт, либо через `eas submit --platform android`).
3. Создайте **email list** из 12+ человек (друзья, коллеги). Отправьте им opt-in ссылку.
4. Они должны зайти по ссылке и установить приложение → пользоваться **минимум 14 дней**.
5. После 14 дней Google Console разблокирует возможность publish to production.

### 4.7. Публикация в production
После 14 дней закрытого теста:
1. **Production → Create new release** → залить `.aab` (или promote из closed testing).
2. Заполнить release notes.
3. **Submit for review**. Обычно 1–7 дней.

---

## 🍏 ЧАСТЬ 5. ПУБЛИКАЦИЯ В APP STORE

### 5.1. App Store Connect
1. Войдите в https://appstoreconnect.apple.com (Apple ID разработчика).
2. **My Apps → +** → New App.
3. Заполните:
   - **Platform:** iOS
   - **Name:** Dota Edge Analyzer
   - **Primary language:** Russian
   - **Bundle ID:** `com.dotaedge.analyzer` (выберите из списка — он создастся автоматически после первой EAS-сборки).
   - **SKU:** `dotaedge-1` (любая уникальная строка для вас).

### 5.2. Сборка iOS
```bash
cd artifacts/mobile
eas build --profile production --platform ios
```
- EAS спросит про Apple ID → введите.
- EAS автоматически создаст **distribution certificate** и **provisioning profile** в вашем Apple Developer аккаунте.
- Сборка занимает 20–30 минут (iOS дольше из-за провижининга).
- На выходе получите `.ipa`.

### 5.3. Загрузка в App Store Connect
Самый простой путь — через EAS:
```bash
eas submit --profile production --platform ios
```
Это автоматически загрузит `.ipa` в App Store Connect.

### 5.4. Заполнение карточки в App Store Connect
Так же, как Google Play, но строже:
- **Screenshots:** обязательно для **iPhone 6.7"** (1290×2796) и **iPhone 6.5"** (1284×2778). Минимум 3 на каждый размер.
- **App Preview:** не обязательно.
- **Description:** на русском, упор на **аналитику и образовательный характер**.
- **Keywords:** dota, esports, аналитика, статистика, прогнозы (НЕ используйте «ставки», «казино», «букмекер» — Apple отклонит).
- **Support URL:** ссылка на email или сайт поддержки.
- **Privacy Policy URL:** та же, что для Google.
- **Age rating:** ответьте на анкету. Из-за gambling-related content (даже без приёма ставок) рейтинг будет **17+**.

### 5.5. Privacy Nutrition Label
Apple требует точно описать, что собираете:
- **Data Not Collected** — если вы не собираете ничего на сервер. Так и пишите.
- Если включите аналитику в будущем — обновите карточку.

### 5.6. Самое важное: App Store Review Guideline 5.3 (Gaming, Gambling, Lotteries)
Apple очень внимательно смотрит на esports/betting приложения. Чтобы пройти review:
1. **Никаких партнёрских ссылок на букмекеров** — нельзя кнопок «Сделать ставку», нельзя deep links.
2. В описании и метаданных явно: **«Приложение является аналитическим инструментом и не принимает ставки»**.
3. В самом приложении дисклеймер 18+ должен быть **до первого экрана** (у вас это уже есть в onboarding ✅).
4. **Не упоминайте конкретных букмекеров** в публичном описании App Store (внутри приложения — можно).

### 5.7. Submit for Review
1. App Store Connect → **App Store → Prepare for Submission** → выбрать загруженный `.ipa` build.
2. Заполнить всё, что обведено красным.
3. **Add for Review → Submit**.
4. Обычно 24–48 часов на ответ. Возможны вопросы от ревьюера — отвечайте оперативно.

---

## 🔄 ЧАСТЬ 6. ОБНОВЛЕНИЯ ПРИЛОЖЕНИЯ (после первого релиза)

При выпуске новой версии:

1. Обновить в `artifacts/mobile/app.json`:
   ```json
   "version": "1.0.1",
   "ios": { "buildNumber": "2" },
   "android": { "versionCode": 2 }
   ```
2. Собрать:
   ```bash
   eas build --profile production --platform all
   ```
3. Залить:
   ```bash
   eas submit --profile production --platform all
   ```
4. В Play Console / App Store Connect создать новый release с release notes.

> **OTA-обновления через EAS Update:** для мелких правок JS/UI можно НЕ собирать новую версию, а пушить обновление мгновенно через `eas update` (без review!). Подключается отдельно — см. https://docs.expo.dev/eas-update/getting-started/

---

## ❗ ЧЕК-ЛИСТ ПЕРЕД ПЕРВЫМ SUBMIT

### Технический
- [ ] `eas build --profile preview --platform android` собрался без ошибок
- [ ] APK установлен на реальный телефон, основные экраны работают (live-матчи грузятся, фильтры применяются, бэктест считает, алерты создаются)
- [ ] API-сервер опубликован отдельно, его URL прописан в `eas.json` → `production.env.EXPO_PUBLIC_DOMAIN`
- [ ] Иконка `icon.png` 1024×1024 без прозрачности
- [ ] Screenshots сделаны (мин. 3 для каждой платформы)

### Юридический
- [ ] Privacy Policy опубликована (URL работает)
- [ ] Terms of Service / EULA (опционально, но желательно)
- [ ] Дисклеймер 18+ внутри приложения (✅ уже есть в onboarding)
- [ ] В описании в сторах: **«Не букмекер. Не принимает ставки. Образовательно-аналитический инструмент»**

### Сторовый
- [ ] Apple Developer + Google Play Console аккаунты активны и оплачены
- [ ] Bundle ID `com.dotaedge.analyzer` зарегистрирован в обоих
- [ ] Заполнены все поля карточки в App Store Connect и Google Play Console
- [ ] Возрастной рейтинг **17+/18+** проставлен
- [ ] Закрытое тестирование Google запущено (14 дней до production!)

---

## 🆘 ТИПИЧНЫЕ ПРОБЛЕМЫ

| Симптом | Решение |
|---|---|
| `eas build` падает на iOS | Проверьте, что Apple Developer активен и оплачен |
| Apple отклонил по 5.3 (Gambling) | Уберите все упоминания «ставки» из метаданных, усильте дисклеймер |
| Google требует Closed Testing | Это новое требование 2024+. Найдите 12 тестировщиков, 14 дней опыта |
| iOS приложение крашится при пуше | Убедитесь, что `expo-notifications` в `dependencies` (✅ уже исправлено) |
| Мобилка не видит API в production | URL в `eas.json` → `EXPO_PUBLIC_DOMAIN` должен быть **без https://** и **без слеша на конце** |
| Apple запрашивает demo-аккаунт для review | Дайте им тестовый OpenDota match ID и скриншоты — у вас нет логина, поэтому объясните это |

---

## 📞 КОНТАКТЫ И ДОКУМЕНТАЦИЯ

- Expo / EAS docs: https://docs.expo.dev/build/introduction/
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Google Play Policies: https://play.google.com/about/developer-content-policy/
- Replit deployments: см. встроенный гайд по `Publishing` (кнопка Deploy в Workspace)

---

**Итого реальный таймлайн до публичного релиза в обоих сторах:**
- iOS: **5–10 дней** (1 день регистрация → 1 час подготовка → 30 мин сборка → 1–3 дня review).
- Android: **3–4 недели** (из-за обязательных 14 дней closed testing для новых аккаунтов).

Удачи с релизом! 🚀

# План выкатки в Google Play / App Store + подписки в RuStore / AppGallery

> Документ для владельца и ИИ-агентов. Контекст: мобилка — Expo (React Native)
> в `artifacts/mobile`, бэкенд — Express (`artifacts/api-server`), тарифы уже
> заложены в БД (`app_users.tariff`, default `free`). Simple/Lite-режим UI
> закомментирован под будущий Premium-gating. Выкатка в RuStore описана в
> `docs/rustore-release.md` — этот документ её ДОПОЛНЯЕТ (Google/Apple +
> подписки во всех четырёх сторах).

---

## 0. Важные ограничения (прочитать первым)

1. **Тематика приложения — беттинг-аналитика.** Мы НЕ принимаем ставки и не
   являемся букмекером, но показываем коэффициенты и прогнозы. У сторов разные
   политики:
   - **Google Play**: категория «Gambling-related» — аналитика без приёма
     ставок обычно проходит как обычное приложение, но при показе
     букмекерских коэффициентов ревьюеры могут потребовать анкету Gambling
     apps declaration, возрастной рейтинг 18+ и гео-ограничения. Возможный
     план Б: собрать «стор-версию» с выключенным блоком коэффициентов
     (`BOOKMAKERS_ENABLED` уже управляется с бэка через `/api/client-config` —
     достаточно завести флаг per-platform).
   - **App Store**: guideline 5.3 (gambling). Аналитика допустима, но 17+
     рейтинг обязателен; Apple строже к «betting tips» — в описании
     позиционировать как «esports statistics & analytics», без обещаний
     выигрыша.
   - **RuStore / AppGallery**: лояльнее, 18+ рейтинг достаточен.
2. **Российский аккаунт разработчика:**
   - Google Play: монетизация (Play Billing) для аккаунтов РФ **приостановлена**
     — продавать подписки из РФ-аккаунта нельзя. Нужен аккаунт разработчика в
     другой юрисдикции + юрлицо/карта этой юрисдикции для payout.
   - Apple: аналогично, payout на российские счета не работает; нужен Apple
     Developer Program ($99/год) на не-РФ юрлицо/ИП.
   - Если не-РФ юрлица нет: реалистичный путь — Google/Apple выкатываем
     **бесплатную** версию (Premium активируется промокодом/вебом), а платные
     подписки продаём только в RuStore + AppGallery + на своём сайте.
3. **Никакого обхода IAP:** если подписка покупается внутри приложения на
   iOS/Android(GP) — обязаны использовать нативный биллинг стора (Apple 30/15%,
   Google 15%). Ссылки «купи на сайте» внутри iOS-приложения запрещены
   (кроме юрисдикций, где разрешено внешнее анкорирование). В RuStore и
   AppGallery — свои SDK оплаты (RuStore Payments, Huawei IAP).

---

## 1. Google Play — выкатка

### 1.1 Аккаунт и организация
- [ ] Google Play Console, регистрация $25 (разово). Для монетизации — не-РФ
      юрлицо/ИП + банковский счёт (см. п.0.2).
- [ ] Заполнить Data safety form (мы собираем: email при регистрации,
      client-logs без PII; политика конфиденциальности — нужна публичная
      страница, можно раздавать с api-server `/privacy`).
- [ ] Анкета возрастного рейтинга (IARC) → 18+ из-за беттинг-контента.
- [ ] Gambling declaration: указать «нет реальных ставок, только аналитика».

### 1.2 Технические доработки в `artifacts/mobile`
- [ ] `app.json`: `android.package` (например `ru.aegis.analytics`),
      `versionCode` авто через EAS.
- [ ] Сборка: `eas build --platform android --profile production` → `.aab`
      (Google принимает только App Bundle, не APK — в отличие от RuStore).
- [ ] Подпись: Play App Signing (Google хранит ключ) + upload key от EAS.
      ⚠️ Использовать ОТДЕЛЬНЫЙ keystore от RuStore-версии не обязательно,
      но applicationId должен совпадать, если хотим общие пуши/диплинки.
- [ ] Прод-URL API вшить в `eas.json` env (`EXPO_PUBLIC_API_URL`).
- [ ] Target API level: Google требует последний-1 (сейчас 35) — Expo SDK
      обновить при необходимости.
- [ ] Экран 18+ gate уже есть — оставить.

### 1.3 Стор-ассеты
- [ ] Иконка 512×512, feature graphic 1024×500, 4–8 скриншотов телефона
      (можно снять с эмулятора), описание RU+EN.
- [ ] Политика конфиденциальности (публичный URL) + страница удаления
      аккаунта (Google требует «account deletion» URL — **доработка**:
      эндпоинт `DELETE /api/auth/me` + простая веб-страница).

### 1.4 Релизный процесс
- [ ] Internal testing → Closed testing (20 тестеров 14 дней — ОБЯЗАТЕЛЬНО для
      новых личных аккаунтов) → Production.
- [ ] Ревью 1–7 дней.

---

## 2. Apple App Store — выкатка

### 2.1 Аккаунт
- [ ] Apple Developer Program $99/год (не-РФ юрлицо/ИП для payout, см. п.0.2).
- [ ] App Store Connect: создать приложение, bundle id `ru.aegis.analytics`
      (или обратный домен юрлица).

### 2.2 Технические доработки
- [ ] iOS-сборка ещё НИ РАЗУ не делалась — прогнать
      `eas build --platform ios --profile production` (EAS умеет собирать iOS
      без Mac; сертификаты/provisioning генерит сам через Apple API key).
- [ ] Проверить iOS-специфику UI: safe areas, отсутствие Android-only API,
      пуш-разрешения (если включим пуши — нужен APNs key).
- [ ] `app.json`: `ios.bundleIdentifier`, `buildNumber`, `infoPlist` — описания
      разрешений (сейчас приложение не использует камеру/гео — хорошо).
- [ ] Возрастной рейтинг 17+ (frequent/intense simulated gambling → выбрать
      «Infrequent/Mild» + честно указать ссылки на букмекеров, если оставляем).
- [ ] Sign in with Apple НЕ обязателен (у нас email/password без сторонних
      OAuth — правило 4.8 не срабатывает).

### 2.3 Ревью-риски и подготовка
- [ ] Review notes: тестовый аккаунт (email+пароль), объяснение что ставки не
      принимаются.
- [ ] Позиционирование «esports analytics», без слов «betting tips /
      guaranteed win» в описании и скриншотах.
- [ ] Ревью 1–3 дня, вероятен 1 реджект с вопросами по 5.3 — отвечать фактами.

---

## 3. Подписки — общая архитектура (доработки в нашем коде)

Единая модель для всех 4 сторов: **приложение покупает подписку в нативном
биллинге стора → шлёт чек/токен на наш бэкенд → бэкенд валидирует у стора →
проставляет `app_users.tariff='premium'` + `premium_until` → мобилка получает
тариф из `GET /api/auth/me`**. Источник правды — наша БД, а не клиент.

### 3.1 Доработки БД (`lib/db`)
- [ ] `app_users`: добавить `premium_until timestamptz`, `premium_source text`
      (`rustore|appgallery|google|apple|promo`), `store_subscription_id text`.
- [ ] Новая таблица `subscription_receipts`: userId, store, productId,
      purchaseToken/receipt (raw), status, expiresAt, lastCheckedAt — для
      аудита и повторной валидации.

### 3.2 Доработки api-server
- [ ] `POST /api/subscriptions/verify` — body `{store, productId, token}`,
      Zod-валидация; серверная проверка чека:
      - **RuStore**: RuStore API `GET /public/subscription/{token}` c ключом
        консоли (env `RUSTORE_SUB_API_KEY`).
      - **AppGallery**: Huawei Order Service API
        (`/applications/purchases/tokens/verify`), OAuth client credentials
        (env `HUAWEI_CLIENT_ID/SECRET`).
      - **Google**: Play Developer API `purchases.subscriptionsv2.get`
        (service-account JSON, env `GOOGLE_PLAY_SA_JSON`).
      - **Apple**: App Store Server API `GET /inApps/v1/subscriptions/{txId}`
        (p8-ключ, env `APPLE_IAP_KEY_*`) — НЕ старый verifyReceipt.
- [ ] Крон в SchedulerWorker: раз в сутки перепроверять активные подписки
      (истечение/refund) и снимать premium.
- [ ] Webhooks (после MVP): RuStore callback, Huawei notifications, Google RTDN
      (Pub/Sub), Apple App Store Server Notifications v2 — мгновенные
      отмены/продления.
- [ ] `GET /api/auth/me` — вернуть `tariff`, `premiumUntil`.

### 3.3 Доработки мобилки
- [ ] Экран «Premium» (paywall): цена, что входит, кнопка покупки, restore.
- [ ] Гейтинг фичей: раскомментировать Lite/simple-режим — free видит simple,
      premium видит detailed + алерты + ladder (точный сплит решить с
      владельцем).
- [ ] Абстракция биллинга `services/billing/`: интерфейс + 4 реализации,
      выбор по store-каналу сборки (env `EXPO_PUBLIC_STORE=rustore|appgallery|
      google|apple`). ⚠️ RuStore/AppGallery SDK — нативные модули, потребуют
      **Expo prebuild / dev-client** (managed workflow недостаточно):
      - RuStore: `react-native-rustore-billing` (официальный от VK).
      - AppGallery: Huawei IAP (`@hmscore/react-native-hms-iap`).
      - Google: `react-native-iap` или RevenueCat.
      - Apple: то же (`react-native-iap` / StoreKit2 через RevenueCat).
      Для Google+Apple разумно взять **RevenueCat** (бесплатно до $2.5k MTR) —
      он закрывает валидацию чеков и вебхуки из коробки; RuStore/AppGallery
      он НЕ поддерживает — для них своя реализация по 3.2.

### 3.4 Продукты и цены
- [ ] Определить SKU: `aegis_premium_month` (например 299 ₽/мес),
      `aegis_premium_year` (например 1990 ₽/год). Одинаковые id во всех сторах.
- [ ] Триал: 7 дней (поддерживается всеми четырьмя).

---

## 4. RuStore — включение подписок (пошагово)

1. [ ] RuStore Консоль → приложение → «Монетизация» → подключить: нужен
       договор с RuStore (юрлицо/ИП/самозанятый РФ), реквизиты счёта.
2. [ ] Создать подписки (SKU из п.3.4): название, цена в ₽, период, триал.
3. [ ] Получить ключ для серверной валидации (Консоль → «Ключи API» →
       подписки) → секрет `RUSTORE_SUB_API_KEY` на бэкенд.
4. [ ] В мобилке подключить `react-native-rustore-billing`:
       `RuStoreBillingClient.init(consoleApplicationId, deeplinkScheme)`;
       покупка → `purchaseProduct(productId)` → получить `subscriptionToken`
       → отправить на `POST /api/subscriptions/verify`.
5. [ ] Deeplink-схема для возврата из оплаты (СБП/карта открываются вне
       приложения): прописать `scheme` в `app.json`.
6. [ ] Тестирование: «песочница» RuStore — добавить тестовые аккаунты VK ID,
       покупки без списания.
7. [ ] Выкатить обновление APK с биллингом на модерацию (повторное ревью).

## 5. Huawei AppGallery — публикация + подписки (пошагово)

1. [ ] Huawei Developer аккаунт (бесплатно, физлицо ок; для монетизации —
       merchant service, принимает и не-CN юрлица; payout возможен на РФ-счёт
       через Huawei Russia — уточнить актуальность при регистрации).
2. [ ] AppGallery Connect: создать проект+приложение, скачать
       `agconnect-services.json` в `artifacts/mobile`.
3. [ ] Сборка: тот же APK/AAB, что для RuStore (HMS-устройства без Google
       Services — наш стек Expo без Firebase, поэтому ОК; если добавим пуши,
       для Huawei нужен HMS Push Kit отдельно).
4. [ ] Включить IAP: AppGallery Connect → Earning → In-App Purchases →
       активировать, задать SKU подписок (auto-renewable), цены в ₽.
5. [ ] Подключить `@hmscore/react-native-hms-iap` (prebuild), покупка →
       `purchaseToken` → `POST /api/subscriptions/verify` (store=appgallery).
6. [ ] Серверная валидация: OAuth токен по `client_id/client_secret` проекта →
       Order Service API verify. Секреты `HUAWEI_CLIENT_ID`, `HUAWEI_CLIENT_SECRET`.
7. [ ] Модерация AppGallery 1–3 дня; указать 18+, «аналитика, ставки не
       принимаются».

## 6. Подписки в Google Play / App Store (когда появится не-РФ юрлицо)

- [ ] Google: Play Console → Monetize → Subscriptions → создать SKU; настроить
      RTDN (Pub/Sub topic) → наш webhook; service account с правами Android
      Publisher для верификации.
- [ ] Apple: App Store Connect → Subscriptions → группа + SKU; App Store
      Server Notifications v2 URL → наш webhook; ключ App Store Server API.
- [ ] Пройти Paid Applications Agreement (Apple) / платёжный профиль (Google).
- [ ] В коде уже всё готово по п.3 — только конфиги и SKU.

---

## 7. Сводный порядок работ (рекомендуемый)

| # | Этап | Зависимости | Оценка |
|---|---|---|---|
| 1 | Доработки БД + `POST /api/subscriptions/verify` + крон перепроверки | — | 1–2 дня агента |
| 2 | Paywall-экран + гейтинг Lite/Premium в мобилке | 1 | 1–2 дня агента |
| 3 | RuStore: договор монетизации + SKU + ключ API (владелец) | — | 1–3 дня (бюрократия) |
| 4 | RuStore billing SDK в мобилке (prebuild) + e2e в песочнице | 1,2,3 | 1–2 дня агента |
| 5 | Релиз RuStore с подписками | 4 | модерация 1–3 дня |
| 6 | AppGallery: аккаунт + IAP + SDK + релиз | 1,2 | 2–3 дня + модерация |
| 7 | Google Play: аккаунт (не-РФ для денег) + бесплатный релиз | — | ревью до 7 дней + 14 дней closed testing |
| 8 | App Store: аккаунт + первая iOS-сборка + релиз | — | 2–4 дня + ревью |
| 9 | Подписки Google/Apple (RevenueCat) | 7,8 + юрлицо | 2–3 дня агента |

**Что нужно ОТ ВЛАДЕЛЬЦА:** аккаунты разработчика (RuStore — есть по плану
rustore-release; Huawei; Google $25; Apple $99/год), договор монетизации
RuStore, решение по не-РФ юрлицу для Google/Apple денег, финальные цены SKU,
решение какие фичи входят в Premium.

**Что доработает агент:** всё из п.3 (БД, verify-эндпоинт, крон, вебхуки),
paywall и гейтинг в мобилке, интеграция 4 биллинг-SDK, prebuild-конфигурация
Expo, стор-ассеты (скриншоты/описания), страницы privacy + удаления аккаунта.

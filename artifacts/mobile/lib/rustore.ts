/**
 * RuStore Billing — заглушка и план интеграции.
 *
 * ─────────────────────────────────────────────────────────────
 * СТАТУС: НЕ ИНТЕГРИРОВАН. Файл содержит план и тип-контракт.
 * ─────────────────────────────────────────────────────────────
 *
 * ## Ограничения RuStore Billing для Expo
 *
 * Официального React Native SDK от RuStore нет. Единственный
 * вариант — написать Expo Module (нативный Android-модуль),
 * который обёртывает ru.rustore.sdk:billingclient (Java/Kotlin).
 * Это требует перехода на Expo Development Build (bare workflow).
 *
 * ## Почему RevenueCat не работает для RuStore
 *
 * RevenueCat поддерживает только App Store Connect и Google Play.
 * RuStore использует собственный биллинг на стороне VK.
 *
 * ## Альтернатива: серверный платёжный шлюз (рекомендуется)
 *
 * Вместо нативного RuStore Billing можно использовать российские
 * платёжные шлюзы через web-checkout в WebView/Browser:
 *
 * | Провайдер    | Физлицо/ИП | Комиссия | Метод интеграции |
 * |--------------|-----------|----------|-----------------|
 * | YooKassa     | Оба        | 3.5%     | REST API + WebView |
 * | CloudPayments| Оба        | 1.2-3.5% | REST API + WebView |
 * | Robokassa    | Оба        | 5-6%     | WebView redirect |
 * | Tinkoff Pay  | Оба        | ~2.5%    | REST API + WebView |
 *
 * Физлицо: можно работать с YooKassa/CloudPayments как ИП.
 * ИП — регистрация онлайн через Госуслуги, 5-7 рабочих дней,
 * госпошлина ~800 руб. (при электронной подаче через Госуслуги — бесплатно).
 *
 * ## Рекомендуемая архитектура (без нативного SDK)
 *
 * 1. Пользователь тапает "Купить Premium" → открывается WebView
 *    с URL платёжного шлюза (YooKassa/CloudPayments).
 * 2. Пользователь оплачивает картой / через СБП.
 * 3. Шлюз шлёт webhook на наш бэкенд (POST /api/payments/webhook).
 * 4. Бэкенд верифицирует подпись → создаёт запись subscription
 *    в PostgreSQL → отдаёт флаг isSubscribed через /api/config/monetization.
 * 5. Мобильный клиент опрашивает /api/config/monetization → разблокирует Premium.
 *
 * Схема обхода RevenueCat: заменить useSubscription на serverSubscription
 * ниже, который читает статус с нашего API, а не с RC.
 *
 * ## Следующие шаги для активации
 *
 * [ ] Зарегистрировать ИП (онлайн, Госуслуги, 5-7 дней, бесплатно)
 * [ ] Подключить YooKassa или CloudPayments (заявка + договор, ~3-5 дней)
 * [ ] Добавить таблицу `subscriptions` в schema (userId, expiresAt, provider)
 * [ ] Создать POST /api/payments/checkout + POST /api/payments/webhook
 * [ ] Заменить WebView-checkout в settings.tsx для канала RuStore
 * [ ] Опубликовать APK на RuStore (бесплатно, без биллинга сначала)
 */

/** Тип-заглушка для будущей интеграции серверного billing-шлюза. */
export interface ServerSubscription {
  isSubscribed: boolean;
  expiresAt: Date | null;
  provider: "rustore_yookassa" | "rustore_cloudpayments" | "revenuecat" | null;
}

/** Пока всегда возвращает false — заглушка до реализации серверного billing. */
export function useServerSubscription(): Pick<ServerSubscription, "isSubscribed"> {
  return { isSubscribed: false };
}

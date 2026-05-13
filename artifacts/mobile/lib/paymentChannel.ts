/**
 * Канал монетизации.
 *
 * Задаётся в env (EXPO_PUBLIC_PAYMENT_CHANNEL) на этапе EAS-сборки:
 *   - 'revenuecat' (default) — App Store / Google Play через RC SDK
 *   - 'rustore'              — RuStore APK, оплата через YooKassa WebBrowser
 *
 * В eas.json для профиля production-android выставляется 'rustore'.
 */

export type PaymentChannel = 'revenuecat' | 'rustore';

export function getPaymentChannel(): PaymentChannel {
  const ch = process.env.EXPO_PUBLIC_PAYMENT_CHANNEL;
  if (ch === 'rustore') return 'rustore';
  return 'revenuecat';
}

export const PAYMENT_CHANNEL = getPaymentChannel();

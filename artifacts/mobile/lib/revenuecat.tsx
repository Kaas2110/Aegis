/**
 * RevenueCat — primary провайдер монетизации.
 * Adapty оставлен как альтернатива (lib/adapty.tsx) — переключение делается
 * заменой импортов в app/_layout.tsx и lib/featureFlags.tsx.
 *
 * Контракт `useSubscription`/типы пакетов — совместим с lib/adapty.tsx,
 * чтобы UI (settings.tsx, index.tsx) работал без изменений.
 *
 * Ключи (env):
 *   - EXPO_PUBLIC_REVENUECAT_TEST_API_KEY (web/dev/Expo Go)
 *   - EXPO_PUBLIC_REVENUECAT_IOS_API_KEY  (production iOS)
 *   - EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY (production Android)
 *
 * На web и в случае отсутствия ключей SDK не активируется,
 * хук возвращает isSubscribed=false и пустые offerings.
 */
import React, { createContext, useContext } from "react";
import { Platform } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";

const REVENUECAT_TEST_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
const REVENUECAT_IOS_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
const REVENUECAT_ANDROID_API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;

export const REVENUECAT_ENTITLEMENT_IDENTIFIER = "premium";

// ─── Ленивый импорт SDK (web-safe) ────────────────────────────────────────────

type PurchasesModule = any;
let _sdk: PurchasesModule | null = null;

async function getSdk(): Promise<PurchasesModule | null> {
  if (Platform.OS === "web") return null;
  if (_sdk) return _sdk;
  try {
    const mod = await import("react-native-purchases");
    _sdk = (mod as any).default ?? mod;
    return _sdk;
  } catch {
    return null;
  }
}

function getRevenueCatApiKey(): string | null {
  const isDevLike =
    __DEV__ ||
    Platform.OS === "web" ||
    Constants.executionEnvironment === "storeClient";

  if (isDevLike) return REVENUECAT_TEST_API_KEY ?? null;
  if (Platform.OS === "ios") return REVENUECAT_IOS_API_KEY ?? null;
  if (Platform.OS === "android") return REVENUECAT_ANDROID_API_KEY ?? null;
  return REVENUECAT_TEST_API_KEY ?? null;
}

export async function initializeRevenueCat() {
  const apiKey = getRevenueCatApiKey();
  if (!apiKey) {
    if (__DEV__) console.warn("[RevenueCat] API key не задан — пропускаем активацию.");
    return;
  }
  const Purchases = await getSdk();
  if (!Purchases) return;
  try {
    Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
    Purchases.configure({ apiKey });
    if (__DEV__) console.log("[RevenueCat] SDK активирован");
  } catch (err: any) {
    if (__DEV__) console.warn("[RevenueCat] configure:", err?.message ?? err);
  }
}

// ─── Унифицированный тип пакета (совместим с adapty.tsx) ──────────────────────
//
// Тип называется AdaptyPackageInfo для обратной совместимости с UI, но реально
// сюда мапится `PurchasesPackage` из RevenueCat. _raw хранит исходный объект.

export interface AdaptyPackageInfo {
  /** Идентификатор продукта в магазине (com.aegis.premium.monthly, etc.) */
  identifier: string;
  product: {
    priceString: string;
    price: number;
    currencyCode: string | null;
  };
  /** Оригинальный объект SDK для передачи в makePurchase / purchasePackage */
  _raw: any;
}

export interface SubscriptionOfferings {
  current: {
    availablePackages: AdaptyPackageInfo[];
  } | null;
}

function mapPackage(p: any): AdaptyPackageInfo {
  // RC v10 структура: p.product.{priceString, price, currencyCode, identifier, subscriptionPeriod}
  // Поддержим и legacy snake_case на всякий случай.
  const prod = p?.product ?? {};
  const priceString: string = prod.priceString ?? prod.price_string ?? `${prod.price ?? ''}`;
  const price: number = typeof prod.price === 'number' ? prod.price : Number(prod.price ?? 0);
  const currencyCode: string | null = prod.currencyCode ?? prod.currency_code ?? null;
  return {
    identifier: prod.identifier ?? p.identifier ?? '',
    product: { priceString, price, currencyCode },
    _raw: p,
  };
}

function mapOfferings(rcOfferings: any): SubscriptionOfferings {
  const current = rcOfferings?.current;
  if (!current) return { current: null };
  const pkgs = (current.availablePackages ?? []).map(mapPackage);
  return { current: pkgs.length > 0 ? { availablePackages: pkgs } : null };
}

// ─── Helpers периода/триала (та же сигнатура что в adapty.tsx) ────────────────

const PERIOD_LABEL: Record<string, string> = {
  WEEKLY:  'в неделю',
  MONTHLY: 'в месяц',
  ANNUAL:  'в год',
  YEARLY:  'в год',
  TWO_MONTH:    'каждые 2 месяца',
  THREE_MONTH:  'каждые 3 месяца',
  SIX_MONTH:    'каждые 6 месяцев',
  LIFETIME: 'навсегда',
};

/** ISO 8601 период (P1W/P1M/P1Y) → ярлык. */
function periodFromIso(iso: string | undefined): string {
  if (!iso) return '';
  const m = /^P(\d+)([DWMY])$/.exec(iso);
  if (!m) return '';
  const n = Number(m[1]);
  switch (m[2]) {
    case 'D': return n === 7 ? 'в неделю' : `за ${n} дн.`;
    case 'W': return n === 1 ? 'в неделю' : `за ${n} нед.`;
    case 'M':
      if (n === 1) return 'в месяц';
      if (n === 12) return 'в год';
      return `каждые ${n} мес.`;
    case 'Y': return n === 1 ? 'в год' : `за ${n} лет`;
  }
  return '';
}

export function getPlanLabel(pkg: AdaptyPackageInfo): string {
  const raw = pkg?._raw ?? {};
  // 1) RC: packageType (ANNUAL/MONTHLY/WEEKLY/LIFETIME)
  const pt = String(raw.packageType ?? '').toUpperCase();
  if (PERIOD_LABEL[pt]) return PERIOD_LABEL[pt];
  // 2) RC: product.subscriptionPeriod ISO 8601
  const iso = raw.product?.subscriptionPeriod ?? raw.product?.subscriptionPeriodIso;
  const fromIso = periodFromIso(iso);
  if (fromIso) return fromIso;
  // 3) Fallback по identifier
  const id = (pkg.identifier || '').toLowerCase();
  if (id.includes('year') || id.includes('annual')) return 'в год';
  if (id.includes('month')) return 'в месяц';
  if (id.includes('week')) return 'в неделю';
  return 'в период';
}

/**
 * Возвращает количество дней триала. Fallback = 7 (мы всегда настраиваем
 * 7-дневный free trial в App Store Connect / Play Console).
 */
export function getTrialDays(pkg: AdaptyPackageInfo | null | undefined): number {
  if (!pkg) return 0;
  const raw = pkg._raw ?? {};
  const intro = raw.product?.introPrice;
  if (intro && typeof intro === 'object') {
    const u = String(intro.periodUnit ?? intro.period?.unit ?? '').toUpperCase();
    const n = Number(intro.periodNumberOfUnits ?? intro.period?.numberOfUnits ?? 0);
    if (n > 0) {
      if (u.startsWith('DAY')) return n;
      if (u.startsWith('WEEK')) return n * 7;
      if (u.startsWith('MONTH')) return n * 30;
    }
  }
  // Fallback — на тест-окружении introPrice часто null, но в сторе мы всегда
  // настраиваем 7-дневный free trial.
  return 7;
}

const SORT_TYPE: Record<string, number> = {
  WEEKLY: 0, MONTHLY: 1, TWO_MONTH: 2, THREE_MONTH: 3, SIX_MONTH: 4, ANNUAL: 5, YEARLY: 5, LIFETIME: 6,
};

export function sortPackages(pkgs: AdaptyPackageInfo[]): AdaptyPackageInfo[] {
  return [...pkgs].sort((a, b) => {
    const pa = String(a._raw?.packageType ?? '').toUpperCase();
    const pb = String(b._raw?.packageType ?? '').toUpperCase();
    return (SORT_TYPE[pa] ?? 99) - (SORT_TYPE[pb] ?? 99);
  });
}

export function isAnnualPackage(pkg: AdaptyPackageInfo): boolean {
  const pt = String(pkg._raw?.packageType ?? '').toUpperCase();
  if (pt === 'ANNUAL' || pt === 'YEARLY') return true;
  const iso = pkg._raw?.product?.subscriptionPeriod;
  if (iso === 'P1Y' || iso === 'P12M') return true;
  return (pkg.identifier || '').toLowerCase().includes('year') ||
         (pkg.identifier || '').toLowerCase().includes('annual');
}

// ─── Хук подписки (тот же контракт что в adapty.tsx) ──────────────────────────

function useSubscriptionContext() {
  const qc = useQueryClient();

  const customerInfoQuery = useQuery({
    queryKey: ["revenuecat", "customer-info"],
    queryFn: async () => {
      const Purchases = await getSdk();
      if (!Purchases) return null;
      try {
        return await Purchases.getCustomerInfo();
      } catch (err: any) {
        if (__DEV__) console.warn('[RevenueCat] getCustomerInfo:', err?.message ?? err);
        return null;
      }
    },
    staleTime: 60 * 1000,
    retry: 1,
  });

  const offeringsQuery = useQuery({
    queryKey: ["revenuecat", "offerings"],
    queryFn: async (): Promise<SubscriptionOfferings> => {
      const Purchases = await getSdk();
      if (!Purchases) return { current: null };
      try {
        const raw = await Purchases.getOfferings();
        return mapOfferings(raw);
      } catch (err: any) {
        if (__DEV__) console.warn('[RevenueCat] getOfferings:', err?.message ?? err);
        return { current: null };
      }
    },
    staleTime: 300 * 1000,
    retry: 1,
  });

  const purchaseMutation = useMutation({
    mutationFn: async (pkg: AdaptyPackageInfo) => {
      const Purchases = await getSdk();
      if (!Purchases) throw new Error("RevenueCat SDK недоступен на этой платформе");
      const { customerInfo } = await Purchases.purchasePackage(pkg._raw);
      return customerInfo;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["revenuecat", "customer-info"] }),
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      const Purchases = await getSdk();
      if (!Purchases) throw new Error("RevenueCat SDK недоступен на этой платформе");
      return Purchases.restorePurchases();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["revenuecat", "customer-info"] }),
  });

  const customerInfo = customerInfoQuery.data;
  const isSubscribed =
    customerInfo?.entitlements?.active?.[REVENUECAT_ENTITLEMENT_IDENTIFIER] !== undefined;

  return {
    customerInfo,
    profile: customerInfo, // alias для совместимости с adapty-style потребителями
    offerings: offeringsQuery.data ?? { current: null },
    isSubscribed,
    isLoading: customerInfoQuery.isLoading || offeringsQuery.isLoading,
    purchase: purchaseMutation.mutateAsync,
    restore: restoreMutation.mutateAsync,
    isPurchasing: purchaseMutation.isPending,
    isRestoring: restoreMutation.isPending,
  };
}

type SubscriptionContextValue = ReturnType<typeof useSubscriptionContext>;
const Context = createContext<SubscriptionContextValue | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const value = useSubscriptionContext();
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSubscription() {
  const ctx = useContext(Context);
  if (!ctx) {
    throw new Error("useSubscription must be used within a SubscriptionProvider");
  }
  return ctx;
}

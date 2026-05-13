/**
 * Adapty — замена RevenueCat для RU/СНГ рынка.
 * Adapty v3 SDK. Singleton экспортируется как `adapty` из пакета.
 *
 * API-ключ: EXPO_PUBLIC_ADAPTY_KEY (публичный, безопасно в env).
 * Access Level «premium» настраивается в Adapty Dashboard.
 *
 * На web / dev Adapty SDK недоступен — используем заглушку (isSubscribed=false).
 *
 * Placement ID для пейволла — «main» (нужно создать в дашборде Adapty).
 * Если не создан, офферинги будут пустыми, но приложение не упадёт.
 */
import React, { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdaptyPaywallProduct,
  AdaptyProfile,
} from 'react-native-adapty';

const ADAPTY_KEY = process.env.EXPO_PUBLIC_ADAPTY_KEY ?? '';
export const ADAPTY_PREMIUM_ACCESS_LEVEL = 'premium';

// Placement ID пейволла — создайте в Adapty Dashboard → Placements
const PLACEMENT_ID = 'main';

// ─── Ленивый импорт SDK (не работает на web) ─────────────────────────────────

let _sdk: typeof import('react-native-adapty') | null = null;
async function getSdk() {
  if (Platform.OS === 'web') return null;
  if (_sdk) return _sdk;
  try {
    _sdk = await import('react-native-adapty');
    return _sdk;
  } catch {
    return null;
  }
}

// ─── Инициализация ────────────────────────────────────────────────────────────

export async function initializeAdapty() {
  if (!ADAPTY_KEY) {
    if (__DEV__) console.warn('[Adapty] EXPO_PUBLIC_ADAPTY_KEY не задан — пропускаем активацию.');
    return;
  }
  const sdk = await getSdk();
  if (!sdk) return;
  try {
    await sdk.adapty.activate(ADAPTY_KEY);
    if (__DEV__) console.log('[Adapty] SDK активирован');
  } catch (err: any) {
    // SDK кидает если уже активирован — молча игнорируем
    if (__DEV__) console.warn('[Adapty] activate:', err?.message ?? err);
  }
}

// ─── Наш публичный тип пакета (обёртка над AdaptyPaywallProduct) ──────────────

export interface AdaptyPackageInfo {
  /** Идентификатор продукта в магазине (com.aegis.premium.monthly, etc.) */
  identifier: string;
  product: {
    priceString: string;
    price: number;
    currencyCode: string | null;
  };
  /** Оригинальный объект Adapty SDK для передачи в makePurchase */
  _raw: AdaptyPaywallProduct;
}

export interface AdaptyOfferingsResult {
  current: {
    availablePackages: AdaptyPackageInfo[];
  } | null;
}

// ─── Маппинг продукта ─────────────────────────────────────────────────────────

function mapProduct(p: AdaptyPaywallProduct): AdaptyPackageInfo {
  // Цена — либо localizedPrice из SDK, либо форматируем вручную
  const raw = p as any;
  const price: number = raw.price ?? 0;
  const currencyCode: string | null = raw.currencyCode ?? null;
  const priceString: string =
    raw.localizedPrice ??
    (currencyCode ? `${price} ${currencyCode}` : `${price}`);

  return {
    identifier: p.vendorProductId,
    product: { priceString, price, currencyCode },
    _raw: p,
  };
}

// ─── Период/метка тарифа ──────────────────────────────────────────────────────

const PERIOD_LABEL: Record<string, string> = {
  week:  'в неделю',
  month: 'в месяц',
  year:  'в год',
};

export function getPlanLabel(pkg: AdaptyPackageInfo): string {
  // Пробуем достать период из subscriptionDetails
  const sd = (pkg._raw as any).subscriptionDetails;
  const unit: string = sd?.subscriptionPeriod?.unit ?? '';
  return PERIOD_LABEL[unit.toLowerCase()] ?? 'в период';
}

export function getTrialDays(pkg: AdaptyPackageInfo | null | undefined): number {
  if (!pkg) return 0;
  const sd = (pkg._raw as any).subscriptionDetails;
  const offer = sd?.introductoryOffer ?? sd?.promotionalOffers?.[0];
  if (!offer) return 0;
  const period = offer.subscriptionPeriod;
  if (!period) return 0;
  const n = period.numberOfUnits ?? 0;
  const unit: string = (period.unit ?? '').toLowerCase();
  if (unit === 'day') return n;
  if (unit === 'week') return n * 7;
  if (unit === 'month') return n * 30;
  return 0;
}

const SORT_UNIT: Record<string, number> = { week: 0, month: 1, year: 2 };

export function sortPackages(pkgs: AdaptyPackageInfo[]): AdaptyPackageInfo[] {
  return [...pkgs].sort((a, b) => {
    const ua = (a._raw as any).subscriptionDetails?.subscriptionPeriod?.unit ?? '';
    const ub = (b._raw as any).subscriptionDetails?.subscriptionPeriod?.unit ?? '';
    return (SORT_UNIT[ua.toLowerCase()] ?? 99) - (SORT_UNIT[ub.toLowerCase()] ?? 99);
  });
}

/** Определяет «годовой» тариф (для показа плашки «ВЫГОДНО») */
export function isAnnualPackage(pkg: AdaptyPackageInfo): boolean {
  const unit = (pkg._raw as any).subscriptionDetails?.subscriptionPeriod?.unit ?? '';
  return unit.toLowerCase() === 'year';
}

// ─── Context / Provider / Hook ────────────────────────────────────────────────

function useSubscriptionContext() {
  const qc = useQueryClient();

  const profileQuery = useQuery({
    queryKey: ['adapty', 'profile'],
    queryFn: async (): Promise<AdaptyProfile | null> => {
      const sdk = await getSdk();
      if (!sdk) return null;
      return sdk.adapty.getProfile();
    },
    staleTime: 60_000,
    retry: 2,
  });

  const offeringsQuery = useQuery({
    queryKey: ['adapty', 'offerings'],
    queryFn: async (): Promise<AdaptyOfferingsResult> => {
      const sdk = await getSdk();
      if (!sdk) return { current: null };
      try {
        const paywall = await sdk.adapty.getPaywallForDefaultAudience(PLACEMENT_ID, 'ru');
        const products = await sdk.adapty.getPaywallProducts(paywall);
        const pkgs = products.map(mapProduct);
        return { current: pkgs.length > 0 ? { availablePackages: pkgs } : null };
      } catch (err: any) {
        if (__DEV__) console.warn('[Adapty] getPaywall:', err?.message ?? err);
        return { current: null };
      }
    },
    staleTime: 300_000,
    retry: 1,
  });

  const purchaseMutation = useMutation({
    mutationFn: async (pkg: AdaptyPackageInfo) => {
      const sdk = await getSdk();
      if (!sdk) throw new Error('Adapty SDK недоступен на этой платформе');
      return sdk.adapty.makePurchase(pkg._raw);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adapty', 'profile'] });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      const sdk = await getSdk();
      if (!sdk) throw new Error('Adapty SDK недоступен на этой платформе');
      return sdk.adapty.restorePurchases();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adapty', 'profile'] });
    },
  });

  const profile = profileQuery.data;
  const accessLevel = profile?.accessLevels?.[ADAPTY_PREMIUM_ACCESS_LEVEL];
  const isSubscribed = accessLevel?.isActive === true;

  return {
    profile,
    offerings: offeringsQuery.data,
    isSubscribed,
    isLoading: profileQuery.isLoading || offeringsQuery.isLoading,
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
  if (!ctx) throw new Error('useSubscription must be used within a SubscriptionProvider');
  return ctx;
}

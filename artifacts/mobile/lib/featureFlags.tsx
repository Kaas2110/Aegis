/**
 * Чтение matrix фичей с бэкенда (/api/config/monetization) + удобный хук
 * для гейтинга UI. Источник истины: app_settings.feature_flags.
 *
 * Модель: независимые булевы per-tier.
 *   flags.win_probability = { free: false, basic: false, premium: true }
 * Нет каскада «минимального тира» — каждый тир задаётся независимо.
 *
 *  - mode 'freemium' — Free + Premium. Тир пользователя из RevenueCat
 *    (isSubscribed → 'premium', иначе 'free').
 *  - mode 'tiered' — Free + Basic + Premium. Basic тир ещё не реализован
 *    (entitlement отсутствует), поэтому пока: isSubscribed → 'premium', иначе 'free'.
 */

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSubscription } from './adapty';
import { getApiUrl } from './api/baseUrl';
import { notificationService } from '@/services/notifications/NotificationService';

export type SubscriptionTier = 'free' | 'basic' | 'premium';
export type MonetizationMode = 'freemium' | 'tiered';

export type FeatureKey =
  | 'win_probability'
  | 'market_predictions'
  | 'draft_analysis'
  | 'backtest'
  | 'alerts_edge'
  | 'live_predictions';

export interface TierAccess {
  free: boolean;
  basic: boolean;
  premium: boolean;
}

export interface FeatureFlagsConfig {
  mode: MonetizationMode;
  flags: Record<FeatureKey, TierAccess>;
  features: Array<{ key: FeatureKey; label: string; description?: string }>;
}

const DEFAULT_TIER_ACCESS: TierAccess = { free: false, basic: false, premium: true };

const DEFAULT_CONFIG: FeatureFlagsConfig = {
  mode: 'freemium',
  flags: {
    win_probability:    { ...DEFAULT_TIER_ACCESS },
    market_predictions: { ...DEFAULT_TIER_ACCESS },
    draft_analysis:     { ...DEFAULT_TIER_ACCESS },
    backtest:           { ...DEFAULT_TIER_ACCESS },
    alerts_edge:        { ...DEFAULT_TIER_ACCESS },
    live_predictions:   { ...DEFAULT_TIER_ACCESS },
  },
  features: [],
};

const Context = createContext<FeatureFlagsConfig>(DEFAULT_CONFIG);

export function FeatureFlagsProvider({ children }: { children: React.ReactNode }) {
  const { data } = useQuery({
    queryKey: ['monetization-config'],
    queryFn: async (): Promise<FeatureFlagsConfig> => {
      const r = await fetch(getApiUrl('/api/config/monetization'));
      if (!r.ok) throw new Error(`config: HTTP ${r.status}`);
      return (await r.json()) as FeatureFlagsConfig;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const value = data ?? DEFAULT_CONFIG;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useFeatureFlagsConfig(): FeatureFlagsConfig {
  return useContext(Context);
}

export function useUserTier(): SubscriptionTier {
  const { isSubscribed } = useSubscription();
  // Basic тир ещё не реализован (нет entitlement в RC).
  // Когда появится — добавить проверку active['basic'] здесь.
  return isSubscribed ? 'premium' : 'free';
}

/** Side-effect компонент: при потере доступа к alerts_edge глушит
 *  фоновые уведомления (push/in-app). */
export function FeatureFlagsSideEffects() {
  const access = useFeatureAccess('alerts_edge');
  useEffect(() => {
    notificationService.setEnabled(access.canAccess);
  }, [access.canAccess]);
  return null;
}

export interface FeatureAccess {
  canAccess: boolean;
  /** Первый тир, у которого есть доступ (для CTA «Доступно в X»). */
  required: SubscriptionTier;
  current: SubscriptionTier;
  mode: MonetizationMode;
}

export function useFeatureAccess(key: FeatureKey): FeatureAccess {
  const cfg = useFeatureFlagsConfig();
  const current = useUserTier();
  return useMemo<FeatureAccess>(() => {
    const tierAccess: TierAccess = cfg.flags[key] ?? DEFAULT_TIER_ACCESS;

    // Доступ для текущего тира пользователя
    const canAccess = tierAccess[current] === true;

    // Первый (наименьший) тир с доступом — для CTA в paywall
    const tiers: SubscriptionTier[] = ['free', 'basic', 'premium'];
    let required: SubscriptionTier = 'premium';
    for (const t of tiers) {
      if (tierAccess[t]) { required = t; break; }
    }

    // В freemium тира `basic` не существует — повышаем до premium для CTA
    if (cfg.mode === 'freemium' && required === 'basic') required = 'premium';

    return { canAccess, required, current, mode: cfg.mode };
  }, [cfg, current, key]);
}

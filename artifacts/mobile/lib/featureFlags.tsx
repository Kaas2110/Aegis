/**
 * Чтение matrix фичей с бэкенда (/api/config/monetization) + удобный хук
 * для гейтинга UI. Источник истины: app_settings.feature_flags. Меняется
 * админом через /api/admin/feature-flags без релиза.
 *
 *  - mode 'freemium' — Free + Premium. Тир пользователя берётся из RevenueCat
 *    (isSubscribed → 'premium', иначе 'free').
 *  - mode 'tiered' — Free + Basic + Premium. Basic тир ещё не реализован
 *    (entitlement отсутствует), поэтому пока ведёт себя как freemium:
 *    isSubscribed → 'premium', иначе 'free'.
 *
 * canAccess: ранг пользователя >= ранга, требуемого для фичи.
 */

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSubscription } from './revenuecat';
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

export interface FeatureFlagsConfig {
  mode: MonetizationMode;
  flags: Record<FeatureKey, SubscriptionTier>;
  features: Array<{ key: FeatureKey; label: string; description?: string }>;
}

const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, basic: 1, premium: 2 };

const DEFAULT_CONFIG: FeatureFlagsConfig = {
  mode: 'freemium',
  flags: {
    win_probability: 'premium',
    market_predictions: 'premium',
    draft_analysis: 'premium',
    backtest: 'premium',
    alerts_edge: 'premium',
    live_predictions: 'premium',
  },
  features: [],
};

const Context = createContext<FeatureFlagsConfig>(DEFAULT_CONFIG);

export function FeatureFlagsProvider({ children }: { children: React.ReactNode }) {
  const { data } = useQuery({
    queryKey: ['monetization-config'],
    queryFn: async (): Promise<FeatureFlagsConfig> => {
      const r = await fetch('/api/config/monetization');
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
  // Basic тир ещё не реализован (нет соответствующего entitlement в RC).
  // Когда появится — добавить проверку active['basic'] здесь.
  return isSubscribed ? 'premium' : 'free';
}

/** Side-effect компонент: при потере доступа к alerts_edge глушит
 *  фоновые уведомления (push/in-app), чтобы persisted-правила не срабатывали
 *  у пользователей без подписки. */
export function FeatureFlagsSideEffects() {
  const access = useFeatureAccess('alerts_edge');
  useEffect(() => {
    notificationService.setEnabled(access.canAccess);
  }, [access.canAccess]);
  return null;
}

export interface FeatureAccess {
  canAccess: boolean;
  required: SubscriptionTier;
  current: SubscriptionTier;
  /** В freemium режиме показывает только free|premium колонки в paywall. */
  mode: MonetizationMode;
}

export function useFeatureAccess(key: FeatureKey): FeatureAccess {
  const cfg = useFeatureFlagsConfig();
  const current = useUserTier();
  return useMemo<FeatureAccess>(() => {
    let required = cfg.flags[key] ?? 'premium';
    // В freemium тира `basic` не существует — поднимаем требование до premium,
    // чтобы доступ нельзя было получить через несуществующий тир.
    if (cfg.mode === 'freemium' && required === 'basic') required = 'premium';
    return {
      canAccess: TIER_RANK[current] >= TIER_RANK[required],
      required,
      current,
      mode: cfg.mode,
    };
  }, [cfg, current, key]);
}

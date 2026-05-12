/**
 * Универсальный гейт: оборачивает любой контент и блокирует его,
 * если пользователь не имеет доступа к фиче. По умолчанию рисует
 * blur-style overlay с CTA «Открыть в Premium». В режиме `inline`
 * целиком заменяет children на компактную карточку-замок.
 *
 * Если пользователь имеет доступ — рендерит children без обёртки.
 */

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import {
  useFeatureAccess,
  type FeatureKey,
  type SubscriptionTier,
} from '@/lib/featureFlags';

const TIER_LABEL: Record<SubscriptionTier, string> = {
  free: 'Free',
  basic: 'Basic',
  premium: 'Premium',
};

interface Props {
  feature: FeatureKey;
  /** inline = карточка вместо контента; overlay = размытый контент с замком */
  variant?: 'overlay' | 'inline';
  /** Заголовок CTA (по умолчанию: «Доступно в Premium») */
  title?: string;
  /** Под-заголовок CTA */
  subtitle?: string;
  children: React.ReactNode;
}

export function PremiumGate({ feature, variant = 'overlay', title, subtitle, children }: Props) {
  const colors = useColors();
  const access = useFeatureAccess(feature);

  if (access.canAccess) return <>{children}</>;

  // В freemium режиме тира `basic` не существует на клиенте — сворачиваем
  // его в `premium`, чтобы CTA не выглядел как «купи Basic», когда Basic
  // не продаётся.
  const effectiveRequired: SubscriptionTier =
    access.mode === 'freemium' && access.required === 'basic'
      ? 'premium'
      : access.required;
  const tierLabel = TIER_LABEL[effectiveRequired];
  const headline = title ?? `Доступно в ${tierLabel}`;

  const goToPaywall = () => router.push('/(tabs)/settings');

  if (variant === 'inline') {
    return (
      <TouchableOpacity
        onPress={goToPaywall}
        activeOpacity={0.85}
        style={[styles.inlineCard, { backgroundColor: colors.card, borderColor: colors.primary + '55' }]}
      >
        <View style={[styles.inlineIcon, { backgroundColor: colors.primary + '22' }]}>
          <Feather name="lock" size={18} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.inlineTitle, { color: colors.foreground }]}>{headline}</Text>
          {subtitle && (
            <Text style={[styles.inlineSubtitle, { color: colors.mutedForeground }]} numberOfLines={2}>
              {subtitle}
            </Text>
          )}
        </View>
        <Feather name="chevron-right" size={18} color={colors.primary} />
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.overlayWrap}>
      <View style={styles.dimmed} pointerEvents="none">
        {children}
      </View>
      <View style={styles.overlayCenter} pointerEvents="box-none">
        <TouchableOpacity
          onPress={goToPaywall}
          activeOpacity={0.9}
          style={[styles.lockBadge, { backgroundColor: colors.card, borderColor: colors.primary }]}
        >
          <Feather name="lock" size={14} color={colors.primary} />
          <Text style={[styles.lockText, { color: colors.primary }]}>{headline}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/** Маленький badge «Premium / Basic», который можно вставлять в ряд */
export function TierBadge({ tier }: { tier: SubscriptionTier }) {
  const colors = useColors();
  if (tier === 'free') return null;
  const bg = tier === 'premium' ? colors.primary : colors.warning;
  return (
    <View style={{ backgroundColor: bg + '22', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 9, color: bg, letterSpacing: 0.6 }}>
        {TIER_LABEL[tier].toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlayWrap: { position: 'relative' },
  dimmed: { opacity: 0.35 },
  overlayCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  lockText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  inlineCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginVertical: 6,
  },
  inlineIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 14,
  },
  inlineSubtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    marginTop: 2,
  },
});

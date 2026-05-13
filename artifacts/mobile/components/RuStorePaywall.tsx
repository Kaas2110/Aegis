/**
 * RuStorePaywall — пейволл для RuStore APK.
 * Оплата через YooKassa (WebBrowser redirect, без нативного SDK).
 *
 * Используется только когда EXPO_PUBLIC_PAYMENT_CHANNEL=rustore.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useColors } from '@/hooks/useColors';
import { getApiUrl } from '@/lib/api/baseUrl';
import { useServerSubscription } from '@/lib/serverSubscription';

interface Plan {
  id: 'monthly' | 'annual';
  title: string;
  price: string;
  period: string;
  badge?: string;
}

const PLANS: Plan[] = [
  { id: 'monthly', title: '1 месяц',  price: '299 ₽',   period: 'в месяц' },
  { id: 'annual',  title: '1 год',    price: '1 990 ₽', period: 'в год', badge: 'ВЫГОДНО' },
];

interface RuStorePaywallModalProps {
  visible: boolean;
  onClose: () => void;
}

export function RuStorePaywallModal({ visible, onClose }: RuStorePaywallModalProps) {
  const colors = useColors();
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'annual'>('monthly');
  const [loading, setLoading] = useState(false);
  const { deviceId, refetch } = useServerSubscription();

  async function handlePurchase() {
    if (!deviceId) { Alert.alert('Ошибка', 'Не удалось определить идентификатор устройства'); return; }
    setLoading(true);
    try {
      const r = await fetch(getApiUrl('/api/payments/checkout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, plan: selectedPlan }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as any)?.error ?? `HTTP ${r.status}`);
      }
      const { confirmationUrl } = (await r.json()) as { confirmationUrl: string };

      const result = await WebBrowser.openAuthSessionAsync(confirmationUrl, 'aegis://payment-complete');

      // Даём вебхуку время обработаться (до 3 сек)
      await new Promise(r => setTimeout(r, 3000));
      refetch();

      if (result.type === 'success' || result.type === 'dismiss') {
        onClose();
        if (result.type === 'success') {
          Alert.alert('Готово!', 'Aegis Premium активирован. Спасибо за поддержку!');
        }
      }
    } catch (e: any) {
      Alert.alert('Ошибка оплаты', e?.message ?? 'Попробуйте позже');
    } finally {
      setLoading(false);
    }
  }

  async function handleRestore() {
    if (!deviceId) return;
    setLoading(true);
    refetch();
    await new Promise(r => setTimeout(r, 1500));
    setLoading(false);
    Alert.alert('Проверка выполнена', 'Если у вас есть активная подписка, она уже отображается.');
  }

  const colors2 = colors;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: colors2.card }]}>

          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors2.foreground }]}>Aegis Premium</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Feather name="x" size={22} color={colors2.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* Фичи */}
          <View style={styles.features}>
            {[
              { icon: 'trending-up' as const, text: 'Бэктест модели — equity-кривая и KPI' },
              { icon: 'layers' as const,      text: 'Анализ пиков / банов в драфте' },
              { icon: 'bell' as const,         text: 'Алерты по уверенности модели' },
              { icon: 'bar-chart-2' as const,  text: 'Все 15 рынков прогнозов' },
            ].map(({ icon, text }) => (
              <View key={text} style={styles.featureRow}>
                <View style={[styles.featureIcon, { backgroundColor: colors2.primary + '22' }]}>
                  <Feather name={icon} size={15} color={colors2.primary} />
                </View>
                <Text style={[styles.featureText, { color: colors2.foreground }]}>{text}</Text>
              </View>
            ))}
          </View>

          {/* Планы */}
          <Text style={[styles.planLabel, { color: colors2.mutedForeground }]}>ВЫБЕРИТЕ ТАРИФ</Text>
          <View style={styles.plans}>
            {PLANS.map(plan => {
              const isActive = selectedPlan === plan.id;
              return (
                <TouchableOpacity
                  key={plan.id}
                  onPress={() => setSelectedPlan(plan.id)}
                  style={[
                    styles.planCard,
                    {
                      borderColor:     isActive ? colors2.primary : colors2.border,
                      backgroundColor: isActive ? colors2.primary + '12' : colors2.background,
                    },
                  ]}
                >
                  <View style={[styles.radio, {
                    borderColor: isActive ? colors2.primary : colors2.mutedForeground,
                    backgroundColor: isActive ? colors2.primary : 'transparent',
                  }]}>
                    {isActive && <View style={[styles.radioDot, { backgroundColor: colors2.primaryForeground }]} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.planTitle, { color: colors2.foreground }]}>
                      {plan.price}
                      <Text style={[styles.planPeriod, { color: colors2.mutedForeground }]}>
                        {' '}{plan.period}
                      </Text>
                    </Text>
                  </View>
                  {plan.badge && (
                    <View style={[styles.badge, { backgroundColor: colors2.positive + '33' }]}>
                      <Text style={[styles.badgeText, { color: colors2.positive }]}>{plan.badge}</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* CTA */}
          <TouchableOpacity
            onPress={handlePurchase}
            disabled={loading}
            style={[styles.cta, { backgroundColor: colors2.primary }]}
          >
            {loading
              ? <ActivityIndicator color={colors2.primaryForeground} />
              : <Text style={[styles.ctaText, { color: colors2.primaryForeground }]}>
                  Оплатить через YooKassa
                </Text>
            }
          </TouchableOpacity>

          <Text style={[styles.disclaimer, { color: colors2.mutedForeground }]}>
            Оплата банковской картой или СБП. Отмена — через поддержку.
          </Text>

          <TouchableOpacity onPress={handleRestore} disabled={loading} style={styles.restore}>
            <Text style={[styles.restoreText, { color: colors2.primary }]}>
              Восстановить подписку
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** Карточка-раздел в настройках для RuStore-канала */
export function RuStoreSubscriptionCard({ colors }: { colors: ReturnType<typeof import('@/hooks/useColors').useColors> }) {
  const { isSubscribed, isLoading, expiresAt, plan } = useServerSubscription();
  const [showPaywall, setShowPaywall] = useState(false);

  if (isLoading) {
    return (
      <View style={[cardStyles.card, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'center', padding: 20 }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (isSubscribed) {
    const expiresFormatted = expiresAt
      ? new Date(expiresAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;
    const planLabel = plan === 'annual' ? 'Годовая' : plan === 'monthly' ? 'Ежемесячная' : '';
    return (
      <View style={[cardStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[cardStyles.row, { borderBottomColor: 'transparent' }]}>
          <Feather name="award" size={18} color={colors.primary} style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={[cardStyles.label, { color: colors.foreground }]}>Aegis Premium</Text>
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 12, color: colors.mutedForeground, marginTop: 2 }}>
              {planLabel ? `${planLabel} подписка` : 'Подписка активна'}
              {expiresFormatted ? ` · до ${expiresFormatted}` : ''}
            </Text>
          </View>
          <View style={{ backgroundColor: colors.primary + '22', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: colors.primary }}>PRO</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <>
      <View style={[cardStyles.card, { backgroundColor: colors.card, borderColor: colors.primary + '55', borderWidth: 1.5 }]}>
        <View style={{ padding: 16, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Feather name="zap" size={18} color={colors.primary} />
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 16, color: colors.foreground }}>Aegis Premium</Text>
          </View>
          <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 13, color: colors.mutedForeground, lineHeight: 19 }}>
            Полный доступ к бэктесту модели, расширенным алертам и всем рынкам прогнозов.
          </Text>
          <View style={{ gap: 6 }}>
            {['Бэктест и equity-кривая', 'Анализ драфтов и факторов', 'Алерты по уверенности'].map(f => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Feather name="check-circle" size={14} color={colors.positive} />
                <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 13, color: colors.foreground }}>{f}</Text>
              </View>
            ))}
          </View>
          <TouchableOpacity
            onPress={() => setShowPaywall(true)}
            style={{ backgroundColor: colors.primary, borderRadius: 12, height: 52, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}
          >
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 15, color: colors.primaryForeground }}>
              Подключить Premium
            </Text>
          </TouchableOpacity>
          <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: colors.mutedForeground, textAlign: 'center' }}>
            от 299 ₽/мес · оплата через YooKassa (карты, СБП)
          </Text>
        </View>
      </View>
      <RuStorePaywallModal visible={showPaywall} onClose={() => setShowPaywall(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  overlay:     { flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' },
  sheet:       { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 16 },
  header:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title:       { fontFamily: 'Inter_700Bold', fontSize: 20 },
  features:    { gap: 10 },
  featureRow:  { flexDirection: 'row', alignItems: 'center', gap: 12 },
  featureIcon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  featureText: { fontFamily: 'Inter_500Medium', fontSize: 14, flex: 1 },
  planLabel:   { fontFamily: 'Inter_600SemiBold', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase' },
  plans:       { gap: 8 },
  planCard:    { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 12 },
  radio:       { width: 18, height: 18, borderRadius: 9, borderWidth: 2, marginRight: 10, alignItems: 'center', justifyContent: 'center' },
  radioDot:    { width: 7, height: 7, borderRadius: 4 },
  planTitle:   { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  planPeriod:  { fontFamily: 'Inter_400Regular' },
  badge:       { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  badgeText:   { fontFamily: 'Inter_700Bold', fontSize: 10 },
  cta:         { borderRadius: 14, height: 56, alignItems: 'center', justifyContent: 'center' },
  ctaText:     { fontFamily: 'Inter_700Bold', fontSize: 16 },
  disclaimer:  { fontFamily: 'Inter_400Regular', fontSize: 11, textAlign: 'center', lineHeight: 16 },
  restore:     { alignItems: 'center', paddingVertical: 4 },
  restoreText: { fontFamily: 'Inter_500Medium', fontSize: 13, textDecorationLine: 'underline' },
});

const cardStyles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, marginBottom: 16, overflow: 'hidden' },
  row:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  label: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
});

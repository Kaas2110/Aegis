import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Switch, Platform, BackHandler,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { logProductEvent } from '@/services/logging/EventLogger';
import { notificationService } from '@/services/notifications/NotificationService';

// Шаг выбора букмекеров убран из онбординга: теперь пользователь выбирает
// букмекера прямо на экране конкретного матча через попап-пикер.
type Step = 'welcome' | 'filters' | 'notifications';
const STEPS: Step[] = ['welcome', 'filters', 'notifications'];

export default function OnboardingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setAgeConfirmed, setOnboarded, updateSettings } = useApp();
  const [step, setStep] = useState<Step>('welcome');
  const [minOdds, setMinOdds] = useState(1.5);
  const [minEdge, setMinEdge] = useState(0.03);
  const [minConf, setMinConf] = useState(60);
  const [analyticsConsent, setAnalyticsConsent] = useState(true);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const bottomPad = Platform.OS === 'web' ? 34 : insets.bottom;
  const currentIdx = STEPS.indexOf(step);

  function nextStep() {
    const next = STEPS[currentIdx + 1];
    if (next) setStep(next);
  }

  async function handleWelcomeConfirm() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await setAgeConfirmed(true);
    await logProductEvent('age_gate_confirmed', 'onboarding');
    nextStep();
  }

  async function handleFiltersNext() {
    await updateSettings({
      minOdds,
      minEdge,
      minConfidence: minConf,
      analyticsConsent,
    });
    nextStep();
  }

  async function handleEnableNotifications() {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try { await notificationService.requestPermissions(); } catch {}
    await logProductEvent('notifications_permission_requested', 'onboarding');
    await finishOnboarding();
  }

  async function handleSkipNotifications() {
    await logProductEvent('notifications_permission_skipped', 'onboarding');
    await finishOnboarding();
  }

  async function finishOnboarding() {
    await setOnboarded(true);
    await logProductEvent('onboarding_completed', 'onboarding');
    router.replace('/(tabs)');
  }

  const p = colors.primary;
  const fg = colors.foreground;

  function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        disabled={disabled}
        style={[
          styles.primaryBtn,
          { backgroundColor: disabled ? colors.muted : p },
        ]}
      >
        <Text style={[styles.primaryBtnText, { color: disabled ? colors.mutedForeground : colors.primaryForeground }]}>
          {label}
        </Text>
        {!disabled && <Feather name="arrow-right" size={18} color={colors.primaryForeground} />}
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: topPad, paddingBottom: bottomPad }]}>
      {/* Progress */}
      {step !== 'welcome' && (
        <View style={styles.progressBar}>
          {STEPS.slice(1).map((s, i) => (
            <View
              key={s}
              style={[styles.progressSegment, { backgroundColor: i <= currentIdx - 1 ? p : colors.muted }]}
            />
          ))}
        </View>
      )}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ── WELCOME ──────────────────────────── */}
        {step === 'welcome' && (
          <View style={styles.centeredStep}>
            {/* Иконка */}
            <View style={[styles.iconWrap, { borderColor: p + '30' }]}>
              <View style={[styles.iconOuter, { backgroundColor: p + '18' }]}>
                <View style={[styles.iconInner, { backgroundColor: p + '30' }]}>
                  <Text style={[styles.iconText, { color: p }]}>AE</Text>
                </View>
              </View>
            </View>

            <Text style={[styles.appTitle, { color: fg }]}>Aegis</Text>
            <Text style={[styles.appSubtitle, { color: colors.mutedForeground }]}>
              Профессиональная аналитика матчей Dota 2
            </Text>

            {/* Преимущества */}
            <View style={[styles.featuresList, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {[
                { icon: 'activity', text: 'Реальные live-данные с OpenDota' },
                { icon: 'cpu', text: '15 типов ставок · ML-модели' },
                { icon: 'bell', text: 'Алерты по уверенности модели' },
                { icon: 'trending-up', text: 'Прематч + лайв прогнозы' },
              ].map(({ icon, text }) => (
                <View key={text} style={styles.featureRow}>
                  <View style={[styles.featureIcon, { backgroundColor: p + '18' }]}>
                    <Feather name={icon as any} size={14} color={p} />
                  </View>
                  <Text style={[styles.featureText, { color: colors.foreground }]}>{text}</Text>
                </View>
              ))}
            </View>

            {/* 18+ */}
            <View style={[styles.ageBox, { backgroundColor: colors.card, borderColor: p + '40', borderLeftColor: p }]}>
              <View style={styles.ageRow}>
                <View style={[styles.ageBadge, { backgroundColor: p + '20', borderColor: p }]}>
                  <Text style={[styles.ageNum, { color: p }]}>18+</Text>
                </View>
                <Text style={[styles.ageTitle, { color: fg }]}>Подтверждение возраста</Text>
              </View>
              <Text style={[styles.ageDesc, { color: colors.mutedForeground }]}>
                Нажимая кнопку ниже, я подтверждаю, что мне исполнилось 18 лет и ознакомился с дисклеймером.
              </Text>
            </View>

            {/* Дисклеймер */}
            <View style={[styles.disclaimerBox, { backgroundColor: colors.card, borderColor: colors.warning + '40', borderLeftColor: colors.warning }]}>
              <View style={styles.disclaimerHeader}>
                <Feather name="alert-triangle" size={13} color={colors.warning} />
                <Text style={[styles.disclaimerTitle, { color: colors.warning }]}>Важный дисклеймер</Text>
              </View>
              <Text style={[styles.disclaimerText, { color: colors.mutedForeground }]}>
                <Text style={{ color: fg }}>Приложение не гарантирует результат</Text>, не размещает ставки от вашего имени и не является советом делать ставки.{'\n\n'}
                Ставки связаны с риском потери денег. Играйте ответственно.
              </Text>
            </View>

            <PrimaryButton label="Мне есть 18 лет — принять и продолжить" onPress={handleWelcomeConfirm} />
            <TouchableOpacity onPress={() => {
              if (Platform.OS === 'android') {
                BackHandler.exitApp();
              } else {
                router.replace('/onboarding');
              }
            }}>
              <Text style={[styles.exitLink, { color: colors.mutedForeground }]}>Мне нет 18 лет — выйти</Text>
            </TouchableOpacity>
            <View style={styles.legalRow}>
              <TouchableOpacity onPress={() => (router.push as Function)({ pathname: '/legal', params: { type: 'privacy' } })}>
                <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Конфиденциальность</Text>
              </TouchableOpacity>
              <Text style={[styles.legalSep, { color: colors.mutedForeground }]}>·</Text>
              <TouchableOpacity onPress={() => (router.push as Function)({ pathname: '/legal', params: { type: 'terms' } })}>
                <Text style={[styles.legalLink, { color: colors.mutedForeground }]}>Условия использования</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── FILTERS ──────────────────────────── */}
        {step === 'filters' && (
          <View style={styles.step}>
            <Text style={[styles.stepTitle, { color: fg }]}>Фильтры по умолчанию</Text>
            <Text style={[styles.stepSubtitle, { color: colors.mutedForeground }]}>
              Минимальные параметры для отображения событий
            </Text>

            <FilterGroup label="Минимальный коэффициент">
              {[1.2, 1.5, 2.0, 3.0].map(v => (
                <ChipBtn key={v} label={v.toFixed(1)} active={minOdds === v} onPress={() => setMinOdds(v)} colors={colors} />
              ))}
            </FilterGroup>

            <FilterGroup label="Минимальное расхождение с рынком">
              {[0, 0.03, 0.05, 0.10].map(v => (
                <ChipBtn key={v} label={(v * 100).toFixed(0) + '%'} active={minEdge === v} onPress={() => setMinEdge(v)} colors={colors} />
              ))}
            </FilterGroup>

            <FilterGroup label="Минимальная уверенность модели">
              {[50, 60, 70, 80].map(v => (
                <ChipBtn key={v} label={v + '%'} active={minConf === v} onPress={() => setMinConf(v)} colors={colors} />
              ))}
            </FilterGroup>

            <View style={[styles.consentRow, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.consentLabel, { color: fg }]}>Аналитика и логирование</Text>
                <Text style={[styles.consentDesc, { color: colors.mutedForeground }]}>
                  Сохранять события локально для улучшения продукта
                </Text>
              </View>
              <Switch
                value={analyticsConsent}
                onValueChange={setAnalyticsConsent}
                trackColor={{ false: colors.muted, true: p + '88' }}
                thumbColor={analyticsConsent ? p : colors.mutedForeground}
              />
            </View>

            <PrimaryButton label="Дальше" onPress={handleFiltersNext} />
          </View>
        )}

        {/* ── NOTIFICATIONS ────────────────────── */}
        {step === 'notifications' && (
          <View style={styles.centeredStep}>
            <View style={[styles.iconWrap, { borderColor: p + '30' }]}>
              <View style={[styles.iconOuter, { backgroundColor: p + '18' }]}>
                <View style={[styles.iconInner, { backgroundColor: p + '30' }]}>
                  <Feather name="bell" size={26} color={p} />
                </View>
              </View>
            </View>

            <Text style={[styles.appTitle, { color: fg }]}>Алерты по уверенности</Text>
            <Text style={[styles.appSubtitle, { color: colors.mutedForeground }]}>
              Получайте пуш, когда модель уверена в исходе ≥ {minConf}% — чтобы не пропустить выгодный момент
            </Text>

            <View style={[styles.featuresList, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {[
                { icon: 'zap', text: 'Сигнал когда модель ≥ заданного порога' },
                { icon: 'star', text: 'Пуш на старт матча любимой команды' },
                { icon: 'shield', text: 'Полный контроль: можно выключить в настройках' },
              ].map(({ icon, text }) => (
                <View key={text} style={styles.featureRow}>
                  <View style={[styles.featureIcon, { backgroundColor: p + '18' }]}>
                    <Feather name={icon as any} size={14} color={p} />
                  </View>
                  <Text style={[styles.featureText, { color: colors.foreground }]}>{text}</Text>
                </View>
              ))}
            </View>

            <PrimaryButton label="Включить уведомления" onPress={handleEnableNotifications} />
            <TouchableOpacity onPress={handleSkipNotifications}>
              <Text style={[styles.exitLink, { color: colors.mutedForeground }]}>Пропустить — включу позже</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.filterLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <View style={styles.filterRow}>{children}</View>
    </View>
  );
}

function ChipBtn({
  label, active, onPress, colors,
}: {
  label: string; active: boolean; onPress: () => void;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, {
        backgroundColor: active ? colors.primary : colors.card,
        borderColor: active ? colors.primary : colors.border,
      }]}
    >
      <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.foreground }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  progressBar: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    height: 30,
    alignItems: 'center',
  },
  progressSegment: { height: 3, borderRadius: 2, flex: 1 },
  content: { flexGrow: 1, padding: 20, gap: 16 },
  centeredStep: { gap: 16, paddingTop: 6 },
  step: { gap: 14, paddingTop: 10 },
  iconWrap: {
    alignSelf: 'center',
    width: 100,
    height: 100,
    borderRadius: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconOuter: {
    width: 84,
    height: 84,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconInner: {
    width: 60,
    height: 60,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontFamily: 'Inter_700Bold', fontSize: 18, letterSpacing: 1 },
  appTitle: { fontFamily: 'Inter_700Bold', fontSize: 26, textAlign: 'center' },
  appSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 14, textAlign: 'center', lineHeight: 21 },
  featuresList: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  featureRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  featureIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  featureText: { fontFamily: 'Inter_400Regular', fontSize: 13, flex: 1 },
  ageBox: {
    borderRadius: 14,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 14,
    gap: 10,
  },
  ageRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ageBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ageNum: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  ageTitle: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  ageDesc: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 20 },
  disclaimerBox: {
    borderRadius: 14,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 14,
    gap: 8,
  },
  disclaimerHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  disclaimerTitle: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  disclaimerText: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 20 },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    height: 54,
    marginTop: 4,
  },
  primaryBtnText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  exitLink: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'center' },
  legalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  legalLink: { fontFamily: 'Inter_400Regular', fontSize: 11, textDecorationLine: 'underline' },
  legalSep: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  stepTitle: { fontFamily: 'Inter_700Bold', fontSize: 24 },
  stepSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 20 },
  filterLabel: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  filterRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  chipText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  consentLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  consentDesc: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 2 },
});

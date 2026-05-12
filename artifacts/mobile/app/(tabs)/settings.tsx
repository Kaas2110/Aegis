import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Platform, Alert, ActivityIndicator, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { logProductEvent } from '@/services/logging/EventLogger';
import { DisclaimerBanner } from '@/components/DisclaimerBanner';
import { useSubscription } from '@/lib/revenuecat';
import type { PurchasesPackage } from 'react-native-purchases';

interface Tier1Team {
  teamId: number;
  name: string | null;
  tag: string | null;
  rating: number | null;
}

function FavoriteTeamsCard({ colors }: { colors: ReturnType<typeof import('@/hooks/useColors').useColors> }) {
  const { settings, updateSettings } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [teams, setTeams] = useState<Tier1Team[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = settings.favoriteTeamIds ?? [];

  useEffect(() => {
    if (!expanded || teams !== null || loading) return;
    setLoading(true);
    setError(null);
    fetch('/api/teams/tier1?limit=50')
      .then(r => r.json())
      .then((data: { teams: Tier1Team[] }) => {
        setTeams(data.teams ?? []);
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, [expanded, teams, loading]);

  function toggle(id: number) {
    const next = selected.includes(id) ? selected.filter(t => t !== id) : [...selected, id];
    updateSettings({ favoriteTeamIds: next });
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={[styles.row, { borderBottomColor: 'transparent' }]}
      >
        <Feather name="star" size={16} color={colors.warning} style={{ marginRight: 4 }} />
        <Text style={[styles.rowLabel, { color: colors.foreground, flex: 1 }]}>Любимые команды</Text>
        {selected.length > 0 && (
          <Text style={[styles.rowValue, { color: colors.mutedForeground }]}>{selected.length} выбрано</Text>
        )}
        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
      </TouchableOpacity>

      {expanded && (
        <View style={teamStyles.grid}>
          {loading && <ActivityIndicator color={colors.primary} style={{ marginVertical: 12 }} />}
          {error && (
            <Text style={[teamStyles.hint, { color: colors.destructive }]}>
              Не удалось загрузить список: {error}
            </Text>
          )}
          {teams?.map(team => {
            const isSelected = selected.includes(team.teamId);
            const label = team.name ?? team.tag ?? `team_${team.teamId}`;
            return (
              <TouchableOpacity
                key={team.teamId}
                onPress={() => toggle(team.teamId)}
                style={[teamStyles.chip, {
                  backgroundColor: isSelected ? colors.primary + '22' : colors.muted,
                  borderColor: isSelected ? colors.primary : colors.border,
                }]}
              >
                <View style={[teamStyles.dot, { backgroundColor: isSelected ? colors.primary : colors.mutedForeground }]} />
                <Text style={[teamStyles.chipText, { color: isSelected ? colors.primary : colors.foreground }]} numberOfLines={1}>
                  {label}
                </Text>
                {isSelected && <Feather name="check" size={12} color={colors.primary} />}
              </TouchableOpacity>
            );
          })}
          {teams && teams.length > 0 && (
            <Text style={[teamStyles.hint, { color: colors.mutedForeground }]}>
              Топ-{teams.length} команд по рейтингу OpenDota. Получите пуш-уведомление, когда матч любимой команды начнётся в лайве.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

const PLAN_LABEL: Record<string, string> = {
  '$rc_weekly': 'в неделю',
  '$rc_monthly': 'в месяц',
  '$rc_annual': 'в год',
};

const PLAN_SORT: Record<string, number> = {
  '$rc_weekly': 0,
  '$rc_monthly': 1,
  '$rc_annual': 2,
};

function getPlanLabel(pkg: PurchasesPackage): string {
  return PLAN_LABEL[pkg.identifier] ?? 'в период';
}

function sortPackages(pkgs: PurchasesPackage[]): PurchasesPackage[] {
  return [...pkgs].sort((a, b) => {
    const ai = PLAN_SORT[a.identifier] ?? 99;
    const bi = PLAN_SORT[b.identifier] ?? 99;
    return ai - bi;
  });
}

function SubscriptionCard({ colors }: { colors: ReturnType<typeof import('@/hooks/useColors').useColors> }) {
  const { isSubscribed, isLoading, offerings, purchase, restore, isPurchasing, isRestoring } = useSubscription();
  const [showPaywall, setShowPaywall] = useState(false);
  const [selectedPkg, setSelectedPkg] = useState<PurchasesPackage | null>(null);

  const currentOffering = offerings?.current;
  const packages = sortPackages(currentOffering?.availablePackages ?? []);
  const defaultPkg = packages.find(p => p.identifier === '$rc_monthly') ?? packages[0] ?? null;
  const activePkg = selectedPkg ?? defaultPkg;

  if (isLoading) {
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'center', padding: 20 }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (isSubscribed) {
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.row, { borderBottomColor: 'transparent' }]}>
          <Feather name="award" size={18} color={colors.primary} style={{ marginRight: 8 }} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowLabel, { color: colors.foreground }]}>Aegis Premium</Text>
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 12, color: colors.mutedForeground, marginTop: 2 }}>Подписка активна</Text>
          </View>
          <View style={{ backgroundColor: colors.primary + '22', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: colors.primary }}>PRO</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={async () => { try { await restore(); } catch (e: any) { Alert.alert('Ошибка', e.message ?? 'Не удалось восстановить'); } }}
          disabled={isRestoring}
          style={[styles.row, { borderBottomColor: 'transparent' }]}
        >
          <Text style={[styles.rowLabel, { color: colors.mutedForeground, fontSize: 13 }]}>Восстановить покупки</Text>
          {isRestoring ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : <Feather name="refresh-cw" size={14} color={colors.mutedForeground} />}
        </TouchableOpacity>
      </View>
    );
  }

  const bestPriceStr = activePkg?.product.priceString ?? '—';

  return (
    <>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={{ padding: 16, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Feather name="zap" size={18} color={colors.primary} />
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 16, color: colors.foreground }}>Aegis Premium</Text>
          </View>
          <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 13, color: colors.mutedForeground, lineHeight: 19 }}>
            Полный доступ к бэктесту модели, расширенным алертам по уверенности и всем рынкам прогнозов.
          </Text>
          <View style={{ gap: 6 }}>
            {['Бэктест и equity-кривая', 'Анализ драфтов и факторов', 'Алерты по edge и минимальной уверенности'].map(f => (
              <View key={f} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Feather name="check-circle" size={14} color={colors.positive} />
                <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 13, color: colors.foreground }}>{f}</Text>
              </View>
            ))}
          </View>
          <TouchableOpacity
            onPress={() => setShowPaywall(true)}
            style={{ backgroundColor: colors.primary, borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 }}
          >
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 15, color: colors.primaryForeground }}>
              {bestPriceStr !== '—' ? `от ${bestPriceStr} / нед` : 'Попробовать Premium'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={async () => { try { await restore(); } catch (e: any) { Alert.alert('Ошибка', e.message ?? 'Не удалось восстановить'); } }}
            disabled={isRestoring}
            style={{ alignItems: 'center' }}
          >
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 12, color: colors.mutedForeground }}>Восстановить покупки</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal visible={showPaywall} transparent animationType="slide" onRequestClose={() => setShowPaywall(false)}>
        <View style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: colors.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, gap: 18 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 20, color: colors.foreground }}>Aegis Premium</Text>
              <TouchableOpacity onPress={() => setShowPaywall(false)}>
                <Feather name="x" size={22} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            <View style={{ gap: 10 }}>
              {[
                { icon: 'trending-up' as const, text: 'Бэктест модели — equity-кривая и KPI' },
                { icon: 'layers' as const, text: 'Анализ пиков / банов в драфте' },
                { icon: 'bell' as const, text: 'Алерты по edge и уверенности' },
                { icon: 'bar-chart-2' as const, text: 'Все 15 рынков прогнозов' },
              ].map(({ icon, text }) => (
                <View key={text} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: colors.primary + '22', alignItems: 'center', justifyContent: 'center' }}>
                    <Feather name={icon} size={16} color={colors.primary} />
                  </View>
                  <Text style={{ fontFamily: 'Inter_500Medium', fontSize: 14, color: colors.foreground, flex: 1 }}>{text}</Text>
                </View>
              ))}
            </View>

            {packages.length > 1 && (
              <View style={{ gap: 8 }}>
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: colors.mutedForeground, letterSpacing: 1, textTransform: 'uppercase' }}>
                  Выберите тариф
                </Text>
                {packages.map(pkg => {
                  const isActive = (activePkg?.identifier ?? '') === pkg.identifier;
                  return (
                    <TouchableOpacity
                      key={pkg.identifier}
                      onPress={() => setSelectedPkg(pkg)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        borderRadius: 12,
                        borderWidth: 1.5,
                        borderColor: isActive ? colors.primary : colors.border,
                        backgroundColor: isActive ? colors.primary + '12' : colors.background,
                        paddingHorizontal: 14,
                        paddingVertical: 12,
                      }}
                    >
                      <View style={{
                        width: 18, height: 18, borderRadius: 9,
                        borderWidth: 2,
                        borderColor: isActive ? colors.primary : colors.mutedForeground,
                        backgroundColor: isActive ? colors.primary : 'transparent',
                        marginRight: 10,
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        {isActive && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.primaryForeground }} />}
                      </View>
                      <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 14, color: colors.foreground, flex: 1 }}>
                        {pkg.product.priceString}
                        <Text style={{ fontFamily: 'Inter_400Regular', color: colors.mutedForeground }}>
                          {' '}{getPlanLabel(pkg)}
                        </Text>
                      </Text>
                      {pkg.identifier === '$rc_annual' && (
                        <View style={{ backgroundColor: colors.positive + '33', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 10, color: colors.positive }}>ВЫГОДНО</Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {packages.length === 0 && (
              <View style={{ backgroundColor: colors.muted, borderRadius: 14, padding: 16, alignItems: 'center', gap: 4 }}>
                <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 28, color: colors.foreground }}>
                  {bestPriceStr !== '—' ? bestPriceStr : '...'}
                </Text>
                <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 13, color: colors.mutedForeground }}>
                  {activePkg ? getPlanLabel(activePkg) : 'в месяц'} · отмена в любой момент
                </Text>
              </View>
            )}

            <TouchableOpacity
              onPress={async () => {
                if (!activePkg) { Alert.alert('Нет доступных тарифов'); return; }
                try {
                  await purchase(activePkg);
                  setShowPaywall(false);
                  await logProductEvent('subscription_purchased', 'paywall', { price: activePkg.product.priceString, plan: activePkg.identifier });
                } catch (e: any) {
                  if (!e.userCancelled) Alert.alert('Ошибка покупки', e.message ?? 'Попробуйте позже');
                }
              }}
              disabled={isPurchasing || !activePkg}
              style={{ backgroundColor: colors.primary, borderRadius: 14, height: 54, alignItems: 'center', justifyContent: 'center' }}
            >
              {isPurchasing
                ? <ActivityIndicator color={colors.primaryForeground} />
                : <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 16, color: colors.primaryForeground }}>
                    {activePkg ? `Подключить за ${activePkg.product.priceString}` : 'Подключить Premium'}
                  </Text>
              }
            </TouchableOpacity>

            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: colors.mutedForeground, textAlign: 'center', lineHeight: 16 }}>
              Оплата через App Store / Google Play. Отмена в любое время в настройках магазина.
            </Text>
          </View>
        </View>
      </Modal>
    </>
  );
}

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { settings, updateSettings, setOnboarded, setAgeConfirmed, isAdmin } = useApp();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  function Row({ label, value, onPress, danger, right }: { label: string; value?: string; onPress?: () => void; danger?: boolean; right?: React.ReactNode }) {
    return (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={onPress ? 0.7 : 1}
        style={[styles.row, { borderBottomColor: colors.border }]}
      >
        <Text style={[styles.rowLabel, { color: danger ? colors.destructive : colors.foreground }]}>{label}</Text>
        {value && <Text style={[styles.rowValue, { color: colors.mutedForeground }]}>{value}</Text>}
        {right}
        {onPress && <Feather name="chevron-right" size={16} color={colors.mutedForeground} />}
      </TouchableOpacity>
    );
  }

  function SectionHeader({ title }: { title: string }) {
    return <Text style={[styles.sectionHeader, { color: colors.mutedForeground }]}>{title}</Text>;
  }

  async function handleDeleteAccount() {
    Alert.alert(
      'Удалить аккаунт',
      'Все данные будут удалены. Это действие необратимо.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            await logProductEvent('account_deleted', 'settings');
            await AsyncStorage.clear();
            await setAgeConfirmed(false);
            await setOnboarded(false);
            router.replace('/onboarding');
          },
        },
      ]
    );
  }

  async function handleExportData() {
    await logProductEvent('privacy_export_requested', 'settings');
    Alert.alert('Экспорт данных', 'В MVP 1 данные хранятся локально в AsyncStorage. Функция полного экспорта доступна в следующих версиях.');
  }

  async function handleEnableAdmin() {
    await updateSettings({ role: settings.role === 'admin' ? 'user' : 'admin' });
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.content, { paddingTop: topPad + 12, paddingBottom: insets.bottom + 90 }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.title, { color: colors.foreground }]}>Профиль</Text>

      {/* Подписка идёт первой — самый важный CTA / статус пользователя. */}
      <SubscriptionCard colors={colors} />

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SectionHeader title="ОТОБРАЖЕНИЕ" />
        {/* TODO(subscription): «Режим карточек» убран — всегда подробный.
            Когда введём подписку, базовый план = вероятности и серии,
            премиум = драфты, факторы модели, бэктест и алерты по edge. */}
        <Row
          label="Глоссарий терминов"
          value="ОЦ, %, коэф..."
          onPress={() => router.push('/glossary')}
        />
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SectionHeader title="ФИЛЬТРЫ ПО УМОЛЧАНИЮ" />
        <Row label="Язык" value={settings.language === 'ru' ? 'Русский' : 'English'} />
        <Row label="Мин. коэффициент" value={settings.minOdds.toFixed(1)} />
        <Row label="Мин. расхождение" value={`${(settings.minEdge * 100).toFixed(0)}%`} />
        <Row label="Мин. уверенность" value={`${settings.minConfidence}`} />
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SectionHeader title="ПРИВАТНОСТЬ" />
        <Row
          label="Аналитика и логирование"
          right={
            <Switch
              value={settings.analyticsConsent}
              onValueChange={v => updateSettings({ analyticsConsent: v })}
              trackColor={{ false: colors.muted, true: colors.primary + '88' }}
              thumbColor={settings.analyticsConsent ? colors.primary : colors.mutedForeground}
            />
          }
        />
        <Row
          label="Только +ОЦ события"
          right={
            <Switch
              value={settings.showOnlyPositiveEV}
              onValueChange={v => updateSettings({ showOnlyPositiveEV: v })}
              trackColor={{ false: colors.muted, true: colors.primary + '88' }}
              thumbColor={settings.showOnlyPositiveEV ? colors.primary : colors.mutedForeground}
            />
          }
        />
        <Row
          label="Скрывать устаревшие данные"
          right={
            <Switch
              value={settings.hideStaleData}
              onValueChange={v => updateSettings({ hideStaleData: v })}
              trackColor={{ false: colors.muted, true: colors.primary + '88' }}
              thumbColor={settings.hideStaleData ? colors.primary : colors.mutedForeground}
            />
          }
        />
        <Row
          label="Скрывать mock коэффициенты"
          right={
            <Switch
              value={settings.hideMockMarkets}
              onValueChange={v => updateSettings({ hideMockMarkets: v })}
              trackColor={{ false: colors.muted, true: colors.primary + '88' }}
              thumbColor={settings.hideMockMarkets ? colors.primary : colors.mutedForeground}
            />
          }
        />
        <Row label="Экспортировать мои данные" onPress={handleExportData} />
      </View>

      <FavoriteTeamsCard colors={colors} />

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SectionHeader title="РАЗРАБОТКА" />
        <Row
          label={`Режим Admin ${isAdmin ? '(включен)' : ''}`}
          right={
            <Switch
              value={isAdmin}
              onValueChange={handleEnableAdmin}
              trackColor={{ false: colors.muted, true: colors.warning + '88' }}
              thumbColor={isAdmin ? colors.warning : colors.mutedForeground}
            />
          }
        />
        {isAdmin && (
          <Row label="Debug: Sources & Logs" onPress={() => router.push('/admin')} />
        )}
        <Row label="Сброс онбординга" onPress={async () => { await setOnboarded(false); router.replace('/onboarding'); }} />
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SectionHeader title="АККАУНТ" />
        <Row label="Удалить аккаунт и данные" onPress={handleDeleteAccount} danger />
      </View>

      <DisclaimerBanner />

      <View style={styles.version}>
        <Text style={[styles.versionText, { color: colors.mutedForeground }]}>Aegis · 1.0.0</Text>
        <Text style={[styles.versionText, { color: colors.mutedForeground }]}>Модель: baseline_v1.0.0</Text>
        <Text style={[styles.versionText, { color: colors.mutedForeground }]}>Live-матчи: OpenDota · Коэффициенты: demo (до подключения API)</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 14 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 24 },
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  sectionHeader: { fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1, padding: 12, paddingBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, gap: 10 },
  rowLabel: { fontFamily: 'Inter_500Medium', fontSize: 14, flex: 1 },
  rowValue: { fontFamily: 'Inter_400Regular', fontSize: 14 },
  subLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 3 },
  version: { alignItems: 'center', gap: 4, paddingTop: 8 },
  versionText: { fontFamily: 'Inter_400Regular', fontSize: 11 },
});

const teamStyles = StyleSheet.create({
  grid: { padding: 14, paddingTop: 4, gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontFamily: 'Inter_500Medium', fontSize: 13, flex: 1 },
  hint: { fontFamily: 'Inter_400Regular', fontSize: 11, textAlign: 'center', paddingTop: 4 },
});

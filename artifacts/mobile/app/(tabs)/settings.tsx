import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Platform, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { logProductEvent } from '@/services/logging/EventLogger';
import { DisclaimerBanner } from '@/components/DisclaimerBanner';

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

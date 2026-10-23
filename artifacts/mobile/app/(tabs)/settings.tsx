import { apiFetch } from '../../lib/api';
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Platform, Alert, ActivityIndicator, Modal, TextInput, Share } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { exportAccountData } from '@/services/AuthService';
import { AccountRequestError, LOCAL_EXPORT_KEYS, selectLocalExport } from '@/services/AccountDataClient';
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
    apiFetch('/api/teams/tier1?limit=50')
      .then(r => r.json())
      .then((data: { teams: Tier1Team[] }) => {
        setTeams(data.teams ?? []);
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoading(false));
  }, [expanded, teams, loading]);

  const MAX_FAVORITES = 10;
  function toggle(id: number) {
    let next: number[];
    if (selected.includes(id)) {
      next = selected.filter(t => t !== id);
    } else {
      if (selected.length >= MAX_FAVORITES) {
        Alert.alert(
          'Лимит достигнут',
          `Можно выбрать максимум ${MAX_FAVORITES} любимых команд. Снимите одну, чтобы добавить новую.`,
        );
        return;
      }
      next = [...selected, id];
    }
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
              Выбрано {selected.length}/{MAX_FAVORITES}. Топ-{teams.length} команд по рейтингу OpenDota.
              Пуш приходит, когда матч любимой команды начинается в лайве.
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
  const { settings, updateSettings, setOnboarded } = useApp();
  const { user, logout, deleteAccount } = useAuth();
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [privacyMessage, setPrivacyMessage] = useState('');
  // T004: админ-режим выдаётся ТОЛЬКО с сервера (app_users.is_admin через
  // админку). Свободного тогла в мобилке больше нет.
  const isAdmin = !!user?.isAdmin;

  async function handleLogout() {
    if (Platform.OS === 'web') {
      if (window.confirm('Выйти из аккаунта? Чтобы войти снова, потребуется ввести email и пароль.')) {
        await logout();
        router.replace('/auth');
      }
      return;
    }
    Alert.alert(
      'Выйти из аккаунта',
      'Чтобы войти снова, потребуется ввести email и пароль.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Выйти',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/auth');
          },
        },
      ]
    );
  }
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

  function accountError(error: unknown): string {
    const code = error instanceof AccountRequestError ? error.code : '';
    if (code === 'invalid_password') return 'Неверный пароль. Данные аккаунта сохранены.';
    if (code === 'unauthorized' || code === 'http_401') return 'Войдите в аккаунт ещё раз.';
    if (error instanceof AccountRequestError && (error.retryAfterSeconds || code === 'rate_limited' || code === 'http_429')) return `Слишком много попыток. Повторите позже${error.retryAfterSeconds ? ` (через ${error.retryAfterSeconds} с)` : ''}.`;
    if (code === 'origin_not_allowed') return 'Сервер не разрешает запрос с этого адреса приложения.';
    return 'Не удалось завершить запрос. Проверьте связь с сервером и повторите.';
  }

  async function handleDeleteAccount() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const result = await deleteAccount(deletePassword);
      setDeletePassword('');
      setDeleteVisible(false);
      if (!result.localDataCleared) {
        const message = 'Аккаунт на сервере удалён. Очистить все данные на этом устройстве не удалось: удалите данные приложения в настройках устройства или браузера. Старые серверные журналы и резервные копии могут сохраняться.';
        if (Platform.OS === 'web') window.alert(message); else Alert.alert('Аккаунт удалён', message);
      }
      router.replace('/onboarding');
    } catch (error) {
      setDeleteError(accountError(error));
    } finally {
      setDeleting(false);
    }
  }

  async function handleExportData() {
    if (exporting) return;
    setExporting(true);
    setPrivacyMessage('');
    try {
      const serverAccount = await exportAccountData();
      const deviceLocalData = selectLocalExport(await AsyncStorage.multiGet([...LOCAL_EXPORT_KEYS]));
      const json = JSON.stringify({ formatVersion: 1, exportedAt: new Date().toISOString(), serverAccount, deviceLocalData, limitations: ['operational_logs_and_backups_not_included'] }, null, 2);
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `aegis-data-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setPrivacyMessage('Файл данных подготовлен. Серверные журналы и резервные копии в него не входят.');
      } else {
        const result = await Share.share({ title: 'Данные Aegis', message: json });
        if (result.action === Share.sharedAction) setPrivacyMessage('Данные переданы выбранному приложению. Серверные журналы и резервные копии не включены.');
      }
    } catch (error) {
      setPrivacyMessage(accountError(error));
    } finally {
      setExporting(false);
    }
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
              accessibilityLabel="Аналитика и логирование"
              value={settings.analyticsConsent}
              onValueChange={v => updateSettings({ analyticsConsent: v })}
              trackColor={{ false: colors.muted, true: colors.primary + '88' }}
              thumbColor={settings.analyticsConsent ? colors.primary : colors.mutedForeground}
            />
          }
        />
        <Text style={[styles.privacyHint, { color: colors.mutedForeground }]}>По вашему согласию отправляем события использования и технические журналы. При отключении отправка прекращается, очередь очищается.</Text>
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
        <Row label={exporting ? 'Подготовка данных…' : 'Экспортировать мои данные'} onPress={handleExportData} />
        {!!privacyMessage && <Text accessibilityRole="alert" style={[styles.privacyHint, { color: colors.mutedForeground }]}>{privacyMessage}</Text>}
      </View>

      <FavoriteTeamsCard colors={colors} />

      {/* T004: секция видна только пользователям с is_admin=true (выдаётся
          из админки, /admin-web/users). Свободный тогл удалён. */}
      {isAdmin && (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <SectionHeader title="РАЗРАБОТКА (АДМИН)" />
          <Row label="Debug: Sources & Logs" onPress={() => router.push('/admin')} />
          <Row label="Сброс онбординга" onPress={async () => { await setOnboarded(false); router.replace('/onboarding'); }} />
        </View>
      )}

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <SectionHeader title="АККАУНТ" />
        {user && (
          <Row label="Email" value={user.email} />
        )}
        {user && (
          <Row label="Выйти из аккаунта" onPress={handleLogout} />
        )}
        <Row label="Удалить аккаунт и данные" onPress={() => {setDeleteError('');setDeletePassword('');setDeleteVisible(true);}} danger />
      </View>

      <DisclaimerBanner />

      <View style={styles.version}>
        <Text style={[styles.versionText, { color: colors.mutedForeground }]}>Aegis · 1.0.0</Text>
        <Text style={[styles.versionText, { color: colors.mutedForeground }]}>Версия аналитики: 1.0.0</Text>
        <Text style={[styles.versionText, { color: colors.mutedForeground }]}>Live-матчи: OpenDota · Источник и давность указаны в карточке</Text>
      </View>
      <Modal visible={deleteVisible} transparent animationType="fade" onRequestClose={() => {if (!deleting) {setDeleteVisible(false);setDeletePassword('');}}}>
        <View style={styles.modalBackdrop}>
          <View accessibilityViewIsModal style={[styles.deleteDialog, {backgroundColor: colors.card, borderColor: colors.border}]}>
            <Text style={[styles.dialogTitle, {color: colors.foreground}]}>Удаление аккаунта</Text>
            <Text style={[styles.dialogText, {color: colors.mutedForeground}]}>Аккаунт будет удалён с сервера, вход в него станет недоступен. Настройки и журналы Aegis на этом устройстве будут очищены. Действие необратимо.</Text>
            <Text style={[styles.dialogText, {color: colors.mutedForeground}]}>Старые серверные журналы и резервные копии могут сохраняться; это действие их не удаляет. Перед удалением можно выгрузить свои данные.</Text>
            <TextInput accessibilityLabel="Пароль для удаления аккаунта" placeholder="Текущий пароль" placeholderTextColor={colors.mutedForeground} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" maxLength={200} editable={!deleting} value={deletePassword} onChangeText={setDeletePassword} style={[styles.passwordInput, {color: colors.foreground, borderColor: colors.border}]} />
            {!!deleteError && <Text accessibilityRole="alert" style={[styles.dialogText, {color: colors.destructive}]}>{deleteError}</Text>}
            <TouchableOpacity accessibilityRole="button" disabled={deleting || deletePassword.length < 6} onPress={handleDeleteAccount} style={[styles.dialogButton, {backgroundColor: colors.destructive, opacity: deleting || deletePassword.length < 6 ? 0.5 : 1}]}>
              <Text style={styles.deleteButtonText}>{deleting ? 'Удаление…' : 'Удалить навсегда'}</Text>
            </TouchableOpacity>
            <TouchableOpacity accessibilityRole="button" disabled={deleting} onPress={() => {setDeleteVisible(false);setDeletePassword('');}} style={styles.dialogButton}>
              <Text style={[styles.dialogText, {color: colors.foreground}]}>Отмена</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  privacyHint: {fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18, paddingHorizontal: 14, paddingVertical: 10},
  modalBackdrop: {flex: 1, backgroundColor: '#000A', justifyContent: 'center', alignItems: 'center', padding: 20},
  deleteDialog: {width: '100%', maxWidth: 460, padding: 20, borderRadius: 16, borderWidth: 1, gap: 14},
  dialogTitle: {fontFamily: 'Inter_700Bold', fontSize: 20},
  dialogText: {fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19},
  passwordInput: {fontFamily: 'Inter_400Regular', fontSize: 15, padding: 14, borderWidth: 1, borderRadius: 10},
  dialogButton: {minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 10, padding: 12},
  deleteButtonText: {fontFamily: 'Inter_600SemiBold', fontSize: 14, color: '#fff'},
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

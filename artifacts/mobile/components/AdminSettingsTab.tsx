/**
 * Вкладка «Настройки» в админ-экране.
 * Управляет глобальными feature-флагами через /api/admin/settings.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import {
  getAdminToken, setAdminToken,
  fetchAdminSettings, updateAdminSettings,
  triggerRetrain, pruneSnapshots,
  type AdminSettings,
} from '@/services/AdminApi';

export function AdminSettingsTab() {
  const colors = useColors();
  const [tokenInput, setTokenInput] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [oddsApiKeyConfigured, setOddsApiKeyConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const tok = await getAdminToken();
      setHasToken(!!tok);
      if (tok) {
        const data = await fetchAdminSettings();
        setSettings(data.settings);
        setOddsApiKeyConfigured(data.oddsApiKeyConfigured);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveToken() {
    if (!tokenInput.trim()) return;
    await setAdminToken(tokenInput.trim());
    setTokenInput('');
    await load();
  }

  async function clearToken() {
    Alert.alert('Удалить токен?', 'Доступ к админ-настройкам будет закрыт.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: async () => {
        await setAdminToken('');
        setHasToken(false);
        setSettings(null);
      }},
    ]);
  }

  async function toggleBookmakerOdds() {
    if (!settings) return;
    setSaving(true);
    try {
      const data = await updateAdminSettings({ useBookmakerOdds: !settings.useBookmakerOdds });
      setSettings(data.settings);
    } catch (err) {
      Alert.alert('Ошибка', String(err));
    } finally {
      setSaving(false);
    }
  }

  async function changePruneDays(delta: number) {
    if (!settings) return;
    const newVal = Math.max(1, Math.min(365, settings.liveSnapshotPruneDays + delta));
    if (newVal === settings.liveSnapshotPruneDays) return;
    setSaving(true);
    try {
      const data = await updateAdminSettings({ liveSnapshotPruneDays: newVal });
      setSettings(data.settings);
    } finally {
      setSaving(false);
    }
  }

  async function onRetrain() {
    Alert.alert(
      'Запустить переобучение?',
      'Будет загружен свежий датасет (15 страниц матчей) и переобучена модель. Занимает ~1-2 мин.',
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Запустить', onPress: async () => {
          try {
            const r = await triggerRetrain();
            Alert.alert('Пайплайн запущен', `${r.reason}\nСтатус: ${r.started ? 'идёт' : 'уже работает'}`);
          } catch (err) {
            Alert.alert('Ошибка', String(err));
          }
        }},
      ],
    );
  }

  async function onPrune() {
    try {
      const r = await pruneSnapshots();
      Alert.alert('Готово', `Удалено снапшотов старше ${r.days} дней: ${r.deleted}`);
    } catch (err) {
      Alert.alert('Ошибка', String(err));
    }
  }

  if (loading) {
    return <View style={{ padding: 20, alignItems: 'center' }}><ActivityIndicator color={colors.primary} /></View>;
  }

  if (!hasToken) {
    return (
      <View style={{ gap: 12 }}>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.warning + '55' }]}>
          <Feather name="lock" size={20} color={colors.warning} />
          <Text style={[styles.title, { color: colors.foreground }]}>Введите ADMIN_TOKEN</Text>
          <Text style={[styles.text, { color: colors.mutedForeground }]}>
            Токен задан на сервере в переменной окружения ADMIN_TOKEN. Введите его здесь, чтобы получить доступ к настройкам и переобучению модели.
          </Text>
          <TextInput
            value={tokenInput}
            onChangeText={setTokenInput}
            placeholder="вставьте токен"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background }]}
          />
          <TouchableOpacity onPress={saveToken} style={[styles.btn, { backgroundColor: colors.primary }]}>
            <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Сохранить</Text>
          </TouchableOpacity>
        </View>
        {error && <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>}
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {/* Bookmaker odds toggle */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: colors.foreground }]}>Подтягивать ставки букмекера</Text>
            <Text style={[styles.text, { color: colors.mutedForeground }]}>
              Когда включено — сервер запрашивает The Odds API и считает edge vs. рыночные коэффициенты. Когда выключено — мобилка показывает «популярные ставки» с справедливыми коэффициентами.
            </Text>
          </View>
          <TouchableOpacity
            onPress={toggleBookmakerOdds}
            disabled={saving}
            style={[styles.toggle, {
              backgroundColor: settings?.useBookmakerOdds ? colors.primary : colors.muted,
              opacity: saving ? 0.5 : 1,
            }]}
          >
            <View style={[styles.toggleKnob, {
              backgroundColor: '#fff',
              transform: [{ translateX: settings?.useBookmakerOdds ? 20 : 2 }],
            }]} />
          </TouchableOpacity>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: oddsApiKeyConfigured ? colors.positive + '22' : colors.warning + '22' }]}>
          <Feather name={oddsApiKeyConfigured ? 'check-circle' : 'alert-triangle'} size={12} color={oddsApiKeyConfigured ? colors.positive : colors.warning} />
          <Text style={[styles.statusText, { color: oddsApiKeyConfigured ? colors.positive : colors.warning }]}>
            ODDS_API_KEY {oddsApiKeyConfigured ? 'настроен' : 'не настроен (включение не сработает)'}
          </Text>
        </View>
      </View>

      {/* Prune days */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Хранить live-снапшоты, дней</Text>
        <Text style={[styles.text, { color: colors.mutedForeground }]}>
          Раз в сутки шедулер удаляет live_snapshots старше N дней. Прематч-исходы НЕ удаляются и хранятся бессрочно для метрик качества модели.
        </Text>
        <View style={styles.numRow}>
          <TouchableOpacity onPress={() => changePruneDays(-1)} style={[styles.numBtn, { borderColor: colors.border }]}>
            <Feather name="minus" size={16} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.numValue, { color: colors.foreground }]}>{settings?.liveSnapshotPruneDays}</Text>
          <TouchableOpacity onPress={() => changePruneDays(1)} style={[styles.numBtn, { borderColor: colors.border }]}>
            <Feather name="plus" size={16} color={colors.foreground} />
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={onPrune} style={[styles.btnGhost, { borderColor: colors.border }]}>
          <Feather name="trash-2" size={14} color={colors.mutedForeground} />
          <Text style={[styles.btnGhostText, { color: colors.mutedForeground }]}>Запустить чистку сейчас</Text>
        </TouchableOpacity>
      </View>

      {/* Manual retrain */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.primary + '44' }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Переобучение модели</Text>
        <Text style={[styles.text, { color: colors.mutedForeground }]}>
          Запускает ingest:teams → ingest:matches → train:model → hot-reload. Обычно автоматически: раз в 30 дней или через 7 дней после нового патча.
        </Text>
        <TouchableOpacity onPress={onRetrain} style={[styles.btn, { backgroundColor: colors.primary }]}>
          <Feather name="refresh-cw" size={14} color={colors.primaryForeground} />
          <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Запустить вручную</Text>
        </TouchableOpacity>
      </View>

      {/* Token mgmt */}
      <TouchableOpacity onPress={clearToken} style={[styles.btnGhost, { borderColor: colors.destructive + '55' }]}>
        <Feather name="log-out" size={14} color={colors.destructive} />
        <Text style={[styles.btnGhostText, { color: colors.destructive }]}>Удалить admin-токен с устройства</Text>
      </TouchableOpacity>

      {error && <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  text: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggle: { width: 44, height: 24, borderRadius: 12, justifyContent: 'center' },
  toggleKnob: { width: 20, height: 20, borderRadius: 10 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderRadius: 8 },
  statusText: { fontFamily: 'Inter_500Medium', fontSize: 11 },
  numRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18, paddingVertical: 4 },
  numBtn: { width: 36, height: 36, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  numValue: { fontFamily: 'Inter_700Bold', fontSize: 22, minWidth: 40, textAlign: 'center' },
  input: { borderWidth: 1, borderRadius: 8, padding: 10, fontFamily: 'Inter_400Regular', fontSize: 13 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12, borderRadius: 10 },
  btnText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  btnGhost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, borderRadius: 8, borderWidth: 1 },
  btnGhostText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  errorText: { fontFamily: 'Inter_400Regular', fontSize: 12, padding: 8 },
});

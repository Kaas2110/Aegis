import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, TextInput, Platform, Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { logProductEvent } from '@/services/logging/EventLogger';
import { notificationService, type EvAlert } from '@/services/notifications/NotificationService';
import type { Alert, MarketType } from '@/types';
import { useFeatureAccess } from '@/lib/featureFlags';
import { PremiumGate } from '@/components/PremiumGate';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

const ALERTS_KEY = '@dea_alerts_v2';

// Демо-алерты для превью на залоченном экране — чтобы пользователь
// видел, что именно даёт Premium, а не пустую страницу.
const DEMO_ALERTS = [
  { id: 'demo1', team1: 'Team Spirit', team2: 'PARIVISION', confidence: 0.78, betType: 'match_winner', side: 'team1' as const, odds: 1.62, time: '12м назад' },
  { id: 'demo2', team1: 'Tundra Esports', team2: 'Gaimin Gladiators', confidence: 0.71, betType: 'total_kills', side: 'team1' as const, odds: 1.85, time: '1ч назад' },
  { id: 'demo3', team1: 'BetBoom Team', team2: 'Falcons', confidence: 0.83, betType: 'first_blood', side: 'team2' as const, odds: 1.95, time: '3ч назад' },
];

const MARKET_OPTIONS: Array<{ id: MarketType; label: string }> = [
  { id: 'match_winner',   label: 'Победитель матча' },
  { id: 'map_winner',     label: 'Победитель карты' },
  { id: 'total_kills',    label: 'Тотал убийств' },
  { id: 'total_duration', label: 'Длительность' },
  { id: 'first_blood',    label: 'Первая кровь' },
  { id: 'map_handicap',   label: 'Гандикап карт' },
  { id: 'correct_score',  label: 'Точный счёт' },
];
const CONFIDENCE_OPTIONS = [50, 60, 70, 80] as const;

export default function AlertsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { settings } = useApp();

  const [userAlerts, setUserAlerts] = useState<Alert[]>([]);
  const [evAlerts, setEvAlerts] = useState<EvAlert[]>(() => notificationService.getAlerts());

  const [showModal, setShowModal] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newMinConf, setNewMinConf] = useState<number>(70);
  const [newMode, setNewMode] = useState<'live' | 'prematch' | 'any'>('any');
  const [newMarketTypes, setNewMarketTypes] = useState<MarketType[]>([]);
  const [newOnlyFavs, setNewOnlyFavs] = useState(false);
  const [activeTab, setActiveTab] = useState<'triggered' | 'rules'>('triggered');

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const access = useFeatureAccess('alerts_edge');

  useEffect(() => {
    logProductEvent('match_list_viewed', 'alerts');
    loadUserAlerts();
    notificationService.markAllSeen();
    notificationService.setFavoriteTeamIds(settings.favoriteTeamIds ?? []);
    const unsub = notificationService.subscribe(alerts => setEvAlerts([...alerts]));
    return unsub;
  }, [settings.favoriteTeamIds]);

  async function loadUserAlerts() {
    try {
      // Best-effort миграция: формат v1 (@dea_alerts) был несовместим
      // (одиночный marketType + minOdds/minEdge), поэтому просто чистим
      // легаси-ключ чтобы он не висел вечно. Подробное сообщение пользователь
      // получает естественным образом — список правил будет пустой.
      await AsyncStorage.removeItem('@dea_alerts').catch(() => {});

      const raw = await AsyncStorage.getItem(ALERTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Alert[];
        setUserAlerts(parsed);
        notificationService.setRules(parsed);
      }
    } catch {}
  }

  async function persist(list: Alert[]) {
    setUserAlerts(list);
    notificationService.setRules(list);
    try { await AsyncStorage.setItem(ALERTS_KEY, JSON.stringify(list)); } catch {}
  }

  async function handleCreate() {
    if (!newLabel.trim()) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const alert: Alert = {
      id: generateId(),
      label: newLabel.trim(),
      minConfidence: newMinConf,
      marketTypes: newMarketTypes,
      onlyFavoriteTeams: newOnlyFavs,
      mode: newMode,
      createdAt: new Date(),
      isActive: true,
    };
    await persist([alert, ...userAlerts]);
    await logProductEvent('alert_created', 'alerts', { alertId: alert.id });
    setShowModal(false);
    setNewLabel('');
    setNewMarketTypes([]);
    setNewOnlyFavs(false);
  }

  async function handleDelete(id: string) {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await persist(userAlerts.filter(a => a.id !== id));
  }

  async function handleToggle(id: string) {
    await persist(userAlerts.map(a => a.id === id ? { ...a, isActive: !a.isActive } : a));
  }

  function toggleMarketType(t: MarketType) {
    setNewMarketTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  }

  function formatTime(d: Date): string {
    const diff = Date.now() - new Date(d).getTime();
    const m = Math.floor(diff / 60000);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}ч назад`;
    if (m > 0) return `${m}м назад`;
    return 'только что';
  }

  function betTypeShort(type: string): string {
    return MARKET_OPTIONS.find(o => o.id === type)?.label ?? type;
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <View style={styles.headerTop}>
          <Text style={[styles.title, { color: colors.foreground }]}>Алерты</Text>
          {access.canAccess && (
            <TouchableOpacity onPress={() => setShowModal(true)} style={[styles.addBtn, { backgroundColor: colors.primary }]}>
              <Feather name="plus" size={18} color={colors.primaryForeground} />
            </TouchableOpacity>
          )}
        </View>
        {!access.canAccess && (
          <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
            <PremiumGate
              feature="alerts_edge"
              variant="inline"
              title="Алерты по edge доступны в Premium"
              subtitle="Получайте уведомления о высокой уверенности модели и +EV событиях"
            >
              {null}
            </PremiumGate>
          </View>
        )}

        <View style={[styles.tabs, { backgroundColor: colors.muted }]}>
          {(['triggered', 'rules'] as const).map(t => {
            const active = activeTab === t;
            const label = t === 'triggered' ? `Сработавшие · ${evAlerts.length}` : `Правила · ${userAlerts.length}`;
            return (
              <TouchableOpacity key={t} onPress={() => setActiveTab(t)} style={[styles.tab, active && { backgroundColor: colors.card }]}>
                <Text style={[styles.tabText, { color: active ? colors.foreground : colors.mutedForeground }]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {activeTab === 'triggered' && (
        <FlatList
          data={evAlerts}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 90 }]}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          renderItem={({ item }) => (
            <View style={[
              styles.evCard,
              { backgroundColor: colors.card, borderColor: item.seen ? colors.border : colors.primary + '55',
                borderLeftColor: colors.primary, borderLeftWidth: item.seen ? 1 : 3 }
            ]}>
              <View style={styles.evHeader}>
                <View style={[styles.evBadge, { backgroundColor: colors.primary + '1A' }]}>
                  <Feather name="zap" size={11} color={colors.primary} />
                  <Text style={[styles.evBadgeText, { color: colors.primary }]}>
                    Уверенность {Math.round(item.confidence * 100)}%
                  </Text>
                </View>
                <Text style={[styles.evTime, { color: colors.mutedForeground }]}>{formatTime(item.createdAt)}</Text>
              </View>
              {item.ruleLabel && (
                <Text style={[styles.evRule, { color: colors.mutedForeground }]}>правило: {item.ruleLabel}</Text>
              )}
              <Text style={[styles.evMatchup, { color: colors.foreground }]}>{item.team1} — {item.team2}</Text>
              <View style={styles.evMeta}>
                <View style={[styles.metaPill, { backgroundColor: colors.muted }]}>
                  <Text style={[styles.metaPillText, { color: colors.mutedForeground }]}>{betTypeShort(item.betType)}</Text>
                </View>
                <View style={[styles.metaPill, { backgroundColor: colors.muted }]}>
                  <Text style={[styles.metaPillText, { color: colors.mutedForeground }]}>
                    {item.side === 'team1' ? 'П1' : 'П2'} · спр. коэф {item.odds.toFixed(2)}
                  </Text>
                </View>
              </View>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="bell" size={36} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {access.canAccess ? 'Нет сработавших алертов' : 'Так выглядят алерты Premium'}
              </Text>
              <Text style={[styles.emptySubtext, { color: colors.mutedForeground }]}>
                {access.canAccess
                  ? 'Алерты приходят когда уверенность модели в исходе ≥ настроенного порога'
                  : 'Это превью. Подключите Premium чтобы получать настоящие пуши.'}
              </Text>
              {!access.canAccess && (
                <View style={{ width: '100%', gap: 8, marginTop: 14 }}>
                  {DEMO_ALERTS.map(d => (
                    <View key={d.id} style={[styles.evCard, {
                      backgroundColor: colors.card,
                      borderColor: colors.primary + '33',
                      borderLeftColor: colors.primary,
                      borderLeftWidth: 3,
                      opacity: 0.85,
                    }]}>
                      <View style={styles.evHeader}>
                        <View style={[styles.evBadge, { backgroundColor: colors.primary + '1A' }]}>
                          <Feather name="zap" size={11} color={colors.primary} />
                          <Text style={[styles.evBadgeText, { color: colors.primary }]}>
                            Уверенность {Math.round(d.confidence * 100)}%
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', gap: 5, alignItems: 'center' }}>
                          <View style={{ backgroundColor: colors.warning + '22', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
                            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 9, color: colors.warning, letterSpacing: 0.5 }}>ДЕМО</Text>
                          </View>
                          <Text style={[styles.evTime, { color: colors.mutedForeground }]}>{d.time}</Text>
                        </View>
                      </View>
                      <Text style={[styles.evMatchup, { color: colors.foreground }]}>{d.team1} — {d.team2}</Text>
                      <View style={styles.evMeta}>
                        <View style={[styles.metaPill, { backgroundColor: colors.muted }]}>
                          <Text style={[styles.metaPillText, { color: colors.mutedForeground }]}>{betTypeShort(d.betType)}</Text>
                        </View>
                        <View style={[styles.metaPill, { backgroundColor: colors.muted }]}>
                          <Text style={[styles.metaPillText, { color: colors.mutedForeground }]}>
                            {d.side === 'team1' ? 'П1' : 'П2'} · спр. коэф {d.odds.toFixed(2)}
                          </Text>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          }
        />
      )}

      {activeTab === 'rules' && (
        <FlatList
          data={userAlerts}
          keyExtractor={item => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 90 }]}
          showsVerticalScrollIndicator={false}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          renderItem={({ item }) => (
            <View style={[styles.ruleCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.ruleHeader}>
                <Text style={[styles.ruleLabel, { color: colors.foreground }]}>{item.label}</Text>
                <Switch value={item.isActive} onValueChange={() => handleToggle(item.id)} />
                <TouchableOpacity onPress={() => handleDelete(item.id)} style={[styles.deleteBtn, { backgroundColor: colors.destructive + '1A' }]}>
                  <Feather name="trash-2" size={15} color={colors.destructive} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.ruleMeta, { color: colors.mutedForeground }]}>
                Уверенность ≥ {item.minConfidence}% · {item.mode === 'any' ? 'все матчи' : item.mode === 'live' ? 'только лайв' : 'только до матча'}
              </Text>
              <View style={styles.ruleTags}>
                {item.marketTypes.length === 0 ? (
                  <View style={[styles.metaPill, { backgroundColor: colors.muted }]}>
                    <Text style={[styles.metaPillText, { color: colors.mutedForeground }]}>любой рынок</Text>
                  </View>
                ) : item.marketTypes.map(t => (
                  <View key={t} style={[styles.metaPill, { backgroundColor: colors.muted }]}>
                    <Text style={[styles.metaPillText, { color: colors.mutedForeground }]}>{betTypeShort(t)}</Text>
                  </View>
                ))}
                {item.onlyFavoriteTeams && (
                  <View style={[styles.metaPill, { backgroundColor: colors.primary + '22' }]}>
                    <Text style={[styles.metaPillText, { color: colors.primary }]}>★ избранные</Text>
                  </View>
                )}
              </View>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="bell-off" size={36} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Нет правил</Text>
              <Text style={[styles.emptySubtext, { color: colors.mutedForeground }]}>
                Без правил используется дефолтный порог уверенности 70%. Нажмите + чтобы создать своё.
              </Text>
            </View>
          }
        />
      )}

      <Modal visible={showModal} transparent animationType="slide" onRequestClose={() => setShowModal(false)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setShowModal(false)} />
        <View style={[styles.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 20 }]}>
          <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
          <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Новое правило</Text>

          <Text style={[styles.inputLabel, { color: colors.mutedForeground }]}>Название</Text>
          <TextInput
            value={newLabel}
            onChangeText={setNewLabel}
            placeholder="Напр. Tier1 ≥ 80%"
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { backgroundColor: colors.muted, color: colors.foreground, borderColor: colors.border }]}
          />

          <Text style={[styles.inputLabel, { color: colors.mutedForeground }]}>Когда</Text>
          <View style={styles.chipRow}>
            {(['any', 'live', 'prematch'] as const).map(m => (
              <ChipBtn key={m} label={m === 'any' ? 'Все' : m === 'live' ? 'Лайв' : 'До матча'} active={newMode === m} onPress={() => setNewMode(m)} colors={colors} />
            ))}
          </View>

          <Text style={[styles.inputLabel, { color: colors.mutedForeground }]}>Минимальная уверенность модели</Text>
          <View style={styles.chipRow}>
            {CONFIDENCE_OPTIONS.map(v => (
              <ChipBtn key={v} label={`${v}%`} active={newMinConf === v} onPress={() => setNewMinConf(v)} colors={colors} />
            ))}
          </View>

          <Text style={[styles.inputLabel, { color: colors.mutedForeground }]}>Типы рынков (пусто = любой)</Text>
          <View style={[styles.chipRow, { flexWrap: 'wrap' }]}>
            {MARKET_OPTIONS.map(o => (
              <ChipBtn
                key={o.id}
                label={o.label}
                active={newMarketTypes.includes(o.id)}
                onPress={() => toggleMarketType(o.id)}
                colors={colors}
                small
              />
            ))}
          </View>

          <View style={styles.favRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.inputLabel, { color: colors.foreground, marginTop: 0 }]}>
                Только любимые команды
              </Text>
              <Text style={[styles.favHint, { color: colors.mutedForeground }]}>
                {settings.favoriteTeamIds.length > 0
                  ? `Сохранено команд: ${settings.favoriteTeamIds.length}`
                  : 'Добавьте любимые команды в настройках профиля'}
              </Text>
            </View>
            <Switch value={newOnlyFavs} onValueChange={setNewOnlyFavs} disabled={settings.favoriteTeamIds.length === 0} />
          </View>

          <TouchableOpacity
            onPress={handleCreate}
            style={[styles.createBtn, { backgroundColor: newLabel.trim() ? colors.primary : colors.muted }]}
          >
            <Text style={[styles.createBtnText, { color: newLabel.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
              Создать правило
            </Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

function ChipBtn({
  label, active, onPress, colors, small,
}: {
  label: string; active: boolean; onPress: () => void;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
  small?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, small && styles.chipSmall, {
        backgroundColor: active ? colors.primary : colors.muted,
        borderColor: active ? colors.primary : colors.border,
      }]}
    >
      <Text style={[styles.chipText, small && { fontSize: 11 }, { color: active ? colors.primaryForeground : colors.mutedForeground }]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { borderBottomWidth: 1, paddingHorizontal: 14, paddingBottom: 10 },
  headerTop: { flexDirection: 'row', alignItems: 'center', paddingBottom: 10 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 20, flex: 1 },
  addBtn: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  tab: { flex: 1, borderRadius: 8, paddingVertical: 7, alignItems: 'center' },
  tabText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  list: { padding: 14 },
  evCard: { borderRadius: 14, borderWidth: 1, padding: 13, gap: 8 },
  evHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  evBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  evBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 12 },
  evTime: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  evRule: { fontFamily: 'Inter_400Regular', fontSize: 11, fontStyle: 'italic' },
  evMatchup: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  evMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  ruleCard: { borderRadius: 14, borderWidth: 1, padding: 13, gap: 6 },
  ruleHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ruleLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14, flex: 1 },
  deleteBtn: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  ruleMeta: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  ruleTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  metaPill: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  metaPillText: { fontFamily: 'Inter_500Medium', fontSize: 10 },
  empty: { alignItems: 'center', paddingTop: 70, gap: 8, paddingHorizontal: 30 },
  emptyText: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
  emptySubtext: { fontFamily: 'Inter_400Regular', fontSize: 13, textAlign: 'center' },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 10, maxHeight: '90%' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 6 },
  sheetTitle: { fontFamily: 'Inter_700Bold', fontSize: 18, marginBottom: 4 },
  inputLabel: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 4 },
  input: { borderRadius: 10, borderWidth: 1, padding: 12, fontFamily: 'Inter_400Regular', fontSize: 14 },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: { flex: 1, borderRadius: 8, borderWidth: 1, paddingVertical: 10, alignItems: 'center', minWidth: 60 },
  chipSmall: { flex: 0, paddingVertical: 6, paddingHorizontal: 10 },
  chipText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  favRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  favHint: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  createBtn: { borderRadius: 12, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  createBtnText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
});

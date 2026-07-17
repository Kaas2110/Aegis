import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';
import { getStoredProductEvents, getStoredTechnicalLogs, getStoredAuditLogs } from '@/services/logging/EventLogger';

export default function AdminScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [productEventCount, setProductEventCount] = useState(0);
  const [techLogCount, setTechLogCount] = useState(0);
  const [auditLogCount, setAuditLogCount] = useState(0);
  const [recentEvents, setRecentEvents] = useState<unknown[]>([]);
  // T004: вкладки «Настройки»/«Метрики» удалены — они ходили в /api/admin/*
  // с легаси-заголовком X-Admin-Token, который сервер больше не принимает.
  // Управление настройками и метриками живёт в admin-web (/admin-web).
  const [activeSection, setActiveSection] = useState<'sources' | 'logs' | 'model'>('logs');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  useEffect(() => {
    loadLogs();
  }, []);

  async function loadLogs() {
    const [events, tech, audit] = await Promise.all([
      getStoredProductEvents(),
      getStoredTechnicalLogs(),
      getStoredAuditLogs(),
    ]);
    setProductEventCount(events.length);
    setTechLogCount(tech.length);
    setAuditLogCount(audit.length);
    setRecentEvents(events.slice(-10).reverse());
  }

  // T004: жёсткий гейт — экран доступен только пользователям с is_admin=true
  // (выдаётся из админки). Защита от прямого deep-link'а на /admin.
  if (!user?.isAdmin) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
        <Feather name="lock" size={32} color={colors.mutedForeground} />
        <Text style={{ color: colors.foreground, fontFamily: 'Inter_600SemiBold', fontSize: 16, marginTop: 12 }}>Доступ ограничен</Text>
        <Text style={{ color: colors.mutedForeground, fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: 6, textAlign: 'center' }}>
          Админ-режим выдаётся администратором. Если он был выдан только что — перезапустите приложение.
        </Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.primary, fontFamily: 'Inter_600SemiBold', fontSize: 14 }}>Назад</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 8, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.foreground }]}>Admin · Debug</Text>
        <View style={[styles.adminBadge, { backgroundColor: colors.warning + '22', borderColor: colors.warning + '55' }]}>
          <Text style={[styles.adminBadgeText, { color: colors.warning }]}>ADMIN</Text>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}
        contentContainerStyle={{ flexDirection: 'row' }}
      >
        {(['logs', 'sources', 'model'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            onPress={() => setActiveSection(tab)}
            style={[styles.tab, { paddingHorizontal: 18 }, activeSection === tab && { borderBottomColor: colors.primary, borderBottomWidth: 2 }]}
          >
            <Text style={[styles.tabText, { color: activeSection === tab ? colors.primary : colors.mutedForeground }]}>
              {tab === 'sources' ? 'Источники' : tab === 'logs' ? 'Логи' : 'Модель'}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}
        showsVerticalScrollIndicator={false}
      >
        {activeSection === 'sources' && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Адаптеры источников данных</Text>
            <View style={[styles.sourceCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                Здоровье источников будет подгружаться через серверный admin-эндпоинт.
                Текущие активные источники: OpenDota, PandaScore, The Odds API, Stratz.
              </Text>
            </View>
          </View>
        )}

        {activeSection === 'logs' && (
          <View style={styles.section}>
            <View style={styles.logStats}>
              <LogStatBox label="Продуктовые" count={productEventCount} colors={colors} onRefresh={loadLogs} />
              <LogStatBox label="Технические" count={techLogCount} colors={colors} onRefresh={loadLogs} />
              <LogStatBox label="Прогнозы" count={auditLogCount} colors={colors} onRefresh={loadLogs} />
            </View>

            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Последние события</Text>
            {recentEvents.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Нет событий. Взаимодействуйте с приложением.</Text>
            ) : (
              recentEvents.map((evt: unknown, i) => {
                const e = evt as { eventName: string; screenName: string; timestamp: string; platform: string };
                return (
                  <View key={i} style={[styles.logRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <Text style={[styles.logEvent, { color: colors.primary }]}>{e.eventName}</Text>
                    <Text style={[styles.logMeta, { color: colors.mutedForeground }]}>
                      {e.screenName} · {e.platform} · {new Date(e.timestamp).toLocaleTimeString()}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        )}

        {activeSection === 'model' && (
          <View style={styles.section}>
            <View style={[styles.modelCard, { backgroundColor: colors.card, borderColor: colors.primary + '44' }]}>
              <Text style={[styles.modelVersion, { color: colors.primary }]}>baseline_v1.0.0</Text>
              <Text style={[styles.modelLabel, { color: colors.mutedForeground }]}>Текущая версия модели</Text>
            </View>

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>ModelProvider Interface</Text>
              {[
                'getPrematchPrediction(match, marketType)',
                'getDraftAdjustedPrediction(match, marketType)',
                'getLivePrediction(match, marketType)',
                'getMarketEdge(modelProb, fairProb)',
                'getExpectedValue(modelProb, odds)',
                'getModelExplanation(result)',
              ].map(m => (
                <View key={m} style={[styles.interfaceRow, { borderBottomColor: colors.border }]}>
                  <Feather name="code" size={12} color={colors.mutedForeground} />
                  <Text style={[styles.interfaceText, { color: colors.foreground }]}>{m}</Text>
                </View>
              ))}
            </View>

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Калибровка</Text>
              <MetaItem label="Метод" value="нет (заглушка)" colors={colors} />
              <MetaItem label="raw_probability" value="прямой выход модели" colors={colors} />
              <MetaItem label="calibrated_prob" value="raw × 0.98" colors={colors} />
              <MetaItem label="следующий шаг" value="isotonic / platt / temperature" colors={colors} />
            </View>

            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Интерфейсы адаптеров</Text>
              {[
                'OpenDotaAdapter ✓',
                'PandaScoreAdapter ✓',
                'TheOddsApiAdapter ✓',
                'StratzAdapter ✓',
                'PinnacleScraper (best-effort)',
                'BookmakerScrapers (Fonbet/LigaStavok/PARI/BetBoom/1xStavka/Olimp)',
              ].map(a => (
                <View key={a} style={[styles.interfaceRow, { borderBottomColor: colors.border }]}>
                  <View style={[styles.adapterDot, { backgroundColor: a.includes('✓') ? colors.positive : colors.muted }]} />
                  <Text style={[styles.interfaceText, { color: a.includes('✓') ? colors.foreground : colors.mutedForeground }]}>{a}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function MetaItem({ label, value, colors, negative }: { label: string; value: string; colors: ReturnType<typeof import('@/hooks/useColors').useColors>; negative?: boolean }) {
  return (
    <View style={metaStyles.row}>
      <Text style={[metaStyles.label, { color: colors.mutedForeground }]}>{label}:</Text>
      <Text style={[metaStyles.value, { color: negative ? colors.destructive : colors.foreground }]}>{value}</Text>
    </View>
  );
}

function LogStatBox({ label, count, colors, onRefresh }: { label: string; count: number; colors: ReturnType<typeof import('@/hooks/useColors').useColors>; onRefresh: () => void }) {
  return (
    <TouchableOpacity onPress={onRefresh} style={[logStatStyles.box, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[logStatStyles.count, { color: colors.primary }]}>{count}</Text>
      <Text style={[logStatStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const metaStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  label: { fontFamily: 'Inter_400Regular', fontSize: 12, width: 80 },
  value: { fontFamily: 'Inter_500Medium', fontSize: 12, flex: 1 },
});

const logStatStyles = StyleSheet.create({
  box: { flex: 1, borderRadius: 10, borderWidth: 1, padding: 12, alignItems: 'center', gap: 2 },
  count: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  label: { fontFamily: 'Inter_400Regular', fontSize: 10, textAlign: 'center' },
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 12, borderBottomWidth: 1, gap: 10 },
  backBtn: { padding: 6 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 18, flex: 1 },
  adminBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  adminBadgeText: { fontFamily: 'Inter_700Bold', fontSize: 11 },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  content: { padding: 14, gap: 12 },
  section: { gap: 10 },
  sectionTitle: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  sourceCard: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  logStats: { flexDirection: 'row', gap: 8 },
  logRow: { borderRadius: 10, borderWidth: 1, padding: 10, gap: 4 },
  logEvent: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  logMeta: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  emptyText: { fontFamily: 'Inter_400Regular', fontSize: 14, textAlign: 'center', paddingVertical: 20 },
  modelCard: { borderRadius: 12, borderWidth: 1, padding: 16, alignItems: 'center', gap: 4 },
  modelVersion: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  modelLabel: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 15, marginBottom: 4 },
  interfaceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1 },
  interfaceText: { fontFamily: 'Inter_400Regular', fontSize: 12, flex: 1 },
  adapterDot: { width: 8, height: 8, borderRadius: 4 },
});

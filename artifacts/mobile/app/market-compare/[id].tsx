import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { MOCK_MATCHES, buildMockMarkets } from '@/services/mock/mockData';
import { getCachedMatch, getCachedMarkets } from '@/services/LiveDataService';
import { logProductEvent } from '@/services/logging/EventLogger';
import type { Market, BookmakerOdds } from '@/types';

type SortKey = 'ev' | 'edge' | 'odds' | 'confidence';

export default function MarketCompareScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [sortKey, setSortKey] = useState<SortKey>('ev');
  const [activeMarket, setActiveMarket] = useState<string>('mkt_m1_map_winner');
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const cached = id ? getCachedMatch(id) : undefined;
  const match = cached?.match ?? MOCK_MATCHES.find(m => m.id === id);
  const markets = (cached?.markets.length
    ? cached.markets
    : getCachedMarkets(id ?? '').length
      ? getCachedMarkets(id ?? '')
      : buildMockMarkets().filter(mkt => mkt.matchId === id));

  useEffect(() => {
    logProductEvent('bookmaker_compare_opened', 'market_compare', { matchId: id });
  }, []);

  if (!match || markets.length === 0) {
    return (
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <View style={[styles.header, {
          paddingTop: topPad + 8,
          backgroundColor: colors.card,
          borderBottomColor: colors.border,
        }]}>
          <TouchableOpacity
            onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }}
            style={styles.backBtn}
          >
            <Feather name="arrow-left" size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Сравнение коэффициентов</Text>
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 30 }}>
          <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
          <Text style={{ color: colors.foreground, fontFamily: 'Inter_700Bold', fontSize: 17, textAlign: 'center' }}>
            Нет данных для сравнения
          </Text>
          <Text style={{ color: colors.mutedForeground, fontFamily: 'Inter_400Regular', fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
            Вернитесь к матчу и попробуйте снова.
          </Text>
          <TouchableOpacity
            onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, marginTop: 4 }}
          >
            <Feather name="arrow-left" size={16} color={colors.primaryForeground} />
            <Text style={{ color: colors.primaryForeground, fontFamily: 'Inter_600SemiBold', fontSize: 15 }}>Вернуться назад</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const selectedMarket = markets.find(m => m.id === activeMarket) || markets[0];
  const bookmakers = [...selectedMarket.allBookmakerOdds].sort((a, b) => {
    if (sortKey === 'ev') {
      const evA = selectedMarket.prediction.modelProbability * (a.oddsTeam1 - 1) - (1 - selectedMarket.prediction.modelProbability);
      const evB = selectedMarket.prediction.modelProbability * (b.oddsTeam1 - 1) - (1 - selectedMarket.prediction.modelProbability);
      return evB - evA;
    }
    if (sortKey === 'edge') return (selectedMarket.prediction.modelProbability - b.fairProbTeam1) - (selectedMarket.prediction.modelProbability - a.fairProbTeam1);
    if (sortKey === 'odds') return b.oddsTeam1 - a.oddsTeam1;
    return 0;
  });

  const modelProb = selectedMarket.prediction.modelProbability;

  function getEV(odds: BookmakerOdds): number {
    return modelProb * (odds.oddsTeam1 - 1) - (1 - modelProb);
  }
  function getEdge(odds: BookmakerOdds): number {
    return modelProb - odds.fairProbTeam1;
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 8, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Сравнение коэффициентов</Text>
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            {match.team1.shortName} vs {match.team2.shortName}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 30 }]}
        showsVerticalScrollIndicator={false}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.marketTabs}>
          {markets.map(mkt => (
            <TouchableOpacity
              key={mkt.id}
              onPress={() => setActiveMarket(mkt.id)}
              style={[styles.marketTab, { backgroundColor: activeMarket === mkt.id ? colors.primary : colors.card, borderColor: activeMarket === mkt.id ? colors.primary : colors.border }]}
            >
              <Text style={[styles.marketTabText, { color: activeMarket === mkt.id ? colors.primaryForeground : colors.mutedForeground }]}>
                {mkt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Модельная вероятность</Text>
          <View style={styles.modelProbRow}>
            <View style={styles.modelProbBlock}>
              <Text style={[styles.modelProbValue, { color: colors.primary }]}>{Math.round(modelProb * 100)}%</Text>
              <Text style={[styles.modelProbLabel, { color: colors.mutedForeground }]}>{match.team1.name}</Text>
            </View>
            <View style={[styles.modelDivider, { backgroundColor: colors.border }]} />
            <View style={styles.modelProbBlock}>
              <Text style={[styles.modelProbValue, { color: colors.dire }]}>{Math.round((1 - modelProb) * 100)}%</Text>
              <Text style={[styles.modelProbLabel, { color: colors.mutedForeground }]}>{match.team2.name}</Text>
            </View>
          </View>
          <Text style={[styles.modelMeta, { color: colors.mutedForeground }]}>
            Уверенность модели: {Math.round(selectedMarket.prediction.confidence * 100)}%
          </Text>
        </View>

        <View style={styles.sortBar}>
          <Text style={[styles.sortLabel, { color: colors.mutedForeground }]}>Сортировка:</Text>
          {(['ev', 'edge', 'odds', 'confidence'] as SortKey[]).map(k => (
            <TouchableOpacity
              key={k}
              onPress={() => {
                setSortKey(k);
                logProductEvent('market_sorted', 'market_compare', { sortKey: k });
              }}
              style={[styles.sortChip, { backgroundColor: sortKey === k ? colors.primary : colors.muted, borderColor: sortKey === k ? colors.primary : colors.border }]}
            >
              <Text style={[styles.sortChipText, { color: sortKey === k ? colors.primaryForeground : colors.mutedForeground }]}>
                {k === 'ev' ? 'EV' : k === 'edge' ? 'Edge' : k === 'odds' ? 'Коэф.' : 'Conf.'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={[styles.tableCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.tableHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.th, { color: colors.mutedForeground, flex: 1.5 }]}>Букмекер</Text>
            <Text style={[styles.th, { color: colors.mutedForeground }]}>Коэф.</Text>
            <Text style={[styles.th, { color: colors.mutedForeground }]}>Рынок</Text>
            <Text style={[styles.th, { color: colors.mutedForeground }]}>Перевес</Text>
            <Text style={[styles.th, { color: colors.mutedForeground }]}>Ценность</Text>
          </View>

          {bookmakers.map((bk, i) => {
            const ev = getEV(bk);
            const edge = getEdge(bk);
            const evColor = ev > 0 ? colors.positive : ev < -0.03 ? colors.destructive : colors.mutedForeground;
            const edgeColor = edge > 0 ? colors.positive : edge < -0.02 ? colors.destructive : colors.mutedForeground;
            const isBest = i === 0;
            return (
              <View key={bk.bookmakerId} style={[styles.tableRow, { borderBottomColor: colors.border, backgroundColor: isBest ? colors.positive + '0A' : 'transparent' }]}>
                <View style={[styles.td, { flex: 1.5 }]}>
                  {bk.isMock && (
                    <View style={[styles.mockDot, { backgroundColor: colors.warning }]} />
                  )}
                  <Text style={[styles.bkName, { color: colors.foreground }]}>{bk.bookmakerName}</Text>
                  {isBest && <Feather name="star" size={10} color={colors.positive} />}
                </View>
                <Text style={[styles.tdText, { color: colors.primary }]}>{bk.oddsTeam1.toFixed(2)}</Text>
                <Text style={[styles.tdText, { color: colors.mutedForeground }]}>{Math.round(bk.fairProbTeam1 * 100)}%</Text>
                <Text style={[styles.tdText, { color: edgeColor }]}>{edge > 0 ? '+' : ''}{(edge * 100).toFixed(1)}%</Text>
                <Text style={[styles.tdText, { color: evColor }]}>{ev > 0 ? '+' : ''}{(ev * 100).toFixed(1)}%</Text>
              </View>
            );
          })}
        </View>

        <View style={[styles.noteCard, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Feather name="info" size={12} color={colors.mutedForeground} />
          <Text style={[styles.noteText, { color: colors.mutedForeground }]}>
            Коэффициенты — демо-данные. Рыночная вероятность очищена от маржи. Перевес = модель − рынок. Ценность (EV) = модель × (коэф − 1) − (1 − модель).
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingBottom: 12, borderBottomWidth: 1, gap: 10 },
  backBtn: { padding: 6 },
  headerTitle: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  headerSub: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  content: { padding: 14, gap: 12 },
  marketTabs: { gap: 8, paddingBottom: 2 },
  marketTab: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  marketTabText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  card: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 8 },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  modelProbRow: { flexDirection: 'row', alignItems: 'center' },
  modelProbBlock: { flex: 1, alignItems: 'center', gap: 4 },
  modelProbValue: { fontFamily: 'Inter_700Bold', fontSize: 28 },
  modelProbLabel: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  modelDivider: { width: 1, height: 50 },
  modelMeta: { fontFamily: 'Inter_400Regular', fontSize: 11, textAlign: 'center' },
  sortBar: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  sortLabel: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  sortChip: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  sortChipText: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  tableCard: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  tableHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1 },
  th: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 11, textAlign: 'center' },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1 },
  td: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  tdText: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 12, textAlign: 'center' },
  bkName: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  mockDot: { width: 5, height: 5, borderRadius: 2.5 },
  noteCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderRadius: 10, borderWidth: 1, padding: 12 },
  noteText: { fontFamily: 'Inter_400Regular', fontSize: 11, flex: 1, lineHeight: 16 },
});

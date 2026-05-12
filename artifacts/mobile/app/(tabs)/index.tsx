import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import { MatchCard } from '@/components/MatchCard';
import { FilterBar } from '@/components/FilterBar';
import { AegisLogo } from '@/components/AegisLogo';
import { useSubscription } from '@/lib/revenuecat';
import { TouchableOpacity as RNTouchable } from 'react-native';
import { fetchLiveData, type EnrichedMatch } from '@/services/LiveDataService';
import { MOCK_MATCHES, buildMockMarkets } from '@/services/mock/mockData';
import { logProductEvent } from '@/services/logging/EventLogger';
import { notificationService, notifyFavoriteTeamMatchStart } from '@/services/notifications/NotificationService';
import type { Match, Market } from '@/types';

const REFRESH_INTERVAL_MS = 60_000;

/**
 * Маленький значок-индикатор статуса подписки в шапке.
 * Premium → золотая корона, Free → замок (открывает экран подписки).
 */
function PremiumHeaderBadge() {
  const colors = useColors();
  const { isSubscribed } = useSubscription();
  if (isSubscribed) {
    return (
      <RNTouchable
        onPress={() => router.push('/(tabs)/settings')}
        style={{ width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }}
      >
        <Feather name="award" size={18} color={colors.primary} />
      </RNTouchable>
    );
  }
  return (
    <RNTouchable
      onPress={() => router.push('/(tabs)/settings')}
      style={{ width: 36, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }}
    >
      <Feather name="zap" size={18} color={colors.warning} />
    </RNTouchable>
  );
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { filters, settings } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enrichedLive, setEnrichedLive] = useState<EnrichedMatch[]>([]);
  const [enrichedPrematch, setEnrichedPrematch] = useState<EnrichedMatch[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [dataSources, setDataSources] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [unseenAlerts, setUnseenAlerts] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  async function loadData(silent = false) {
    if (!silent) setLoading(true);
    try {
      const bookmakerSource = filters.bookmaker !== 'all' ? filters.bookmaker : undefined;
      const result = await fetchLiveData(bookmakerSource);
      setEnrichedLive(result.liveMatches);
      setEnrichedPrematch(result.prematchMatches);
      setIsMock(result.isMock);
      setDataSources(result.sources);
      setLastUpdated(new Date(result.fetchedAt));
      // Проверяем алерты по всем обогащённым матчам
      await notificationService.checkAndNotify([...result.liveMatches, ...result.prematchMatches]);
      // Пуш на старт матча любимой команды
      await notifyFavoriteTeamMatchStart(
        result.liveMatches.map((em) => ({ id: em.match.id, team1: em.match.team1, team2: em.match.team2, status: 'live' })),
        settings.favoriteTeamIds ?? [],
      );
      setUnseenAlerts(notificationService.getUnseenCount());
    } catch {
      // Fallback на mock данные
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    notificationService.requestPermissions();
    loadData();
    logProductEvent('match_list_viewed', 'home');
    intervalRef.current = setInterval(() => loadData(true), REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [filters.bookmaker]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
    await logProductEvent('match_list_refreshed', 'home');
  }, []);

  const allLive = enrichedLive.map(e => e.match);
  const allPrematch = enrichedPrematch.map(e => e.match);

  function applyFilters(arr: Match[]): Match[] {
    return arr.filter(m => {
      if (filters.mode !== 'all' && m.status !== filters.mode) return false;
      return true;
    });
  }

  const liveMatches = applyFilters(allLive);
  const prematchMatches = applyFilters(allPrematch);

  const marketsMap: Map<string, Market[]> = new Map();
  [...enrichedLive, ...enrichedPrematch].forEach(e => {
    marketsMap.set(e.match.id, e.markets);
  });

  const mockMarkets = buildMockMarkets();
  MOCK_MATCHES.forEach(m => {
    if (!marketsMap.has(m.id)) {
      marketsMap.set(m.id, mockMarkets.filter(mk => mk.matchId === m.id));
    }
  });

  function getBestMarket(matchId: string): Market | undefined {
    const mkts = marketsMap.get(matchId) ?? [];
    return mkts
      .filter(mkt => mkt.prediction.ev > 0)
      .sort((a, b) => b.prediction.ev - a.prediction.ev)[0]
      ?? mkts[0];
  }

  type SectionItem =
    | { type: 'source_bar'; id: string }
    | { type: 'header'; label: string; id: string; isLive?: boolean; subtitle?: string }
    | { type: 'match'; match: Match; id: string };

  // Группировка по турниру. Внутри групп — сортировка по startTime asc.
  // Порядок групп: сначала LIVE-секция (одна большая), затем PREMATCH секции по
  // турнирам, отсортированные по самому раннему begin_at.
  function groupByTournament(arr: Match[], headerPrefix: string, isLive: boolean): SectionItem[] {
    if (arr.length === 0) return [];
    const groups = new Map<string, Match[]>();
    for (const m of arr) {
      const key = (m.tournamentName || 'Pro Match').trim();
      const list = groups.get(key) ?? [];
      list.push(m);
      groups.set(key, list);
    }
    // sort matches inside each group
    for (const list of groups.values()) {
      list.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    }
    // sort groups by earliest match begin_at
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const ta = (groups.get(a)?.[0]?.startTime.getTime()) ?? 0;
      const tb = (groups.get(b)?.[0]?.startTime.getTime()) ?? 0;
      return ta - tb;
    });
    const out: SectionItem[] = [];
    for (const key of sortedKeys) {
      const list = groups.get(key) ?? [];
      out.push({
        type: 'header',
        label: `${headerPrefix} · ${key}`,
        subtitle: `${list.length} ${list.length === 1 ? 'матч' : 'матчей'}`,
        id: `${headerPrefix}_${key}`,
        isLive,
      });
      list.forEach(m => out.push({ type: 'match', match: m, id: m.id }));
    }
    return out;
  }

  const sections: SectionItem[] = [
    { type: 'source_bar', id: 'source_bar' },
    // ЛАЙВ — отдельной плоской группой, без разбивки по турнирам (их обычно мало)
    ...(liveMatches.length > 0
      ? [{ type: 'header' as const, label: `ЛАЙВ · ${liveMatches.length}`, id: 'live_header', isLive: true }]
      : []),
    ...liveMatches.map(m => ({ type: 'match' as const, match: m, id: m.id })),
    // СКОРО — разбито по турнирам
    ...groupByTournament(prematchMatches, 'СКОРО', false),
  ];

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* ── ШАПКА ──────────────────────────────── */}
      <View style={[
        styles.header,
        { paddingTop: topPad + 10, backgroundColor: colors.card, borderBottomColor: colors.borderGold }
      ]}>
        {/* Двойная золотая полоса под шапкой — как в HUD Dota 2 */}
        <View style={[styles.goldLine, { backgroundColor: colors.borderGold, opacity: 0.5 }]} />
        <View style={[styles.goldLineBottom, { backgroundColor: colors.primary }]} />
        <View style={styles.headerTop}>
          {/* Фирменный логотип Aegis — щит с лезвием-графиком */}
          <AegisLogo size={42} />

          <View style={styles.headerTitles}>
            <Text style={[styles.appName, { color: colors.foreground }]}>AEGIS</Text>
            <Text style={[styles.appSub, { color: colors.secondaryForeground }]}>
              DOTA 2 · MATCH ANALYTICS
            </Text>
          </View>

          <View style={styles.headerActions}>
            {loading && !refreshing && (
              <ActivityIndicator size="small" color={colors.primary} />
            )}
            <TouchableOpacity
              onPress={() => {
                notificationService.markAllSeen();
                setUnseenAlerts(0);
                router.push('/(tabs)/alerts');
              }}
              style={styles.actionBtn}
            >
              <Feather name="bell" size={18} color={unseenAlerts > 0 ? colors.primary : colors.mutedForeground} />
              {unseenAlerts > 0 && (
                <View style={[styles.badge, { backgroundColor: colors.primary }]}>
                  <Text style={[styles.badgeText, { color: colors.primaryForeground }]}>
                    {unseenAlerts > 9 ? '9+' : String(unseenAlerts)}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
            <PremiumHeaderBadge />
            <TouchableOpacity onPress={() => router.push('/admin')} style={styles.actionBtn}>
              <Feather name="settings" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        </View>
        <FilterBar />
      </View>

      {/* ── СПИСОК ────────────────────────────── */}
      <FlatList
        data={sections}
        keyExtractor={item => item.id}
        scrollEnabled
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => {
          if (item.type === 'source_bar') {
            return (
              <DataSourceBar
                isMock={isMock}
                sources={dataSources}
                lastUpdated={lastUpdated}
                colors={colors}
              />
            );
          }

          if (item.type === 'header') {
            const accentColor = item.isLive ? colors.destructive : colors.warning;
            return (
              <View style={styles.sectionHeader}>
                <View style={[styles.sectionLine, { backgroundColor: colors.borderGold }]} />
                <View style={[styles.sectionDiamond, { borderColor: accentColor, backgroundColor: accentColor + '22' }]} />
                <View style={{ flexShrink: 1, alignItems: 'center' }}>
                  <Text style={[styles.sectionLabel, { color: accentColor }]} numberOfLines={1}>
                    {item.label}
                  </Text>
                  {item.subtitle && (
                    <Text style={[styles.sectionSubtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {item.subtitle}
                    </Text>
                  )}
                </View>
                <View style={[styles.sectionDiamond, { borderColor: accentColor, backgroundColor: accentColor + '22' }]} />
                <View style={[styles.sectionLine, { backgroundColor: colors.borderGold }]} />
                    </View>
            );
          }

          if (item.type === 'match') {
            const match = item.match;
            const bestMarket = getBestMarket(match.id);
            return (
              <MatchCard
                match={match}
                bestMarket={bestMarket}
                onPress={async () => {
                  await logProductEvent('match_detail_opened', 'home', { matchId: match.id });
                  router.push({ pathname: '/match/[id]', params: { id: match.id } });
                }}
              />
            );
          }

          return null;
        }}
        ListEmptyComponent={
          loading ? null : (
            <View style={styles.empty}>
              <Feather name="inbox" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Нет матчей по фильтрам</Text>
            </View>
          )
        }
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
      />
    </View>
  );
}

function DataSourceBar({
  isMock, sources, lastUpdated, colors,
}: {
  isMock: boolean;
  sources: string[];
  lastUpdated: Date | null;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  // Внутренние идентификаторы источников → понятные пользователю русские лейблы.
  const SOURCE_LABEL_RU: Record<string, string> = {
    opendota: 'OpenDota (лайв)',
    pandascore: 'PandaScore (расписание)',
    the_odds_api: 'The Odds API',
    'demo-live': 'демо-лайв',
    fonbet: 'Fonbet',
    liga_stavok: 'Лига Ставок',
    pari: 'PARI',
    betboom: 'BetBoom',
    x1stavka: '1xStavka',
    olimp: 'Olimp.bet',
    mock: 'Mock (тест)',
  };
  const labels = sources.map(s => SOURCE_LABEL_RU[s] ?? s);

  return (
    <View style={[barStyles.bar, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <View style={[barStyles.dot, { backgroundColor: isMock ? colors.warning : colors.positive }]} />
      <Text style={[barStyles.text, { color: colors.mutedForeground }]} numberOfLines={1}>
        {isMock
          ? 'Демо-данные'
          : `Источники: ${labels.join(' · ')}`}
      </Text>
      <Text style={[barStyles.time, { color: colors.mutedForeground }]}>{timeStr}</Text>
    </View>
  );
}

const barStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 4,
  },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  text: { fontFamily: 'Inter_500Medium', fontSize: 11, flex: 1 },
  time: { fontFamily: 'Inter_500Medium', fontSize: 11 },
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { borderBottomWidth: 1, paddingBottom: 4, position: 'relative' },
  goldLine: { position: 'absolute', left: 0, right: 0, bottom: 2, height: 1 },
  goldLineBottom: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 1 },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    gap: 12,
  },
  headerTitles: { flex: 1 },
  appName: { fontFamily: 'Cinzel_700Bold', fontSize: 18, letterSpacing: 2.5 },
  appSub: { fontFamily: 'Cinzel_500Medium', fontSize: 10, marginTop: 2, letterSpacing: 1.6 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionBtn: { padding: 5, position: 'relative' },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontFamily: 'Inter_700Bold', fontSize: 9 },
  list: { padding: 14, gap: 0 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 2,
  },
  sectionLine: { flex: 1, height: 1, opacity: 0.6 },
  sectionDiamond: {
    width: 8,
    height: 8,
    borderWidth: 1,
    transform: [{ rotate: '45deg' }],
  },
  sectionLabel: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 11,
    letterSpacing: 2.5,
    paddingHorizontal: 4,
    textAlign: 'center',
  },
  sectionSubtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 9,
    letterSpacing: 0.5,
    marginTop: 1,
  },
  realBadge: { borderRadius: 2, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 4 },
  realBadgeText: { fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 0.6 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontFamily: 'Forum_400Regular', fontSize: 15, letterSpacing: 0.5 },
});

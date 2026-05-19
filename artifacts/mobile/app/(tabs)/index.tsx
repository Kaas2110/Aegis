import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { BookmakerDropdown } from '@/components/BookmakerDropdown';
import { fetchLiveData, rebuildMarketsForBookmaker, type EnrichedMatch } from '@/services/LiveDataService';
import { logProductEvent } from '@/services/logging/EventLogger';
import { notificationService, notifyFavoriteTeamMatchStart } from '@/services/notifications/NotificationService';
import type { Match, Market } from '@/types';

// Phase 10: динамические интервалы. Дефолты используются до первого ответа
// /api/client-config; затем мобилка раз в CONFIG_REFRESH_INTERVAL_MS пуллит
// конфиг и подменяет polling-интервал hot (live/idle выбирается по
// `enrichedLive.length > 0`). Админ правит интервалы из /admin-web/workers.
const DEFAULT_LIVE_REFRESH_MS = 60_000;
const DEFAULT_IDLE_REFRESH_MS = 300_000;
const CONFIG_REFRESH_INTERVAL_MS = 5 * 60_000;

type ClientConfig = { pollLiveSec: number; pollIdleSec: number; version: number };

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { filters, settings } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [enrichedLive, setEnrichedLive] = useState<EnrichedMatch[]>([]);
  const [enrichedPrematch, setEnrichedPrematch] = useState<EnrichedMatch[]>([]);
  const [noData, setNoData] = useState(false);
  const [dataSources, setDataSources] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [unseenAlerts, setUnseenAlerts] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const configIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Текущий polling-интервал и режим (live/idle). Меняется когда либо
  // (а) /api/client-config вернул новый конфиг, либо (б) переключился режим
  // live↔idle по `enrichedLive.length`. Передаём через ref, чтобы избежать
  // лишних ре-рендеров и проблем с stale closure в setInterval.
  const pollConfigRef = useRef<ClientConfig>({
    pollLiveSec: Math.round(DEFAULT_LIVE_REFRESH_MS / 1000),
    pollIdleSec: Math.round(DEFAULT_IDLE_REFRESH_MS / 1000),
    version: 0,
  });
  const lastLiveCountRef = useRef(0);
  const currentIntervalMsRef = useRef<number>(DEFAULT_LIVE_REFRESH_MS);
  // Контроллер для отмены предыдущего загрузочного цикла, когда стартует новый
  // (interval + pull-to-refresh могут пересекаться). Без этого старые колбэки
  // могли бы перезаписать свежие данные — см. code review 2026-05-14.
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadGenRef = useRef(0);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  async function loadData(silent = false) {
    // Отменяем предыдущий цикл и инкрементируем поколение
    loadAbortRef.current?.abort();
    const ctrl = new AbortController();
    loadAbortRef.current = ctrl;
    const myGen = ++loadGenRef.current;
    const isCurrent = () => myGen === loadGenRef.current;

    if (!silent) setLoading(true);
    try {
      // Прогрессивная загрузка: сначала показываем матчи без markets
      // (карточки появляются мгновенно), затем ML-предсказания подгружаются
      // последовательно — первый матч списка обогащается первым.
      const result = await fetchLiveData({
        signal: ctrl.signal,
        onShellsReady: (partial) => {
          if (!isCurrent()) return;
          setEnrichedLive(partial.liveMatches);
          setEnrichedPrematch(partial.prematchMatches);
          setNoData(partial.noData);
          setDataSources(partial.sources);
          setLastUpdated(new Date(partial.fetchedAt));
        },
        onMatchEnriched: (em) => {
          if (!isCurrent()) return;
          // Карточка может быть как live, так и прематч — обновляем в обоих
          // массивах по match.id (id уникален между live/prematch: `od_*` vs `up_*`).
          setEnrichedLive(prev => prev.map(p => p.match.id === em.match.id ? em : p));
          setEnrichedPrematch(prev => prev.map(p => p.match.id === em.match.id ? em : p));
        },
      });
      if (!isCurrent()) return;
      // Финальный snapshot — гарантированно показывает обогащённые matches
      // (на случай если onShellsReady не успел отработать для пустого ответа).
      setEnrichedLive(result.liveMatches);
      setEnrichedPrematch(result.prematchMatches);
      setNoData(result.noData);
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
      // Сетевая ошибка — оставляем последний успешный snapshot
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  // Phase 10: пересоздаём data-interval. Вызывается при первом монтировании,
  // при каждом обновлении конфига и при смене live/idle режима. Никаких
  // overlap'ов — старый interval всегда clear'ится первым.
  const restartDataInterval = useCallback(() => {
    const cfg = pollConfigRef.current;
    const isLive = lastLiveCountRef.current > 0;
    const nextMs = (isLive ? cfg.pollLiveSec : cfg.pollIdleSec) * 1000;
    if (nextMs === currentIntervalMsRef.current && intervalRef.current) return;
    currentIntervalMsRef.current = nextMs;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => loadData(true), nextMs);
  }, []);

  // Hot-reload polling-конфига с api-server. Не критично если упало — оставим
  // дефолты / последний успешный конфиг.
  const refreshClientConfig = useCallback(async () => {
    try {
      const resp = await fetch('/api/client-config');
      if (!resp.ok) return;
      const cfg = (await resp.json()) as Partial<ClientConfig>;
      if (
        typeof cfg.pollLiveSec === 'number' && cfg.pollLiveSec > 0 &&
        typeof cfg.pollIdleSec === 'number' && cfg.pollIdleSec > 0
      ) {
        pollConfigRef.current = {
          pollLiveSec: Math.floor(cfg.pollLiveSec),
          pollIdleSec: Math.floor(cfg.pollIdleSec),
          version: typeof cfg.version === 'number' ? cfg.version : 0,
        };
        restartDataInterval();
      }
    } catch {
      // network/parse error — keep current config
    }
  }, [restartDataInterval]);

  useEffect(() => {
    notificationService.requestPermissions();
    loadData(true); // тихая загрузка при первом открытии — не показываем спиннер
    logProductEvent('match_list_viewed', 'home');
    void refreshClientConfig();             // первый запрос конфига
    restartDataInterval();                  // стартуем data-interval с дефолта
    configIntervalRef.current = setInterval(() => void refreshClientConfig(), CONFIG_REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (configIntervalRef.current) clearInterval(configIntervalRef.current);
    };
  }, [refreshClientConfig, restartDataInterval]);

  // Реагируем на смену режима live↔idle (когда live матчи появились/исчезли).
  useEffect(() => {
    lastLiveCountRef.current = enrichedLive.length;
    restartDataInterval();
  }, [enrichedLive.length, restartDataInterval]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
    await logProductEvent('match_list_refreshed', 'home');
  }, []);

  const allLive = enrichedLive.map(e => e.match);
  const allPrematch = enrichedPrematch.map(e => e.match);

  // F1 (Phase 9): аккордеон «Завершённые матчи» — collapsed по умолчанию.
  const [finishedExpanded, setFinishedExpanded] = useState(false);

  // F2 (Phase 9): карта `matchId -> {hasSelectedBk, maxOdds}` для фильтра minOdds.
  // ВАЖНО: maxOdds считается ТОЛЬКО для выбранного букмекера (filters.bookmaker),
  // а не для произвольного — иначе фильтр будет отсеивать по «чужим» котировкам.
  // hasSelectedBk=false → фильтр становится no-op (нет данных = не отсеиваем).
  // Для filters.bookmaker==='none' карта не нужна (фильтр не применяется).
  const oddsMap = useMemo(() => {
    const m = new Map<string, { hasSelectedBk: boolean; maxOdds: number }>();
    if (filters.bookmaker === 'none') return m;
    for (const em of [...enrichedLive, ...enrichedPrematch]) {
      // Ищем выбранного букмекера среди доступных по матчу. Если не найден —
      // селектед-кэфов нет, фильтр будет no-op.
      const selected = em.availableBookmakers.find(b => b.bookmakerId === filters.bookmaker);
      if (!selected) {
        m.set(em.match.id, { hasSelectedBk: false, maxOdds: 0 });
        continue;
      }
      // Пересобираем маркеты под выбранного букмекера (как делает экран матча),
      // чтобы bestOdds на всех маркетах принадлежали именно ему.
      const rebuilt = rebuildMarketsForBookmaker(em, filters.bookmaker);
      let maxOdds = 0;
      for (const mk of rebuilt) {
        const o1 = mk.bestOdds?.oddsTeam1 ?? 0;
        const o2 = mk.bestOdds?.oddsTeam2 ?? 0;
        if (o1 > maxOdds) maxOdds = o1;
        if (o2 > maxOdds) maxOdds = o2;
      }
      // Если у выбранного букмекера на матче нет ни одной валидной котировки
      // (>0), трактуем как «данных нет» → no-op.
      m.set(em.match.id, { hasSelectedBk: maxOdds > 0, maxOdds });
    }
    return m;
  }, [enrichedLive, enrichedPrematch, filters.bookmaker]);

  function applyFilters(arr: Match[]): Match[] {
    return arr.filter(m => {
      if (filters.mode !== 'all') {
        // 'between_maps' матчи относим к 'live' — пользователь думает о них как
        // о текущей серии (счёт меняется, продолжается). В фильтре 'live' их
        // показываем, в фильтре 'prematch' — нет.
        const effectiveStatus = m.status === 'between_maps' ? 'live' : m.status;
        if (effectiveStatus !== filters.mode) return false;
      }
      // F2: minOdds — применяется только когда выбран реальный букмекер и порог > 1.0,
      // и ТОЛЬКО против котировок выбранного букмекера (см. oddsMap выше).
      // Если у выбранного бука на этом матче нет котировок (hasSelectedBk=false) —
      // фильтр no-op (иначе лента будет пустой).
      if (filters.bookmaker !== 'none' && filters.minOdds > 1.0) {
        const info = oddsMap.get(m.id);
        if (info && info.hasSelectedBk && info.maxOdds < filters.minOdds) return false;
      }
      return true;
    });
  }

  // F1 (Phase 9): finished отделяем ДО applyFilters, чтобы аккордеон
  // показывался независимо от filters.mode (иначе при mode='live'/'prematch'
  // завершённые матчи вообще исчезали бы из ленты). minOdds к finished тоже
  // не применяем — там нет активных рынков для ставки.
  const finishedMatches = allLive.filter(m => m.status === 'finished');
  const activeLive = allLive.filter(m => m.status !== 'finished');
  const liveMatches = applyFilters(activeLive);
  const prematchMatches = applyFilters(allPrematch);

  /**
   * Реактивная карта markets: пересчитывается при изменении данных или выбора бука.
   * — 'none': показываем markets без кэфов (edge/EV=0, только прогнозы модели)
   * — 'bovada' / другой id: перебираем availableBookmakers матча и если совпадение
   *   есть — пересобираем markets под выбранного бука; иначе используем как есть.
   */
  const marketsMap = useMemo(() => {
    const map = new Map<string, Market[]>();
    for (const em of [...enrichedLive, ...enrichedPrematch]) {
      if (filters.bookmaker === 'none') {
        // Режим «Без БК»: явно очищаем availableBookmakers чтобы edge/EV = 0
        map.set(em.match.id, rebuildMarketsForBookmaker({ ...em, availableBookmakers: [] }, 'no_bookmaker'));
      } else {
        const hasBk = em.availableBookmakers.some(b => b.bookmakerId === filters.bookmaker);
        map.set(em.match.id, hasBk
          ? rebuildMarketsForBookmaker(em, filters.bookmaker)
          : em.markets);
      }
    }
    return map;
  }, [enrichedLive, enrichedPrematch, filters.bookmaker]);

  // O(1) lookup статуса прогноза в renderItem — без этого FlatList на каждый
  // ререндер бегал бы O(N) find() по объединённому массиву (= O(N²) total).
  const statusMap = useMemo(() => {
    const map = new Map<string, EnrichedMatch['predictionStatus']>();
    for (const em of enrichedLive) map.set(em.match.id, em.predictionStatus);
    for (const em of enrichedPrematch) map.set(em.match.id, em.predictionStatus);
    return map;
  }, [enrichedLive, enrichedPrematch]);

  function getBestMarket(matchId: string): Market | undefined {
    const mkts = marketsMap.get(matchId) ?? [];
    if (mkts.length === 0) return undefined;

    // Жёсткий приоритет: match_winner ВСЕГДА первым.
    // Map_winner, тоталы и прочие — только если match_winner недоступен.
    //
    // Почему НЕ используем EV-сортировку внутри winner-типов:
    // EV = modelProb(team1) × (odds1-1) − (1−modelProb(team1)).
    // При stub-модели (50/50) map_winner.ev > match_winner.ev потому что у
    // match_winner реальный прогноз (33% для REK × 6.50) даёт ev≈1.1,
    // а у map_winner заглушка 50% × 6.50 даёт ev≈2.25 → алгоритм выбирает
    // карту с ложным EV, а не матч-виннер с честным прогнозом.
    const TYPE_PRIORITY = [
      'match_winner',
      'map_winner',
      'first_blood',
      'total_kills',
      'total_duration',
    ];

    for (const type of TYPE_PRIORITY) {
      const m = mkts.find(mkt => mkt.type === type);
      if (m) return m;
    }
    return mkts[0];
  }

  type SectionItem =
    | { type: 'source_bar'; id: string }
    | { type: 'header'; label: string; id: string; isLive?: boolean; subtitle?: string }
    | { type: 'match'; match: Match; id: string }
    | { type: 'finished_accordion'; id: string; count: number; expanded: boolean };

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
    // F1 (Phase 9): завершённые матчи — collapsed accordion сверху ленты.
    // Внутри — те же MatchCard, но без плиток прогнозов (см. MatchCard.isFinished).
    ...(finishedMatches.length > 0
      ? [{ type: 'finished_accordion' as const, id: 'finished_accordion', count: finishedMatches.length, expanded: finishedExpanded }]
      : []),
    ...(finishedExpanded
      ? finishedMatches.map(m => ({ type: 'match' as const, match: m, id: `fin_${m.id}` }))
      : []),
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
            <BookmakerDropdown />
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
                noData={noData}
                sources={dataSources}
                lastUpdated={lastUpdated}
                colors={colors}
              />
            );
          }

          if (item.type === 'finished_accordion') {
            return (
              <TouchableOpacity
                onPress={() => setFinishedExpanded(e => !e)}
                activeOpacity={0.7}
                style={[styles.finishedAccordion, { backgroundColor: colors.muted, borderColor: colors.border }]}
              >
                <Feather
                  name={item.expanded ? 'chevron-down' : 'chevron-right'}
                  size={14}
                  color={colors.mutedForeground}
                />
                <Text style={[styles.finishedAccordionText, { color: colors.mutedForeground }]}>
                  Завершённые матчи · {item.count}
                </Text>
              </TouchableOpacity>
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
                predictionStatus={statusMap.get(match.id) ?? 'pending'}
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
  noData, sources, lastUpdated, colors,
}: {
  noData: boolean;
  sources: string[];
  lastUpdated: Date | null;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  const timeStr = lastUpdated
    ? lastUpdated.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  return (
    <View style={[barStyles.bar, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <View style={[barStyles.dot, { backgroundColor: noData ? colors.warning : colors.positive }]} />
      <Text style={[barStyles.text, { color: colors.mutedForeground }]}>
        {noData
          ? 'Нет данных от апстрима'
          : `${sources.join(' · ')}`}
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
  // F1 (Phase 9): аккордеон «Завершённые матчи · N» — компактный нейтральный
  // header, отличается от LIVE/PREMATCH (без диамантов и cinzel-капителей).
  finishedAccordion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    marginTop: 8,
    marginBottom: 4,
  },
  finishedAccordionText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    letterSpacing: 0.5,
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontFamily: 'Forum_400Regular', fontSize: 15, letterSpacing: 0.5 },
});

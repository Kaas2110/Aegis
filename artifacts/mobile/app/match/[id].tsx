import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Platform, ActivityIndicator, Modal, Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { getApiUrl } from '@/lib/api/baseUrl';
import { useColors } from '@/hooks/useColors';
import {
  MOCK_MATCHES, buildMockMarkets,
} from '@/services/mock/mockData';
import {
  getCachedMatch, rebuildMarketsForBookmaker,
} from '@/services/LiveDataService';
import { MarketCard } from '@/components/MarketCard';
import { TotalsLadder } from '@/components/TotalsLadder';
import { ProbabilityBar } from '@/components/ProbabilityBar';
import { FreshnessIndicator } from '@/components/FreshnessIndicator';
import { logProductEvent } from '@/services/logging/EventLogger';
import type { Match, Market } from '@/types';
import { useFeatureAccess } from '@/lib/featureFlags';
import { PremiumGate } from '@/components/PremiumGate';

// TODO(bookmakers): см. replit.md → «Bookmakers roadmap». Включить когда
// подключим платный источник кэфов (The Odds API Pro / OddsJam).
const SHOW_BOOKMAKER_PICKER: boolean = false;

function formatGameTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Кнопка "Назад" — используется везде, включая экраны ошибок ─────────────
function BackButton({ colors }: { colors: ReturnType<typeof import('@/hooks/useColors').useColors> }) {
  return (
    <TouchableOpacity
      onPress={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(tabs)');
        }
      }}
      style={[backStyles.btn, { backgroundColor: colors.card, borderColor: colors.border }]}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Feather name="arrow-left" size={20} color={colors.foreground} />
    </TouchableOpacity>
  );
}

const backStyles = StyleSheet.create({
  btn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

// ── Состояние ошибки / не найдено ───────────────────────────────────────────
function ErrorScreen({
  title, subtitle, colors, topPad, insetBottom,
}: {
  title: string;
  subtitle?: string;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
  topPad: number;
  insetBottom: number;
}) {
  return (
    <View style={[errStyles.root, { backgroundColor: colors.background }]}>
      {/* Всегда показываем шапку с кнопкой назад */}
      <View style={[errStyles.header, {
        paddingTop: topPad + 10,
        backgroundColor: colors.card,
        borderBottomColor: colors.border,
      }]}>
        <BackButton colors={colors} />
        <Text style={[errStyles.headerTitle, { color: colors.mutedForeground }]}>
          Детали матча
        </Text>
      </View>

      <View style={errStyles.body}>
        <View style={[errStyles.iconWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
        </View>
        <Text style={[errStyles.title, { color: colors.foreground }]}>{title}</Text>
        {subtitle && (
          <Text style={[errStyles.subtitle, { color: colors.mutedForeground }]}>{subtitle}</Text>
        )}
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/(tabs)');
          }}
          style={[errStyles.backBtn, { backgroundColor: colors.primary }]}
        >
          <Feather name="arrow-left" size={16} color={colors.primaryForeground} />
          <Text style={[errStyles.backBtnText, { color: colors.primaryForeground }]}>
            Вернуться назад
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const errStyles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  headerTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    padding: 30,
  },
  iconWrap: {
    width: 70,
    height: 70,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontFamily: 'Inter_700Bold', fontSize: 18, textAlign: 'center' },
  subtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginTop: 8,
  },
  backBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
});

// ── Главный экран ────────────────────────────────────────────────────────────

export default function MatchDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  // Порядок табов: «Прогнозы» (бывший «Рынки») переехал на первое место —
  // это главная ценность приложения, пользователь видит её сразу. «Обзор»
  // ушёл на последнее место как справочный экран.
  const [activeTab, setActiveTab] = useState<'markets' | 'draft' | 'overview'>('markets');
  // Подвкладки во вкладке «Драфт» — для серий BO3/BO5 пользователь хочет
  // переключаться между картами. Пока бэк отдаёт draft только для текущей карты,
  // на картах 2/3 показываем заглушку «откроется когда стартует карта N».
  const [draftMapTab, setDraftMapTab] = useState<1 | 2 | 3>(1);
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  // ── Гуманизированное объяснение прогноза от бэка (T006) ───────────────────
  // Делаем один fetch /api/analytics/explain когда у матча есть оба teamId.
  // Кэш отсутствует — экран открывается редко, оверхед минимальный.
  type ExplainResp = {
    winner: {
      radiantProb: number; direProb: number;
      favorite: { name: string; prob: number };
      summary: string;
      factors: Array<{ label: string; impact: number; direction: 'radiant' | 'dire' | 'neutral'; description: string }>;
    };
    totals: { kills: { expected: number; low: number; high: number }; duration: { expectedMin: number; low: number; high: number } };
    teams: { radiant: { id: number; name: string }; dire: { id: number; name: string } };
  };
  const [explain, setExplain] = useState<ExplainResp | null>(null);
  // Предыдущая вероятность Radiant — для расчёта live-дельты «было X% → стало Y%».
  const [prevProbR, setPrevProbR] = useState<number | null>(null);

  // Ищем матч сначала в живом кэше, затем в mock
  const cached = id ? getCachedMatch(id) : undefined;
  const match: Match | undefined = cached?.match ?? MOCK_MATCHES.find(m => m.id === id);
  const baseMarkets: Market[] = cached?.markets
    ?? buildMockMarkets().filter(mkt => mkt.matchId === id);

  // ── Пикер букмекера ────────────────────────────────────────────────────────
  // Если у матча есть несколько букмекеров — даём пользователю выбрать,
  // чьи коэффициенты использовать. Edge/EV/справ. вероятность пересчитываются
  // на лету без повторного запроса на сервер.
  const availableBookmakers = cached?.availableBookmakers
    ?? baseMarkets[0]?.allBookmakerOdds
    ?? [];
  const [selectedBookmakerId, setSelectedBookmakerId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Сбрасываем выбор при смене матча или если выбранный букмекер пропал из обновлённого списка.
  useEffect(() => {
    if (selectedBookmakerId &&
        !availableBookmakers.some(b => b.bookmakerId === selectedBookmakerId)) {
      setSelectedBookmakerId(null);
    }
  }, [match?.id, availableBookmakers, selectedBookmakerId]);

  const effectiveBookmakerId = selectedBookmakerId ?? availableBookmakers[0]?.bookmakerId ?? null;
  const selectedBookmaker = availableBookmakers.find(b => b.bookmakerId === effectiveBookmakerId);

  // Пересобираем markets с выбранным букмекером (только если у нас есть кэш + больше одного букмекера)
  const markets: Market[] = useMemo(() => {
    if (!cached || !selectedBookmakerId || availableBookmakers.length <= 1) return baseMarkets;
    return rebuildMarketsForBookmaker(cached, selectedBookmakerId);
  }, [cached, selectedBookmakerId, baseMarkets, availableBookmakers.length]);

  useEffect(() => {
    if (match) logProductEvent('match_detail_opened', 'match_detail', { matchId: match.id });
  }, [match?.id]);

  // Wave 4: тоталы от букмекеров — пробуем найти реальные линии по именам команд.
  // Оба типа (kills/duration) за один обход источников не получить через текущий API,
  // поэтому делаем два параллельных запроса. Ошибки — silent (fallback на синтетику).
  interface BkLinesResult { lines: number[]; source: string; sourceName: string }
  const [bkKills, setBkKills] = useState<BkLinesResult | null>(null);
  const [bkDuration, setBkDuration] = useState<BkLinesResult | null>(null);

  useEffect(() => {
    if (!match) return;
    const t1 = match.team1.name?.trim();
    const t2 = match.team2.name?.trim();
    if (!t1 || !t2) return;
    let cancelled = false;
    const fetchLines = async (type: 'kills' | 'duration', setter: (v: BkLinesResult | null) => void) => {
      try {
        const r = await fetch(getApiUrl(
          `/api/bookmakers/match-lines?team1=${encodeURIComponent(t1)}&team2=${encodeURIComponent(t2)}&type=${type}`
        ));
        if (!r.ok || cancelled) return;
        const json = await r.json() as { found: boolean; lines?: number[]; source?: string; sourceName?: string };
        if (!cancelled && json.found && json.lines && json.lines.length >= 2) {
          setter({ lines: json.lines, source: json.source ?? '', sourceName: json.sourceName ?? json.source ?? '' });
        }
      } catch { /* silent — bookmakers may be geo-blocked */ }
    };
    Promise.all([
      fetchLines('kills', setBkKills),
      fetchLines('duration', setBkDuration),
    ]);
    return () => { cancelled = true; };
  }, [match?.id]);

  // T006: подтягиваем гуманизированный прогноз
  useEffect(() => {
    if (!match) return;
    const tR = Number(match.team1.id);
    const tD = Number(match.team2.id);
    if (!Number.isFinite(tR) || !Number.isFinite(tD) || tR <= 0 || tD <= 0 || tR === tD) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(getApiUrl(`/api/analytics/explain?radiantTeamId=${tR}&direTeamId=${tD}`));
        if (!r.ok) return;
        const json = await r.json() as ExplainResp;
        if (!cancelled) {
          setExplain(prev => {
            // запоминаем предыдущую вероятность для live-дельты
            if (prev) setPrevProbR(prev.winner.radiantProb);
            return json;
          });
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [match?.id, match?.liveSnapshot?.gameTimeSeconds]);

  // Нет ID вообще
  if (!id) {
    return (
      <ErrorScreen
        title="Некорректная ссылка"
        subtitle="Идентификатор матча не передан."
        colors={colors}
        topPad={topPad}
        insetBottom={insets.bottom}
      />
    );
  }

  // Матч не найден
  if (!match) {
    return (
      <ErrorScreen
        title="Матч не найден"
        subtitle="Возможно, матч завершился или данные ещё загружаются. Вернитесь на главный экран и обновите список."
        colors={colors}
        topPad={topPad}
        insetBottom={insets.bottom}
      />
    );
  }

  const snap = match.liveSnapshot;
  const draft = match.draft;
  const isLive = match.status === 'live';

  // T005: канонический порядок блоков во вкладке «Прогнозы».
  // Сначала исход серии (match_winner), затем текущая карта, тоталы,
  // длительность, гандикап, точный счёт — потом всё остальное в исходном порядке.
  const MARKET_ORDER: Record<string, number> = {
    match_winner: 0,
    map_winner: 1,
    total_kills: 2,
    total_duration: 3,
    map_handicap: 4,
    kills_handicap: 5,
    correct_score: 6,
  };
  const sortedMarkets = [...markets].sort((a, b) => {
    const oa = MARKET_ORDER[a.type] ?? 99;
    const ob = MARKET_ORDER[b.type] ?? 99;
    return oa - ob;
  });
  const bestMarket = sortedMarkets.find(m => m.type === 'map_winner') ?? sortedMarkets[0];

  // Без режима букмекера показываем только победителей (матча и карты).
  // Тоталы/гандикапы/первая кровь и т.д. имеют смысл только как «вероятность
  // против линии бука» — без линии это просто П1/П2 проценты, которые путают
  // пользователя (см. фидбэк по «Тотал убийств 52% / 48%»).
  // Когда подключим букмекеров (SHOW_BOOKMAKER_PICKER=true), фильтр снимется
  // и для тоталов будет рендериться TotalsLadder с реальными ТБ/ТМ-линиями.
  const WINNER_ONLY_MARKETS: ReadonlySet<string> = new Set(['match_winner', 'map_winner']);
  const visibleMarkets = SHOW_BOOKMAKER_PICKER
    ? sortedMarkets
    : sortedMarkets.filter(m => WINNER_ONLY_MARKETS.has(m.type));

  // ── Feature access ──────────────────────────────────────────────────────────
  const winProbAccess    = useFeatureAccess('win_probability');
  const marketAccess     = useFeatureAccess('market_predictions');
  const draftAccess      = useFeatureAccess('draft_analysis');
  const liveAccess       = useFeatureAccess('live_predictions');

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* ── ШАПКА ─────────────────────────────── */}
      <View style={[styles.header, {
        paddingTop: topPad + 8,
        backgroundColor: colors.card,
        borderBottomColor: colors.border,
      }]}>
        <BackButton colors={colors} />

        <View style={styles.headerCenter}>
          <Text style={[styles.headerTournament, { color: colors.mutedForeground }]} numberOfLines={1}>
            {match.tournamentName} · {match.format}
          </Text>
          <View style={styles.headerTeams}>
            <Text style={[styles.headerTeam, { color: colors.radiant }]}>
              {match.team1.shortName}
            </Text>
            <Text style={[styles.headerVs, { color: colors.mutedForeground }]}>
              {isLive && snap ? `${snap.radiantKills}—${snap.direKills}` : 'vs'}
            </Text>
            <Text style={[styles.headerTeam, { color: colors.dire }]}>
              {match.team2.shortName}
            </Text>
          </View>
          {isLive && snap && (
            <View style={styles.headerLive}>
              <View style={[styles.liveDot, { backgroundColor: colors.destructive }]} />
              <Text style={[styles.liveLabel, { color: colors.destructive }]}>ЛАЙВ</Text>
              <Text style={[styles.gameTimeTxt, { color: colors.mutedForeground }]}>
                {formatGameTime(snap.gameTimeSeconds)}
              </Text>
              <FreshnessIndicator ageSeconds={snap.snapshotAge} />
            </View>
          )}
        </View>

        <TouchableOpacity
          onPress={() => router.push({ pathname: '/market-compare/[id]', params: { id: match.id } })}
          style={styles.compareBtn}
        >
          <Feather name="bar-chart" size={18} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* ── ВКЛАДКИ ───────────────────────────── */}
      <View style={[styles.tabBar, {
        backgroundColor: colors.card,
        borderBottomColor: colors.border,
      }]}>
        {(['markets', 'draft', 'overview'] as const).map(tab => {
          const isActive = activeTab === tab;
          const locked =
            (tab === 'markets' && !marketAccess.canAccess) ||
            (tab === 'draft' && !draftAccess.canAccess) ||
            (tab === 'overview' && !winProbAccess.canAccess);
          return (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={[
                styles.tab,
                isActive && { borderBottomColor: colors.primary, borderBottomWidth: 2 },
              ]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={[
                  styles.tabText,
                  { color: isActive ? colors.primary : colors.mutedForeground },
                ]}>
                  {tab === 'markets' ? 'Прогнозы' : tab === 'draft' ? 'Драфт' : 'Обзор'}
                </Text>
                {locked && <Feather name="lock" size={10} color={colors.mutedForeground} />}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── КОНТЕНТ ───────────────────────────── */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 30 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ОБЗОР */}
        {activeTab === 'overview' && (
          <View style={styles.section}>
            {/* ПЕРВЫМ блоком — вероятности событий (по требованию пользователя). */}
            {bestMarket && (
              <PremiumGate feature="win_probability" variant="overlay">
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.primary + '55' }]}>
                  <SectionTitle title="Вероятность победы" colors={colors} />
                  <ProbabilityBar
                    team1Name={match.team1.name}
                    team2Name={match.team2.name}
                    modelProb={bestMarket.prediction.modelProbability}
                    marketProb={bestMarket.bestOdds.fairProbTeam1}
                  />
                </View>
              </PremiumGate>
            )}

            {/* Популярные рынки — только вероятность модели. */}
            {markets.length > 1 && (
              <PremiumGate feature="market_predictions" variant="overlay">
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <SectionTitle title="Популярные ставки" colors={colors} />
                  {markets.slice(1, 5).map(mkt => {
                    const pct = Math.round(mkt.prediction.modelProbability * 100);
                    return (
                      <View key={mkt.id} style={[styles.factorRow, { borderBottomColor: colors.border }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.factorName, { color: colors.foreground }]}>{mkt.label}</Text>
                        </View>
                        <View style={[styles.factorImpact, {
                          backgroundColor: colors.muted,
                          borderColor: colors.border,
                          alignItems: 'center',
                          minWidth: 56,
                        }]}>
                          <Text style={[styles.factorImpactText, { color: colors.foreground }]}>
                            {pct}%
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </PremiumGate>
            )}

            {isLive && snap && (
              <PremiumGate feature="live_predictions" variant="overlay">
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <SectionTitle title="Лайв-статистика" colors={colors} />
                  <View style={styles.statsGrid}>
                  <StatItem label="Убийства Р/Д" value={`${snap.radiantKills} / ${snap.direKills}`} colors={colors} />
                  <StatItem label="Голд Radiant" value={`${(snap.netWorthRadiant / 1000).toFixed(1)}k`} colors={colors} positive />
                  <StatItem label="Голд Dire" value={`${(snap.netWorthDire / 1000).toFixed(1)}k`} colors={colors} />
                  <StatItem label="Опыт Р/Д" value={`${(snap.xpRadiant / 1000).toFixed(1)}k / ${(snap.xpDire / 1000).toFixed(1)}k`} colors={colors} />
                  <StatItem label="Башни Radiant" value={String(snap.towersRadiant)} colors={colors} />
                  <StatItem label="Башни Dire" value={String(snap.towersDire)} colors={colors} />
                  <StatItem label="Выкупы Radiant" value={String(snap.buybacksAvailableRadiant)} colors={colors} positive />
                  <StatItem label="Выкупы Dire" value={String(snap.buybacksAvailableDire)} colors={colors} negative={snap.buybacksAvailableDire < 2} />
                  <StatItem
                    label="Рошан"
                    value={snap.roshanAlive ? 'Жив' : snap.aegisHolder ? `Аегис: ${snap.aegisHolder}` : 'Убит'}
                    colors={colors}
                  />
                </View>
                {snap.lastBigEvent && (
                  <View style={[styles.eventAlert, { backgroundColor: colors.warning + '20', borderColor: colors.warning + '55' }]}>
                    <Feather name="zap" size={12} color={colors.warning} />
                    <Text style={[styles.eventAlertText, { color: colors.warning }]}>{snap.lastBigEvent}</Text>
                  </View>
                )}
              </View>
              </PremiumGate>
            )}

            {/* Блок «Динамика вероятностей» отключён: реальной таймсерии лайв-вероятностей
                сейчас нет (есть только текущий снимок), а прежний MOCK_TIMELINE рисовал
                неотличимый от реального график на основе фейковых точек. Включим, когда
                бэк начнёт хранить полноценную historic-таймлайн вероятностей по матчу. */}

            {/* T006: гуманизированный обзор. Заменил собой сухой dump explanationJson. */}
            {explain && (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <SectionTitle title="Обзор по матчу" colors={colors} />
                <Text style={[styles.explanationSummary, { color: colors.foreground, fontSize: 14 }]}>
                  {explain.winner.summary}
                </Text>
                {/* Live-delta: показываем «было X% → стало Y%» если есть предыдущий замер */}
                {isLive && prevProbR !== null && Math.abs(prevProbR - explain.winner.radiantProb) > 0.005 && (
                  <View style={[styles.deltaCard, {
                    backgroundColor: explain.winner.radiantProb > prevProbR ? colors.radiant + '15' : colors.dire + '15',
                    borderColor: explain.winner.radiantProb > prevProbR ? colors.radiant + '55' : colors.dire + '55',
                  }]}>
                    <Feather name={explain.winner.radiantProb > prevProbR ? 'trending-up' : 'trending-down'} size={14} color={explain.winner.radiantProb > prevProbR ? colors.radiant : colors.dire} />
                    <Text style={[styles.deltaText, { color: colors.foreground }]}>
                      {match.team1.shortName}: {Math.round(prevProbR * 100)}% → {Math.round(explain.winner.radiantProb * 100)}%
                      <Text style={{ color: colors.mutedForeground }}>
                        {' '}({explain.winner.radiantProb > prevProbR ? '+' : ''}{Math.round((explain.winner.radiantProb - prevProbR) * 100)} п.п.)
                      </Text>
                    </Text>
                  </View>
                )}
                <View style={styles.factors}>
                  {explain.winner.factors.map((f, i) => {
                    const positive = f.direction === 'radiant';
                    const negative = f.direction === 'dire';
                    const pillColor = positive ? colors.radiant : negative ? colors.dire : colors.mutedForeground;
                    return (
                      <View key={i} style={[styles.factorRow, { borderBottomColor: colors.border }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.factorName, { color: colors.foreground }]}>{f.label}</Text>
                          <Text style={[styles.factorDesc, { color: colors.mutedForeground }]}>{f.description}</Text>
                        </View>
                        <View style={[styles.factorImpact, {
                          backgroundColor: pillColor + '20',
                          borderColor: pillColor + '55',
                          flexDirection: 'row',
                          gap: 4,
                          paddingHorizontal: 8,
                        }]}>
                          <Feather
                            name={f.direction === 'neutral' ? 'minus' : f.direction === 'radiant' ? 'arrow-left' : 'arrow-right'}
                            size={12}
                            color={pillColor}
                          />
                          <Text style={[styles.factorImpactText, { color: pillColor, fontSize: 11 }]}>
                            {f.direction === 'neutral' ? 'нейтр.' : f.direction === 'radiant' ? match.team1.shortName : match.team2.shortName}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* T005: Тоталы карусель — ориентиры от модели */}
            {explain && (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <SectionTitle title="Прогноз по тоталам" colors={colors} />
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
                  <TotalCard
                    title="Убийства"
                    expected={String(explain.totals.kills.expected)}
                    range={`${explain.totals.kills.low}–${explain.totals.kills.high}`}
                    icon="zap"
                    colors={colors}
                  />
                  <TotalCard
                    title="Длительность"
                    expected={`${explain.totals.duration.expectedMin} мин`}
                    range={`${explain.totals.duration.low}–${explain.totals.duration.high} мин`}
                    icon="clock"
                    colors={colors}
                  />
                </ScrollView>
                <Text style={[styles.sectionHint, { color: colors.mutedForeground, marginTop: 8 }]}>
                  Грубые ориентиры по силе команд. Точная модель тоталов — в разработке.
                </Text>
              </View>
            )}

            {/* Если нет никаких данных вообще */}
            {!isLive && !snap && !bestMarket && (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.emptyCard}>
                  <Feather name="clock" size={28} color={colors.mutedForeground} />
                  <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>
                    Данные матча появятся после начала
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* ДРАФТ */}
        {activeTab === 'draft' && (
          <View style={styles.section}>
            {!draftAccess.canAccess && (
              <PremiumGate
                feature="draft_analysis"
                variant="inline"
                title="Анализ драфта доступен в Premium"
                subtitle="Пики, баны и Draft Score по синергии, контрпикам и масштабированию"
              >
                {null}
              </PremiumGate>
            )}
            {/* T005: подвкладки по картам. Для BO3/BO5 — реальные карты,
                для BO1 — единственная карта без выбора. */}
            {(match.format === 'BO3' || match.format === 'BO5') && (
              <View style={[styles.mapSubTabs, { backgroundColor: colors.muted }]}>
                {([1, 2, 3] as const).map(n => {
                  const active = draftMapTab === n;
                  const isCurrent = n === (match.currentMapNumber ?? 1);
                  return (
                    <TouchableOpacity
                      key={n}
                      onPress={() => setDraftMapTab(n)}
                      style={[styles.mapSubTab, active && { backgroundColor: colors.card }]}
                    >
                      <Text style={[styles.mapSubTabText, { color: active ? colors.foreground : colors.mutedForeground }]}>
                        Карта {n}{isCurrent ? ' · сейчас' : ''}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            {/* Драфт показываем только когда выбранная карта = текущей.
                Для других карт — контентная заглушка, пока бэк не отдаёт
                драфты per-map (TODO: расширить /api/matches/live). */}
            <View style={{ opacity: draftAccess.canAccess ? 1 : 0.35 }} pointerEvents={draftAccess.canAccess ? 'auto' : 'none'}>
            {draftMapTab !== (match.currentMapNumber ?? 1) ? (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.emptyCard}>
                  <Feather name="map" size={28} color={colors.mutedForeground} />
                  <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>
                    Драфт карты {draftMapTab} появится когда стартует эта карта
                  </Text>
                </View>
              </View>
            ) : draft ? (
              <>
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <SectionTitle title="Пики" colors={colors} />
                  <View style={styles.draftGrid}>
                    <View style={styles.draftSide}>
                      <Text style={[styles.sideLabel, { color: colors.radiant }]}>{match.team1.name}</Text>
                      {draft.picks.filter(p => p.side === 'radiant').map(p => (
                        <View key={p.heroId} style={[styles.heroChip, { backgroundColor: colors.radiant + '1A', borderColor: colors.radiant + '44' }]}>
                          <Text style={[styles.heroName, { color: colors.radiant }]}>{p.heroName}</Text>
                        </View>
                      ))}
                    </View>
                    <View style={styles.draftSide}>
                      <Text style={[styles.sideLabel, { color: colors.dire }]}>{match.team2.name}</Text>
                      {draft.picks.filter(p => p.side === 'dire').map(p => (
                        <View key={p.heroId} style={[styles.heroChip, { backgroundColor: colors.dire + '1A', borderColor: colors.dire + '44' }]}>
                          <Text style={[styles.heroName, { color: colors.dire }]}>{p.heroName}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>

                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <SectionTitle title="Баны" colors={colors} />
                  <View style={styles.bansRow}>
                    {draft.bans.map(b => (
                      <View key={b.heroId} style={[styles.banChip, { backgroundColor: colors.muted, borderColor: colors.border }]}>
                        <Text style={[styles.banName, { color: colors.mutedForeground }]}>{b.heroName}</Text>
                      </View>
                    ))}
                  </View>
                </View>

                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <SectionTitle title="Draft Score" colors={colors} />
                  <View style={styles.draftScores}>
                    <DraftScore label="Синергия" radiant={draft.radiantSynergy} dire={draft.direSynergy} colors={colors} />
                    <DraftScore label="Контрпики" radiant={draft.radiantCounter} dire={draft.direCounter} colors={colors} />
                    <DraftScore label="Лейт-гейм" radiant={draft.radiantScalingScore} dire={draft.direScalingScore} colors={colors} />
                    <DraftScore label="Ранняя игра" radiant={draft.radiantEarlyGameScore} dire={draft.direEarlyGameScore} colors={colors} />
                  </View>
                </View>
              </>
            ) : (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.emptyCard}>
                  <Feather name="shield" size={28} color={colors.mutedForeground} />
                  <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>
                    Данные драфта недоступны для этого матча
                  </Text>
                </View>
              </View>
            )}
            </View>
          </View>
        )}

        {/* РЫНКИ */}
        {activeTab === 'markets' && (
          <View style={styles.section}>
            {!marketAccess.canAccess && (
              <PremiumGate
                feature="market_predictions"
                variant="inline"
                title="Прогнозы по рынкам доступны в Premium"
                subtitle="Все 15 рынков: winner, тоталы, первая кровь, форы и длительность"
              >
                {null}
              </PremiumGate>
            )}
            {/* TODO(bookmakers): пикер букмекера скрыт до появления реальных
                платных кэфов. Бэкенд-логика (availableBookmakers, selectedBookmakerId,
                pickerOpen state, модалка ниже) оставлена нетронутой — при включении
                достаточно раскомментировать этот блок. См. replit.md → «Bookmakers roadmap». */}
            {selectedBookmaker && SHOW_BOOKMAKER_PICKER && availableBookmakers.length >= 2 && (
              <TouchableOpacity
                onPress={() => setPickerOpen(true)}
                style={[styles.bookmakerPicker, { backgroundColor: colors.card, borderColor: colors.border }]}
                activeOpacity={0.7}
              >
                <View style={styles.bookmakerPickerLeft}>
                  <Feather name="briefcase" size={14} color={colors.primary} />
                  <View>
                    <Text style={[styles.bookmakerPickerLabel, { color: colors.mutedForeground }]}>
                      Букмекер
                    </Text>
                    <Text style={[styles.bookmakerPickerName, { color: colors.foreground }]}>
                      {selectedBookmaker.bookmakerName}
                      {selectedBookmaker.isMock && (
                        <Text style={{ color: colors.warning }}>  · демо</Text>
                      )}
                    </Text>
                  </View>
                </View>
                <View style={styles.bookmakerPickerRight}>
                  <Text style={[styles.bookmakerPickerOdds, { color: colors.primary }]}>
                    {selectedBookmaker.oddsTeam1.toFixed(2)} / {selectedBookmaker.oddsTeam2.toFixed(2)}
                  </Text>
                  <Feather name="chevron-down" size={16} color={colors.mutedForeground} />
                </View>
              </TouchableOpacity>
            )}

            <View style={{ opacity: marketAccess.canAccess ? 1 : 0.35 }} pointerEvents={marketAccess.canAccess ? 'auto' : 'none'}>
            {visibleMarkets.length > 0 ? (
              visibleMarkets.map(mkt => {
                // Тоталы рендерим лестницей ТБ/ТМ (как у буков), а не П1/П2.
                // Нужны числовые team_id (OpenDota) — у mock-матчей их нет, поэтому
                // показываем ladder только когда есть оба ID.
                if (mkt.type === 'total_kills' || mkt.type === 'total_duration') {
                  const t1Id = Number(match.team1.id);
                  const t2Id = Number(match.team2.id);
                  if (Number.isInteger(t1Id) && Number.isInteger(t2Id) && t1Id > 0 && t2Id > 0) {
                    const ladderType = mkt.type === 'total_kills' ? 'kills' : 'duration';
                    const liveCurrent = isLive && snap
                      ? (ladderType === 'kills'
                          ? snap.radiantKills + snap.direKills
                          : Math.floor(snap.gameTimeSeconds / 60))
                      : null;
                    const liveMinute = isLive && snap ? Math.floor(snap.gameTimeSeconds / 60) : null;
                    const fmt = (match.format ?? 'BO3').toUpperCase() as 'BO1' | 'BO3' | 'BO5';
                    const bkResult = ladderType === 'kills' ? bkKills : bkDuration;
                    return (
                      <TotalsLadder
                        key={mkt.id}
                        radiantTeamId={t1Id}
                        direTeamId={t2Id}
                        type={ladderType}
                        format={fmt}
                        liveCurrent={liveCurrent}
                        liveMinute={liveMinute}
                        bookmakerLines={bkResult?.lines}
                        bookmakerSource={bkResult?.sourceName}
                      />
                    );
                  }
                }
                return (
                  <MarketCard
                    key={mkt.id}
                    market={mkt}
                    team1Name={match.team1.name}
                    team2Name={match.team2.name}
                    onPress={async () => {
                      await logProductEvent('market_card_viewed', 'match_detail', { matchId: match.id, marketId: mkt.id });
                      router.push({ pathname: '/market-compare/[id]', params: { id: match.id } });
                    }}
                  />
                );
              })
            ) : (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.emptyCard}>
                  <Feather name="trending-up" size={28} color={colors.mutedForeground} />
                  <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>
                    Аналитика по рынкам загружается
                  </Text>
                </View>
              </View>
            )}
            </View>
          </View>
        )}
      </ScrollView>

      {/* ── Попап выбора букмекера ─────────────────────────────────────────── */}
      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable
          style={pickerStyles.overlay}
          onPress={() => setPickerOpen(false)}
        >
          <Pressable
            style={[pickerStyles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={e => e.stopPropagation()}
          >
            <View style={[pickerStyles.header, { borderBottomColor: colors.border }]}>
              <Text style={[pickerStyles.title, { color: colors.foreground }]}>
                Выберите букмекера
              </Text>
              <Text style={[pickerStyles.subtitle, { color: colors.mutedForeground }]}>
                Котировки и оценка ценности пересчитаются по выбранной конторе
              </Text>
            </View>
            <ScrollView style={pickerStyles.list}>
              {availableBookmakers.map(bk => {
                const isActive = bk.bookmakerId === effectiveBookmakerId;
                return (
                  <TouchableOpacity
                    key={bk.bookmakerId}
                    onPress={() => {
                      setSelectedBookmakerId(bk.bookmakerId);
                      setPickerOpen(false);
                    }}
                    style={[
                      pickerStyles.row,
                      { borderBottomColor: colors.border },
                      isActive && { backgroundColor: colors.primary + '14' },
                    ]}
                  >
                    <View style={pickerStyles.rowLeft}>
                      <View style={[pickerStyles.radio, {
                        borderColor: isActive ? colors.primary : colors.border,
                        backgroundColor: isActive ? colors.primary : 'transparent',
                      }]}>
                        {isActive && <Feather name="check" size={11} color={colors.primaryForeground} />}
                      </View>
                      <View>
                        <Text style={[pickerStyles.bkName, { color: colors.foreground }]}>
                          {bk.bookmakerName}
                        </Text>
                        {bk.isMock && (
                          <Text style={[pickerStyles.mockTag, { color: colors.warning }]}>
                            демо-данные
                          </Text>
                        )}
                      </View>
                    </View>
                    <View style={pickerStyles.rowRight}>
                      <Text style={[pickerStyles.oddVal, { color: colors.radiant }]}>
                        {bk.oddsTeam1.toFixed(2)}
                      </Text>
                      <Text style={[pickerStyles.oddSep, { color: colors.mutedForeground }]}>·</Text>
                      <Text style={[pickerStyles.oddVal, { color: colors.dire }]}>
                        {bk.oddsTeam2.toFixed(2)}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity
              onPress={() => setPickerOpen(false)}
              style={[pickerStyles.closeBtn, { backgroundColor: colors.muted }]}
            >
              <Text style={[pickerStyles.closeBtnText, { color: colors.foreground }]}>
                Закрыть
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const pickerStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  sheet: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '80%',
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    gap: 4,
  },
  title: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  subtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 16 },
  list: { maxHeight: 400 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 },
  radio: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  bkName: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  mockTag: { fontFamily: 'Inter_500Medium', fontSize: 10, marginTop: 2 },
  rowRight: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  oddVal: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  oddSep: { fontFamily: 'Inter_400Regular', fontSize: 14 },
  closeBtn: {
    margin: 12,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  closeBtnText: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
});

// ── Вспомогательные компоненты ──────────────────────────────────────────────

function SectionTitle({ title, colors }: {
  title: string;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  return (
    <Text style={[sectionStyles.title, { color: colors.foreground }]}>{title}</Text>
  );
}

function StatItem({ label, value, colors, positive, negative }: {
  label: string; value: string;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
  positive?: boolean; negative?: boolean;
}) {
  const color = positive ? colors.positive : negative ? colors.destructive : colors.foreground;
  return (
    <View style={statStyles.item}>
      <Text style={[statStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[statStyles.value, { color }]}>{value}</Text>
    </View>
  );
}

function TotalCard({ title, expected, range, icon, colors }: {
  title: string; expected: string; range: string; icon: 'zap' | 'clock';
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  return (
    <View style={[totalStyles.card, { backgroundColor: colors.muted, borderColor: colors.border }]}>
      <View style={totalStyles.header}>
        <Feather name={icon} size={14} color={colors.primary} />
        <Text style={[totalStyles.title, { color: colors.mutedForeground }]}>{title}</Text>
      </View>
      <Text style={[totalStyles.expected, { color: colors.foreground }]}>{expected}</Text>
      <Text style={[totalStyles.range, { color: colors.mutedForeground }]}>диапазон {range}</Text>
    </View>
  );
}

const totalStyles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, minWidth: 140, gap: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontFamily: 'Inter_500Medium', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6 },
  expected: { fontFamily: 'Inter_700Bold', fontSize: 22, marginTop: 4 },
  range: { fontFamily: 'Inter_400Regular', fontSize: 11 },
});

function DraftScore({ label, radiant, dire, colors }: {
  label: string; radiant: number; dire: number;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  const rPct = Math.round(radiant * 100);
  const dPct = Math.round(dire * 100);
  const rWins = radiant > dire;
  return (
    <View style={draftStyles.row}>
      <Text style={[draftStyles.rScore, { color: rWins ? colors.radiant : colors.mutedForeground }]}>{rPct}%</Text>
      <Text style={[draftStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[draftStyles.dScore, { color: !rWins ? colors.dire : colors.mutedForeground }]}>{dPct}%</Text>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  title: { fontFamily: 'Inter_700Bold', fontSize: 15, marginBottom: 2 },
});

const statStyles = StyleSheet.create({
  item: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
    minWidth: '30%',
    flex: 1,
  },
  label: { fontFamily: 'Inter_400Regular', fontSize: 10, textAlign: 'center' },
  value: { fontFamily: 'Inter_700Bold', fontSize: 15, marginTop: 2, textAlign: 'center' },
});

const draftStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  rScore: { fontFamily: 'Inter_700Bold', fontSize: 14, width: 45, textAlign: 'left' },
  label: { fontFamily: 'Inter_400Regular', fontSize: 13, flex: 1, textAlign: 'center' },
  dScore: { fontFamily: 'Inter_700Bold', fontSize: 14, width: 45, textAlign: 'right' },
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerCenter: { flex: 1, alignItems: 'center', gap: 2 },
  headerTournament: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  headerTeams: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTeam: { fontFamily: 'Inter_700Bold', fontSize: 18 },
  headerVs: { fontFamily: 'Inter_400Regular', fontSize: 14 },
  headerLive: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveLabel: { fontFamily: 'Inter_700Bold', fontSize: 11 },
  gameTimeTxt: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  compareBtn: { padding: 6 },
  mapSubTabs: { flexDirection: 'row', borderRadius: 10, padding: 3, marginBottom: 10 },
  mapSubTab: { flex: 1, borderRadius: 8, paddingVertical: 7, alignItems: 'center' },
  mapSubTabText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  deltaCard: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, marginTop: 6 },
  deltaText: { fontFamily: 'Inter_600SemiBold', fontSize: 13, flex: 1 },
  tabBar: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  scroll: { flex: 1 },
  scrollContent: { padding: 14, gap: 12 },
  section: { gap: 12 },
  card: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 10 },
  bookmakerPicker: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  bookmakerPickerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  bookmakerPickerLabel: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 9,
    letterSpacing: 0.8,
    marginBottom: 1,
  },
  bookmakerPickerName: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  bookmakerPickerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bookmakerPickerOdds: { fontFamily: 'Inter_700Bold', fontSize: 13 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  eventAlert: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
  },
  eventAlertText: { fontFamily: 'Inter_500Medium', fontSize: 12, flex: 1 },
  explanationSummary: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 20 },
  factors: { gap: 0 },
  factorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  factorName: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  factorDesc: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 2 },
  factorImpact: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 4, minWidth: 64 },
  factorImpactText: { fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 0.3 },
  factorMicroLabel: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 8,
    letterSpacing: 0.8,
    opacity: 0.85,
    marginBottom: 1,
  },
  sectionHint: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 4,
    marginTop: -2,
  },
  draftGrid: { flexDirection: 'row', gap: 10 },
  draftSide: { flex: 1, gap: 6 },
  sideLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 12, marginBottom: 4 },
  heroChip: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6 },
  heroName: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  bansRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  banChip: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  banName: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  draftScores: { gap: 2 },
  emptyCard: { alignItems: 'center', gap: 10, paddingVertical: 20 },
  emptyCardText: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
});

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';
import {
  getCachedMatch, getCachedMarkets, rebuildMarketsForBookmaker,
} from '@/services/LiveDataService';
import { MarketCard } from '@/components/MarketCard';
import { TotalsLadder } from '@/components/TotalsLadder';
import { ProbabilityBar } from '@/components/ProbabilityBar';
import { FreshnessIndicator } from '@/components/FreshnessIndicator';
import { logProductEvent } from '@/services/logging/EventLogger';
import type { Match, Market } from '@/types';


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
    totals: { kills: { expected: number; low: number; high: number }; duration: { expectedMin: number; low: number; high: number }; usedMlModel?: boolean };
    teams: { radiant: { id: number; name: string }; dire: { id: number; name: string } };
  };
  const [explain, setExplain] = useState<ExplainResp | null>(null);
  // Предыдущая вероятность Radiant — для расчёта live-дельты «было X% → стало Y%».
  const [prevProbR, setPrevProbR] = useState<number | null>(null);

  // Ищем матч в живом кэше — никаких заглушек, если не нашли = реальная ошибка.
  const cached = id ? getCachedMatch(id) : undefined;
  const match: Match | undefined = cached?.match;
  const baseMarkets: Market[] = cached?.markets ?? getCachedMarkets(id ?? '');

  const availableBookmakers = cached?.availableBookmakers
    ?? baseMarkets[0]?.allBookmakerOdds
    ?? [];

  // Используем глобально выбранный букмекер (из главного экрана)
  const { filters } = useApp();
  const effectiveBookmakerId = filters.bookmaker !== 'none' ? filters.bookmaker : null;
  const selectedBookmaker = effectiveBookmakerId
    ? availableBookmakers.find(b => b.bookmakerId === effectiveBookmakerId) ?? null
    : null;

  // Пересобираем markets с выбранным букмекером
  const markets: Market[] = useMemo(() => {
    if (!cached || !effectiveBookmakerId) return baseMarkets;
    return rebuildMarketsForBookmaker(cached, effectiveBookmakerId);
  }, [cached, effectiveBookmakerId, baseMarkets]);

  useEffect(() => {
    if (match) logProductEvent('match_detail_opened', 'match_detail', { matchId: match.id });
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
        const r = await fetch(`/api/analytics/explain?radiantTeamId=${tR}&direTeamId=${tD}`);
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
  const isBetweenMaps = match.status === 'between_maps';
  const isFinished = match.status === 'finished';

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
  // «Вероятность победы» в Обзоре — берём ТОЛЬКО match_winner или map_winner.
  // Других рынков (totals, first_blood) сюда НЕ подсовываем — их вероятность
  // не относится к победе команды. Если ML не вернул winner — отдельная
  // карточка «Прогноз победителя недоступен» (см. ниже).
  const bestMarket = sortedMarkets.find(m => m.type === 'match_winner')
    ?? sortedMarkets.find(m => m.type === 'map_winner')
    ?? null;

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
              {isLive && snap
                ? `${snap.radiantKills}—${snap.direKills}`
                : isBetweenMaps
                  ? `${match.team1MapsWon} — ${match.team2MapsWon}`
                  : 'vs'}
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
          {isBetweenMaps && (
            <View style={styles.headerLive}>
              <View style={[styles.liveDot, { backgroundColor: colors.primary }]} />
              <Text style={[styles.liveLabel, { color: colors.primary }]}>ПЕРЕРЫВ</Text>
              <Text style={[styles.gameTimeTxt, { color: colors.mutedForeground }]}>
                карта {match.currentMapNumber}
              </Text>
            </View>
          )}
          {isFinished && (
            <View style={styles.headerLive}>
              <Text style={[styles.liveLabel, { color: colors.mutedForeground }]}>МАТЧ ЗАВЕРШЁН</Text>
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
        {(['markets', 'draft', 'overview'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            onPress={() => setActiveTab(tab)}
            style={[
              styles.tab,
              activeTab === tab && { borderBottomColor: colors.primary, borderBottomWidth: 2 },
            ]}
          >
            <Text style={[
              styles.tabText,
              { color: activeTab === tab ? colors.primary : colors.mutedForeground },
            ]}>
              {tab === 'markets' ? 'Прогнозы' : tab === 'draft' ? 'Драфт' : 'Обзор'}
            </Text>
          </TouchableOpacity>
        ))}
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
            {bestMarket ? (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.primary + '55' }]}>
                <SectionTitle title="Вероятность победы" colors={colors} />
                <ProbabilityBar
                  team1Name={match.team1.name}
                  team2Name={match.team2.name}
                  modelProb={bestMarket.prediction.modelProbability}
                  marketProb={bestMarket.bestOdds.fairProbTeam1}
                />
              </View>
            ) : (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <SectionTitle title="Вероятность победы" colors={colors} />
                <Text style={{ color: colors.mutedForeground, fontSize: 13, lineHeight: 18 }}>
                  Прогноз победителя недоступен — у одной из команд нет истории матчей в нашей базе для ML-модели. Никаких math-моделей с дефолтным рейтингом мы не показываем (это были бы фейковые 50/50).
                </Text>
              </View>
            )}

            {markets.length > 1 && (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <SectionTitle title="Популярные ставки" colors={colors} />
                {markets.slice(1, 5).map(mkt => {
                  const pct = Math.round(mkt.prediction.modelProbability * 100);
                  const hasOdds = mkt.bestOdds.oddsTeam1 > 0;
                  const edge = mkt.prediction.edge;
                  const isValue = edge > 0.04;
                  return (
                    <View key={mkt.id} style={[styles.factorRow, { borderBottomColor: colors.border }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.factorName, { color: colors.foreground }]}>{mkt.label}</Text>
                        {hasOdds && (
                          <Text style={[styles.factorName, { color: colors.mutedForeground, fontSize: 11, marginTop: 1 }]}>
                            {mkt.bestOdds.oddsTeam1.toFixed(2)} / {mkt.bestOdds.oddsTeam2.toFixed(2)}
                          </Text>
                        )}
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        {isValue && (
                          <View style={[styles.factorImpact, { backgroundColor: colors.primary + '25', borderColor: colors.primary + '66' }]}>
                            <Text style={[styles.factorImpactText, { color: colors.primary, fontSize: 10 }]}>
                              +{Math.round(edge * 100)}%
                            </Text>
                          </View>
                        )}
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
                    </View>
                  );
                })}
              </View>
            )}

            {isLive && snap && (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <SectionTitle title="Лайв-статистика" colors={colors} />
                <View style={styles.statsGrid}>
                  {/* OpenDota /api/live даёт ТОЛЬКО эти 4 показателя на каждую сторону.
                      Раньше тут показывались xp/выкупы/рошан с заглушечными числами
                      (0k опыта, 5 выкупов, «Убит») — пользователь жаловался на дезу.
                      Поля с null (xp, выкупы, рошан) скрываем полностью; вернём
                      когда подключим источник с полным сейв-стейтом. */}
                  <StatItem label="Убийства Р/Д" value={`${snap.radiantKills} / ${snap.direKills}`} colors={colors} />
                  <StatItem label="Голд Radiant" value={`${(snap.netWorthRadiant / 1000).toFixed(1)}k`} colors={colors} positive />
                  <StatItem label="Голд Dire" value={`${(snap.netWorthDire / 1000).toFixed(1)}k`} colors={colors} />
                  <StatItem label="Башни Radiant" value={String(snap.towersRadiant)} colors={colors} />
                  <StatItem label="Башни Dire" value={String(snap.towersDire)} colors={colors} />
                  <StatItem label="Бараки Radiant" value={String(snap.barracksRadiant)} colors={colors} />
                  <StatItem label="Бараки Dire" value={String(snap.barracksDire)} colors={colors} />
                </View>
                {snap.lastBigEvent && (
                  <View style={[styles.eventAlert, { backgroundColor: colors.warning + '20', borderColor: colors.warning + '55' }]}>
                    <Feather name="zap" size={12} color={colors.warning} />
                    <Text style={[styles.eventAlertText, { color: colors.warning }]}>{snap.lastBigEvent}</Text>
                  </View>
                )}
              </View>
            )}

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
                  {explain.totals.usedMlModel
                    ? 'На основе статистики прошлых матчей этих команд'
                    : 'Данные загружаются'}
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

                <DraftScoreBlock
                  radiantHeroIds={draft.picks.filter(p => p.side === 'radiant').map(p => Number(p.heroId)).filter(n => Number.isInteger(n) && n > 0)}
                  direHeroIds={draft.picks.filter(p => p.side === 'dire').map(p => Number(p.heroId)).filter(n => Number.isInteger(n) && n > 0)}
                  colors={colors}
                />
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
        )}

        {/* РЫНКИ */}
        {activeTab === 'markets' && (
          <View style={styles.section}>

            {sortedMarkets.length > 0 ? (
              sortedMarkets.map(mkt => {
                // Тоталы рендерим лестницей ТБ/ТМ (как у буков), а не П1/П2.
                // Нужны числовые team_id (OpenDota); если их нет — фолбэк на обычный MarketCard.
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
                    return (
                      <TotalsLadder
                        key={mkt.id}
                        radiantTeamId={t1Id}
                        direTeamId={t2Id}
                        type={ladderType}
                        format={fmt}
                        liveCurrent={liveCurrent}
                        liveMinute={liveMinute}
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
                  <Feather name={isFinished ? 'check-circle' : isBetweenMaps ? 'pause-circle' : 'trending-up'} size={28} color={colors.mutedForeground} />
                  <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>
                    {isFinished
                      ? 'Матч завершён. Прогнозы больше не обновляются.'
                      : isBetweenMaps
                        ? 'Прогноз недоступен — перерыв между картами. Появится после старта новой карты.'
                        : 'Аналитика по рынкам загружается'}
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}
      </ScrollView>

    </View>
  );
}


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

// DraftScoreBlock — фетчит реальные synergy/counter/early/late с бэка для
// конкретных 5+5 героев. Бэк возвращает 0..100 (или null если нет данных в
// hero_synergy/hero_matchups/hero_stats). Запрос идёт когда оба драфта полные
// (5 пиков на сторону), иначе показываем «Завершите драфт».
function DraftScoreBlock({ radiantHeroIds, direHeroIds, colors }: {
  radiantHeroIds: number[]; direHeroIds: number[];
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  type Side = { synergy: number | null; counter: number | null; early: number | null; late: number | null };
  const [data, setData] = useState<{ radiant: Side; dire: Side; meta: { synergyPairsFound: number; counterPairsFound: number; heroesResolved: number } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = radiantHeroIds.length === 5 && direHeroIds.length === 5;
  const key = ready ? `${[...radiantHeroIds].sort().join(',')}|${[...direHeroIds].sort().join(',')}` : '';

  useEffect(() => {
    if (!ready) { setData(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    fetch('/api/analytics/draft-score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ radiantHeroIds, direHeroIds }),
    })
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        if (!json?.ok) throw new Error(json?.error ?? 'unknown');
        setData(json);
      })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <SectionTitle title="Draft Score" colors={colors} />
      {!ready ? (
        <View style={styles.emptyCard}>
          <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>
            Расчёт начнётся когда обе команды выберут по 5 героев (сейчас {radiantHeroIds.length}/5 vs {direHeroIds.length}/5).
          </Text>
        </View>
      ) : loading && !data ? (
        <View style={styles.emptyCard}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>Считаю синергию и контрпики…</Text>
        </View>
      ) : error ? (
        <View style={styles.emptyCard}>
          <Text style={[styles.emptyCardText, { color: colors.mutedForeground }]}>Не удалось посчитать: {error}</Text>
        </View>
      ) : data ? (
        <View style={styles.draftScores}>
          <DraftScore100 label="Синергия"     r={data.radiant.synergy} d={data.dire.synergy} colors={colors} />
          <DraftScore100 label="Контрпики"    r={data.radiant.counter} d={data.dire.counter} colors={colors} />
          <DraftScore100 label="Ранняя игра"  r={data.radiant.early}   d={data.dire.early}   colors={colors} />
          <DraftScore100 label="Лейт-гейм"    r={data.radiant.late}    d={data.dire.late}    colors={colors} />
          {data.meta.synergyPairsFound === 0 && (
            <Text style={[styles.sectionHint, { color: colors.mutedForeground, marginTop: 6 }]}>
              Синергия: данных пока нет — таблица hero_synergy ещё не наполнена.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

// DraftScore100 — версия для значений 0..100 (число процентов) с поддержкой null.
function DraftScore100({ label, r, d, colors }: {
  label: string; r: number | null; d: number | null;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  const rTxt = r == null ? '—' : `${Math.round(r)}%`;
  const dTxt = d == null ? '—' : `${Math.round(d)}%`;
  const rWins = r != null && d != null && r > d;
  const dWins = r != null && d != null && d > r;
  return (
    <View style={draftStyles.row}>
      <Text style={[draftStyles.rScore, { color: rWins ? colors.radiant : colors.mutedForeground }]}>{rTxt}</Text>
      <Text style={[draftStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[draftStyles.dScore, { color: dWins ? colors.dire : colors.mutedForeground }]}>{dTxt}</Text>
    </View>
  );
}

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

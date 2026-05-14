/**
 * MarketCard — карточка ставки.
 * Компактный режим: заголовок + 2 плитки.
 * Раскрытый: + метрики + подробные объяснения.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import type { Market } from '@/types';
import { OddsTilesPair } from './OddsTile';
import { FreshnessIndicator } from './FreshnessIndicator';

interface Props {
  market: Market;
  team1Name: string;
  team2Name: string;
  defaultExpanded?: boolean;
  onPress?: () => void;
}

function marketTypeRu(type: string): string {
  const map: Record<string, string> = {
    map_winner: 'Победитель карты',
    match_winner: 'Победитель матча',
    total_kills: 'Тотал убийств',
    total_duration: 'Длительность',
    first_blood: 'Первая кровь',
    first_tower: 'Первая башня',
    first_roshan: 'Первый Рошан',
    kills_handicap: 'Гандикап убийств',
    map_handicap: 'Гандикап карт',
    correct_score: 'Точный счёт',
    net_worth_lead: 'Лидерство NW',
    comeback: 'Камбэк (Live)',
    draft_advantage: 'Дрэфт',
    over_under_maps: 'Тотал карт',
    first_barracks: 'Первые казармы',
  };
  return map[type] ?? type;
}

export function MarketCard({ market, team1Name, team2Name, defaultExpanded = false, onPress }: Props) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const pred = market.prediction;
  const odds = market.bestOdds;
  const isPositiveEV = pred.ev > 0;
  const isTotalMarket = market.type === 'total_kills' || market.type === 'total_duration';
  const t1Label = isTotalMarket ? (market.type === 'total_kills' ? 'Больше 52.5' : 'Больше 43.5 мин') : team1Name;
  const t2Label = isTotalMarket ? (market.type === 'total_kills' ? 'Меньше 52.5' : 'Меньше 43.5 мин') : team2Name;
  const edgePct = ((pred.edge) * 100).toFixed(1);
  const confPct = Math.round(pred.confidence * 100);

  function toggle() {
    setExpanded(e => !e);
  }

  return (
    <View style={[
      styles.card,
      {
        backgroundColor: colors.card,
        borderColor: isPositiveEV ? colors.positive + '55' : colors.border,
        borderLeftWidth: isPositiveEV ? 3 : 1,
        borderLeftColor: isPositiveEV ? colors.positive : colors.border,
      }
    ]}>
      {/* ── ШАПКА ─────────────────────────────── */}
      <TouchableOpacity onPress={toggle} style={styles.header} activeOpacity={0.7}>
        <View style={styles.headerLeft}>
          <Text style={[styles.typeLabel, { color: colors.mutedForeground }]}>
            {marketTypeRu(market.type).toUpperCase()}
          </Text>
          <Text style={[styles.marketLabel, { color: colors.foreground }]}>{market.label}</Text>
        </View>
        <View style={styles.headerRight}>
          {/* TODO(bookmakers): значок «положительной ценности» (бывш. +ОЦ)
              скрыт вместе с букмекерским UI — без реальных кэфов edge=0
              и значок только путал. Вернётся после подключения кэфов. */}
          <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
        </View>
      </TouchableOpacity>

      {/* ── ПЛИТКИ (всегда видны) ──────────────── */}
      <View style={styles.tilesRow}>
        <OddsTilesPair
          team1Label={t1Label}
          team2Label={t2Label}
          modelProbTeam1={pred.modelProbability}
          fairProbTeam1={odds.fairProbTeam1}
          oddsTeam1={odds.oddsTeam1}
          oddsTeam2={odds.oddsTeam2}
          bookmakerName={odds.bookmakerName}
          edgeTeam1={pred.edge}
          evTeam1={pred.ev}
          confidence={pred.confidence}
          forceDetailed={expanded}
          onPressTeam1={onPress}
          onPressTeam2={onPress}
        />
      </View>

      {/* ── РАСКРЫТЫЕ ДЕТАЛИ ──────────────────── */}
      {expanded && (
        <View style={[styles.expandedSection, { borderTopColor: colors.border }]}>

          {/* Сводка метрик */}
          <View style={styles.metricsRow}>
            <MetricPill
              label="Расхождение"
              value={(pred.edge > 0 ? '+' : '') + edgePct + '%'}
              positive={pred.edge > 0}
              colors={colors}
            />
            <MetricPill
              label="Уверенность"
              value={confPct + '%'}
              positive={confPct >= 65}
              colors={colors}
            />
            <FreshnessIndicator ageSeconds={odds.snapshotAge} />
          </View>

          {/* Факторы модели */}
          {pred.explanationJson.topFactors.length > 0 && (
            <View style={[styles.factorsBox, { backgroundColor: colors.muted }]}>
              <Text style={[styles.factorsTitle, { color: colors.mutedForeground }]}>ФАКТОРЫ ПРОГНОЗА</Text>
              {pred.explanationJson.topFactors.slice(0, 3).map((f, i) => (
                <View key={i} style={styles.factorRow}>
                  <View style={[styles.factorBar, {
                    width: Math.max(4, Math.round(f.impact * 120)),
                    backgroundColor: f.impact > 0.08 ? colors.primary : colors.mutedForeground,
                  }]} />
                  <Text style={[styles.factorName, { color: colors.foreground }]}>{f.factor}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Объяснение итога */}
          <Text style={[styles.summary, { color: colors.mutedForeground }]}>
            {pred.explanationJson.summary}
          </Text>

          {/* Кнопка сравнения букмекеров */}
          {market.allBookmakerOdds.length > 1 && (
            <TouchableOpacity onPress={onPress} style={styles.compareBtn}>
              <Text style={[styles.compareText, { color: colors.primary }]}>
                Все букмекеры ({market.allBookmakerOdds.length})
              </Text>
              <Feather name="chevron-right" size={13} color={colors.primary} />
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

function MetricPill({
  label, value, positive, colors,
}: {
  label: string; value: string; positive: boolean;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  const color = positive ? colors.positive : colors.destructive;
  return (
    <View style={[pillStyles.pill, { backgroundColor: color + '15', borderColor: color + '40' }]}>
      <Text style={[pillStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[pillStyles.value, { color }]}>{value}</Text>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  pill: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: 'center',
  },
  label: { fontFamily: 'Inter_400Regular', fontSize: 9, letterSpacing: 0.3 },
  value: { fontFamily: 'Inter_700Bold', fontSize: 13 },
});

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: 14,
    paddingBottom: 8,
    gap: 10,
  },
  headerLeft: { flex: 1, gap: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.2,
  },
  marketLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
  },
  tilesRow: {
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  expandedSection: {
    borderTopWidth: 1,
    padding: 14,
    gap: 10,
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  factorsBox: {
    borderRadius: 8,
    padding: 10,
    gap: 6,
  },
  factorsTitle: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 9,
    letterSpacing: 1,
    marginBottom: 2,
  },
  factorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  factorBar: {
    height: 4,
    borderRadius: 2,
    minWidth: 4,
  },
  factorName: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
  },
  summary: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    lineHeight: 18,
  },
  compareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-end',
  },
  compareText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
  },
});

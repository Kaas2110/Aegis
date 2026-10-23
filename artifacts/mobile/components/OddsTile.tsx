/**
 * OddsTile — лаконичная плитка коэффициента в стиле букмекерского приложения.
 *
 * Режим без БК (odds=0):
 *   ┌──────────────┐
 *   │ П1  Team R.  │
 *   │    [  67%  ] │
 *   └──────────────┘
 *
 * Режим с БК (odds>0):
 *   ┌─────────────────────┐
 *   │ П1  Team R.         │
 *   │ [ 67% ] │ [1.87 BK] │
 *   └─────────────────────┘
 *
 * Подробный режим: + строка с ОЦ и БК
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';

interface OddsTileProps {
  shortLabel: string;          // П1 / П2
  outcomeLabel: string;        // Team Liquid / Больше 52.5
  displayPercent?: number;
  modelProbability: number;    // 0..1
  marketProbability: number;   // 0..1 (для подробной аналитики)
  odds: number;
  bookmakerName: string;
  edge: number | null;                // прогноз − рынок
  ev: number | null;                  // ожидаемая ценность
  confidence: number | null;          // 0..1
  forceDetailed?: boolean;     // принудительно показать подробности (на экране матча)
  onPress?: () => void;
}

export function OddsTile({
  shortLabel, outcomeLabel, modelProbability,
  odds, bookmakerName, ev, displayPercent,
  onPress,
}: OddsTileProps) {
  const colors = useColors();
  const modelPct = displayPercent ?? Math.round(modelProbability * 100);
  const hasOdds = odds > 0;
  // «Уверенный» прогноз (≥60%) выделяем сильнее золотом — Dota inventory vibe.
  const isStrong = modelPct >= 60;
  // Положительный EV при наличии кэфа: зелёная подсветка коэффициента
  const isPositiveEV = hasOdds && ev !== null && ev > 0;

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[
        styles.root,
        {
          backgroundColor: isStrong ? colors.goldDeep + '55' : colors.card,
          borderColor: isStrong ? colors.primary : colors.borderGold + '66',
        },
      ]}
    >
      <View style={styles.topRow}>
        <View style={[styles.labelBox, { backgroundColor: colors.muted }]}>
          <Text style={[styles.labelText, { color: colors.mutedForeground }]}>{shortLabel}</Text>
        </View>
        <Text
          style={[styles.outcome, { color: colors.mutedForeground }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {outcomeLabel}
        </Text>
      </View>

      <View style={styles.mainRow}>
        {/* Вероятность модели — всегда */}
        <LinearGradient
          colors={isStrong
            ? [colors.goldHi, colors.primary, colors.goldLo]
            : [colors.goldDeep, colors.goldDeep + 'AA']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[styles.probBadge, hasOdds && styles.probBadgeNarrow]}
        >
          <Text
            style={[
              styles.probability,
              { color: isStrong ? colors.primaryForeground : colors.primary },
              hasOdds && styles.probabilityNarrow,
            ]}
            numberOfLines={1}
          >
            {modelPct}%
          </Text>
        </LinearGradient>

        {/* Кэф букмекера — только когда есть реальные данные */}
        {hasOdds && (
          <View
            style={[
              styles.oddsBadge,
              {
                backgroundColor: isPositiveEV
                  ? colors.radiant + '22'
                  : colors.muted,
                borderColor: isPositiveEV
                  ? colors.radiant + '66'
                  : colors.border,
              },
            ]}
          >
            <Text
              style={[
                styles.oddsValue,
                { color: isPositiveEV ? colors.radiant : colors.foreground },
              ]}
              numberOfLines={1}
            >
              {odds.toFixed(2)}
            </Text>
            {bookmakerName && bookmakerName !== 'Нет данных' && (
              <Text
                style={[styles.oddsSource, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {bookmakerName}
              </Text>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── ПАРА ПЛИТОК ──────────────────────────────────────────────────────────

interface OddsTilesPairProps {
  team1Label: string;
  team2Label: string;
  modelProbTeam1: number;
  fairProbTeam1: number;
  oddsTeam1: number;
  oddsTeam2: number;
  bookmakerName: string;
  edgeTeam1: number | null;
  evTeam1: number | null;
  confidence: number | null;
  forceDetailed?: boolean;
  onPressTeam1?: () => void;
  onPressTeam2?: () => void;
}

export function OddsTilesPair({
  team1Label, team2Label, modelProbTeam1, fairProbTeam1,
  oddsTeam1, oddsTeam2, bookmakerName, edgeTeam1, evTeam1,
  confidence, forceDetailed, onPressTeam1, onPressTeam2,
}: OddsTilesPairProps) {
  const modelProbTeam2 = 1 - modelProbTeam1;
  const fairProbTeam2 = 1 - fairProbTeam1;
  const edgeTeam2 = edgeTeam1 === null ? null : modelProbTeam2 - fairProbTeam2;
  const evTeam2 = evTeam1 === null ? null : modelProbTeam2 * oddsTeam2 - 1;

  return (
    <View style={pairStyles.row}>
      <View style={pairStyles.tile}>
        <OddsTile
          shortLabel="П1"
          outcomeLabel={team1Label}
          modelProbability={modelProbTeam1}
          marketProbability={fairProbTeam1}
          odds={oddsTeam1}
          bookmakerName={bookmakerName}
          edge={edgeTeam1}
          ev={evTeam1}
          confidence={confidence}
          forceDetailed={forceDetailed}
          onPress={onPressTeam1}
        />
      </View>
      <View style={pairStyles.tile}>
        <OddsTile
          shortLabel="П2"
          outcomeLabel={team2Label}
          displayPercent={100 - Math.round(modelProbTeam1 * 100)}
          modelProbability={modelProbTeam2}
          marketProbability={fairProbTeam2}
          odds={oddsTeam2}
          bookmakerName={bookmakerName}
          edge={edgeTeam2}
          ev={evTeam2}
          confidence={confidence}
          forceDetailed={forceDetailed}
          onPress={onPressTeam2}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderRadius: 3,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 8,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  labelBox: {
    borderRadius: 2,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  labelText: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 10,
    letterSpacing: 0.8,
  },
  outcome: {
    fontFamily: 'Forum_400Regular',
    fontSize: 13,
    flex: 1,
    letterSpacing: 0.3,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 6,
  },
  probBadge: {
    flex: 1,
    borderRadius: 3,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  probBadgeNarrow: {
    flex: 0,
    minWidth: 60,
    paddingHorizontal: 10,
  },
  probability: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 26,
    letterSpacing: -0.4,
  },
  probabilityNarrow: {
    fontSize: 20,
  },
  oddsBadge: {
    flex: 1,
    borderRadius: 3,
    borderWidth: 1,
    paddingVertical: 6,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  oddsValue: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 20,
    letterSpacing: -0.3,
  },
  oddsSource: {
    fontFamily: 'Inter_500Medium',
    fontSize: 9,
    letterSpacing: 0.3,
  },
});

const pairStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1 },
});

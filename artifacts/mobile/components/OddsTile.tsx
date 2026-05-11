/**
 * OddsTile — лаконичная плитка коэффициента в стиле букмекерского приложения.
 *
 * Простой режим:
 *   ┌──────────────┐
 *   │ П1  Team R.  │
 *   │ 67%    2.00  │
 *   └──────────────┘
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
  modelProbability: number;    // 0..1
  marketProbability: number;   // 0..1 (для подробной аналитики)
  odds: number;
  bookmakerName: string;
  edge: number;                // прогноз − рынок
  ev: number;                  // ожидаемая ценность
  confidence: number;          // 0..1
  forceDetailed?: boolean;     // принудительно показать подробности (на экране матча)
  onPress?: () => void;
}

export function OddsTile({
  shortLabel, outcomeLabel, modelProbability,
  onPress,
}: OddsTileProps) {
  const colors = useColors();
  // TODO(bookmakers): по запросу пользователя оставлена только вероятность модели.
  // Кэф, EV/ОЦ и название букмекера скрыты до подключения реальных кэфов.
  const modelPct = Math.round(modelProbability * 100);
  // «Уверенный» прогноз (≥60%) выделяем сильнее золотом — Dota inventory vibe.
  const isStrong = modelPct >= 60;

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
        <LinearGradient
          colors={isStrong
            ? [colors.goldHi, colors.primary, colors.goldLo]
            : [colors.goldDeep, colors.goldDeep + 'AA']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={styles.probBadge}
        >
          <Text
            style={[
              styles.probability,
              { color: isStrong ? colors.primaryForeground : colors.primary },
            ]}
            numberOfLines={1}
          >
            {modelPct}%
          </Text>
        </LinearGradient>
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
  edgeTeam1: number;
  evTeam1: number;
  confidence: number;
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
  const edgeTeam2 = modelProbTeam2 - fairProbTeam2;
  const evTeam2 = modelProbTeam2 * (oddsTeam2 - 1) - (1 - modelProbTeam2);

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
    borderRadius: 3, // угловатый Dota-стиль
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
    justifyContent: 'center',
  },
  probBadge: {
    flex: 1,
    borderRadius: 3,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  probability: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 26,
    letterSpacing: -0.4,
  },
});

const pairStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1 },
});

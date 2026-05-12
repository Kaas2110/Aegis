/**
 * OddsTile — лаконичная плитка коэффициента в стиле букмекерского приложения.
 *
 * Два режима отображения, выбор зависит от того, выбран ли букмекер
 * (передаётся через `showOdds` — это `filters.bookmaker !== 'none'`):
 *
 *   showOdds=false (режим «Без ставок»):
 *     ┌──────────────┐
 *     │ П1  Team R.  │
 *     │     67%      │   ← большой % модели в центре
 *     └──────────────┘
 *
 *   showOdds=true (выбран Fonbet / PARI / …):
 *     ┌──────────────┐
 *     │ П1  Team R.  │
 *     │ 67%    2.00  │   ← % модели слева, кэф бука справа
 *     └──────────────┘
 *
 * Клик по плитке (если onPress задан) открывает экран матча с подробной
 * аналитикой (ОЦ, EV, факторы модели).
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';

interface OddsTileProps {
  shortLabel: string;          // П1 / П2
  outcomeLabel: string;        // Team Liquid / Больше 52.5
  modelProbability: number;    // 0..1
  odds: number;
  /** Если true — показываем коэф бука рядом с %. Иначе — только %. */
  showOdds?: boolean;
  onPress?: () => void;
}

export function OddsTile({
  shortLabel, outcomeLabel, modelProbability, odds, showOdds = false, onPress,
}: OddsTileProps) {
  const colors = useColors();
  const modelPct = Math.round(modelProbability * 100);
  // «Уверенный» прогноз (≥60%) выделяем сильнее золотом — Dota inventory vibe.
  const isStrong = modelPct >= 60;
  const hasOdds = showOdds && Number.isFinite(odds) && odds > 1;

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

      {hasOdds ? (
        // Режим с букмекером: % модели слева, коэф справа.
        // Цветовая логика: % акцентный (золото), кэф нейтральный, чтобы
        // визуально считывался прогноз модели, а не цифра бука.
        <View style={styles.dualRow}>
          <View style={[styles.probHalf, {
            backgroundColor: isStrong ? colors.primary : colors.goldDeep + 'AA',
          }]}>
            <Text style={[styles.probabilitySmall, {
              color: isStrong ? colors.primaryForeground : colors.primary,
            }]}>
              {modelPct}%
            </Text>
          </View>
          <View style={[styles.oddsHalf, { borderColor: colors.borderGold + '66' }]}>
            <Text style={[styles.oddsValue, { color: colors.foreground }]}>
              {odds.toFixed(2)}
            </Text>
          </View>
        </View>
      ) : (
        // Режим без ставок: чистая большая плитка вероятности.
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
      )}
    </TouchableOpacity>
  );
}

// ── ПАРА ПЛИТОК ──────────────────────────────────────────────────────────

interface OddsTilesPairProps {
  team1Label: string;
  team2Label: string;
  modelProbTeam1: number;
  oddsTeam1: number;
  oddsTeam2: number;
  /** true — показываем кэфы рядом с %. false — только %. */
  showOdds?: boolean;
  onPressTeam1?: () => void;
  onPressTeam2?: () => void;
}

export function OddsTilesPair({
  team1Label, team2Label, modelProbTeam1,
  oddsTeam1, oddsTeam2, showOdds, onPressTeam1, onPressTeam2,
}: OddsTilesPairProps) {
  const modelProbTeam2 = 1 - modelProbTeam1;

  return (
    <View style={pairStyles.row}>
      <View style={pairStyles.tile}>
        <OddsTile
          shortLabel="П1"
          outcomeLabel={team1Label}
          modelProbability={modelProbTeam1}
          odds={oddsTeam1}
          showOdds={showOdds}
          onPress={onPressTeam1}
        />
      </View>
      <View style={pairStyles.tile}>
        <OddsTile
          shortLabel="П2"
          outcomeLabel={team2Label}
          modelProbability={modelProbTeam2}
          odds={oddsTeam2}
          showOdds={showOdds}
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
  // Двухколоночный режим (с кэфом)
  dualRow: {
    flexDirection: 'row',
    gap: 4,
  },
  probHalf: {
    flex: 1,
    borderRadius: 3,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  probabilitySmall: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 18,
    letterSpacing: -0.2,
  },
  oddsHalf: {
    flex: 1,
    borderRadius: 3,
    borderWidth: 1,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  oddsValue: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 18,
    letterSpacing: -0.2,
  },
});

const pairStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1 },
});

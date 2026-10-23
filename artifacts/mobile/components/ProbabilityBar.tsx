import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface Props {
  team1Name: string;
  team2Name: string;
  modelProb: number;
  marketProb: number;
  showMarket?: boolean;
}

export function ProbabilityBar({ team1Name, team2Name, modelProb, marketProb, showMarket = true }: Props) {
  const colors = useColors();

  const t1ModelPct = Math.round(modelProb * 100);
  const t2ModelPct = 100 - t1ModelPct;

  return (
    <View style={styles.container}>
      <View style={styles.labels}>
        <Text style={[styles.teamLabel, { color: colors.radiant }]} numberOfLines={1}>{team1Name}</Text>
        <Text style={[styles.probLabel, { color: colors.foreground }]}>{t1ModelPct}% — {t2ModelPct}%</Text>
        <Text style={[styles.teamLabel, { color: colors.dire, textAlign: 'right' }]} numberOfLines={1}>{team2Name}</Text>
      </View>

      <View style={[styles.track, { backgroundColor: colors.muted }]}>
        <View style={[styles.fill, { width: `${t1ModelPct}%`, backgroundColor: colors.radiant }]} />
      </View>

      {showMarket && (
        <View style={styles.marketRow}>
          <Text style={[styles.marketLabel, { color: colors.mutedForeground }]}>
            Рынок: {Math.round(marketProb * 100)}% — {100 - Math.round(marketProb * 100)}%
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6 },
  labels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  teamLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 12, flex: 1 },
  probLabel: { fontFamily: 'Inter_700Bold', fontSize: 14, textAlign: 'center', flex: 1 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  marketRow: { alignItems: 'center' },
  marketLabel: { fontFamily: 'Inter_400Regular', fontSize: 11 },
});

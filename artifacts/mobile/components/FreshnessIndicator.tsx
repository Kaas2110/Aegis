import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface Props {
  ageSeconds: number;
  showLabel?: boolean;
}

export function FreshnessIndicator({ ageSeconds, showLabel = true }: Props) {
  const colors = useColors();

  let color: string;
  let label: string;

  if (ageSeconds <= 60) {
    color = colors.positive;
    label = ageSeconds < 5 ? 'только что' : `${ageSeconds}с назад`;
  } else if (ageSeconds <= 120) {
    color = colors.warning;
    label = `${Math.round(ageSeconds / 60)}м назад`;
  } else if (ageSeconds <= 300) {
    color = colors.stale;
    label = `${Math.round(ageSeconds / 60)}м назад ⚠`;
  } else {
    color = colors.mutedForeground;
    label = 'устаревшие данные';
  }

  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      {showLabel && <Text style={[styles.text, { color }]}>{label}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontFamily: 'Inter_400Regular', fontSize: 11 },
});

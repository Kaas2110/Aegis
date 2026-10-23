import React, {useEffect, useState} from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface Props {
  ageSeconds: number;
  at?: string;
  showLabel?: boolean;
}

export function FreshnessIndicator({ ageSeconds: initialAge, at, showLabel = true }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),15000);return()=>clearInterval(timer);},[]);
  const ts=at?Date.parse(at):NaN;
  const ageSeconds=at ? (Number.isFinite(ts)&&ts<=now+5000?Math.max(0,Math.floor((now-ts)/1000)):Infinity) : Math.floor(initialAge);
  const colors = useColors();

  let color: string;
  let label: string;

  if (!Number.isFinite(ageSeconds)) {
    color = colors.mutedForeground; label = 'Давность неизвестна';
  } else if (ageSeconds <= 60) {
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

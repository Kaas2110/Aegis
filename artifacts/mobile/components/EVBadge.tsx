import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface Props {
  ev: number;
  size?: 'sm' | 'md';
}

export function EVBadge({ ev, size = 'md' }: Props) {
  const colors = useColors();
  const isPositive = ev > 0;
  const color = isPositive ? colors.positive : colors.destructive;
  const label = (isPositive ? '+' : '') + (ev * 100).toFixed(1) + '%';

  return (
    <View style={[styles.badge, { backgroundColor: color + '22', borderColor: color }]}>
      <Text style={[styles.label, { color, fontSize: size === 'sm' ? 9 : 11 }]}>ОЦ</Text>
      <Text style={[styles.value, { color, fontSize: size === 'sm' ? 10 : 12 }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  label: {
    fontFamily: 'Inter_500Medium',
    opacity: 0.7,
  },
  value: {
    fontFamily: 'Inter_700Bold',
  },
});

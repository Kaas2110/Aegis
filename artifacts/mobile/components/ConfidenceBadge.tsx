import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface Props {
  confidence: number;
  size?: 'sm' | 'md';
}

export function ConfidenceBadge({ confidence, size = 'md' }: Props) {
  const colors = useColors();
  const isHigh = confidence >= 70;
  const isMid = confidence >= 50 && confidence < 70;
  const color = isHigh ? colors.positive : isMid ? colors.warning : colors.mutedForeground;

  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: color + '22' }]}>
      <Text style={[styles.text, { color, fontSize: size === 'sm' ? 10 : 11 }]}>
        {confidence}%
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignItems: 'center',
  },
  text: {
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.3,
  },
});

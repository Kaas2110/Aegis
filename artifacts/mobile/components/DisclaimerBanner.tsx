import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

export function DisclaimerBanner() {
  const colors = useColors();
  return (
    <View style={[styles.container, { backgroundColor: colors.muted, borderColor: colors.warning + '55', borderLeftColor: colors.warning }]}>
      <Text style={[styles.text, { color: colors.mutedForeground }]}>
        Прогнозы являются аналитической оценкой вероятностей и не гарантируют результат. Ставки связаны с риском потери денег.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 8,
    borderWidth: 1,
    borderLeftWidth: 3,
    padding: 10,
    marginHorizontal: 16,
  },
  text: {
    fontFamily: 'Inter_400Regular',
    fontSize: 11,
    lineHeight: 16,
  },
});

import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useApp } from '@/context/AppContext';

const BOOKMAKER_OPTIONS = [
  { label: 'Все', value: 'all' },
  { label: 'Fonbet', value: 'fonbet' },
  { label: 'Лига Ставок', value: 'liga_stavok' },
  { label: 'PARI', value: 'pari' },
  { label: 'BetBoom', value: 'betboom' },
  { label: '1xStavka', value: 'x1stavka' },
  { label: 'Olimp', value: 'olimp' },
  { label: 'Mock', value: 'mock' },
] as const;

const ODDS_OPTIONS = [
  { label: '1.2+', value: 1.2 },
  { label: '1.5+', value: 1.5 },
  { label: '2.0+', value: 2.0 },
  { label: '3.0+', value: 3.0 },
] as const;

const MODE_OPTIONS = [
  { label: 'Все', value: 'all' },
  { label: 'Лайв', value: 'live' },
  { label: 'До матча', value: 'prematch' },
] as const;

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? colors.primary : colors.muted, borderColor: active ? colors.primary : colors.border }]}
    >
      <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.mutedForeground }]}>{label}</Text>
    </TouchableOpacity>
  );
}

export function FilterBar() {
  const colors = useColors();
  const { filters, updateFilters } = useApp();

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        <View style={styles.group}>
          <Text style={[styles.groupLabel, { color: colors.mutedForeground }]}>Режим</Text>
          {MODE_OPTIONS.map(o => (
            <Chip key={o.value} label={o.label} active={filters.mode === o.value} onPress={() => updateFilters({ mode: o.value })} />
          ))}
        </View>
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
        <View style={styles.group}>
          <Text style={[styles.groupLabel, { color: colors.mutedForeground }]}>Коэф.</Text>
          {ODDS_OPTIONS.map(o => (
            <Chip key={o.value} label={o.label} active={filters.minOdds === o.value} onPress={() => updateFilters({ minOdds: o.value })} />
          ))}
        </View>
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
        <View style={styles.group}>
          <Text style={[styles.groupLabel, { color: colors.mutedForeground }]}>БК</Text>
          {BOOKMAKER_OPTIONS.map(o => (
            <Chip key={o.value} label={o.label} active={filters.bookmaker === o.value} onPress={() => updateFilters({ bookmaker: o.value })} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: 8 },
  scroll: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  group: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  groupLabel: { fontFamily: 'Inter_400Regular', fontSize: 11, marginRight: 2 },
  chip: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  chipText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
  separator: { width: 1, height: 24, marginHorizontal: 4 },
});

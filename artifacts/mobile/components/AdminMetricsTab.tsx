/**
 * Вкладка «Метрики» в админ-экране.
 * Показывает агрегаты качества прематч-предсказаний из таблицы prematch_outcomes.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fetchAdminMetrics, type ModelMetrics } from '@/services/AdminApi';

export function AdminMetricsTab() {
  const colors = useColors();
  const [data, setData] = useState<ModelMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setData(await fetchAdminMetrics());
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  if (loading) return <View style={{ padding: 20, alignItems: 'center' }}><ActivityIndicator color={colors.primary} /></View>;
  if (err) {
    return (
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.warning + '55' }]}>
        <Text style={[styles.title, { color: colors.warning }]}>Не удалось загрузить</Text>
        <Text style={[styles.text, { color: colors.mutedForeground }]}>{err}</Text>
        <TouchableOpacity onPress={load} style={[styles.btn, { backgroundColor: colors.primary }]}>
          <Text style={[styles.btnText, { color: colors.primaryForeground }]}>Повторить</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!data) return null;

  const accPct = data.accuracy != null ? `${(data.accuracy * 100).toFixed(1)}%` : '—';
  const brier = data.brierScore != null ? data.brierScore.toFixed(3) : '—';

  return (
    <View style={{ gap: 12 }}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.primary + '44' }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Out-of-sample точность модели</Text>
        <Text style={[styles.text, { color: colors.mutedForeground }]}>
          Считается по прематч-предсказаниям, для которых уже известен реальный исход (таблица prematch_outcomes). Не путать с train/test точностью при обучении модели — это РЕАЛЬНАЯ точность в проде.
        </Text>
        <View style={styles.bigRow}>
          <View style={styles.bigCell}>
            <Text style={[styles.bigVal, { color: colors.primary }]}>{accPct}</Text>
            <Text style={[styles.bigLab, { color: colors.mutedForeground }]}>Accuracy</Text>
          </View>
          <View style={styles.bigCell}>
            <Text style={[styles.bigVal, { color: colors.primary }]}>{brier}</Text>
            <Text style={[styles.bigLab, { color: colors.mutedForeground }]}>Brier ↓</Text>
          </View>
          <View style={styles.bigCell}>
            <Text style={[styles.bigVal, { color: colors.foreground }]}>{data.resolved}</Text>
            <Text style={[styles.bigLab, { color: colors.mutedForeground }]}>Резолвов</Text>
          </View>
          <View style={styles.bigCell}>
            <Text style={[styles.bigVal, { color: colors.warning }]}>{data.pending}</Text>
            <Text style={[styles.bigLab, { color: colors.mutedForeground }]}>Ждут</Text>
          </View>
        </View>
      </View>

      {data.byModel.length > 0 && (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>По версиям модели</Text>
          {data.byModel.map(m => (
            <View key={m.modelVersion} style={[styles.modelRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.modelVersion, { color: colors.foreground }]} numberOfLines={1}>{m.modelVersion}</Text>
              <Text style={[styles.modelStat, { color: colors.primary }]}>{(m.accuracy * 100).toFixed(1)}%</Text>
              <Text style={[styles.modelStat, { color: colors.mutedForeground }]}>{m.brierScore.toFixed(3)}</Text>
              <Text style={[styles.modelStat, { color: colors.mutedForeground }]}>{m.resolved}</Text>
            </View>
          ))}
          <View style={styles.modelLegend}>
            <Text style={[styles.legendText, { color: colors.mutedForeground }]}>версия · acc · brier · n</Text>
          </View>
        </View>
      )}

      {data.recent.length > 0 && (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.foreground }]}>Последние резолвы</Text>
          {data.recent.slice(0, 10).map(r => {
            const predRadiant = r.predictedRadiantWinProb >= 0.5;
            const correct = r.actualRadiantWin !== null && predRadiant === r.actualRadiantWin;
            return (
              <View key={r.matchId} style={[styles.recentRow, { borderBottomColor: colors.border }]}>
                <Feather
                  name={correct ? 'check-circle' : 'x-circle'}
                  size={14}
                  color={correct ? colors.positive : colors.destructive}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.recentTeams, { color: colors.foreground }]} numberOfLines={1}>
                    {r.radiantName ?? '—'} vs {r.direName ?? '—'}
                  </Text>
                  <Text style={[styles.recentMeta, { color: colors.mutedForeground }]}>
                    Прогноз R: {(r.predictedRadiantWinProb * 100).toFixed(0)}% · Победил: {r.actualRadiantWin ? 'R' : 'D'}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      <TouchableOpacity onPress={load} style={[styles.btnGhost, { borderColor: colors.border }]}>
        <Feather name="refresh-cw" size={14} color={colors.mutedForeground} />
        <Text style={[styles.btnGhostText, { color: colors.mutedForeground }]}>Обновить</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  text: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 18 },
  bigRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  bigCell: { flex: 1, minWidth: 70, alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 8, paddingVertical: 10 },
  bigVal: { fontFamily: 'Inter_700Bold', fontSize: 20 },
  bigLab: { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 2 },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1 },
  modelVersion: { flex: 2, fontFamily: 'Inter_500Medium', fontSize: 12 },
  modelStat: { flex: 1, fontFamily: 'Inter_700Bold', fontSize: 12, textAlign: 'right' },
  modelLegend: { paddingTop: 4 },
  legendText: { fontFamily: 'Inter_400Regular', fontSize: 10, textAlign: 'right' },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1 },
  recentTeams: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  recentMeta: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  btn: { padding: 12, borderRadius: 10, alignItems: 'center' },
  btnText: { fontFamily: 'Inter_600SemiBold', fontSize: 13 },
  btnGhost: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, borderRadius: 8, borderWidth: 1 },
  btnGhostText: { fontFamily: 'Inter_500Medium', fontSize: 12 },
});

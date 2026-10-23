import { apiFetch } from '../../../lib/api';
// Экран сводки матча (T9). Маршрут: /match/summary/<matchId>.
// Использует /api/analytics/match-summary — prematch outcome, калибровка,
// последние market predictions, агрегат live snapshots.
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { logProductEvent } from '@/services/logging/EventLogger';
import { extractNumericMatchId } from '@/lib/matchId';



type Outcome = {
  modelVersion: string | null;
  radiantName: string | null; direName: string | null; leagueName: string | null;
  predictedRadiantWinProb: number | null; predictedConfidence: number | null;
  actualRadiantWin: boolean | null;
  actualScore: { radiant: number; dire: number } | null;
  actualDurationSec: number | null;
  predictedAt: string | null; resolvedAt: string | null;
} | null;

type Market = {
  marketType: string; modelVersion: string;
  probTeam1: number | null; probTeam2: number | null; at: string;
};

type SummaryResp = {
  matchId: number;
  outcome: Outcome;
  calibration: { hit: boolean; delta: number } | null;
  markets: Market[];
  liveSnapshots: {
    firstAt: string | null; lastAt: string | null;
    lastGameTimeSec: number | null; count: number;
  } | null;
};

const marketRu: Record<string, string> = {
  match_winner: 'Победитель матча',
  map_winner: 'Победитель карты',
  first_blood: 'First Blood',
  total_kills: 'Тотал убийств',
  total_duration: 'Тотал длительности',
  kills_handicap: 'Фора по убийствам',
  map_handicap: 'Фора по картам',
  correct_score: 'Точный счёт',
  over_under_maps: 'Тотал карт',
};

function fmtPct(v: number | null, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtSec(s: number | null): string {
  if (s == null || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.abs(s) % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
function fmtAt(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }); }
  catch { return iso; }
}

export default function MatchSummaryScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  // F5 (Phase 9): id из роутера может прийти как канонический `od_NNN`/`up_NNN`
  // (от MatchCard caller) или уже как чистое число (от стрипа в caller).
  // Helper принимает оба формата и отсеивает фолбэк-синтетику.
  const matchId = extractNumericMatchId(id) ?? (() => {
    const n = Number(id);
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const [data, setData] = useState<SummaryResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (matchId == null) {
      setError(`Некорректный ID матча (получено: ${String(id)})`);
      setLoading(false);
      return;
    }
    logProductEvent('match_summary_opened', 'match_summary', { matchId });
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/api/analytics/match-summary?matchId=${matchId}`)
      .then(r => r.json())
      .then((j: SummaryResp & { error?: string }) => {
        if (cancelled) return;
        if (j.error) setError(j.error);
        else setData(j);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [matchId]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, {
        paddingTop: topPad + 8, backgroundColor: colors.card, borderBottomColor: colors.border,
      }]}>
        <TouchableOpacity
          onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); }}
          style={styles.backBtn}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Сводка матча</Text>
      </View>

      {loading && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={{ color: colors.mutedForeground, marginTop: 10 }}>Загрузка…</Text>
        </View>
      )}

      {!loading && error && (
        <View style={styles.center}>
          <Feather name="alert-circle" size={32} color={colors.mutedForeground} />
          <Text style={{ color: colors.foreground, marginTop: 10 }}>{error}</Text>
        </View>
      )}

      {!loading && !error && data && (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40, gap: 14 }}>
          {/* F5 (Phase 9): короткий онбординг-блок — что показывает этот экран.
              Без него секции «Прогноз до матча / Факт / Калибровка / Live» выглядят
              как разрозненный отчёт. */}
          <View style={[styles.section, { backgroundColor: colors.muted, borderColor: colors.border }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Feather name="info" size={14} color={colors.mutedForeground} />
              <Text style={[styles.sectionTitle, { color: colors.foreground, fontSize: 14 }]}>
                О чём эта сводка
              </Text>
            </View>
            <Text style={[styles.hint, { color: colors.mutedForeground, lineHeight: 18 }]}>
              Здесь собран разбор матча: каким был прогноз ДО старта,
              чем матч закончился на самом деле, насколько прогноз ошибся
              (калибровка), какие маркеты были на момент прогноза и сколько
              live-снапшотов удалось снять. Полезно, чтобы понять — почему
              прогноз промахнулся, или наоборот, на чём он выиграл.
            </Text>
          </View>

          {/* Prematch outcome */}
          {data.outcome ? (
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Прогноз до матча</Text>
              {(data.outcome.radiantName || data.outcome.direName) ? (
                <Text style={[styles.bigLine, { color: colors.foreground }]}>
                  {data.outcome.radiantName ?? 'Команда Radiant не указана'}
                  {' vs '}
                  {data.outcome.direName ?? 'Команда Dire не указана'}
                </Text>
              ) : (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  Команды не указаны в записи прогноза.
                </Text>
              )}
              {data.outcome.leagueName && (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  Лига: {data.outcome.leagueName}
                </Text>
              )}
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Вероятность Radiant</Text>
                <Text style={[styles.kvVal, { color: colors.primary }]}>
                  {fmtPct(data.outcome.predictedRadiantWinProb)}
                </Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Уверенность прогноза</Text>
                <Text style={[styles.kvVal, { color: colors.foreground }]}>
                  {fmtPct(data.outcome.predictedConfidence)}
                </Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Версия прогноза</Text>
                <Text style={[styles.kvValSmall, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {data.outcome.modelVersion ?? '—'}
                </Text>
              </View>
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                Прогноз снят: {fmtAt(data.outcome.predictedAt)}
              </Text>
            </View>
          ) : (
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Прогноз до матча</Text>
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                Pre-match прогноз не сохранён в базе.
              </Text>
            </View>
          )}

          {/* Actual outcome + calibration */}
          {data.outcome?.actualRadiantWin != null && (
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Факт</Text>
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Победитель</Text>
                <Text style={[styles.kvVal, {
                  color: data.outcome.actualRadiantWin ? colors.radiant : colors.dire,
                }]}>
                  {data.outcome.actualRadiantWin ? 'Radiant' : 'Dire'}
                </Text>
              </View>
              {data.outcome.actualScore && (
                <View style={styles.kvRow}>
                  <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Счёт</Text>
                  <Text style={[styles.kvVal, { color: colors.foreground }]}>
                    {data.outcome.actualScore.radiant} – {data.outcome.actualScore.dire}
                  </Text>
                </View>
              )}
              {data.outcome.actualDurationSec != null && (
                <View style={styles.kvRow}>
                  <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Длительность</Text>
                  <Text style={[styles.kvVal, { color: colors.foreground }]}>
                    {fmtSec(data.outcome.actualDurationSec)}
                  </Text>
                </View>
              )}
              {data.calibration && (
                <View style={styles.kvRow}>
                  <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Калибровка</Text>
                  <Text style={[styles.kvVal, {
                    color: data.calibration.hit ? colors.radiant : colors.dire,
                  }]}>
                    {data.calibration.hit ? '✓ Попадание' : '✗ Промах'} (Δ {fmtPct(data.calibration.delta)})
                  </Text>
                </View>
              )}
              {data.outcome.resolvedAt && (
                <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                  Резолв: {fmtAt(data.outcome.resolvedAt)}
                </Text>
              )}
            </View>
          )}

          {/* Markets */}
          {data.markets.length > 0 && (
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
                Прогнозы по рынкам ({data.markets.length})
              </Text>
              {data.markets.map(m => (
                <View key={m.marketType} style={styles.marketRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.marketName, { color: colors.foreground }]}>
                      {marketRu[m.marketType] ?? m.marketType}
                    </Text>
                    <Text style={[styles.marketMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {m.modelVersion}
                    </Text>
                  </View>
                  <View style={styles.marketProbs}>
                    <Text style={[styles.marketProb, { color: colors.radiant }]}>
                      {fmtPct(m.probTeam1, 1)}
                    </Text>
                    <Text style={[styles.marketProb, { color: colors.dire }]}>
                      {fmtPct(m.probTeam2, 1)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          {/* Live snapshots */}
          {data.liveSnapshots && data.liveSnapshots.count > 0 && (
            <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Live-наблюдения</Text>
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Снимков</Text>
                <Text style={[styles.kvVal, { color: colors.foreground }]}>
                  {data.liveSnapshots.count}
                </Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Первый</Text>
                <Text style={[styles.kvValSmall, { color: colors.mutedForeground }]}>
                  {fmtAt(data.liveSnapshots.firstAt)}
                </Text>
              </View>
              <View style={styles.kvRow}>
                <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Последний</Text>
                <Text style={[styles.kvValSmall, { color: colors.mutedForeground }]}>
                  {fmtAt(data.liveSnapshots.lastAt)}
                </Text>
              </View>
              {data.liveSnapshots.lastGameTimeSec != null && (
                <View style={styles.kvRow}>
                  <Text style={[styles.kvLabel, { color: colors.mutedForeground }]}>Game time</Text>
                  <Text style={[styles.kvVal, { color: colors.foreground }]}>
                    {fmtSec(data.liveSnapshots.lastGameTimeSec)}
                  </Text>
                </View>
              )}
            </View>
          )}

          {!data.outcome && data.markets.length === 0 && !data.liveSnapshots?.count && (
            <View style={styles.center}>
              <Feather name="database" size={28} color={colors.mutedForeground} />
              <Text style={{ color: colors.mutedForeground, textAlign: 'center', marginTop: 8, fontSize: 13 }}>
                Для этого матча в базе ещё нет ни прогнозов, ни live-снапшотов.
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingBottom: 12, gap: 12, borderBottomWidth: 1,
  },
  backBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 16, flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 4 },
  section: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  sectionTitle: { fontFamily: 'Inter_700Bold', fontSize: 14, marginBottom: 4 },
  bigLine: { fontFamily: 'Inter_600SemiBold', fontSize: 15 },
  hint: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  kvRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  kvLabel: { fontFamily: 'Inter_400Regular', fontSize: 13, flex: 1 },
  kvVal: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  kvValSmall: { fontFamily: 'Inter_400Regular', fontSize: 12, maxWidth: '60%' },
  marketRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#33333322',
  },
  marketName: { fontFamily: 'Inter_500Medium', fontSize: 13 },
  marketMeta: { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 2 },
  marketProbs: { flexDirection: 'row', gap: 10 },
  marketProb: { fontFamily: 'Cinzel_700Bold', fontSize: 14, minWidth: 50, textAlign: 'right' },
});

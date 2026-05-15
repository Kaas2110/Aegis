/**
 * TotalsLadder — лестница ТБ/ТМ как у букмекеров.
 * Несколько линий тотала (49.5, 50.5, …, 55.5) с вероятностью модели для каждой стороны.
 * Live: лестница автоматически центрируется вокруг проекции текущего темпа.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { FreshnessIndicator } from './FreshnessIndicator';

export type TotalsType = 'kills' | 'duration';

interface LadderLine {
  line: number;
  pOver: number;
  pUnder: number;
}
interface LadderResponse {
  type: TotalsType;
  expectedValue: number;
  isLive: boolean;
  projection: null | { current: number; minute: number; projected: number; remainingMin: number };
  lines: LadderLine[];
  interval: null | { q25: number; q75: number };
  confidence: number;
  modelVersion: string;
  unavailable?: boolean;
  unavailableReason?: string;
  generatedAt: string;
}

interface Props {
  radiantTeamId: number;
  direTeamId: number;
  type: TotalsType;
  format?: 'BO1' | 'BO3' | 'BO5';
  liveCurrent?: number | null;
  liveMinute?: number | null;
  defaultExpanded?: boolean;
}

const TYPE_LABEL: Record<TotalsType, { title: string; unit: string }> = {
  kills: { title: 'Тотал убийств', unit: '' },
  duration: { title: 'Длительность', unit: ' мин' },
};

export function TotalsLadder({
  radiantTeamId, direTeamId, type, format = 'BO3',
  liveCurrent, liveMinute, defaultExpanded = true,
}: Props) {
  const colors = useColors();
  const [data, setData] = useState<LadderResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      type,
      radiantTeamId: String(radiantTeamId),
      direTeamId: String(direTeamId),
      format,
      lineCount: '7',
    });
    if (liveCurrent != null && liveMinute != null && liveMinute > 0) {
      params.set('liveCurrent', String(liveCurrent));
      params.set('liveMinute', String(liveMinute));
    }

    fetch(`/api/analytics/totals-ladder?${params.toString()}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<LadderResponse>;
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e?.message ?? e)); setLoading(false); } });

    return () => { cancelled = true; };
  }, [radiantTeamId, direTeamId, type, format, liveCurrent, liveMinute]);

  const meta = TYPE_LABEL[type];

  return (
    <View style={[
      styles.card,
      { backgroundColor: colors.card, borderColor: colors.border },
    ]}>
      <TouchableOpacity onPress={() => setExpanded(e => !e)} style={styles.header} activeOpacity={0.7}>
        <View style={styles.headerLeft}>
          <Text style={[styles.typeLabel, { color: colors.mutedForeground }]}>
            {meta.title.toUpperCase()}
          </Text>
          <Text style={[styles.marketLabel, { color: colors.foreground }]}>
            {data
              ? `${data.lines.length} линий вокруг ${data.expectedValue.toFixed(1)}${meta.unit}`
              : meta.title}
          </Text>
          {data?.projection && (
            <Text style={[styles.subline, { color: colors.mutedForeground }]} numberOfLines={1}>
              {type === 'kills'
                ? `Сейчас ${data.projection.current} к ${data.projection.minute} мин · проекция ~${Math.round(data.projection.projected)}`
                : `Сейчас ${data.projection.minute} мин · проекция ~${Math.round(data.projection.projected)} мин`}
            </Text>
          )}
          {data?.interval && type === 'duration' && (
            <View style={styles.intervalWrap}>
              <View style={[styles.intervalBand, { backgroundColor: colors.muted }]}>
                <View style={[styles.intervalFill, { backgroundColor: colors.primary }]} />
              </View>
              <Text style={[styles.intervalText, { color: colors.mutedForeground }]} numberOfLines={1}>
                q25–q75: {data.interval.q25.toFixed(1)}–{data.interval.q75.toFixed(1)} мин
              </Text>
            </View>
          )}
        </View>
        <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={colors.mutedForeground} />
      </TouchableOpacity>

      {expanded && (
        <View style={[styles.body, { borderTopColor: colors.border }]}>
          {/* Шапка таблицы */}
          <View style={styles.tableHeader}>
            <Text style={[styles.tableHeaderCell, styles.lineCol, { color: colors.mutedForeground }]}>ЛИНИЯ</Text>
            <Text style={[styles.tableHeaderCell, styles.sideCol, { color: colors.positive }]}>БОЛЬШЕ (ТБ)</Text>
            <Text style={[styles.tableHeaderCell, styles.sideCol, { color: colors.destructive }]}>МЕНЬШЕ (ТМ)</Text>
          </View>

          {loading && (
            <View style={styles.loadingBox}>
              <ActivityIndicator color={colors.primary} />
            </View>
          )}

          {error && !loading && (
            <View style={[styles.errBox, { backgroundColor: colors.destructive + '15', borderColor: colors.destructive + '40' }]}>
              <Feather name="alert-circle" size={12} color={colors.destructive} />
              <Text style={[styles.errText, { color: colors.destructive }]}>
                Не удалось загрузить лестницу: {error}
              </Text>
            </View>
          )}

          {!loading && !error && data && (data.unavailable || data.lines.length === 0) && (
            <View style={[styles.errBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Feather name="info" size={12} color={colors.mutedForeground} />
              <Text style={[styles.errText, { color: colors.mutedForeground }]}>
                Прогноз ТБ/ТМ недоступен — {data.unavailableReason ?? 'модель ещё не обучена для этой пары команд'}. Math-фолбэк со stub-фичами мы не показываем (это были бы фейковые цифры).
              </Text>
            </View>
          )}

          {!loading && !error && data && !data.unavailable && data.lines.length > 0 && data.lines.map((row) => {
            const overBest = row.pOver >= row.pUnder;
            return (
              <View
                key={row.line}
                style={[
                  styles.row,
                  { borderTopColor: colors.border },
                ]}
              >
                <View style={styles.lineCol}>
                  <Text style={[styles.lineText, { color: colors.foreground }]}>
                    {row.line.toFixed(1)}{meta.unit}
                  </Text>
                </View>
                <ProbCell
                  pct={Math.round(row.pOver * 100)}
                  isBest={overBest}
                  side="over"
                  colors={colors}
                />
                <ProbCell
                  pct={Math.round(row.pUnder * 100)}
                  isBest={!overBest}
                  side="under"
                  colors={colors}
                />
              </View>
            );
          })}

          {!loading && !error && data && !data.unavailable && data.lines.length > 0 && (
            <View style={styles.footer}>
              <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
                Уверенность модели: {Math.round(data.confidence * 100)}%
              </Text>
              <FreshnessIndicator ageSeconds={Math.floor((Date.now() - new Date(data.generatedAt).getTime()) / 1000)} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function ProbCell({
  pct, isBest, side, colors,
}: {
  pct: number;
  isBest: boolean;
  side: 'over' | 'under';
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
}) {
  const tone = side === 'over' ? colors.positive : colors.destructive;
  return (
    <View style={[
      styles.sideCol,
      styles.probPill,
      isBest
        ? { backgroundColor: tone + '25', borderColor: tone + '88' }
        : { backgroundColor: colors.muted, borderColor: colors.border },
    ]}>
      <Text style={[
        styles.probText,
        { color: isBest ? tone : colors.mutedForeground, fontFamily: isBest ? 'Cinzel_700Bold' : 'Inter_600SemiBold' },
      ]}>
        {pct}%
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 14,
    paddingBottom: 12,
    gap: 10,
  },
  headerLeft: { flex: 1, gap: 2 },
  typeLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 9, letterSpacing: 1.2 },
  marketLabel: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  subline: { fontFamily: 'Inter_400Regular', fontSize: 11, marginTop: 2 },
  intervalWrap: { marginTop: 4, gap: 4 },
  intervalBand: {
    height: 4,
    borderRadius: 999,
    overflow: 'hidden',
  },
  intervalFill: {
    width: '100%',
    height: '100%',
    opacity: 0.85,
  },
  intervalText: { fontFamily: 'Inter_400Regular', fontSize: 11 },
  body: {
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 8,
    gap: 8,
    alignItems: 'center',
  },
  tableHeaderCell: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 9,
    letterSpacing: 1,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    gap: 8,
    borderTopWidth: 1,
  },
  lineCol: {
    width: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineText: {
    fontFamily: 'Cinzel_700Bold',
    fontSize: 14,
  },
  sideCol: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  probPill: {
    borderRadius: 4,
    borderWidth: 1,
    paddingVertical: 6,
  },
  probText: {
    fontSize: 16,
    letterSpacing: -0.3,
  },
  loadingBox: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  errBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginVertical: 6,
  },
  errText: { fontFamily: 'Inter_400Regular', fontSize: 11, flex: 1 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 10,
    marginTop: 4,
  },
  footerText: { fontFamily: 'Inter_400Regular', fontSize: 11 },
});

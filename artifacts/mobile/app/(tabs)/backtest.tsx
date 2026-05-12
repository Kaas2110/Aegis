import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Line, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { Feather } from '@expo/vector-icons';
import { getApiUrl } from '@/lib/api/baseUrl';
import { useColors } from '@/hooks/useColors';
import { logProductEvent } from '@/services/logging/EventLogger';
import type { BacktestResult } from '@/types';
import { useFeatureAccess } from '@/lib/featureFlags';
import { PremiumGate } from '@/components/PremiumGate';

const PERIOD_OPTIONS = [30, 90, 180, 365] as const;
const CONF_OPTIONS = [50, 60, 70, 80] as const;
const ODDS_OPTIONS = [1.2, 1.5, 2.0] as const;

export default function BacktestScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [periodDays, setPeriodDays] = useState<number>(90);
  const [minConf, setMinConf] = useState<number>(60);
  const [minOdds, setMinOdds] = useState<number>(1.5);
  const [isRunning, setIsRunning] = useState(false);

  const topPad = Platform.OS === 'web' ? 67 : insets.top;
  const access = useFeatureAccess('backtest');

  async function handleRun() {
    if (!access.canAccess) return;
    setIsRunning(true);
    setError(null);
    await logProductEvent('backtest_started', 'backtest', { periodDays, minConf, minOdds });
    try {
      const resp = await fetch(getApiUrl('/api/analytics/backtest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minConfidence: minConf, minOdds, periodDays }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json() as BacktestResult;
      setResult(json);
      await logProductEvent('backtest_completed', 'backtest', { n: json.kpis.numberOfBets, roi: json.kpis.roi });
    } catch (err) {
      setError(String(err));
    } finally {
      setIsRunning(false);
    }
  }

  useEffect(() => { handleRun(); /* eslint-disable-line */ }, []);

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.content, { paddingTop: topPad + 12, paddingBottom: insets.bottom + 90 }]}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.title, { color: colors.foreground }]}>Бэктест модели</Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        Реальная история прогнозов из prematch_outcomes — что было бы, если ставить по уверенности модели
      </Text>

      {!access.canAccess && (
        <PremiumGate
          feature="backtest"
          variant="inline"
          title="Бэктест доступен в Premium"
          subtitle="Историческая equity-кривая и KPI стратегии. Открывается после оформления подписки."
        >
          {null}
        </PremiumGate>
      )}

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, opacity: access.canAccess ? 1 : 0.4 }]}
        pointerEvents={access.canAccess ? 'auto' : 'none'}
      >
        <Text style={[styles.cardTitle, { color: colors.foreground }]}>Параметры</Text>

        <Text style={[styles.paramLabel, { color: colors.mutedForeground }]}>Период (дней)</Text>
        <View style={styles.row}>
          {PERIOD_OPTIONS.map(v => (
            <ChipBtn key={v} label={String(v)} active={periodDays === v} onPress={() => setPeriodDays(v)} colors={colors} />
          ))}
        </View>

        <Text style={[styles.paramLabel, { color: colors.mutedForeground }]}>Мин. уверенность модели</Text>
        <View style={styles.row}>
          {CONF_OPTIONS.map(v => (
            <ChipBtn key={v} label={`${v}%`} active={minConf === v} onPress={() => setMinConf(v)} colors={colors} />
          ))}
        </View>

        <Text style={[styles.paramLabel, { color: colors.mutedForeground }]}>Мин. справедливый коэф (1/p)</Text>
        <View style={styles.row}>
          {ODDS_OPTIONS.map(v => (
            <ChipBtn key={v} label={v.toFixed(2)} active={minOdds === v} onPress={() => setMinOdds(v)} colors={colors} />
          ))}
        </View>

        <TouchableOpacity
          onPress={handleRun}
          disabled={isRunning}
          style={[styles.runBtn, { backgroundColor: isRunning ? colors.muted : colors.primary }]}
        >
          {isRunning
            ? <ActivityIndicator color={colors.mutedForeground} />
            : <Text style={[styles.runBtnText, { color: colors.primaryForeground }]}>Пересчитать</Text>
          }
        </TouchableOpacity>
      </View>

      {error && (
        <View style={[styles.errorCard, { backgroundColor: colors.destructive + '15', borderColor: colors.destructive + '55' }]}>
          <Feather name="alert-circle" size={14} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
        </View>
      )}

      {result && result.kpis.numberOfBets === 0 && (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, alignItems: 'center', gap: 6 }]}>
          <Feather name="database" size={24} color={colors.mutedForeground} />
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Недостаточно данных</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground, textAlign: 'center', marginTop: 0 }]}>
            {result.message ?? 'OutcomeTracker ещё не накопил resolved прогнозов под выбранные фильтры. Попробуйте увеличить период или снизить уверенность.'}
          </Text>
        </View>
      )}

      {result && result.kpis.numberOfBets > 0 && (
        <>
          {/* KPI карточки */}
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Итог за {periodDays} дн.</Text>
            <View style={styles.kpiRow}>
              <KpiCard label="Прибыль" value={`${result.kpis.profitUnits >= 0 ? '+' : ''}${result.kpis.profitUnits.toFixed(1)}`} sub="ед." colors={colors} positive={result.kpis.profitUnits >= 0} big />
              <KpiCard label="Доходность" value={`${(result.kpis.roi * 100).toFixed(1)}%`} sub="на ставку" colors={colors} positive={result.kpis.roi >= 0} big />
            </View>
            <View style={styles.kpiRow}>
              <KpiCard label="Ставок" value={String(result.kpis.numberOfBets)} colors={colors} />
              <KpiCard label="Попаданий" value={`${(result.kpis.hitRate * 100).toFixed(1)}%`} colors={colors} positive={result.kpis.hitRate > 0.5} />
              <KpiCard label="Ср. коэф" value={result.kpis.avgOdds.toFixed(2)} colors={colors} />
            </View>
            <View style={styles.kpiRow}>
              <KpiCard label="Просадка" value={`${result.kpis.maxDrawdown.toFixed(1)} ед.`} colors={colors} negative />
              <KpiCard label="Brier" value={result.kpis.brierScore != null ? result.kpis.brierScore.toFixed(3) : '—'} colors={colors} />
            </View>
          </View>

          {/* Equity-кривая */}
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Кривая капитала</Text>
            <EquityChart points={result.equityCurve.map(p => p.units)} colors={colors} />
            <Text style={[styles.equityNote, { color: colors.mutedForeground }]}>
              Старт 0 ед. · {result.equityCurve.length} последовательных ставок · 1 единица на ставку
            </Text>
          </View>

          {/* Распределение по уверенности */}
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Точность по уверенности</Text>
            <View style={styles.confBuckets}>
              {result.confidenceBuckets.map(b => {
                const maxCount = Math.max(...result.confidenceBuckets.map(x => x.count), 1);
                const pct = (b.count / maxCount);
                return (
                  <View key={b.label} style={styles.confBucket}>
                    <Text style={[styles.confLabel, { color: colors.mutedForeground }]}>{b.label}</Text>
                    <View style={[styles.confBarBg, { backgroundColor: colors.muted }]}>
                      <View style={[styles.confBarFill, {
                        width: `${pct * 100}%`,
                        backgroundColor: b.hitRate >= 0.55 ? colors.positive : colors.warning,
                      }]} />
                    </View>
                    <Text style={[styles.confValue, { color: colors.foreground }]}>
                      {b.count > 0 ? `${(b.hitRate * 100).toFixed(0)}% · n=${b.count}` : '—'}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function ChipBtn({ label, active, onPress, colors }: { label: string; active: boolean; onPress: () => void; colors: ReturnType<typeof import('@/hooks/useColors').useColors> }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, { backgroundColor: active ? colors.primary : colors.muted, borderColor: active ? colors.primary : colors.border }]}>
      <Text style={[styles.chipText, { color: active ? colors.primaryForeground : colors.mutedForeground }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function KpiCard({ label, value, sub, colors, positive, negative, big }: {
  label: string; value: string; sub?: string;
  colors: ReturnType<typeof import('@/hooks/useColors').useColors>;
  positive?: boolean; negative?: boolean; big?: boolean;
}) {
  const color = negative ? colors.destructive : positive ? colors.positive : colors.foreground;
  return (
    <View style={[styles.kpiBox, { backgroundColor: colors.muted }]}>
      <Text style={[big ? styles.kpiValueBig : styles.kpiValue, { color }]}>{value}</Text>
      <Text style={[styles.kpiLabel, { color: colors.mutedForeground }]}>{label}{sub ? ` · ${sub}` : ''}</Text>
    </View>
  );
}

/**
 * Equity-кривая в фирменной стилистике Aegis: плавная кривая Безье,
 * мягкая амбер-заливка под линией, светящаяся точка на конце.
 * Без сторонних либ — чистый react-native-svg.
 */
function EquityChart({ points, colors }: { points: number[]; colors: ReturnType<typeof import('@/hooks/useColors').useColors> }) {
  const W = 320;
  const H = 140;
  const pad = 10;

  // Прореживание для перформанса
  const sample = points.length <= 150 ? points : (() => {
    const step = points.length / 150;
    const out: number[] = [];
    for (let i = 0; i < 150; i++) out.push(points[Math.floor(i * step)] ?? 0);
    return out;
  })();

  if (sample.length < 2) {
    return <View style={{ height: H, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: colors.mutedForeground }}>Нужно ≥ 2 ставок</Text>
    </View>;
  }

  const min = Math.min(0, ...sample);
  const max = Math.max(0, ...sample);
  const range = (max - min) || 1;
  const dx = (W - pad * 2) / (sample.length - 1);
  const yFor = (v: number) => H - pad - ((v - min) / range) * (H - pad * 2);
  const xFor = (i: number) => pad + i * dx;

  // Плавная кривая через Catmull–Rom → Bezier (tension 0.5).
  // Даёт мягкий «торговый» силуэт без зубцов от каждой ставки.
  const pts = sample.map((v, i) => ({ x: xFor(i), y: yFor(v) }));
  let line = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    line += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  // Замкнутый контур для заливки до низа карточки
  const area = `${line} L ${pts[pts.length - 1]!.x} ${H - pad} L ${pts[0]!.x} ${H - pad} Z`;

  const last = sample[sample.length - 1] ?? 0;
  const positive = last >= 0;
  // Фирменный амбер для прибыли, более тёплый красный для убытка
  const lineColor = positive ? colors.primary : colors.destructive;
  const zeroY = yFor(0);
  const lastX = xFor(sample.length - 1);
  const lastY = yFor(last);

  return (
    <Svg width={W} height={H} style={{ alignSelf: 'center' }}>
      <Defs>
        <LinearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={lineColor} stopOpacity={0.32} />
          <Stop offset="1" stopColor={lineColor} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      {/* Тонкая нулевая линия — почти невидимая, только намёк на baseline */}
      <Line x1={pad} y1={zeroY} x2={W - pad} y2={zeroY} stroke={colors.border} strokeWidth={1} strokeOpacity={0.5} strokeDasharray="2,4" />
      {/* Заливка под кривой */}
      <Path d={area} fill="url(#equityFill)" />
      {/* Сама кривая — толстая мягкая линия */}
      <Path d={line} stroke={lineColor} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {/* Светящаяся точка на конце: внешний halo + ядро */}
      <Circle cx={lastX} cy={lastY} r={7} fill={lineColor} fillOpacity={0.18} />
      <Circle cx={lastX} cy={lastY} r={3.5} fill={lineColor} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 14 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 24 },
  subtitle: { fontFamily: 'Inter_400Regular', fontSize: 13, marginTop: -8 },
  card: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 10 },
  cardTitle: { fontFamily: 'Inter_700Bold', fontSize: 16 },
  paramLabel: { fontFamily: 'Inter_400Regular', fontSize: 12, marginTop: 4 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7, minWidth: 50, alignItems: 'center' },
  chipText: { fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  runBtn: { borderRadius: 12, height: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  runBtnText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  kpiRow: { flexDirection: 'row', gap: 8 },
  kpiBox: { flex: 1, borderRadius: 10, padding: 12, alignItems: 'center', minWidth: 80 },
  kpiValue: { fontFamily: 'Inter_700Bold', fontSize: 18 },
  kpiValueBig: { fontFamily: 'Inter_700Bold', fontSize: 24 },
  kpiLabel: { fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 4, textAlign: 'center' },
  equityNote: { fontFamily: 'Inter_400Regular', fontSize: 11, textAlign: 'center', marginTop: 2 },
  confBuckets: { gap: 8 },
  confBucket: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  confLabel: { fontFamily: 'Inter_500Medium', fontSize: 12, width: 60 },
  confBarBg: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  confBarFill: { height: '100%', borderRadius: 4 },
  confValue: { fontFamily: 'Inter_500Medium', fontSize: 11, width: 90, textAlign: 'right' },
  errorCard: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, borderWidth: 1, padding: 12 },
  errorText: { fontFamily: 'Inter_500Medium', fontSize: 12, flex: 1 },
});

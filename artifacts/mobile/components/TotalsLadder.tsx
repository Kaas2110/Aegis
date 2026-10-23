import {expireTotalsAt} from '../lib/totalsExpiry';
import { guardLiveTotals } from '../lib/liveFreshness';
import type { LiveDataQuality } from '../lib/liveFreshness';
import { usePredictionClock } from '../hooks/usePredictionClock';
import { apiFetch } from '../lib/api';
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
  pOver: number | null;
  pUnder: number | null;
  pPush: number | null;
  oddsOver?: number | null;
  oddsUnder?: number | null;
}
interface LadderResponse {
  type: TotalsType;
  displayUnit?: 'kills' | 'minutes';
  lineSource?: 'model' | 'bookmaker';
  bookmakerId?: string;
  quoteReceivedAt?: string;
  probabilityExpiresAt?: string;
  modelUnavailable?: boolean;
  modelUnavailableReason?: string;
  expectedValue: number | null;
  isLive: boolean;
  projection: null | { current: number; minute: number; projected: number; remainingMin: number };
  lines: LadderLine[];
  interval: null | { q25: number; q75: number };
  confidence: number | null;
  modelVersion: string;
  liveSource?: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  generatedAt: string;
  expiresAt?: string;
}

interface Props {
  radiantTeamId: number;
  direTeamId: number;
  type: TotalsType;
  format?: 'BO1' | 'BO3' | 'BO5' | 'unknown';
  /** OpenDota match_id текущего матча. Нужен в live-режиме, чтобы бэк подменил
   * прематч-LGB на свежее T3.5 live-totals предсказание из таблицы predictions. */
  matchId?: number | null;
  eventId?: string;
  bookmakerId?: string | null;
  status?: 'prematch' | 'live' | 'between_maps' | 'finished';
  snapshotReceivedAt?: string | null;
  liveDataQuality?: LiveDataQuality;
  defaultExpanded?: boolean;
}

const TYPE_LABEL: Record<TotalsType, { title: string; unit: string }> = {
  kills: { title: 'Тотал убийств', unit: '' },
  duration: { title: 'Длительность', unit: ' мин' },
};

export function TotalsLadder({
  radiantTeamId, direTeamId, type, format = 'unknown',
  matchId, eventId, bookmakerId, status = 'prematch', snapshotReceivedAt, liveDataQuality, defaultExpanded = true,
}: Props) {
  const colors = useColors();
  const [rawData, setData] = useState<LadderResponse | null>(null);
  const now = usePredictionClock(rawData?.expiresAt, rawData?.probabilityExpiresAt);
  const data = guardLiveTotals(rawData, status, liveDataQuality, now);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let controller: AbortController | null = null;
    const params = new URLSearchParams({type,radiantTeamId:String(radiantTeamId),direTeamId:String(direTeamId),format,status,lineCount:'7'});
    if (matchId != null && Number.isSafeInteger(matchId) && matchId > 0) params.set('matchId',String(matchId));
    if (eventId) params.set('eventId',eventId);
    if (bookmakerId) params.set('bookmakerId',bookmakerId);
    setData(null);
    async function refresh() {
      if (pending || cancelled) return;
      if (!bookmakerId && (!Number.isSafeInteger(radiantTeamId) || !Number.isSafeInteger(direTeamId) || radiantTeamId<=0 || direTeamId<=0 || radiantTeamId===direTeamId)) {
        setData({type,expectedValue:null,isLive:status==='live',projection:null,lines:[],interval:null,confidence:null,modelVersion:'unavailable',unavailable:true,unavailableReason:'Команды не сопоставлены с источником данных',generatedAt:new Date().toISOString()});setLoading(false);return;
      }
      pending = true;setLoading(true);setError(null);
      controller = new AbortController();
      const timeout = setTimeout(()=>controller?.abort(),20_000);
      try {
        const response = await apiFetch('/api/analytics/totals-ladder?' + params.toString(),{signal:controller.signal});
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const value = await response.json() as LadderResponse;
        // Unit tags make old servers incapable of displaying seconds as minutes.
        if (!value.unavailable && value.displayUnit !== (type === 'duration' ? 'minutes' : 'kills')) throw new Error('Несовместимые единицы прогноза');
        if (!cancelled) setData(value);
      } catch (e:any) {if (!cancelled) {setData(null);setError(String(e?.message ?? e));}}
      finally {clearTimeout(timeout);pending=false;if (!cancelled) setLoading(false);}
    }
    void refresh();
    // Reads our server's stored predictions only; never refreshes a provider.
    const refreshTimer = setInterval(()=>void refresh(),120_000);
    return () => {cancelled=true;controller?.abort();clearInterval(refreshTimer);};
  }, [radiantTeamId,direTeamId,type,format,matchId,eventId,bookmakerId,status,snapshotReceivedAt]);

  useEffect(()=>{
    const timer=setInterval(()=>setData(prev=>expireTotalsAt(prev)),1000);
    return()=>clearInterval(timer);
  },[]);
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
            {data?.lineSource === 'bookmaker' && data.lines.length > 0
              ? `${data.lines.length} линий · ${data.bookmakerId}`
              : data?.expectedValue != null
              ? `${data.lines.length} линий вокруг ${data.expectedValue.toFixed(1)}${meta.unit}`
              : meta.title}
          </Text>
          {data?.projection && (
            <Text style={[styles.subline, { color: colors.mutedForeground }]} numberOfLines={1}>
              {type === 'kills'
                ? `Сейчас ${data.projection.current} к ${data.projection.minute.toFixed(1)} мин · проекция ~${Math.round(data.projection.projected)}`
                : `Сейчас ${data.projection.minute.toFixed(1)} мин · проекция ~${Math.round(data.projection.projected)} мин`}
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
                Прогноз недоступен
              </Text>
            </View>
          )}

          {!loading && !error && data && (data.unavailable || data.lines.length === 0) && (
            <View style={[styles.errBox, { backgroundColor: colors.muted, borderColor: colors.border }]}>
              <Feather name="info" size={12} color={colors.mutedForeground} />
              <Text style={[styles.errText, { color: colors.mutedForeground }]}>
                Прогноз недоступен
              </Text>
            </View>
          )}

          {!loading && !error && data?.modelUnavailable && data.lines.length > 0 && (
            <Text style={[styles.footerText,{color:colors.mutedForeground,marginVertical:6}]}>Прогноз недоступен</Text>
          )}
          {!loading && !error && data && !data.unavailable && data.lines.length > 0 && data.lines.map((row) => {
            const comparable = row.pOver !== null && row.pUnder !== null;
            const overBest = comparable && row.pOver! >= row.pUnder!;
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
                    {data.lineSource === 'bookmaker' ? String(row.line) : row.line.toFixed(1)}{meta.unit}
                    {row.pPush != null && row.pPush >= .0005 ? '\nВозврат ' + (row.pPush*100).toFixed(1) + '%' : ''}
                  </Text>
                </View>
                <ProbCell
                  pct={row.pOver === null ? null : Math.round(row.pOver * 100)}
                  odds={row.oddsOver}
                  isBest={overBest}
                  side="over"
                  colors={colors}
                />
                <ProbCell
                  pct={row.pUnder === null ? null : Math.round(row.pUnder * 100)}
                  odds={row.oddsUnder}
                  isBest={comparable && !overBest}
                  side="under"
                  colors={colors}
                />
              </View>
            );
          })}

          {!loading && !error && data && !data.unavailable && data.lines.length > 0 && (
            <View style={styles.footer}>
              <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
                {data.lineSource === 'bookmaker' ? 'Линии и коэффициенты выбранной БК' : 'Медиана · вероятность возврата учтена'}
              </Text>
              <FreshnessIndicator ageSeconds={0} at={data.quoteReceivedAt ?? data.generatedAt} />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function ProbCell({
  pct, odds, isBest, side, colors,
}: {
  pct: number | null;
  odds?: number | null;
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
        {pct === null ? '—' : `${pct}%`}
      </Text>
      {odds !== undefined && <Text style={[styles.footerText,{color:colors.foreground}]}>{odds === null ? 'Кэф —' : 'Кэф '+String(odds)}</Text>}
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

import { apiFetch } from '../../../lib/api';
// Экран сравнения двух команд (T8). Маршрут: /match/compare/<aId>-<bId>.
// Берёт данные из /api/analytics/team-compare и рендерит две колонки + diff.
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { logProductEvent } from '@/services/logging/EventLogger';



type SeriesMomentum = {
  activeSeries: { seriesId: string; opponentId: string; format: number;
    winsForTeam: number; winsForOpponent: number; mapsPlayed: number } | null;
  recentSeriesWinRate: number | null;
  recentSeriesCount: number;
} | null;

type DynamicForm = {
  winRate30d: number | null; winRate90d: number | null;
  weightedWinRate: number | null; weightedSampleSize: number;
  winStreak: number; daysSinceLastMatch: number | null;
} | null;

type EloDecomp = {
  avgPlayerRating: number | null; playerRatingSpread: number | null;
  knownPlayers: number; tierLevel: 1 | 2 | 3 | null;
} | null;

type Styles = {
  avgDurationSec30d: number | null; firstBloodRate30d: number | null;
  avgKillsFor: number | null; avgKillsAgainst: number | null;
  paceLabel: 'slow' | 'mid' | 'fast' | null; aggression: number | null;
} | null;

type Entropy = {
  pickEntropyNorm: number | null; uniqueHeroesPicked: number;
  radiantBias: number | null; radiantWinRate: number | null; direWinRate: number | null;
} | null;

type TeamProfile = {
  teamId: number; teamName: string | null; teamRating: number | null;
  seriesMomentum: SeriesMomentum; dynamicForm: DynamicForm;
  eloDecomp: EloDecomp; styles: Styles; entropy: Entropy;
  sectionsAvailable: number; computedMs: number;
};

type CompareResp = {
  teamA: TeamProfile; teamB: TeamProfile;
  h2h: { winsA: number; winsB: number; games: number; periodDays: number; computedAt: string | null } | null;
  diff: {
    ratingDelta: number | null; weightedFormDelta: number | null;
    avgPlayerRatingDelta: number | null;
    tierLevelA: number | null; tierLevelB: number | null;
  };
};

function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}
function paceRu(p: string | null | undefined): string {
  if (p === 'slow') return 'медленный';
  if (p === 'mid') return 'средний';
  if (p === 'fast') return 'быстрый';
  return '—';
}

// F6 (Phase 9): «накапливаются» — секция считается пустой, если ни одно из
// числовых/строковых полей не заполнено. Тогда вместо пяти строк «— vs —»
// показываем одну явную подсказку, что данные ещё не набраны.
function isAllEmpty(obj: Record<string, unknown> | null | undefined, keys: string[]): boolean {
  if (!obj) return true;
  return keys.every(k => {
    const v = (obj as Record<string, unknown>)[k];
    return v == null || (typeof v === 'number' && !Number.isFinite(v));
  });
}
// Только истинно-nullable поля. winStreak/knownPlayers сервер отдаёт как 0
// даже для пустого профиля (см. teamProfile.ts) — это шум, не сигнал.
const FORM_KEYS = ['winRate30d', 'winRate90d', 'weightedWinRate'];
const ELO_KEYS = ['avgPlayerRating', 'tierLevel'];

export default function TeamCompareScreen() {
  const { ids } = useLocalSearchParams<{ ids: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? 67 : insets.top;

  const [data, setData] = useState<CompareResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const parts = (ids ?? '').split('-');
  const a = Number(parts[0]);
  const b = Number(parts[1]);

  useEffect(() => {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a === b) {
      setError('Некорректные ID команд');
      setLoading(false);
      return;
    }
    logProductEvent('team_compare_opened', 'team_compare', { teamAId: a, teamBId: b });
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/api/analytics/team-compare?teamAId=${a}&teamBId=${b}`)
      .then(r => r.json())
      .then((j: CompareResp & { error?: string }) => {
        if (cancelled) return;
        if (j.error) { setError(j.error); }
        else { setData(j); }
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [a, b]);

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
        <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
          Сравнение команд
        </Text>
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
          <Text style={{ color: colors.mutedForeground, marginTop: 4, fontSize: 12, textAlign: 'center' }}>
            Возможно, для одной из команд ещё не накоплено данных.
          </Text>
        </View>
      )}

      {!loading && !error && data && (
        <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40, gap: 14 }}>
          {/* Заголовки команд */}
          <View style={styles.teamHeaderRow}>
            <View style={[styles.teamHeaderCol, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.teamName, { color: colors.foreground }]} numberOfLines={1}>
                {data.teamA.teamName ?? `#${data.teamA.teamId}`}
              </Text>
              <Text style={[styles.teamRating, { color: colors.primary }]}>
                {fmtNum(data.teamA.teamRating, 0)}
              </Text>
            </View>
            <Text style={[styles.vs, { color: colors.mutedForeground }]}>VS</Text>
            <View style={[styles.teamHeaderCol, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={[styles.teamName, { color: colors.foreground }]} numberOfLines={1}>
                {data.teamB.teamName ?? `#${data.teamB.teamId}`}
              </Text>
              <Text style={[styles.teamRating, { color: colors.primary }]}>
                {fmtNum(data.teamB.teamRating, 0)}
              </Text>
            </View>
          </View>

          {/* F6 (Phase 9): баннер «данные накапливаются», если у одной из
              команд критические секции пустые. По API подтверждено: мелкие/
              новые tier-3 команды (например 128329, 137885) дают полностью
              null TeamProfile. Без баннера экран выглядит сломанным. */}
          {(() => {
            const aEmpty = isAllEmpty(data.teamA.dynamicForm as Record<string, unknown> | null, FORM_KEYS)
              && isAllEmpty(data.teamA.eloDecomp as Record<string, unknown> | null, ELO_KEYS);
            const bEmpty = isAllEmpty(data.teamB.dynamicForm as Record<string, unknown> | null, FORM_KEYS)
              && isAllEmpty(data.teamB.eloDecomp as Record<string, unknown> | null, ELO_KEYS);
            if (!aEmpty && !bEmpty) return null;
            const who = aEmpty && bEmpty ? 'обеих команд' : aEmpty
              ? (data.teamA.teamName ?? `#${data.teamA.teamId}`)
              : (data.teamB.teamName ?? `#${data.teamB.teamId}`);
            return (
              <View style={[styles.section, { backgroundColor: colors.muted, borderColor: colors.border, flexDirection: 'row', gap: 8, alignItems: 'flex-start' }]}>
                <Feather name="clock" size={14} color={colors.mutedForeground} style={{ marginTop: 2 }} />
                <Text style={[styles.hint, { color: colors.mutedForeground, flex: 1, lineHeight: 17 }]}>
                  Для {who} ещё накапливаются данные — это обычно мелкая/новая команда
                  без достаточной истории pro-матчей. Прочерки в строках ниже означают
                  «пока нечего показать», а не «данные сломаны».
                </Text>
              </View>
            );
          })()}

          {/* H2H */}
          {data.h2h ? (
            <Section title="История встреч" colors={colors}>
              <CompareRow
                label={`H2H (${data.h2h.periodDays}д)`}
                left={`${data.h2h.winsA}`} right={`${data.h2h.winsB}`}
                colors={colors}
              />
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                Всего матчей: {data.h2h.games}
              </Text>
            </Section>
          ) : (
            <Section title="История встреч" colors={colors}>
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                Прямых встреч за последний период нет.
              </Text>
            </Section>
          )}

          {/* Форма */}
          <Section title="Форма" colors={colors}>
            <CompareRow label="Winrate 30д"
              left={fmtPct(data.teamA.dynamicForm?.winRate30d)}
              right={fmtPct(data.teamB.dynamicForm?.winRate30d)} colors={colors} />
            <CompareRow label="Winrate 90д"
              left={fmtPct(data.teamA.dynamicForm?.winRate90d)}
              right={fmtPct(data.teamB.dynamicForm?.winRate90d)} colors={colors} />
            <CompareRow label="Recency-weighted"
              left={fmtPct(data.teamA.dynamicForm?.weightedWinRate, 1)}
              right={fmtPct(data.teamB.dynamicForm?.weightedWinRate, 1)} colors={colors} />
            <CompareRow label="Текущая серия побед"
              left={String(data.teamA.dynamicForm?.winStreak ?? '—')}
              right={String(data.teamB.dynamicForm?.winStreak ?? '—')} colors={colors} />
          </Section>

          {/* Сила состава */}
          <Section title="Сила состава" colors={colors}>
            <CompareRow label="Tier"
              left={data.teamA.eloDecomp?.tierLevel ? `T${data.teamA.eloDecomp.tierLevel}` : '—'}
              right={data.teamB.eloDecomp?.tierLevel ? `T${data.teamB.eloDecomp.tierLevel}` : '—'}
              colors={colors} />
            <CompareRow label="Средний игрок (Glicko)"
              left={fmtNum(data.teamA.eloDecomp?.avgPlayerRating, 0)}
              right={fmtNum(data.teamB.eloDecomp?.avgPlayerRating, 0)} colors={colors} />
            <CompareRow label="Известных игроков"
              left={String(data.teamA.eloDecomp?.knownPlayers ?? '—')}
              right={String(data.teamB.eloDecomp?.knownPlayers ?? '—')} colors={colors} />
          </Section>

          {/* Стиль */}
          <Section title="Стиль игры" colors={colors}>
            <CompareRow label="Темп"
              left={paceRu(data.teamA.styles?.paceLabel)}
              right={paceRu(data.teamB.styles?.paceLabel)} colors={colors} />
            <CompareRow label="Длительность 30д (мин)"
              left={data.teamA.styles?.avgDurationSec30d ? fmtNum(data.teamA.styles.avgDurationSec30d / 60, 1) : '—'}
              right={data.teamB.styles?.avgDurationSec30d ? fmtNum(data.teamB.styles.avgDurationSec30d / 60, 1) : '—'}
              colors={colors} />
            <CompareRow label="Убийства за матч"
              left={fmtNum(data.teamA.styles?.avgKillsFor, 1)}
              right={fmtNum(data.teamB.styles?.avgKillsFor, 1)} colors={colors} />
            <CompareRow label="First Blood rate"
              left={fmtPct(data.teamA.styles?.firstBloodRate30d)}
              right={fmtPct(data.teamB.styles?.firstBloodRate30d)} colors={colors} />
          </Section>

          {/* Разнообразие пиков */}
          <Section title="Разнообразие пиков" colors={colors}>
            <CompareRow label="Энтропия пиков"
              left={fmtPct(data.teamA.entropy?.pickEntropyNorm, 1)}
              right={fmtPct(data.teamB.entropy?.pickEntropyNorm, 1)} colors={colors} />
            <CompareRow label="Уникальных героев"
              left={String(data.teamA.entropy?.uniqueHeroesPicked ?? '—')}
              right={String(data.teamB.entropy?.uniqueHeroesPicked ?? '—')} colors={colors} />
            <CompareRow label="WR на Radiant"
              left={fmtPct(data.teamA.entropy?.radiantWinRate)}
              right={fmtPct(data.teamB.entropy?.radiantWinRate)} colors={colors} />
            <CompareRow label="WR на Dire"
              left={fmtPct(data.teamA.entropy?.direWinRate)}
              right={fmtPct(data.teamB.entropy?.direWinRate)} colors={colors} />
          </Section>

          {/* Diff-сводка */}
          <Section title="Перевес" colors={colors}>
            {data.diff.ratingDelta != null && (
              <Text style={[styles.diffLine, { color: colors.foreground }]}>
                Рейтинг команды: {data.diff.ratingDelta > 0 ? '+' : ''}{fmtNum(data.diff.ratingDelta, 0)} в пользу {data.diff.ratingDelta > 0 ? 'A' : 'B'}
              </Text>
            )}
            {data.diff.weightedFormDelta != null && (
              <Text style={[styles.diffLine, { color: colors.foreground }]}>
                Форма (weighted): {data.diff.weightedFormDelta > 0 ? '+' : ''}{fmtPct(data.diff.weightedFormDelta, 1)} в пользу {data.diff.weightedFormDelta > 0 ? 'A' : 'B'}
              </Text>
            )}
            {data.diff.avgPlayerRatingDelta != null && (
              <Text style={[styles.diffLine, { color: colors.foreground }]}>
                Состав (Glicko): {data.diff.avgPlayerRatingDelta > 0 ? '+' : ''}{fmtNum(data.diff.avgPlayerRatingDelta, 0)} в пользу {data.diff.avgPlayerRatingDelta > 0 ? 'A' : 'B'}
              </Text>
            )}
            {data.diff.ratingDelta == null && data.diff.weightedFormDelta == null && data.diff.avgPlayerRatingDelta == null && (
              <Text style={[styles.hint, { color: colors.mutedForeground }]}>
                Недостаточно данных для расчёта перевеса.
              </Text>
            )}
          </Section>

          <Text style={[styles.footer, { color: colors.mutedForeground }]}>
            A = {data.teamA.teamName ?? data.teamA.teamId} · B = {data.teamB.teamName ?? data.teamB.teamId}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

function Section({ title, children, colors }: {
  title: string; children: React.ReactNode;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>{title}</Text>
      <View style={{ gap: 6 }}>{children}</View>
    </View>
  );
}

function CompareRow({ label, left, right, colors }: {
  label: string; left: string; right: string;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowVal, { color: colors.foreground, textAlign: 'left' }]}>{left}</Text>
      <Text style={[styles.rowLabel, { color: colors.mutedForeground }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.rowVal, { color: colors.foreground, textAlign: 'right' }]}>{right}</Text>
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
  teamHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  teamHeaderCol: {
    flex: 1, padding: 12, borderRadius: 10, borderWidth: 1, alignItems: 'center', gap: 4,
  },
  teamName: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  teamRating: { fontFamily: 'Cinzel_700Bold', fontSize: 20 },
  vs: { fontFamily: 'Cinzel_700Bold', fontSize: 14, opacity: 0.6 },
  section: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 10 },
  sectionTitle: { fontFamily: 'Inter_700Bold', fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabel: { flex: 1, fontFamily: 'Inter_400Regular', fontSize: 12, textAlign: 'center' },
  rowVal: { fontFamily: 'Inter_600SemiBold', fontSize: 14, minWidth: 70 },
  hint: { fontFamily: 'Inter_400Regular', fontSize: 12 },
  diffLine: { fontFamily: 'Inter_500Medium', fontSize: 13 },
  footer: { fontFamily: 'Inter_400Regular', fontSize: 11, textAlign: 'center', marginTop: 8 },
});

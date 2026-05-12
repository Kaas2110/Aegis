import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import type { Match, Market } from '@/types';
import { OddsTilesPair } from './OddsTile';
import { OrnateCorners } from './OrnateFrame';
import { HexBadge } from './HexBadge';
import { PremiumGate } from './PremiumGate';

interface Props {
  match: Match;
  bestMarket?: Market;
  onPress?: () => void;
}

function formatGameTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function marketTypeRu(type: string): string {
  switch (type) {
    case 'map_winner': return 'Победитель карты';
    case 'match_winner': return 'Победитель матча';
    case 'total_kills': return 'Тотал убийств';
    case 'total_duration': return 'Тотал по времени';
    default: return type;
  }
}

export function MatchCard({ match, bestMarket, onPress }: Props) {
  const colors = useColors();
  const isLive = match.status === 'live';
  const isPrematch = match.status === 'prematch';
  const snap = match.liveSnapshot;
  const hasPositiveEV = bestMarket && bestMarket.prediction.ev > 0.08;

  const timeUntil = isPrematch
    ? (() => {
        const diff = match.startTime.getTime() - Date.now();
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        return h > 0 ? `через ${h}ч ${m}м` : `через ${m}м`;
      })()
    : null;

  // Карточки с +EV получают двойную золотую рамку и угловые ornaments —
  // визуальная метафора «эпического» предмета из инвентаря Dota.
  const accentColor = hasPositiveEV ? colors.primary : colors.borderGold;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={styles.outerWrap}>
      {/* Внешняя золотая рамка (1px) для эпического вайба */}
      <View
        style={[
          styles.card,
          {
            backgroundColor: colors.card,
            borderColor: accentColor,
            borderWidth: 1,
          },
        ]}
      >
        {/* Тонкая верхняя градиентная полоса (золото→прозрачность) — как в HUD Dota */}
        <LinearGradient
          colors={[accentColor + 'BB', accentColor + '00']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.topAccentLine}
        />

        {/* Угловые ornaments — только для +EV карточек, чтобы не зашумлять список */}
        {hasPositiveEV && <OrnateCorners color={colors.primary} size={16} />}

        {/* ── TOP META ──────────────────────────── */}
        <View style={styles.metaRow}>
          <Text style={[styles.tournament, { color: colors.mutedForeground }]} numberOfLines={1}>
            {match.tournamentName}
          </Text>
          <View style={styles.metaRight}>
            <Text style={[styles.format, { color: colors.secondaryForeground }]}>{match.format}</Text>
            {isLive && (
              <View style={[styles.livePill, { borderColor: colors.destructive + '88' }]}>
                <View style={[styles.liveDot, { backgroundColor: colors.destructive }]} />
                <Text style={[styles.liveText, { color: colors.destructive }]}>ЛАЙВ</Text>
              </View>
            )}
            {isPrematch && timeUntil && (
              <Text style={[styles.prematchText, { color: colors.warning }]}>{timeUntil}</Text>
            )}
          </View>
        </View>

        {/* ── TEAMS ROW ─────────────────────────── */}
        <View style={styles.teamsRow}>
          {/* Team 1 — Radiant side. Цвет (зелёный) и hex-бэйдж уже сообщают
              «это сторона Radiant», поэтому подпись фракции лишняя — показываем
              сразу название команды. */}
          <View style={styles.teamSide}>
            <HexBadge label={match.team1.shortName} color={colors.radiant} size={36} />
            <View style={styles.teamCol}>
              <Text
                style={[styles.teamName, { color: colors.radiant }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {match.team1.name}
              </Text>
            </View>
            {isLive && match.team1MapsWon !== undefined && (
              <Text style={[styles.mapScore, { color: colors.radiant }]}>{match.team1MapsWon}</Text>
            )}
          </View>

          {/* Center score */}
          <View style={styles.centerBlock}>
            {isLive && snap ? (
              <>
                <Text style={[styles.liveScore, { color: colors.foreground }]}>
                  {snap.radiantKills}
                  <Text style={{ color: colors.mutedForeground }}> · </Text>
                  {snap.direKills}
                </Text>
                <Text style={[styles.gameTime, { color: colors.mutedForeground }]}>
                  {formatGameTime(snap.gameTimeSeconds)}
                </Text>
              </>
            ) : (
              <Text style={[styles.vsText, { color: colors.primary }]}>VS</Text>
            )}
          </View>

          {/* Team 2 — Dire side. Аналогично: красный цвет + hex-бэйдж = Dire,
              лейбл фракции убран, осталось только имя команды. */}
          <View style={[styles.teamSide, { justifyContent: 'flex-end' }]}>
            {isLive && match.team2MapsWon !== undefined && (
              <Text style={[styles.mapScore, { color: colors.dire }]}>{match.team2MapsWon}</Text>
            )}
            <View style={[styles.teamCol, { alignItems: 'flex-end' }]}>
              <Text
                style={[styles.teamName, { color: colors.dire, textAlign: 'right' }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
              >
                {match.team2.name}
              </Text>
            </View>
            <HexBadge label={match.team2.shortName} color={colors.dire} size={36} />
          </View>
        </View>

        {/* ── MARKET PREVIEW ────────────────────── */}
        {/* Прогноз вероятности победы — premium-фича. На free тире
            виден силуэт через blur + замок-CTA, кликом ведёт на paywall. */}
        {bestMarket && (
          <PremiumGate feature="win_probability" variant="overlay">
            <View style={[styles.marketSection, { borderTopColor: colors.borderGold + '55' }]}>
              <View style={styles.marketHeader}>
                <Text style={[styles.marketLabel, { color: colors.secondaryForeground }]}>
                  {marketTypeRu(bestMarket.type).toUpperCase()}
                </Text>
              </View>

              <OddsTilesPair
                team1Label={match.team1.shortName}
                team2Label={match.team2.shortName}
                modelProbTeam1={bestMarket.prediction.modelProbability}
                fairProbTeam1={bestMarket.bestOdds.fairProbTeam1}
                oddsTeam1={bestMarket.bestOdds.oddsTeam1}
                oddsTeam2={bestMarket.bestOdds.oddsTeam2}
                bookmakerName={bestMarket.bestOdds.bookmakerName}
                edgeTeam1={bestMarket.prediction.edge}
                evTeam1={bestMarket.prediction.ev}
                confidence={bestMarket.prediction.confidence}
                onPressTeam1={onPress}
                onPressTeam2={onPress}
              />
            </View>
          </PremiumGate>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  outerWrap: { position: 'relative' },
  card: {
    borderRadius: 4, // угловатый Dota-стиль
    padding: 14,
    paddingTop: 16,
    gap: 12,
    position: 'relative',
    overflow: 'hidden',
  },
  topAccentLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tournament: {
    fontFamily: 'Forum_400Regular',
    fontSize: 12,
    flex: 1,
    letterSpacing: 0.6,
  },
  metaRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  format: { fontFamily: 'Cinzel_500Medium', fontSize: 11, letterSpacing: 0.5 },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  liveDot: { width: 5, height: 5, borderRadius: 2.5 },
  liveText: { fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1.2 },
  prematchText: { fontFamily: 'Forum_400Regular', fontSize: 11 },
  teamsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  teamSide: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  teamCol: { flex: 1, gap: 2 },
  // Имя команды — Cinzel 12px, чуть плотнее межбуквенный, одна строка с
  // авто-сжатием до 0.7 (см. adjustsFontSizeToFit). PARIVISION/PLAYTIME
  // влезают целиком на 360-pt экранах.
  teamName: { fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 0.1, lineHeight: 15 },
  mapScore: { fontFamily: 'Cinzel_700Bold', fontSize: 20, marginHorizontal: 1 },
  centerBlock: { alignItems: 'center', minWidth: 48, paddingHorizontal: 2 },
  liveScore: { fontFamily: 'Cinzel_700Bold', fontSize: 16, letterSpacing: -0.2 },
  gameTime: { fontFamily: 'Inter_500Medium', fontSize: 10, marginTop: 2, letterSpacing: 0.5 },
  vsText: { fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1.5 },
  marketSection: { borderTopWidth: 1, paddingTop: 11, gap: 8 },
  marketHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  marketLabel: { fontFamily: 'Cinzel_500Medium', fontSize: 10, letterSpacing: 1.4 },
  edgeBadge: {
    borderRadius: 2,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  edgeBadgeText: { fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 0.8 },
});

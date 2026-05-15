import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useColors } from '@/hooks/useColors';
import type { Match, Market } from '@/types';
import { OddsTilesPair } from './OddsTile';
import { OrnateCorners } from './OrnateFrame';
import { HexBadge } from './HexBadge';

interface Props {
  match: Match;
  bestMarket?: Market;
  /**
   * 'pending'     — обогащение ML ещё не закончилось → крутилка «Данные собираются»
   * 'ready'       — есть прогноз, рендерим OddsTilesPair
   * 'unavailable' — модель скипнула (нет данных по команде / dim mismatch / ml down)
   *                 → показываем «Прогноз недоступен», без 50/50 и без бет-кнопок.
   */
  predictionStatus?: 'pending' | 'ready' | 'unavailable';
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

export function MatchCard({ match, bestMarket, predictionStatus = 'pending', onPress }: Props) {
  const colors = useColors();
  const isLive = match.status === 'live';
  const isPrematch = match.status === 'prematch';
  const isBetweenMaps = match.status === 'between_maps';
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
            {isBetweenMaps && (
              <View style={[styles.livePill, { borderColor: colors.warning + '88' }]}>
                <Text style={[styles.liveText, { color: colors.warning }]}>ПЕРЕРЫВ</Text>
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
            {(isLive || isBetweenMaps) && match.team1MapsWon !== undefined && (
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
            ) : isBetweenMaps ? (
              <>
                <Text style={[styles.liveScore, { color: colors.foreground }]}>
                  {match.team1MapsWon ?? 0}
                  <Text style={{ color: colors.mutedForeground }}> · </Text>
                  {match.team2MapsWon ?? 0}
                </Text>
                <Text style={[styles.gameTime, { color: colors.mutedForeground }]}>
                  карта {match.currentMapNumber}
                </Text>
              </>
            ) : (
              <Text style={[styles.vsText, { color: colors.primary }]}>VS</Text>
            )}
          </View>

          {/* Team 2 — Dire side. Аналогично: красный цвет + hex-бэйдж = Dire,
              лейбл фракции убран, осталось только имя команды. */}
          <View style={[styles.teamSide, { justifyContent: 'flex-end' }]}>
            {(isLive || isBetweenMaps) && match.team2MapsWon !== undefined && (
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
        {bestMarket ? (
          <View style={[styles.marketSection, { borderTopColor: colors.borderGold + '55' }]}>
            <View style={styles.marketHeader}>
              <Text style={[styles.marketLabel, { color: colors.secondaryForeground }]}>
                {(bestMarket.label || marketTypeRu(bestMarket.type)).toUpperCase()}
              </Text>
              {/* Бейдж «ПЕРЕВЕС»: показываем только когда есть реальный кэф от БК */}
              {bestMarket.bestOdds.oddsTeam1 > 0 && bestMarket.prediction.ev > 0 && (
                <View style={[styles.evBadge, { backgroundColor: colors.radiant + '22', borderColor: colors.radiant + '55' }]}>
                  <Text style={[styles.evBadgeText, { color: colors.radiant }]}>
                    +ОЦ {(bestMarket.prediction.ev * 100).toFixed(0)}%
                  </Text>
                </View>
              )}
            </View>

            {(() => {
              // Для тотал-рынков метки — «ТБ» / «ТМ», а не имена команд.
              // Иначе пользователь читает 52% «ТБ 52.5» как вероятность победы
              // одной из команд, что вводит в заблуждение.
              const isTotal = bestMarket.type === 'total_kills' || bestMarket.type === 'total_duration';
              const t1Label = isTotal ? 'ТБ' : match.team1.shortName;
              const t2Label = isTotal ? 'ТМ' : match.team2.shortName;
              // Для тоталов букмекерские коэфы — winner-коэфы, не тотал-коэфы.
              // Сравнивать их с total_kills-вероятностью некорректно → обнуляем.
              const oddsT1 = isTotal ? 0 : bestMarket.bestOdds.oddsTeam1;
              const oddsT2 = isTotal ? 0 : bestMarket.bestOdds.oddsTeam2;
              const fair1  = isTotal ? 0 : bestMarket.bestOdds.fairProbTeam1;
              const edge   = isTotal ? 0 : bestMarket.prediction.edge;
              const ev     = isTotal ? 0 : bestMarket.prediction.ev;
              return (
                <OddsTilesPair
                  team1Label={t1Label}
                  team2Label={t2Label}
                  modelProbTeam1={bestMarket.prediction.modelProbability}
                  fairProbTeam1={fair1}
                  oddsTeam1={oddsT1}
                  oddsTeam2={oddsT2}
                  bookmakerName={isTotal ? '' : bestMarket.bestOdds.bookmakerName}
                  edgeTeam1={edge}
                  evTeam1={ev}
                  confidence={bestMarket.prediction.confidence}
                  onPressTeam1={onPress}
                  onPressTeam2={onPress}
                />
              );
            })()}
          </View>
        ) : predictionStatus === 'unavailable' ? (
          /* Модель честно вернула null (нет данных по команде / dim mismatch).
             НЕ показываем 50/50 — это вводит пользователя в заблуждение. */
          <View style={[styles.pendingSection, { borderTopColor: colors.borderGold + '33' }]}>
            <Text style={[styles.pendingText, { color: colors.mutedForeground }]}>
              Прогноз недоступен
            </Text>
          </View>
        ) : (
          /* Прогноз ещё не подгружен (см. fetchLiveData в LiveDataService.ts —
             карточки рендерятся мгновенно, ML догружается асинхронно по
             приоритету сверху списка вниз). */
          <View style={[styles.pendingSection, { borderTopColor: colors.borderGold + '33' }]}>
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text style={[styles.pendingText, { color: colors.mutedForeground }]}>
              Данные собираются, скоро выдадим прогноз
            </Text>
          </View>
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
  pendingSection: {
    borderTopWidth: 1,
    paddingTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pendingText: {
    fontFamily: 'Forum_400Regular',
    fontSize: 11,
    letterSpacing: 0.3,
    flex: 1,
  },
  marketHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  marketLabel: { fontFamily: 'Cinzel_500Medium', fontSize: 10, letterSpacing: 1.4 },
  edgeBadge: {
    borderRadius: 2,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  edgeBadgeText: { fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 0.8 },
  evBadge: {
    borderRadius: 2,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  evBadgeText: { fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 0.8 },
});

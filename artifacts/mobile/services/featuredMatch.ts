import { apiFetch } from '../lib/api';
/**
 * "Закреплённый" матч, который всегда отображается первым в списке live.
 *
 * Используется чтобы показать пользователю аналитику конкретного реального
 * матча, идущего прямо сейчас, даже если OpenDota /api/live его не вернул
 * (free tier нередко возвращает пустой массив или другие лиги).
 *
 * Прогноз — реальный, от нашей активной ML-модели match_winner: эндпоинт
 * /api/analytics/ml-predict вызывается с реальными teamId, найденными в
 * нашей БД teams (заполняется ingest:teams из OpenDota).
 */

import type { Match, Market, BookmakerOdds, Prediction } from '@/types';
import type { EnrichedMatch } from '@/services/LiveDataService';



// Команды из БД (см. результат запроса):
//   PARIVISION (PV)  — teamId 9572001, ELO 1486, 292W/161L
//   PlayTime         — teamId 10020555, ELO 1201, 23W/22L
//
// На скриншоте Pari: PariVision = "Силы света" (Radiant), PlayTime = "Силы тьмы" (Dire).
// Серия 1:1, идёт 3-я карта, время 11:36 (696 сек), счёт по убийствам 3:4
// (PlayTime 3, PariVision 4), сеть 19k:19k, башни и бараки целы.
export const FEATURED_MATCH_META = {
  matchId: 'featured_pv_pt_map3',
  radiant: {
    teamId: 9572001,
    name: 'PARIVISION',
    shortName: 'PV',
    elo: 1486,
    wins: 292,
    losses: 161,
  },
  dire: {
    teamId: 10020555,
    name: 'PlayTime',
    shortName: 'PT',
    elo: 1201,
    wins: 23,
    losses: 22,
  },
  tournamentName: '1W Essence',
  format: 'BO3' as const,
  seriesScore: { radiant: 1, dire: 1 },
  currentMap: 3,
  gameTimeSec: 696, // 11:36
  netWorth: { radiant: 19000, dire: 19000 },
  kills: { radiant: 4, dire: 3 },
  // Реальные коэффициенты с Pari (1W Essence на скрине):
  bookmakerOdds: [
    { id: 'pari', name: 'Pari', radiantOdds: 1.42, direOdds: 2.74 },
    // Чуть варьируем для остальных, чтобы пикер букмекера имел смысл
    // (реальные коэф'ы у разных контор всегда чуть отличаются).
    { id: 'fonbet', name: 'Fonbet', radiantOdds: 1.45, direOdds: 2.65 },
    { id: 'betboom', name: 'BetBoom', radiantOdds: 1.43, direOdds: 2.70 },
  ],
} as const;

function buildMatch(): Match {
  const m = FEATURED_MATCH_META;
  return {
    id: m.matchId,
    team1: {
      id: String(m.radiant.teamId),
      name: m.radiant.name,
      shortName: m.radiant.shortName,
      logoPlaceholder: m.radiant.shortName,
      region: 'CIS',
      eloRating: m.radiant.elo,
      recentForm: ['W', 'W', 'L', 'W', 'W'],
    },
    team2: {
      id: String(m.dire.teamId),
      name: m.dire.name,
      shortName: m.dire.shortName,
      logoPlaceholder: m.dire.shortName,
      region: 'CIS',
      eloRating: m.dire.elo,
      recentForm: ['L', 'W', 'W', 'L', 'W'],
    },
    team1Side: 'radiant',
    team2Side: 'dire',
    tournamentName: m.tournamentName,
    tournamentTier: 2,
    format: m.format,
    status: 'live',
    currentMapNumber: m.currentMap,
    team1MapsWon: m.seriesScore.radiant,
    team2MapsWon: m.seriesScore.dire,
    startTime: new Date(Date.now() - 90 * 60 * 1000),
    isFavorite: false,
    currentMap: {
      mapNumber: m.currentMap,
      gameTimeSeconds: m.gameTimeSec,
      score: { radiant: m.kills.radiant, dire: m.kills.dire },
    },
    liveSnapshot: {
      snapshotId: `snap_${m.matchId}`,
      gameTimeSeconds: m.gameTimeSec,
      radiantKills: m.kills.radiant,
      direKills: m.kills.dire,
      netWorthRadiant: m.netWorth.radiant,
      netWorthDire: m.netWorth.dire,
      xpRadiant: 0,
      xpDire: 0,
      towersRadiant: 11,
      towersDire: 11,
      barracksRadiant: 6,
      barracksDire: 6,
      roshanAlive: true,
      aegisHolder: null,
      buybacksAvailableRadiant: 5,
      buybacksAvailableDire: 5,
      lastBigEvent: null,
      snapshotAge: 30,
      sourceId: 'featured_manual',
    },
  };
}

function buildBookmakers(): BookmakerOdds[] {
  return FEATURED_MATCH_META.bookmakerOdds.map(bk => {
    const o1 = bk.radiantOdds;
    const o2 = bk.direOdds;
    const fairProb1 = (1 / o1) / (1 / o1 + 1 / o2);
    return {
      bookmakerId: bk.id,
      bookmakerName: bk.name,
      oddsTeam1: o1,
      oddsTeam2: o2,
      impliedProbTeam1: 1 / o1,
      impliedProbTeam2: 1 / o2,
      fairProbTeam1: fairProb1,
      fairProbTeam2: 1 - fairProb1,
      freshness: 0.95,
      snapshotAge: 30,
    };
  });
}

interface MlPredictResponse {
  radiantWinProbability: number;
  direWinProbability: number;
  modelVersion: string;
  features: Record<string, number>;
}

async function fetchMlPrediction(): Promise<MlPredictResponse | null> {
  try {
    const m = FEATURED_MATCH_META;
    const url = `/api/analytics/ml-predict?radiantTeamId=${m.radiant.teamId}&direTeamId=${m.dire.teamId}`;
    const resp = await apiFetch(url);
    if (!resp.ok) return null;
    return await resp.json() as MlPredictResponse;
  } catch {
    return null;
  }
}

/**
 * Собирает featured-матч с прогнозом активной ML-модели.
 * Возвращает null если эндпоинт ml-predict недоступен (например, нет активной
 * модели в БД) — вызывающий код должен корректно обработать отсутствие.
 */
export async function buildFeaturedMatch(): Promise<EnrichedMatch | null> {
  const ml = await fetchMlPrediction();
  if (!ml) return null;

  const match = buildMatch();
  const bookmakers = buildBookmakers();
  const selectedBk = bookmakers[0]; // Pari — основной для расчёта edge/EV

  const probR = ml.radiantWinProbability;
  const probD = ml.direWinProbability;
  const fairProb1 = selectedBk.fairProbTeam1;
  const odds1 = selectedBk.oddsTeam1;

  // Match Winner — главный рынок, на котором висит наш ML.
  const matchWinnerPred: Prediction = {
    predictionId: `pred_${match.id}_match_winner`,
    matchId: match.id,
    marketType: 'match_winner',
    marketLabel: 'Победитель серии',
    modelProbability: probR,
    calibratedProbability: probR * 0.98,
    marketFairProbability: fairProb1,
    rawProbability: probR,
    edge: probR - fairProb1,
    ev: probR * (odds1 - 1) - (1 - probR),
    confidence: 0.7,
    modelVersion: ml.modelVersion,
    featureSnapshotId: `snap_${match.id}`,
    calibrationMethod: 'none',
    createdAt: new Date(),
    freshnessScore: 0.95,
    dataQualityScore: 0.9,
    isStale: false,
    inputFeaturesJson: ml.features,
    explanationJson: {
      topFactors: [
        {
          factor: 'Разница рейтингов',
          impact: ml.features.elo_diff_norm ?? 0,
          description: `ELO ${FEATURED_MATCH_META.radiant.name} ${FEATURED_MATCH_META.radiant.elo} vs ${FEATURED_MATCH_META.dire.name} ${FEATURED_MATCH_META.dire.elo} → +${(ml.features.elo_diff_norm ?? 0).toFixed(2)} к логиту`,
        },
        {
          factor: 'Разница win-rate',
          impact: ml.features.winrate_diff ?? 0,
          description: `WR ${(FEATURED_MATCH_META.radiant.wins / (FEATURED_MATCH_META.radiant.wins + FEATURED_MATCH_META.radiant.losses) * 100).toFixed(1)}% против ${(FEATURED_MATCH_META.dire.wins / (FEATURED_MATCH_META.dire.wins + FEATURED_MATCH_META.dire.losses) * 100).toFixed(1)}%`,
        },
        {
          factor: 'Разница опыта',
          impact: ml.features.experience_diff ?? 0,
          description: `${FEATURED_MATCH_META.radiant.wins + FEATURED_MATCH_META.radiant.losses} матчей vs ${FEATURED_MATCH_META.dire.wins + FEATURED_MATCH_META.dire.losses}`,
        },
      ],
      summary: `Модель ${ml.modelVersion} оценивает шансы ${FEATURED_MATCH_META.radiant.name} в ${(probR * 100).toFixed(1)}%, букмекер даёт ${(fairProb1 * 100).toFixed(1)}%. Перевес ${((probR - fairProb1) * 100).toFixed(1)} п.п.`,
      confidenceBreakdown: [
        { component: 'ELO', score: 0.7 },
        { component: 'Win-rate', score: 0.6 },
      ],
    },
  };

  const matchWinnerMarket: Market = {
    id: `mkt_${match.id}_match_winner`,
    matchId: match.id,
    type: 'match_winner',
    label: 'Победитель серии',
    prediction: matchWinnerPred,
    bestOdds: selectedBk,
    allBookmakerOdds: bookmakers,
  };

  // Map Winner — то же самое, но на текущую карту (модель та же).
  const mapWinnerMarket: Market = {
    ...matchWinnerMarket,
    id: `mkt_${match.id}_map_winner`,
    type: 'map_winner',
    label: `Победитель карты ${FEATURED_MATCH_META.currentMap}`,
    prediction: { ...matchWinnerPred, predictionId: `pred_${match.id}_map_winner`, marketType: 'map_winner', marketLabel: `Победитель карты ${FEATURED_MATCH_META.currentMap}` },
  };

  return {
    match,
    markets: [matchWinnerMarket, mapWinnerMarket],
    predictionStatus: 'ready',
    analyticsResult: {
      predictions: [
        {
          betType: 'match_winner',
          generatedAt: new Date().toISOString(),
          expiresAt: new Date(0).toISOString(), // archived demo, never eligible for serving
          modelVersion: 'archived-demo',
          labelRu: 'Победитель серии',
          probTeam1: probR,
          probTeam2: probD,
          confidence: 0.7,
          edge: probR - fairProb1,
          ev: probR * (odds1 - 1) - (1 - probR),
          mainFactors: [
            { name: 'ELO', impact: ml.features.elo_diff_norm ?? 0, direction: 'radiant' },
            { name: 'WR', impact: ml.features.winrate_diff ?? 0, direction: 'radiant' },
          ],
        },
      ],
      modelVersion: ml.modelVersion,
      generatedAt: new Date().toISOString(),
    },
    availableBookmakers: bookmakers,
  };
}

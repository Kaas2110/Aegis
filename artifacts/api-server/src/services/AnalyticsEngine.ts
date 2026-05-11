/**
 * Оркестратор аналитического движка.
 * Принимает сырые данные матча → нормализует в FeatureVector → запускает все 15 моделей.
 *
 * ML-план (следующий шаг):
 * - Заменить математические модели на LightGBM через Python FastAPI сервис
 * - Автопереобучение раз в неделю на данных последних 3-4 патчей (6-12 мес)
 * - A/B тестирование версий моделей по предсказательной силе (Brier score)
 */

import type { FeatureVector, BetPrediction, BO3Stage } from './BetTypeModels';
import {
  predictMatchWinner, predictMapWinner, predictFirstBlood, predictFirstTower,
  predictFirstRoshan, predictTotalKills, predictTotalDuration, predictMapHandicap,
  predictCorrectScoreAsBet, predictComeback, predictNetWorthLead,
  predictFirstBarracks, predictOverUnderMaps, predictKillsHandicap, predictDraftAdvantage,
} from './BetTypeModels';

export interface MatchInput {
  matchId: string;
  team1: { name: string; elo?: number; form?: number[]; region?: string };
  team2: { name: string; elo?: number; form?: number[]; region?: string };
  format: 'BO1' | 'BO3' | 'BO5';
  tournamentTier?: 1 | 2 | 3;
  draft?: {
    synergy1?: number; synergy2?: number;
    counter1?: number; counter2?: number;
    scaling1?: number; scaling2?: number;
    early1?: number; early2?: number;
  };
  liveSnapshot?: {
    netWorthLead: number;  // >0 = team1/radiant leads
    killsLead: number;
    towerLead: number;
    barracksLost: number;
    aegisHolder: 1 | 2 | null;
    buybackDisadv: number;
    gameTimeSec: number;
  };
  // H2H winrate команды 1 против команды 2
  h2hWinRate1?: number;
  // Wave 3.A — контекст BO3/BO5 серии (если матч является картой серии).
  // seriesScore1/2 — текущий счёт серии (карт) до этой карты.
  seriesContext?: {
    seriesScore1: number;
    seriesScore2: number;
  };
}

/** Из счёта серии и формата выводим стадию для FeatureVector.stage. */
function deriveStage(
  format: 'BO1' | 'BO3' | 'BO5',
  s1: number,
  s2: number,
): BO3Stage | undefined {
  if (format === 'BO1') return undefined;
  if (s1 === 0 && s2 === 0) return 'map1';
  if (format === 'BO3') {
    if (s1 === 1 && s2 === 0) return 'map2_after_10';
    if (s1 === 0 && s2 === 1) return 'map2_after_01';
    if (s1 === 1 && s2 === 1) return 'map3_decider';
    return undefined;
  }
  // BO5
  if (s1 === 1 && s2 === 0) return 'map2_after_10';
  if (s1 === 0 && s2 === 1) return 'map2_after_01';
  if (s1 === 2 && s2 === 1) return 'map4_after_21';
  if (s1 === 1 && s2 === 2) return 'map4_after_12';
  if (s1 === 2 && s2 === 2) return 'map3_decider';
  return undefined;
}

export interface EnrichedPrediction extends BetPrediction {
  matchId: string;
  edge: number;           // edge vs bookmaker (если odds переданы)
  ev: number;             // expected value (если odds переданы)
  bookmakerOdds1?: number;
  bookmakerOdds2?: number;
  generatedAt: string;
}

export interface AnalyticsResult {
  matchId: string;
  team1Name: string;
  team2Name: string;
  predictions: EnrichedPrediction[];
  featureVector: FeatureVector;
  generatedAt: string;
  modelVersion: string;
}

/** Форма: [W,L,W,W,L] → weighted score 0..1 */
function calcFormScore(form: number[] | string[]): number {
  if (!form || form.length === 0) return 0.5;
  const weights = [0.30, 0.25, 0.20, 0.15, 0.10];
  let score = 0;
  let totalW = 0;
  for (let i = 0; i < Math.min(form.length, 5); i++) {
    const win = form[i] === 1 || form[i] === 'W' ? 1 : 0;
    score += win * weights[i];
    totalW += weights[i];
  }
  return totalW > 0 ? score / totalW : 0.5;
}

/** Нормализует MatchInput в FeatureVector */
function buildFeatureVector(input: MatchInput): FeatureVector {
  const elo1 = input.team1.elo ?? 1700;
  const elo2 = input.team2.elo ?? 1700;
  const form1 = calcFormScore(input.team1.form ?? []);
  const form2 = calcFormScore(input.team2.form ?? []);
  const draft = input.draft ?? {};
  const snap = input.liveSnapshot;

  const s1 = input.seriesContext?.seriesScore1 ?? 0;
  const s2 = input.seriesContext?.seriesScore2 ?? 0;
  return {
    elo1,
    elo2,
    form1,
    form2,
    h2hWinRate1: input.h2hWinRate1 ?? 0.5,
    draftSynergy1: draft.synergy1 ?? 0.5,
    draftSynergy2: draft.synergy2 ?? 0.5,
    draftCounter1: draft.counter1 ?? 0.5,
    draftCounter2: draft.counter2 ?? 0.5,
    scalingScore1: draft.scaling1 ?? 0.5,
    scalingScore2: draft.scaling2 ?? 0.5,
    earlyScore1: draft.early1 ?? 0.5,
    earlyScore2: draft.early2 ?? 0.5,
    netWorthLead: snap?.netWorthLead,
    killsLead: snap?.killsLead,
    towerLead: snap?.towerLead,
    barracksLost: snap?.barracksLost,
    aegisHolder: snap?.aegisHolder,
    buybackDisadv: snap?.buybackDisadv,
    gameTimeSec: snap?.gameTimeSec,
    matchFormat: input.format,
    tournamentTier: input.tournamentTier ?? 2,
    isLive: !!snap,
    seriesScore1: s1,
    seriesScore2: s2,
    stage: input.seriesContext ? deriveStage(input.format, s1, s2) : undefined,
  };
}

/** Рассчитывает EV и Edge относительно переданных odds */
function enrichWithOdds(
  pred: BetPrediction,
  odds1?: number,
  odds2?: number,
): EnrichedPrediction {
  let edge = 0;
  let ev = 0;

  if (odds1 && odds2) {
    const fairProb1 = (1 / odds1) / (1 / odds1 + 1 / odds2);
    edge = pred.probTeam1 - fairProb1;
    ev = pred.probTeam1 * (odds1 - 1) - (1 - pred.probTeam1);
  }

  return {
    ...pred,
    matchId: '',
    edge,
    ev,
    bookmakerOdds1: odds1,
    bookmakerOdds2: odds2,
    generatedAt: new Date().toISOString(),
  };
}

export function runAnalytics(
  input: MatchInput,
  bookmakerOdds?: { odds1: number; odds2: number },
): AnalyticsResult {
  const fv = buildFeatureVector(input);
  const now = new Date().toISOString();

  const rawPredictions: BetPrediction[] = [
    predictMatchWinner(fv),
    predictMapWinner(fv, 1),
    predictFirstBlood(fv),
    predictFirstTower(fv),
    predictFirstRoshan(fv),
    predictTotalKills(fv),
    predictTotalDuration(fv),
    predictMapHandicap(fv),
    predictCorrectScoreAsBet(fv),
    predictComeback(fv),
    predictNetWorthLead(fv),
    predictFirstBarracks(fv),
    predictOverUnderMaps(fv),
    predictKillsHandicap(fv),
    predictDraftAdvantage(fv),
  ];

  // Для live матчей фильтруем только актуальные ставки
  const filteredPreds = fv.isLive
    ? rawPredictions
    : rawPredictions.filter(p => !p.isLiveOnly);

  const enriched: EnrichedPrediction[] = filteredPreds.map(p => {
    const e = enrichWithOdds(p, bookmakerOdds?.odds1, bookmakerOdds?.odds2);
    return { ...e, matchId: input.matchId };
  });

  return {
    matchId: input.matchId,
    team1Name: input.team1.name,
    team2Name: input.team2.name,
    predictions: enriched,
    featureVector: fv,
    generatedAt: now,
    modelVersion: 'math_v1.0.0',
  };
}

/**
 * Движок «популярных рынков» для режима БЕЗ букмекера (useBookmakerOdds=false).
 *
 * Идея: букмекер мы не парсим → не знаем, какие линии он выставил. Но статистика
 * pro Dota 2 хорошо известна, и мы можем для типичных популярных рынков
 * рассчитать справедливую вероятность из текущих фичей и live-снапшота.
 *
 * Работает в двух режимах:
 *   1) Прематч (нет liveSnapshot)  — выдаёт прогнозы по самым популярным
 *      разрезам: победитель, фора по картам, тотал убийств 52.5, тотал
 *      длительности 42 мин, первая кровь, первая башня.
 *   2) Лайв (есть liveSnapshot)    — добавляет conditional forecasts:
 *      - проектирует тотал убийств до конца игры из текущего темпа
 *        (kills_per_min × ожид. оставшееся время)
 *      - проектирует длительность матча из текущего net-worth lead и темпа
 *        разрушения башен
 *      - победитель с live-коррекцией (уже встроено в predictMatchWinner)
 *
 * Возвращает массив pretty-named карточек, готовых к отображению в мобилке
 * под заголовком «Популярные ставки» когда букмекер выключен.
 */

import {
  predictMatchWinner, predictTotalKills, predictTotalDuration,
  predictFirstBlood, predictFirstTower, predictMapHandicap, predictCorrectScoreAsBet,
  predictMapWinner,
  type FeatureVector, type BetPrediction,
} from './BetTypeModels';
import { probLogNormalOver } from './MarketLgbm';

export interface PopularMarketCard {
  betType: string;
  labelRu: string;
  /** Что мы рекомендуем (например «ТБ 52.5» или «П1 -1.5») */
  recommendation: string;
  /** Вероятность исхода рекомендации, 0..1 */
  probability: number;
  /** Справедливый коэффициент = 1/probability */
  fairOdds: number;
  confidence: number;
  /** Причина почему рекомендуем именно этот исход */
  rationale: string;
  /** Видимо только в live-режиме: проекция на остаток матча */
  liveProjection?: {
    currentMinute: number;
    currentKills: number;
    projectedFinalKills: number;
    projectedDurationMin: number;
  };
}

/** Очень дешёвая population-aware популярная линия для тотала убийств */
function popularKillsLine(expected: number): number {
  // Округляем до .5: 47.3 → 47.5, 53.8 → 53.5
  const r = Math.round(expected);
  return Math.abs(expected - r) < 0.25 ? r + 0.5 : r + (expected > r ? 0.5 : -0.5);
}

/** Та же логика для линии длительности */
function popularDurationLine(expectedMin: number): number {
  return Math.round(expectedMin * 2) / 2; // округление до 0.5
}

function pickHigher(p: number): { side: 'over' | 'under'; prob: number } {
  return p >= 0.5 ? { side: 'over', prob: p } : { side: 'under', prob: 1 - p };
}

/** Конвертирует BetPrediction в PopularMarketCard выбирая более вероятную сторону */
function bestSideCard(
  pred: BetPrediction,
  team1Name: string,
  team2Name: string,
  rationale: string,
): PopularMarketCard {
  const t1Wins = pred.probTeam1 >= pred.probTeam2;
  const prob = t1Wins ? pred.probTeam1 : pred.probTeam2;
  const teamLabel = t1Wins ? team1Name : team2Name;
  return {
    betType: pred.betType,
    labelRu: pred.labelRu,
    recommendation: teamLabel,
    probability: prob,
    fairOdds: 1 / Math.max(prob, 0.01),
    confidence: pred.confidence,
    rationale,
  };
}

export interface BuildPopularMarketsInput {
  features: FeatureVector;
  team1Name: string;
  team2Name: string;
  /**
   * Опциональные LGB-override'ы (Wave 4). Если переданы — переопределяют
   * heuristic вероятности для соответствующих рынков. Mean/std из ml-service —
   * в log-пространстве (label = log(value)).
   */
  lgbOverrides?: {
    firstBloodP: number | null;
    totalKillsLogN: { mean: number; std: number } | null;
    totalDurationLogN: { mean: number; std: number } | null;
  };
}

export function buildPopularMarkets(input: BuildPopularMarketsInput): PopularMarketCard[] {
  const { features: f, team1Name, team2Name, lgbOverrides } = input;
  const cards: PopularMarketCard[] = [];

  // 1) Победитель матча — всегда первый
  const winner = predictMatchWinner(f);
  cards.push(bestSideCard(
    winner, team1Name, team2Name,
    f.isLive
      ? `Текущий перевес ${(f.netWorthLead ?? 0) > 0 ? team1Name : team2Name} по нетворту — ${Math.abs(f.netWorthLead ?? 0)}`
      : `ELO ${Math.round(f.elo1)} vs ${Math.round(f.elo2)}, форма ${(f.form1*100).toFixed(0)}% vs ${(f.form2*100).toFixed(0)}%`,
  ));

  // 2) Победитель карты — если live или формат не BO1
  if (f.isLive || f.matchFormat !== 'BO1') {
    const map = predictMapWinner(f, 1);
    cards.push(bestSideCard(map, team1Name, team2Name, 'Учтён radiant-bias и сила ранней игры'));
  }

  // 3) Тотал убийств — выбираем популярную линию из прогноза
  const pace1 = f.earlyScore1 * 0.7 + f.form1 * 0.3;
  const pace2 = f.earlyScore2 * 0.7 + f.form2 * 0.3;
  const expectedKillsPrematch = 38 + ((pace1 + pace2) / 2) * 30;
  let popularKills = popularKillsLine(expectedKillsPrematch);
  let killsRationale = `Темп команд указывает на ~${expectedKillsPrematch.toFixed(0)} убийств за матч`;

  let liveProjection: PopularMarketCard['liveProjection'];
  if (f.isLive && f.gameTimeSec && f.gameTimeSec > 60) {
    // Live-проекция: kills_so_far + (kills_per_min × оставшиеся минуты)
    const minutesPlayed = f.gameTimeSec / 60;
    const killsSoFar = Math.abs(f.killsLead ?? 0) + Math.max(2, minutesPlayed * 1.2 - Math.abs(f.killsLead ?? 0));
    // ↑ грубая оценка общего числа убийств (kill_lead — разница, не сумма)
    const killsPerMin = Math.max(0.4, killsSoFar / minutesPlayed);
    // Ожид. конец игры: 35 мин из истории, корректируем
    const estimatedTotalDurationMin = Math.max(minutesPlayed + 5, 35);
    const projectedKills = killsSoFar + killsPerMin * (estimatedTotalDurationMin - minutesPlayed);
    popularKills = popularKillsLine(projectedKills);
    killsRationale = `На ${minutesPlayed.toFixed(0)} мин темп ${killsPerMin.toFixed(1)} kills/min → проекция ~${Math.round(projectedKills)} к концу игры`;
    liveProjection = {
      currentMinute: Math.round(minutesPlayed),
      currentKills: Math.round(killsSoFar),
      projectedFinalKills: Math.round(projectedKills),
      projectedDurationMin: Math.round(estimatedTotalDurationMin),
    };
  }
  const tk = predictTotalKills(f, popularKills);
  const lgbKills = lgbOverrides?.totalKillsLogN ?? null;
  if (lgbKills) {
    tk.probTeam1 = probLogNormalOver(popularKills, lgbKills.mean, lgbKills.std);
    tk.probTeam2 = 1 - tk.probTeam1;
    tk.confidence = 0.72;
  }
  const tkSide = pickHigher(tk.probTeam1);
  cards.push({
    betType: 'total_kills',
    labelRu: `Тотал убийств ${tkSide.side === 'over' ? 'больше' : 'меньше'} ${popularKills}`,
    recommendation: tkSide.side === 'over' ? `ТБ ${popularKills}` : `ТМ ${popularKills}`,
    probability: tkSide.prob,
    fairOdds: 1 / Math.max(tkSide.prob, 0.01),
    confidence: tk.confidence,
    rationale: killsRationale,
    liveProjection,
  });

  // 4) Тотал длительности
  const scalingAvg = (f.scalingScore1 + f.scalingScore2) / 2;
  const expectedDur = 28 + scalingAvg * 24;
  const popularDur = popularDurationLine(expectedDur);
  const td = predictTotalDuration(f, popularDur);
  const lgbDur = lgbOverrides?.totalDurationLogN ?? null;
  if (lgbDur) {
    td.probTeam1 = probLogNormalOver(popularDur * 60, lgbDur.mean, lgbDur.std);
    td.probTeam2 = 1 - td.probTeam1;
    td.confidence = 0.72;
  }
  const tdSide = pickHigher(td.probTeam1);
  cards.push({
    betType: 'total_duration',
    labelRu: `Длительность ${tdSide.side === 'over' ? 'больше' : 'меньше'} ${popularDur} мин`,
    recommendation: tdSide.side === 'over' ? `ТБ ${popularDur} мин` : `ТМ ${popularDur} мин`,
    probability: tdSide.prob,
    fairOdds: 1 / Math.max(tdSide.prob, 0.01),
    confidence: td.confidence,
    rationale: scalingAvg > 0.6 ? 'Поздний драфт у обеих команд → дольше' : 'Ранний драфт → быстрее',
  });

  // 5) Первая кровь
  const fb = predictFirstBlood(f);
  if (lgbOverrides?.firstBloodP != null) {
    fb.probTeam1 = lgbOverrides.firstBloodP;
    fb.probTeam2 = 1 - lgbOverrides.firstBloodP;
    fb.confidence = 0.66;
  }
  cards.push(bestSideCard(fb, team1Name, team2Name, lgbOverrides?.firstBloodP != null ? 'LGBM team-rating модель' : 'Агрессивность пиков и форма'));

  // 6) Первая башня (только прематч / самое начало live)
  if (!f.isLive || (f.gameTimeSec ?? 0) < 600) {
    const ft = predictFirstTower(f);
    cards.push(bestSideCard(ft, team1Name, team2Name, 'Качество лайнинга'));
  }

  // 7) Гандикап -1.5 (для BO3+)
  if (f.matchFormat !== 'BO1') {
    const handi = predictMapHandicap(f);
    cards.push(bestSideCard(handi, team1Name, team2Name, 'Расчёт через P(2-0) для BO3'));
  }

  // 8) Точный счёт BO3
  if (f.matchFormat === 'BO3') {
    const cs = predictCorrectScoreAsBet(f);
    cards.push({
      betType: 'correct_score',
      labelRu: cs.labelRu,
      recommendation: cs.probTeam1 > cs.probTeam2 ? '2-0 / 0-2 (быстрая серия)' : '2-1 / 1-2 (3 карты)',
      probability: Math.max(cs.probTeam1, cs.probTeam2),
      fairOdds: 1 / Math.max(Math.max(cs.probTeam1, cs.probTeam2), 0.01),
      confidence: cs.confidence,
      rationale: 'Биномиальная модель из вероятности победы',
    });
  }

  // Сортируем по вероятности (наиболее уверенные — наверх)
  return cards.sort((a, b) => b.probability * b.confidence - a.probability * a.confidence);
}

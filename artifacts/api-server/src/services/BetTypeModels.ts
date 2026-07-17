/**
 * Математические модели для 15 типов ставок Dota 2.
 * Каждая функция принимает нормализованный вектор признаков (FeatureVector)
 * и возвращает BetPrediction с вероятностью, уверенностью и факторами.
 *
 * Архитектура:
 * - Сейчас: детерминированные математические модели (без ML)
 * - Следующий шаг: замена на LightGBM-модели через Python ML-сервис (см. /api/ml)
 */

/**
 * Стадия серии. Wave 3.A — стадия влияет на:
 *  - side advantage (radiant_bonus): на map 2 фиксируется side switch,
 *    momentum победителя map 1 — небольшой бонус к p(map2_win).
 *  - correct_score / over_under_maps / handicap: рынки конpdиционируются
 *    по фактическому счёту серии, а не предполагают i.i.d. карты (не p²).
 *
 * 'map1'           — серия ещё не началась или мы на первой карте.
 * 'map2_after_10'  — серия 1-0 в пользу команды 1.
 * 'map2_after_01'  — серия 0-1 в пользу команды 2.
 * 'map3_decider'   — счёт 1-1 (только в BO3) или 2-2 (BO5).
 * 'map4_after_21'  — BO5 счёт 2-1 в пользу команды 1.
 * 'map4_after_12'  — BO5 счёт 1-2 в пользу команды 2.
 */
export type BO3Stage =
  | 'map1'
  | 'map2_after_10'
  | 'map2_after_01'
  | 'map3_decider'
  | 'map4_after_21'
  | 'map4_after_12';

export interface FeatureVector {
  // Командные фичи
  elo1: number;           // ELO команды 1 (Radiant)
  elo2: number;           // ELO команды 2 (Dire)
  form1: number;          // Форма команды 1: 0..1 (последние 5 игр)
  form2: number;          // Форма команды 2
  h2hWinRate1: number;    // H2H winrate команды 1: 0..1
  // Дraft фичи
  draftSynergy1: number;  // Синергия пиков команды 1: 0..1
  draftSynergy2: number;
  draftCounter1: number;  // Контрпики команды 1: 0..1
  draftCounter2: number;
  scalingScore1: number;  // Потенциал поздней игры: 0..1
  scalingScore2: number;
  earlyScore1: number;    // Потенциал ранней игры: 0..1
  earlyScore2: number;
  // Live фичи (опциональны, только для live-матчей)
  netWorthLead?: number;   // Разница networth: >0 = radiant лидирует
  killsLead?: number;      // Разница убийств
  towerLead?: number;      // Разница башен
  barracksLost?: number;   // Потеряно казарм всего
  aegisHolder?: 1 | 2 | null; // Кто держит эгиду
  buybackDisadv?: number;  // Кол-во buyback недоступно у проигрывающей команды
  gameTimeSec?: number;    // Время игры в секундах
  // Мета
  matchFormat: 'BO1' | 'BO3' | 'BO5';
  tournamentTier: 1 | 2 | 3;
  isLive: boolean;
  // Wave 3.A — BO3/BO5 staging
  stage?: BO3Stage;
  seriesScore1?: number;   // карт выиграно командой 1 в текущей серии
  seriesScore2?: number;
}

export interface BetPrediction {
  betType: string;
  label: string;
  labelRu: string;
  probTeam1: number;      // Вероятность результата для команды 1
  probTeam2: number;      // Вероятность результата для команды 2
  confidence: number;     // 0..1, уверенность модели
  mainFactors: Array<{ name: string; impact: number; direction: 'up' | 'down' | 'neutral' }>;
  modelVersion: string;
  isLiveOnly: boolean;
}

const MODEL_VERSION = 'math_v1.0.0';

// ─── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Базовая Elo-вероятность победы команды 1 */
function eloProb(elo1: number, elo2: number): number {
  return 1 / (1 + Math.pow(10, (elo2 - elo1) / 400));
}

/** Бонус форма: weighted sum последних 5 игр (последние важнее) */
function formBonus(form: number): number {
  return (form - 0.5) * 0.15; // ±0.075 max
}

function normalize(p: number): number {
  return Math.max(0.05, Math.min(0.95, p));
}

/** Чистый clamp в [0,1] — для условных вероятностей, где 0 и 1 валидны. */
function clamp01(p: number): number {
  if (!isFinite(p) || p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/** Биномиальный коэффициент C(n,k). n≤20 в наших задачах. */
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - i + 1)) / i;
  return r;
}

/**
 * P(команда X выигрывает best-of-target серию с маржой ≥2 карт)
 * conditional на текущем счёте (sX, sOther). Используем negative-binomial:
 *   P(X завершит series ровно при k доп. победах оппонента) =
 *     C(needX + k - 1, k) * pX^needX * qX^k
 * где последняя сыгранная карта — X. Margin ≥2 ⇒ итоговый sOther+k ≤ target-2.
 */
function pSeriesWinByMargin2(
  sX: number,
  sOther: number,
  pX: number,
  target: number,
): number {
  const needX = target - sX;
  if (needX <= 0) return sX - sOther >= 2 ? 1 : 0;
  const qX = 1 - pX;
  const maxK = (target - 2) - sOther;  // доп. побед оппонента, после которых X финиширует с margin≥2
  if (maxK < 0) return 0;
  let total = 0;
  for (let k = 0; k <= maxK; k++) {
    total += binom(needX + k - 1, k) * Math.pow(pX, needX) * Math.pow(qX, k);
  }
  return clamp01(total);
}

function confidence(
  features: FeatureVector,
  eloDiff: number,
  hasLiveData: boolean,
  hasDraft: boolean,
): number {
  let conf = 0.55; // base
  conf += Math.min(Math.abs(eloDiff) / 2000, 0.15); // большой разрыв Elo → увереннее
  if (hasDraft) conf += 0.10;
  if (hasLiveData) conf += 0.15;
  if (features.tournamentTier === 1) conf += 0.05; // T1 → более предсказуемо
  return Math.min(conf, 0.92);
}

// ─── СЕРИЙНАЯ МАТЕМАТИКА (Layer A) ─────────────────────────────────────────
//
// Все winner-модели (math и ML) обучены/откалиброваны на исходе СЕРИИ с 0:0.
// Когда серия уже идёт (1-0, 1-1, 2-1) — вероятность взять серию обязана
// пересчитываться. Делается аналитически:
//   1) invert: из P(серия|0:0) восстанавливаем per-map вероятность p
//   2) forward: P(серия | текущий счёт) из p по остатку серии.

/** Сколько карт нужно выиграть для взятия серии. */
function mapsToWin(format: string): number {
  if (format === 'BO1') return 1;
  if (format === 'BO2') return 2; // BO2 — обе карты для «победы 2-0»; трактуем как need 2
  if (format === 'BO5') return 3;
  return 2; // BO3
}

/** P(взять серию | нужно ещё w1 побед team1, w2 побед team2) при per-map p. */
function seriesProbRecursive(p: number, w1: number, w2: number): number {
  if (w1 <= 0) return 1;
  if (w2 <= 0) return 0;
  // мемоизация не нужна — глубина ≤ 5
  return p * seriesProbRecursive(p, w1 - 1, w2) + (1 - p) * seriesProbRecursive(p, w1, w2 - 1);
}

/** P(серия | счёт s1:s2) для per-map вероятности p. */
export function seriesWinProb(pMap: number, format: string, s1 = 0, s2 = 0): number {
  const need = mapsToWin(format);
  const w1 = Math.max(0, need - s1);
  const w2 = Math.max(0, need - s2);
  return clamp01(seriesProbRecursive(clamp01(pMap), w1, w2));
}

/**
 * Обратная задача: модельная вероятность q — это P(серия|0:0).
 * Ищем per-map p, при котором seriesWinProb(p,fmt,0,0)=q (бисекция).
 */
export function perMapProbFromSeries(qSeries: number, format: string): number {
  const q = Math.min(0.99, Math.max(0.01, qSeries));
  if (mapsToWin(format) === 1) return q;
  let lo = 0.01, hi = 0.99;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (seriesWinProb(mid, format, 0, 0) < q) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Пересчёт серийной вероятности с учётом текущего счёта.
 * qSeriesFrom00 — вероятность модели (прематч, с 0:0).
 */
export function adjustSeriesProbForScore(
  qSeriesFrom00: number,
  format: string,
  s1: number,
  s2: number,
): number {
  if (!s1 && !s2) return qSeriesFrom00;
  const pMap = perMapProbFromSeries(qSeriesFrom00, format);
  return seriesWinProb(pMap, format, s1, s2);
}

// ─── 1. ПОБЕДИТЕЛЬ МАТЧА ────────────────────────────────────────────────────

export function predictMatchWinner(f: FeatureVector): BetPrediction {
  const p_elo = eloProb(f.elo1, f.elo2);
  const p_form = formBonus(f.form1) - formBonus(f.form2);
  const p_h2h = (f.h2hWinRate1 - 0.5) * 0.10;
  const p_draft = (f.draftSynergy1 - f.draftSynergy2) * 0.08 + (f.draftCounter1 - f.draftCounter2) * 0.06;

  let p = p_elo + p_form + p_h2h + p_draft;

  // Live-коррекция
  if (f.isLive && f.netWorthLead !== undefined) {
    const nwFactor = sigmoid(f.netWorthLead / 8000) - 0.5; // ±0.5 max
    const timeFactor = Math.min((f.gameTimeSec ?? 0) / 3600, 1); // [0,1] — сколько прошло
    p += nwFactor * 0.4 * timeFactor;
    if (f.aegisHolder === 1) p += 0.04;
    if (f.aegisHolder === 2) p -= 0.04;
    if (f.buybackDisadv && f.buybackDisadv > 1) p += (f.netWorthLead ?? 0) > 0 ? 0.03 : -0.03;
  }

  p = normalize(p);

  // Layer A: серия уже идёт → пересчитываем P(серии) от текущего счёта.
  const ss1 = f.seriesScore1 ?? 0;
  const ss2 = f.seriesScore2 ?? 0;
  if ((ss1 > 0 || ss2 > 0) && f.matchFormat !== 'BO1') {
    p = adjustSeriesProbForScore(p, f.matchFormat, ss1, ss2);
  }

  const eloDiff = f.elo1 - f.elo2;

  return {
    betType: 'match_winner',
    label: 'Match Winner',
    labelRu: 'Победитель матча',
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: confidence(f, eloDiff, f.isLive, f.draftSynergy1 > 0),
    mainFactors: [
      { name: 'ELO', impact: Math.abs(p_elo - 0.5), direction: p_elo > 0.5 ? 'up' : 'down' },
      { name: 'Форма команды', impact: Math.abs(p_form), direction: p_form > 0 ? 'up' : 'down' },
      { name: 'H2H история', impact: Math.abs(p_h2h), direction: p_h2h > 0 ? 'up' : 'down' },
      { name: 'Дraft', impact: Math.abs(p_draft), direction: p_draft > 0 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 2. ПОБЕДИТЕЛЬ КАРТЫ ────────────────────────────────────────────────────
//
// Wave 3.A: учитываем стадию серии. На map 2/3 происходит side-switch,
// плюс добавляем небольшой momentum-бонус победителю предыдущей карты
// (статистически в проф. сцене ~+2.5% к p(победы) для команды, ведущей в серии).

export function predictMapWinner(f: FeatureVector, mapNumber = 1): BetPrediction {
  // База карты — per-map вероятность, а не серийная (серийная «острее»).
  // Считаем прогноз серии от 0:0 (без Layer A-коррекции) и инвертируем в per-map.
  const base = predictMatchWinner({ ...f, seriesScore1: 0, seriesScore2: 0 });
  const q00 = base.probTeam1;
  let p = f.matchFormat === 'BO1' ? q00 : perMapProbFromSeries(q00, f.matchFormat);
  // Базовый radiant-бонус (статистика проф-сцены ~+2% к стороне Radiant).
  const radiantBonus = f.matchFormat !== 'BO1' ? 0.025 : 0.02;
  p += radiantBonus * (f.earlyScore1 - 0.5);
  // Momentum по стадии серии.
  const s1 = f.seriesScore1 ?? 0;
  const s2 = f.seriesScore2 ?? 0;
  if (s1 > s2) p += 0.025;          // команда 1 ведёт
  else if (s2 > s1) p -= 0.025;     // ведёт команда 2
  p = normalize(p);

  return {
    ...base,
    betType: 'map_winner',
    label: `Map ${mapNumber} Winner`,
    labelRu: `Победитель карты ${mapNumber}`,
    probTeam1: p,
    probTeam2: 1 - p,
  };
}

// ─── 3. ПЕРВАЯ КРОВЬ ────────────────────────────────────────────────────────

export function predictFirstBlood(f: FeatureVector): BetPrediction {
  // Агрессивность: earlyScore = склонность к быстрой игре
  const aggr1 = f.earlyScore1;
  const aggr2 = f.earlyScore2;
  const p = normalize(aggr1 / (aggr1 + aggr2) + (f.form1 - f.form2) * 0.05);

  return {
    betType: 'first_blood',
    label: 'First Blood',
    labelRu: 'Первая кровь',
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: 0.58, // Первая кровь сложнее предсказать
    mainFactors: [
      { name: 'Агрессивность', impact: Math.abs(aggr1 - 0.5), direction: aggr1 > 0.5 ? 'up' : 'down' },
      { name: 'Early game', impact: 0.08, direction: 'neutral' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 4. ПЕРВАЯ БАШНЯ ────────────────────────────────────────────────────────

export function predictFirstTower(f: FeatureVector): BetPrediction {
  const laning1 = f.earlyScore1 * 0.6 + f.draftSynergy1 * 0.4;
  const laning2 = f.earlyScore2 * 0.6 + f.draftSynergy2 * 0.4;
  const p = normalize(laning1 / (laning1 + laning2));

  return {
    betType: 'first_tower',
    label: 'First Tower',
    labelRu: 'Первая башня',
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: 0.60,
    mainFactors: [
      { name: 'Лайнинг', impact: Math.abs(laning1 - laning2), direction: laning1 > laning2 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 5. ПЕРВЫЙ РОШАН ────────────────────────────────────────────────────────

export function predictFirstRoshan(f: FeatureVector): BetPrediction {
  // Рошан зависит от ранней силы + синергии дрэфта
  const roshanStr1 = f.earlyScore1 * 0.5 + f.draftSynergy1 * 0.5;
  const roshanStr2 = f.earlyScore2 * 0.5 + f.draftSynergy2 * 0.5;
  const p = normalize(roshanStr1 / (roshanStr1 + roshanStr2) + 0.02); // лёгкий radiant bias

  return {
    betType: 'first_roshan',
    label: 'First Roshan',
    labelRu: 'Первый Рошан',
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: 0.56,
    mainFactors: [
      { name: 'Сила ранней игры', impact: 0.10, direction: roshanStr1 > roshanStr2 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 6. ТОТАЛ УБИЙСТВ ───────────────────────────────────────────────────────

export function predictTotalKills(f: FeatureVector, line = 52.5): BetPrediction {
  // Ожидаемое число убийств: базовое 45/матч × темп команд
  const pace1 = f.earlyScore1 * 0.7 + f.form1 * 0.3;
  const pace2 = f.earlyScore2 * 0.7 + f.form2 * 0.3;
  const avgPace = (pace1 + pace2) / 2;
  const expectedKills = 38 + avgPace * 30; // [38..68] диапазон
  const pOver = normalize(sigmoid((expectedKills - line) / 8));

  return {
    betType: 'total_kills',
    label: `Total Kills O/U ${line}`,
    labelRu: `Тотал убийств О/У ${line}`,
    probTeam1: pOver,     // team1 = "больше"
    probTeam2: 1 - pOver, // team2 = "меньше"
    confidence: 0.62,
    mainFactors: [
      { name: 'Темп игры', impact: 0.12, direction: avgPace > 0.6 ? 'up' : 'down' },
      { name: 'Ожид. убийств', impact: 0.15, direction: expectedKills > line ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 7. ТОТАЛ ПО ВРЕМЕНИ ────────────────────────────────────────────────────

export function predictTotalDuration(f: FeatureVector, lineMin = 42.0): BetPrediction {
  // Поздний дрэфт → дольше, ранний дрэфт → короче
  const scalingAvg = (f.scalingScore1 + f.scalingScore2) / 2;
  const expectedMin = 28 + scalingAvg * 24; // [28..52] диапазон
  const pOver = normalize(sigmoid((expectedMin - lineMin) / 5));

  return {
    betType: 'total_duration',
    label: `Total Duration O/U ${lineMin}min`,
    labelRu: `Длительность О/У ${lineMin}мин`,
    probTeam1: pOver,
    probTeam2: 1 - pOver,
    confidence: 0.64,
    mainFactors: [
      { name: 'Поздний дрэфт', impact: 0.14, direction: scalingAvg > 0.6 ? 'up' : 'down' },
      { name: 'Ожид. продолж.', impact: 0.12, direction: expectedMin > lineMin ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 8. ГАНДИКАП ПО КАРТАМ ─────────────────────────────────────────────────
//
// Wave 3.A — стадия-зависимый расчёт. -1.5 = команда побеждает с разницей
// ≥2 карт (BO3: 2-0; BO5: 3-0 или 3-1 невозможно если series 1.5 → требуется 3-0).
// Для упрощения интерпретируем как P(серия закончится с разницей ≥2 карт
// в пользу T1), conditional на текущем счёте серии.

export function predictMapHandicap(f: FeatureVector): BetPrediction {
  const p = predictMapWinner(f, 1).probTeam1;  // p уже включает momentum/side
  const q = 1 - p;
  const s1 = f.seriesScore1 ?? 0;
  const s2 = f.seriesScore2 ?? 0;
  const target = f.matchFormat === 'BO5' ? 3 : 2;

  // ВНИМАНИЕ: probTeam1 / probTeam2 здесь — НЕ комплементарные. Это
  // вероятности двух раздельных тикетов «-1.5 на T1» и «-1.5 на T2»
  // (= +1.5 vs T1). Сумма ≤ 1 (остаток = серия закончится с margin <2,
  // т.е. -1.5 не сыграет ни на ком). Это сделано осознанно — на рынке
  // эти две стороны котируются как независимые ставки, а не как
  // дополнения. Никакой нормализации к [0.05,0.95] не применяем —
  // на стадиях 1-1/0-1 (для T1) и 1-0/1-1 (для T2) истинная вероятность
  // ровно 0 и должна остаться нулём.
  const pHandicap1 = pSeriesWinByMargin2(s1, s2, p, target);
  const pHandicap2 = pSeriesWinByMargin2(s2, s1, q, target);

  return {
    betType: 'map_handicap',
    label: 'Map Handicap -1.5 / +1.5',
    labelRu: 'Гандикап по картам -1.5 / +1.5',
    probTeam1: pHandicap1,
    probTeam2: pHandicap2,
    confidence: 0.60 + (f.stage && f.stage !== 'map1' ? 0.05 : 0),
    mainFactors: [
      { name: 'Вероятность победы', impact: 0.18, direction: p > 0.55 ? 'up' : 'down' },
      { name: 'Стадия серии', impact: 0.10, direction: s1 > s2 ? 'up' : s2 > s1 ? 'down' : 'neutral' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 9. ТОЧНЫЙ СЧЁТ (BO3) ───────────────────────────────────────────────────

export interface CorrectScorePrediction {
  score: string;
  label: string;
  probability: number;
}

// Wave 3.A: точный счёт BO3 conditional на текущей стадии серии — не p².
// Возвращает только достижимые исходы из текущего счёта.
export function predictCorrectScore(f: FeatureVector): CorrectScorePrediction[] {
  const p = predictMapWinner(f, 1).probTeam1;
  const q = 1 - p;
  const s1 = f.seriesScore1 ?? 0;
  const s2 = f.seriesScore2 ?? 0;

  // Условные вероятности оставшихся ветвей серии BO3 (target = 2 побед).
  // Допущение: каждая оставшаяся карта i.i.d. ~ Bernoulli(p) — упрощение,
  // но conditioning на счёт убирает наибольшую систематическую ошибку iid-p².
  let p20 = 0, p21 = 0, p12 = 0, p02 = 0;
  if (s1 >= 2) p20 = 1;
  else if (s2 >= 2) p02 = 1;
  else if (s1 === 1 && s2 === 1) { p21 = p; p12 = q; }
  else if (s1 === 1 && s2 === 0) { p20 = p; p21 = q * p; p12 = q * q; }
  else if (s1 === 0 && s2 === 1) { p02 = q; p12 = p * q; p21 = p * p; }
  else { p20 = p * p; p21 = 2 * p * p * q; p12 = 2 * p * q * q; p02 = q * q; }
  return [
    { score: '2-0', label: '2-0 (П1)', probability: p20 },
    { score: '2-1', label: '2-1 (П1)', probability: p21 },
    { score: '1-2', label: '1-2 (П2)', probability: p12 },
    { score: '0-2', label: '0-2 (П2)', probability: p02 },
  ];
}

export function predictCorrectScoreAsBet(f: FeatureVector): BetPrediction {
  const all = predictCorrectScore(f);
  const p20 = all.find(x => x.score === '2-0')?.probability ?? 0;
  const p02 = all.find(x => x.score === '0-2')?.probability ?? 0;
  const dom = Math.abs(p20 - p02);

  return {
    betType: 'correct_score',
    label: 'Correct Score (BO3)',
    labelRu: 'Точный счёт (BO3)',
    probTeam1: clamp01(p20),
    probTeam2: clamp01(p02),
    confidence: 0.54 + (f.stage && f.stage !== 'map1' ? 0.06 : 0),
    mainFactors: [
      { name: 'Dominance', impact: dom, direction: p20 > p02 ? 'up' : 'down' },
      { name: 'Стадия серии', impact: 0.10, direction: (f.seriesScore1 ?? 0) > (f.seriesScore2 ?? 0) ? 'up' : (f.seriesScore2 ?? 0) > (f.seriesScore1 ?? 0) ? 'down' : 'neutral' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 10. КАМБЭК (только live) ───────────────────────────────────────────────

export function predictComeback(f: FeatureVector): BetPrediction {
  if (!f.isLive || f.netWorthLead === undefined || f.gameTimeSec === undefined) {
    return {
      betType: 'comeback',
      label: 'Comeback (Live)',
      labelRu: 'Камбэк (Live)',
      probTeam1: 0.5, probTeam2: 0.5, confidence: 0.10,
      mainFactors: [],
      modelVersion: MODEL_VERSION,
      isLiveOnly: true,
    };
  }

  // Камбэк отстающей команды
  const nwGap = Math.abs(f.netWorthLead);
  const timeRemaining = Math.max(0, 50 * 60 - f.gameTimeSec); // остаток ~50 мин
  const timeFactor = Math.min(timeRemaining / (50 * 60), 1);

  // P(comeback) = σ(-k × nwGap/5000 + timeFactor × 0.8)
  const k = 1.5;
  const pComeback = sigmoid(-k * nwGap / 5000 + timeFactor * 0.8);

  const leadingTeam = (f.netWorthLead ?? 0) > 0 ? 1 : 2;
  const probLeading = 1 - pComeback;
  const probTrailing = pComeback;

  return {
    betType: 'comeback',
    label: 'Live Comeback Probability',
    labelRu: 'Вероятность камбэка (Live)',
    probTeam1: leadingTeam === 1 ? probLeading : probTrailing,
    probTeam2: leadingTeam === 2 ? probLeading : probTrailing,
    confidence: 0.65 + (nwGap > 10000 ? 0.10 : 0),
    mainFactors: [
      { name: 'Net Worth gap', impact: Math.min(nwGap / 20000, 0.3), direction: leadingTeam === 1 ? 'up' : 'down' },
      { name: 'Оставшееся время', impact: timeFactor * 0.2, direction: timeFactor > 0.5 ? 'up' : 'down' },
      ...(f.aegisHolder ? [{ name: 'Эгида', impact: 0.05, direction: f.aegisHolder === 1 ? 'up' as const : 'down' as const }] : []),
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: true,
  };
}

// ─── 11. ПРЕИМУЩЕСТВО ПО NETWORTH В X МИНУТ ─────────────────────────────────

export function predictNetWorthLead(f: FeatureVector, atMinute = 20): BetPrediction {
  // Раннее преимущество: earlyScore → networth лидерство
  const earlyAdv = (f.earlyScore1 - f.earlyScore2) * 0.25;
  const draftAdv = (f.draftSynergy1 - f.draftSynergy2) * 0.15;
  const p = normalize(0.5 + earlyAdv + draftAdv);

  return {
    betType: 'net_worth_lead',
    label: `Net Worth Lead at ${atMinute}min`,
    labelRu: `Лидерство по NW в ${atMinute} мин`,
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: 0.60,
    mainFactors: [
      { name: 'Early game', impact: Math.abs(earlyAdv), direction: earlyAdv > 0 ? 'up' : 'down' },
      { name: 'Дрэфт', impact: Math.abs(draftAdv), direction: draftAdv > 0 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 12. ПЕРВЫЕ КАЗАРМЫ ─────────────────────────────────────────────────────

export function predictFirstBarracks(f: FeatureVector): BetPrediction {
  const midgame1 = (f.scalingScore1 + f.draftSynergy1) / 2;
  const midgame2 = (f.scalingScore2 + f.draftSynergy2) / 2;
  const p = normalize(midgame1 / (midgame1 + midgame2));

  return {
    betType: 'first_barracks',
    label: 'First Barracks',
    labelRu: 'Первые казармы',
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: 0.58,
    mainFactors: [
      { name: 'Mid-game strength', impact: 0.12, direction: midgame1 > midgame2 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 13. ТОТАЛ КАРТ (BO3) — 2.5 ────────────────────────────────────────────

export function predictOverUnderMaps(f: FeatureVector): BetPrediction {
  // Wave 3.A: conditional на текущем счёте серии. P(3 карты в BO3) =
  // P(серия дойдёт до счёта 1-1 хотя бы раз) — суммируем точные счёта 2-1+1-2.
  // Без normalize() — после счёта 2-0/0-2 истинная вероятность over 2.5 = 0.
  const all = predictCorrectScore(f);
  const p3maps = clamp01(
    (all.find(x => x.score === '2-1')?.probability ?? 0) +
    (all.find(x => x.score === '1-2')?.probability ?? 0),
  );
  const p = predictMapWinner(f, 1).probTeam1;
  const pUnder = clamp01(1 - p3maps);

  return {
    betType: 'over_under_maps',
    label: 'Total Maps O/U 2.5',
    labelRu: 'Всего карт О/У 2.5',
    probTeam1: p3maps,         // "больше 2.5" = 3 карты
    probTeam2: pUnder,         // "меньше 2.5" = 2 карты
    confidence: 0.62,
    mainFactors: [
      { name: 'Баланс сил', impact: 0.5 - Math.abs(p - 0.5), direction: Math.abs(p - 0.5) < 0.15 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 14. ГАНДИКАП ПО УБИЙСТВАМ ──────────────────────────────────────────────

export function predictKillsHandicap(f: FeatureVector, line = 5.5): BetPrediction {
  const pace1 = f.earlyScore1 * 0.6 + f.draftSynergy1 * 0.4;
  const pace2 = f.earlyScore2 * 0.6 + f.draftSynergy2 * 0.4;
  const expectedDiff = (pace1 - pace2) * 15; // max ±7.5
  const p = normalize(sigmoid((expectedDiff - line) / 5));

  return {
    betType: 'kills_handicap',
    label: `Kills Handicap ±${line}`,
    labelRu: `Гандикап по убийствам ±${line}`,
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: 0.58,
    mainFactors: [
      { name: 'Темп атаки', impact: 0.10, direction: pace1 > pace2 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

// ─── 15. ПРЕИМУЩЕСТВО ДРЭФТА ────────────────────────────────────────────────

export function predictDraftAdvantage(f: FeatureVector): BetPrediction {
  const score1 = f.draftSynergy1 * 0.4 + f.draftCounter1 * 0.35 + f.earlyScore1 * 0.15 + f.scalingScore1 * 0.10;
  const score2 = f.draftSynergy2 * 0.4 + f.draftCounter2 * 0.35 + f.earlyScore2 * 0.15 + f.scalingScore2 * 0.10;
  const p = normalize(score1 / (score1 + score2));

  return {
    betType: 'draft_advantage',
    label: 'Draft Advantage',
    labelRu: 'Преимущество в дрэфте',
    probTeam1: p,
    probTeam2: 1 - p,
    confidence: 0.64,
    mainFactors: [
      { name: 'Синергия', impact: Math.abs(f.draftSynergy1 - f.draftSynergy2) * 0.3, direction: f.draftSynergy1 > f.draftSynergy2 ? 'up' : 'down' },
      { name: 'Контрпики', impact: Math.abs(f.draftCounter1 - f.draftCounter2) * 0.25, direction: f.draftCounter1 > f.draftCounter2 ? 'up' : 'down' },
    ],
    modelVersion: MODEL_VERSION,
    isLiveOnly: false,
  };
}

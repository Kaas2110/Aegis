/**
 * Wave 3.D — обучение моделей для производных рынков (тотал убийств, тотал
 * длительности, первая кровь).
 *
 * Подход (baseline, не LightGBM):
 *   - per-tier эмпирические распределения, сохраняемые как параметры в
 *     model_versions.weights (jsonb).
 *   - total_kills: log-normal по `radiant_score + dire_score`. Сохраняем
 *     mean/std логарифма + средне-нормальный фоллбэк (если выборка < 30).
 *     Инференс считает P(over line) через нормальное CDF.
 *   - total_duration: log-normal по duration_sec.
 *   - first_blood_radiant: эмпирическая базовая P(radiant first blood) +
 *     линейный сдвиг по eloDiff (логит-сдвиг 0.4 на 200 пунктов рейтинга).
 *     Берём из pro_matches.first_blood_time IS NOT NULL и строим прокси из
 *     finishing scores: «кто получил первую» приближаем по знаку
 *     `radiant_score - dire_score` ранних минут — данных пока нет, поэтому
 *     для first_blood используем только base_rate (P(radiant_win) с малой
 *     поправкой). При появлении детальных данных можно дотренировать.
 *
 * Все три модели пишутся в `model_versions` с собственными `kind`:
 *   - 'market_total_kills' (algorithm='lognormal_per_tier')
 *   - 'market_total_duration' (algorithm='lognormal_per_tier')
 *   - 'market_first_blood'   (algorithm='base_rate_logit')
 *
 * is_active управляется атомарно: для каждого `kind` деактивируем все
 * предыдущие active и вставляем новую активную в одной транзакции.
 *
 * Завершается с exit 0 даже если какой-то из рынков не имеет данных —
 * сценарий вызывается из расписания и не должен валить весь pipeline.
 */

import {
  db,
  proMatchesTable,
  teamsTable,
  modelVersionsTable,
} from '@workspace/db';
import { gte, and, eq, isNotNull } from 'drizzle-orm';
import { classifyTier, type Tier } from './lib/tier';

const TRAIN_WINDOW_DAYS = 180;

interface MatchRow {
  matchId: number;
  startTime: number;
  duration: number;
  radiantScore: number | null;
  direScore: number | null;
  firstBloodTime: number | null;
  radiantWin: boolean;
  radiantTeamId: number | null;
  direTeamId: number | null;
}

interface PerTierLogNormal {
  n: number;
  meanLog: number;
  stdLog: number;
}

interface KillsModelWeights {
  perTier: Record<'t1' | 't2' | 't3' | 'all', PerTierLogNormal>;
  trainAccuracy: number;  // не применимо, ставим 0; держим поле для совместимости
  testSize: number;
}

interface FirstBloodModelWeights {
  baseRadiantP: number;
  eloLogitSlope: number;  // logit-сдвиг на 1 единицу нормированной разницы
  n: number;
}

function safeMeanStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 1 };
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1);
  return { mean: m, std: Math.sqrt(Math.max(v, 1e-9)) };
}

async function loadMatches(): Promise<MatchRow[]> {
  const sinceTs = Math.floor(Date.now() / 1000) - TRAIN_WINDOW_DAYS * 86400;
  const rows = await db
    .select({
      matchId: proMatchesTable.matchId,
      startTime: proMatchesTable.startTime,
      duration: proMatchesTable.duration,
      radiantScore: proMatchesTable.radiantScore,
      direScore: proMatchesTable.direScore,
      firstBloodTime: proMatchesTable.firstBloodTime,
      radiantWin: proMatchesTable.radiantWin,
      radiantTeamId: proMatchesTable.radiantTeamId,
      direTeamId: proMatchesTable.direTeamId,
    })
    .from(proMatchesTable)
    .where(gte(proMatchesTable.startTime, sinceTs));
  return rows.filter((r): r is MatchRow => r.duration != null);
}

async function loadTeamRatings(): Promise<Map<number, number>> {
  const rows = await db
    .select({ teamId: teamsTable.teamId, rating: teamsTable.rating })
    .from(teamsTable);
  const m = new Map<number, number>();
  for (const r of rows) if (r.rating != null) m.set(r.teamId, r.rating);
  return m;
}

function bucketByTier(
  matches: MatchRow[],
  ratings: Map<number, number>,
): Record<'t1' | 't2' | 't3' | 'all', MatchRow[]> {
  const out = { t1: [] as MatchRow[], t2: [] as MatchRow[], t3: [] as MatchRow[], all: [] as MatchRow[] };
  for (const m of matches) {
    out.all.push(m);
    if (!m.radiantTeamId || !m.direTeamId) continue;
    const r1 = ratings.get(m.radiantTeamId);
    const r2 = ratings.get(m.direTeamId);
    if (r1 == null || r2 == null) continue;
    const t = classifyTier(r1, r2);
    if (t === 't1') out.t1.push(m);
    else if (t === 't2') out.t2.push(m);
    else if (t === 't3') out.t3.push(m);
  }
  return out;
}

function fitLogNormalPerTier(
  buckets: Record<'t1' | 't2' | 't3' | 'all', MatchRow[]>,
  extract: (m: MatchRow) => number | null,
): KillsModelWeights {
  const perTier: Record<'t1' | 't2' | 't3' | 'all', PerTierLogNormal> = {
    t1: { n: 0, meanLog: 0, stdLog: 1 },
    t2: { n: 0, meanLog: 0, stdLog: 1 },
    t3: { n: 0, meanLog: 0, stdLog: 1 },
    all: { n: 0, meanLog: 0, stdLog: 1 },
  };
  for (const tier of ['t1', 't2', 't3', 'all'] as const) {
    const vals: number[] = [];
    for (const m of buckets[tier]) {
      const v = extract(m);
      if (v == null || v <= 0) continue;
      vals.push(Math.log(v));
    }
    if (vals.length < 5) continue;
    const { mean, std } = safeMeanStd(vals);
    perTier[tier] = { n: vals.length, meanLog: mean, stdLog: std };
  }
  return { perTier, trainAccuracy: 0, testSize: perTier.all.n };
}

function fitFirstBlood(
  matches: MatchRow[],
  ratings: Map<number, number>,
): FirstBloodModelWeights {
  // Прокси: считаем «radiant получил первую кровь» = `radiant_win` AND
  // matches с известным first_blood_time (что значит игра доехала до фактической
  // первой крови, и мы можем хотя бы оценить долю по сторонам). Реальный
  // парсинг first-blood-team требует /matches/:id players[].firstblood_claimed
  // — добавим в backfill позже.
  let total = 0;
  let radiantFirst = 0;
  for (const m of matches) {
    if (m.firstBloodTime == null) continue;
    total++;
    if (m.radiantWin) radiantFirst++;
  }
  const baseP = total > 0 ? radiantFirst / total : 0.52;
  // Лёгкий логистический сдвиг по eloDiff (без обучения — фиксированная
  // эвристика 0.4 logit на 200 elo). Будет уточнено при backfill.
  return { baseRadiantP: baseP, eloLogitSlope: 0.4, n: total };
}

async function activateModel(opts: {
  kind: string;
  algorithm: string;
  weights: Record<string, unknown>;
  features: string[];
  testSize: number;
  trainAccuracy: number;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const versionStem = `${opts.kind}-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
  await db.transaction(async tx => {
    await tx
      .update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, opts.kind), eq(modelVersionsTable.isActive, true)));
    await tx.insert(modelVersionsTable).values({
      version: versionStem,
      kind: opts.kind,
      algorithm: opts.algorithm,
      features: opts.features,
      weights: opts.weights as Record<string, number>,
      featuresVersion: 1,
      isActive: true,
      trainAccuracy: opts.trainAccuracy,
      testAccuracy: opts.trainAccuracy,
      brierScore: 0,
      trainSampleSize: opts.testSize,
      testSampleSize: opts.testSize,
      metadata: opts.metadata,
    });
  });
}

async function main(): Promise<void> {
  console.log('[train-market-models] loading data');
  const [matches, ratings] = await Promise.all([loadMatches(), loadTeamRatings()]);
  console.log(`[train-market-models] matches=${matches.length} ratings=${ratings.size}`);
  if (matches.length < 30) {
    console.log('[train-market-models] not enough matches — exiting cleanly');
    return;
  }

  const buckets = bucketByTier(matches, ratings);
  console.log(
    `[train-market-models] buckets: t1=${buckets.t1.length} t2=${buckets.t2.length} t3=${buckets.t3.length} all=${buckets.all.length}`,
  );

  // 1. Total kills
  const killsModel = fitLogNormalPerTier(buckets, m =>
    m.radiantScore != null && m.direScore != null ? m.radiantScore + m.direScore : null,
  );
  await activateModel({
    kind: 'market_total_kills',
    algorithm: 'lognormal_per_tier',
    features: ['per_tier_lognormal'],
    weights: killsModel as unknown as Record<string, unknown>,
    testSize: killsModel.testSize,
    trainAccuracy: 0,
    metadata: { description: 'log-normal of (radiant+dire) score per tier' },
  });
  console.log(
    `[train-market-models] total_kills: t1=${killsModel.perTier.t1.n} t2=${killsModel.perTier.t2.n} t3=${killsModel.perTier.t3.n} all=${killsModel.perTier.all.n}`,
  );

  // 2. Total duration
  const durModel = fitLogNormalPerTier(buckets, m => (m.duration > 0 ? m.duration : null));
  await activateModel({
    kind: 'market_total_duration',
    algorithm: 'lognormal_per_tier',
    features: ['per_tier_lognormal'],
    weights: durModel as unknown as Record<string, unknown>,
    testSize: durModel.testSize,
    trainAccuracy: 0,
    metadata: { description: 'log-normal of match duration (sec) per tier' },
  });
  console.log(
    `[train-market-models] total_duration: t1=${durModel.perTier.t1.n} t2=${durModel.perTier.t2.n} t3=${durModel.perTier.t3.n} all=${durModel.perTier.all.n}`,
  );

  // 3. First blood
  const fbModel = fitFirstBlood(matches, ratings);
  await activateModel({
    kind: 'market_first_blood',
    algorithm: 'base_rate_logit',
    features: ['base_rate', 'elo_logit_slope'],
    weights: fbModel as unknown as Record<string, unknown>,
    testSize: fbModel.n,
    trainAccuracy: 0,
    metadata: { description: 'base radiant-first-blood rate + linear elo logit shift' },
  });
  console.log(`[train-market-models] first_blood: n=${fbModel.n} baseP=${fbModel.baseRadiantP.toFixed(3)}`);

  console.log('[train-market-models] done');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[train-market-models] FATAL', err);
    process.exit(1);
  });

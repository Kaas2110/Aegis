/**
 * Обучение LIVE-модели победителя матча.
 *
 * Эта модель работает ВО ВРЕМЯ матча: получает текущий снапшот (NW lead, kills,
 * tower count, game_time) + прематч-вероятность из основной модели → выдаёт
 * P(Radiant победит) обновляемую каждую минуту.
 *
 * Тренировочные данные — соединение трёх таблиц:
 *   live_snapshots (X)        — что происходило на минуте M матча
 *   prematch_outcomes (Y + prior) — кто победил (label) + что предсказала прематч-модель
 *
 * Фичи (5):
 *   x0 = 1                                    bias
 *   x1 = (gameTimeSec - 1800) / 1800          нормализованная минута, центр = 30мин
 *   x2 = radiantLead / 10000                  net worth преимущество в десятках k
 *   x3 = (radiantScore - direScore) / 15      разница убийств
 *   x4 = towerDiff / 11                       разница оставшихся башен (по building_state)
 *   x5 = logit(prematchProb)                  прематч как сильный приор
 *
 * Цель: P(radiant_win | snapshot) = sigmoid(w · x)
 *
 * Sampling: чтобы матч не доминировал в выборке, берём максимум 1 снапшот
 * на каждые 3 минуты игры (gameTime // 180).
 */

import { db, modelVersionsTable } from '@workspace/db';
import { sql, and, eq } from 'drizzle-orm';

interface Sample {
  features: number[];
  label: number;
  matchId: number;
  bucket: number; // gameTime в 3-мин ведре, для сэмплирования
}

const EPOCHS = 200;
const LR = 0.05;
const L2 = 0.001;

// Парсит OpenDota building_state (bitmask) → счётчики башен.
// Стандартное расположение бит:
//   bits 0..10  — Radiant towers (11 штук: 4×T1+T2+T3 + 3 ancients)
//   bits 11..21 — Dire towers
// Это аппроксимация — точное соответствие зависит от версии OpenDota,
// но как фича-индикатор «у кого больше построек цело» работает.
function towerCountsFromBuildingState(bs: number | null | undefined): { r: number; d: number } {
  if (bs == null || !Number.isFinite(bs)) return { r: 11, d: 11 };
  let r = 0, d = 0;
  for (let i = 0; i < 11; i++) if (bs & (1 << i)) r++;
  for (let i = 11; i < 22; i++) if (bs & (1 << i)) d++;
  return { r, d };
}

function logit(p: number): number {
  const eps = 1e-4;
  const q = Math.min(Math.max(p, eps), 1 - eps);
  return Math.log(q / (1 - q));
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const ez = Math.exp(-z);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(z);
  return ez / (1 + ez);
}

function dot(w: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

function trainLogisticRegression(samples: Sample[], dim: number): number[] {
  const w = new Array(dim).fill(0);
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let totalLoss = 0;
    for (let i = samples.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [samples[i], samples[j]] = [samples[j], samples[i]];
    }
    for (const s of samples) {
      const z = dot(w, s.features);
      const p = sigmoid(z);
      const err = p - s.label;
      for (let i = 0; i < dim; i++) {
        const grad = err * s.features[i] + (i === 0 ? 0 : L2 * w[i]);
        w[i] -= LR * grad;
      }
      const eps = 1e-9;
      totalLoss += -(s.label * Math.log(p + eps) + (1 - s.label) * Math.log(1 - p + eps));
    }
    if ((epoch + 1) % 20 === 0) {
      console.log(`  epoch ${epoch + 1}/${EPOCHS} loss=${(totalLoss / samples.length).toFixed(4)}`);
    }
  }
  return w;
}

function evaluate(samples: Sample[], w: number[]): { acc: number; logLoss: number; brier: number } {
  let correct = 0, logLoss = 0, brier = 0;
  for (const s of samples) {
    const p = sigmoid(dot(w, s.features));
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === s.label) correct++;
    const eps = 1e-9;
    logLoss += -(s.label * Math.log(p + eps) + (1 - s.label) * Math.log(1 - p + eps));
    brier += (p - s.label) ** 2;
  }
  return {
    acc: correct / samples.length,
    logLoss: logLoss / samples.length,
    brier: brier / samples.length,
  };
}

async function main() {
  console.log('[train-live-model] Joining live_snapshots × prematch_outcomes …');

  // SQL-джойн: для каждого снапшота с gameTime>=60 берём матч с известным
  // исходом и прематч-прогнозом. Сразу фильтруем мусор (нулевые фичи).
  // Лимитируем 200к строк — этого хватит для логистической регрессии и
  // оперативной памяти node-процесса.
  // LEFT JOIN с обеими таблицами:
  //   po.predicted_radiant_win_prob — реальный прогноз модели (если матч был live-tracked)
  //   pm.radiant_win — исход всегда известен для любого pro_match
  //   COALESCE(po.predicted_radiant_win_prob, 0.5) — нейтральный приор для backfill
  // Это позволяет использовать все live_snapshots (в т.ч. синтетические из backfill),
  // не только те, для которых есть prematch_outcomes.
  const rows = await db.execute(sql`
    SELECT
      ls.match_id          AS "matchId",
      ls.game_time_sec     AS "gameTimeSec",
      ls.radiant_lead      AS "radiantLead",
      ls.radiant_score     AS "radiantScore",
      ls.dire_score        AS "direScore",
      ls.building_state    AS "buildingState",
      COALESCE(po.predicted_radiant_win_prob, 0.5) AS "prematchProb",
      COALESCE(po.actual_radiant_win, pm.radiant_win) AS "actualRadiantWin"
    FROM live_snapshots ls
    INNER JOIN pro_matches pm ON pm.match_id = ls.match_id
    LEFT JOIN prematch_outcomes po ON po.match_id = ls.match_id
    WHERE pm.radiant_win IS NOT NULL
      AND ls.game_time_sec IS NOT NULL
      AND ls.game_time_sec >= 60
      AND ls.game_time_sec <= 7200
    ORDER BY ls.match_id, ls.game_time_sec
    LIMIT 200000
  `);

  console.log(`[train-live-model] Joined ${rows.rows.length} snapshot rows`);

  if (rows.rows.length < 50) {
    console.error(
      '[train-live-model] Not enough joined data (need 50+ resolved snapshots).\n' +
      '  Это нормально на свежей системе — live-модель требует, чтобы\n' +
      '  LiveWorker накопил снапшоты и OutcomeTracker их зарезолвил.\n' +
      '  Запусти переобучение через 1-2 недели работы воркеров.',
    );
    process.exit(0); // НЕ ошибка — не блокируем общий ретрейн-пайплайн.
  }

  // Сэмплирование: 1 снапшот на 3-мин ведро каждого матча, чтобы не
  // переобучаться на длинных матчах.
  const seenBuckets = new Set<string>();
  const samples: Sample[] = [];

  // pg возвращает bigint как СТРОКУ по умолчанию (чтобы не терять precision).
  // Здесь match_id — bigint, а radiant_lead/score/building_state — int4 (number).
  // Явно нормализуем каждое поле, чтобы дальнейшая арифметика и Set-ключи
  // не зависели от того, как именно драйвер сериализовал значение.
  const toNum = (v: unknown): number | null => {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  for (const raw of rows.rows as unknown as Record<string, unknown>[]) {
    const matchId = toNum(raw.matchId);
    const gameTimeSec = toNum(raw.gameTimeSec);
    const prematchProb = toNum(raw.prematchProb);
    if (matchId == null || gameTimeSec == null || prematchProb == null) continue;
    if (prematchProb <= 0 || prematchProb >= 1) continue;

    const bucket = Math.floor(gameTimeSec / 180);
    const key = `${matchId}:${bucket}`;
    if (seenBuckets.has(key)) continue;
    seenBuckets.add(key);

    const towers = towerCountsFromBuildingState(toNum(raw.buildingState));
    const radiantLead = toNum(raw.radiantLead) ?? 0;
    const killDiff = (toNum(raw.radiantScore) ?? 0) - (toNum(raw.direScore) ?? 0);
    const towerDiff = towers.r - towers.d;

    const x = [
      1,
      (gameTimeSec - 1800) / 1800,
      radiantLead / 10000,
      killDiff / 15,
      towerDiff / 11,
      logit(prematchProb),
    ];
    samples.push({
      features: x,
      label: raw.actualRadiantWin ? 1 : 0,
      matchId,
      bucket,
    });
  }

  console.log(`[train-live-model] After bucket sampling: ${samples.length} examples`);

  if (samples.length < 50) {
    console.error('[train-live-model] Not enough sampled data.');
    process.exit(0);
  }

  // Сплит ПО МАТЧАМ (не по снапшотам), чтобы не было утечки данных
  // (один матч в train и test одновременно — это утечка).
  const allMatches = Array.from(new Set(samples.map(s => s.matchId)));
  // Хронологический порядок не сохранится — используем числовой порядок
  // matchId как proxy (более новые матчи = большие id).
  allMatches.sort((a, b) => a - b);
  const splitIdx = Math.floor(allMatches.length * 0.8);
  const trainMatches = new Set(allMatches.slice(0, splitIdx));

  const train = samples.filter(s => trainMatches.has(s.matchId));
  const test = samples.filter(s => !trainMatches.has(s.matchId));
  console.log(`[train-live-model] Matches train/test: ${trainMatches.size}/${allMatches.length - trainMatches.size}`);
  console.log(`[train-live-model] Samples train/test: ${train.length}/${test.length}`);

  if (train.length < 30 || test.length < 5) {
    console.error('[train-live-model] Too few samples after split.');
    process.exit(0);
  }

  console.log('[train-live-model] Training logistic regression …');
  const w = trainLogisticRegression([...train], 6);
  console.log('[train-live-model] Weights:', w.map(x => x.toFixed(4)));

  const trainMetrics = evaluate(train, w);
  const testMetrics = evaluate(test, w);
  console.log(`[train-live-model] TRAIN  acc=${(trainMetrics.acc * 100).toFixed(2)}%  logloss=${trainMetrics.logLoss.toFixed(4)}  brier=${trainMetrics.brier.toFixed(4)}`);
  console.log(`[train-live-model] TEST   acc=${(testMetrics.acc * 100).toFixed(2)}%  logloss=${testMetrics.logLoss.toFixed(4)}  brier=${testMetrics.brier.toFixed(4)}`);

  // Baseline: использовать ТОЛЬКО прематч-прогноз (без снапшота).
  // Так мы видим, даёт ли live-модель прибавку поверх прематча.
  let baselineCorrect = 0;
  let baselineBrier = 0;
  for (const s of test) {
    const prematchProb = sigmoid(s.features[5]); // логит → обратно
    const pred = prematchProb >= 0.5 ? 1 : 0;
    if (pred === s.label) baselineCorrect++;
    baselineBrier += (prematchProb - s.label) ** 2;
  }
  const baselineAcc = baselineCorrect / test.length;
  const baselineBrierAvg = baselineBrier / test.length;
  console.log(
    `[train-live-model] Baseline (только прематч): acc=${(baselineAcc * 100).toFixed(2)}%  brier=${baselineBrierAvg.toFixed(4)}`,
  );
  console.log(
    `[train-live-model] Live model lift: Δacc=${((testMetrics.acc - baselineAcc) * 100).toFixed(2)}pp  Δbrier=${(baselineBrierAvg - testMetrics.brier).toFixed(4)}`,
  );

  const version = `lr-live-v${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  console.log(`[train-live-model] Saving as ${version} …`);

  // Атомарно: деактивируем старые LIVE-модели (НЕ трогаем prematch_winner!)
  // и вставляем новую активную.
  await db.transaction(async tx => {
    await tx
      .update(modelVersionsTable)
      .set({ isActive: false })
      .where(and(eq(modelVersionsTable.kind, 'live_winner'), eq(modelVersionsTable.isActive, true)));
    await tx.insert(modelVersionsTable).values({
      version,
      kind: 'live_winner',
      algorithm: 'logistic_regression_live',
      features: ['bias', 'game_time_norm', 'nw_lead_norm', 'kill_diff_norm', 'tower_diff_norm', 'prematch_logit'],
      weights: { w0: w[0], w1: w[1], w2: w[2], w3: w[3], w4: w[4], w5: w[5] },
      trainAccuracy: trainMetrics.acc,
      testAccuracy: testMetrics.acc,
      brierScore: testMetrics.brier,
      trainSampleSize: train.length,
      testSampleSize: test.length,
      metadata: {
        logLossTrain: trainMetrics.logLoss,
        logLossTest: testMetrics.logLoss,
        baselineAcc,
        baselineBrier: baselineBrierAvg,
        liftAcc: testMetrics.acc - baselineAcc,
        liftBrier: baselineBrierAvg - testMetrics.brier,
        epochs: EPOCHS,
        learningRate: LR,
        l2: L2,
        matchesTrain: trainMatches.size,
        matchesTest: allMatches.length - trainMatches.size,
        bucketingSeconds: 180,
      },
      isActive: true,
    });
  });

  console.log(`[train-live-model] ✅ Live model ${version} saved and activated.`);
  process.exit(0);
}

main().catch(err => {
  console.error('[train-live-model] FATAL', err);
  process.exit(1);
});

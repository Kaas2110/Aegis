import { buildBetTypeCatalogue } from '../services/BetTypeCatalogue';
import {serveBookmakerTotals} from '../services/BookmakerTotalsLadder';
import {readProviderFeed} from '../services/ProviderFeeds';
import {readSource,usableBookmakerEvents,getAllSourceIds} from './bookmakers';
import {totalsLadder} from '../services/TotalsDistribution';
import { Router, type IRouter } from 'express';
import { resolveServingTeams, computeServingPredictions, servingModelRevision } from '../services/ServingPredictions';
import { predictionCacheKey, openDotaMatchId, positiveId, validatePredictionInput } from '../services/PredictionContract';
import { buildPopularMarkets } from '../services/PopularMarkets';
import { type MatchInput } from '../services/AnalyticsEngine';
import { withCache } from '../lib/responseCache';
import { prematchValidationCte, PREMATCH_VALIDATION_POLICY, PREMATCH_VALIDATION_NOTE } from '../lib/prematchValidation';
import {
  getActiveModel,
  loadActiveModel,
  predictMatchWinner as mlPredictMatchWinner,
} from '../services/PredictionModel';
import { getActiveLiveModel, loadActiveLiveModel } from '../services/LiveWinnerModel';
import { getWorkerStats } from '../services/LiveWorker';
import {
  getSchedulerStats,
  getSchedulerState,
  triggerManualRetrain,
} from '../services/SchedulerWorker';
import { db, predictionsTable, modelVersionsTable, prematchOutcomesTable, teamsTable, heroSynergyTable, heroMatchupsTable, heroStatsTable, matchDraftsTable } from '@workspace/db';
import { getTeamProfile } from '../services/features/teamProfile';
import { requireAdminSession } from './adminAuth';
import { eq, desc, sql, and, gte, isNotNull, inArray, or, ilike } from 'drizzle-orm';

export async function validatedAnalytics(raw: MatchInput) {
  validatePredictionInput(raw);
  const context=raw.seriesContext ?? {seriesScore1:0,seriesScore2:0,currentMapNumber:1};
  const input = await resolveServingTeams({...raw,seriesContext:context});
  // The key includes model lineage, providers, score and all input context.
  // Missing-model responses must recover immediately after the model is loaded.
  const result = input.status === 'live' || input.status === 'between_maps' || input.liveSnapshot || openDotaMatchId(input)
    ? await computeServingPredictions(input)
    : await withCache(predictionCacheKey(input, servingModelRevision()), 60_000,
    () => computeServingPredictions(input), result => result.predictions.length > 0);
  const predictions=result.predictions.filter(p=>p.expiresAt && Date.parse(p.expiresAt)>Date.now());
  return {...result,predictions,state:predictions.length?'ready' as const:'unavailable' as const};
}

const router: IRouter = Router();

/**
 * GET /api/analytics/model-status
 * Возвращает информацию об активной ML-модели и статистике воркера.
 */
router.get('/model-status', async (_req, res) => {
  let model = getActiveModel();
  if (!model) model = await loadActiveModel();

  let predictionsCount = 0;
  try {
    const r = await db.select({ c: sql<number>`count(*)::int` }).from(predictionsTable);
    predictionsCount = r[0]?.c ?? 0;
  } catch {
    // ignore
  }

  let allVersions: {
    version: string;
    kind: string;
    featuresVersion: number;
    isActive: boolean;
    testAccuracy: number | null;
    brierScore: number | null;
    trainSampleSize: number | null;
    hardMatchAccuracy: number | null;
    hardMatchBrier: number | null;
    hardMatchCount: number | null;
    createdAt: Date;
  }[] = [];
  try {
    const rows = await db
      .select({
        version: modelVersionsTable.version,
        kind: modelVersionsTable.kind,
        featuresVersion: modelVersionsTable.featuresVersion,
        isActive: modelVersionsTable.isActive,
        testAccuracy: modelVersionsTable.testAccuracy,
        brierScore: modelVersionsTable.brierScore,
        trainSampleSize: modelVersionsTable.trainSampleSize,
        hardMatchAccuracy: modelVersionsTable.hardMatchAccuracy,
        hardMatchBrier: modelVersionsTable.hardMatchBrier,
        hardMatchCount: modelVersionsTable.hardMatchCount,
        createdAt: modelVersionsTable.createdAt,
      })
      .from(modelVersionsTable)
      .orderBy(desc(modelVersionsTable.createdAt))
      .limit(20);
    allVersions = rows;
  } catch {
    // ignore
  }

  let liveModel = getActiveLiveModel();
  if (!liveModel) liveModel = await loadActiveLiveModel();

  res.json({
    activeModel: model
      ? {
          version: model.version,
          algorithm: model.algorithm,
          trainAccuracy: model.trainAccuracy,
          testAccuracy: model.testAccuracy,
          brierScore: model.brierScore,
          trainSize: model.trainSize,
          testSize: model.testSize,
          loadedAt: model.loadedAt,
        }
      : null,
    activeLiveModel: liveModel
      ? {
          version: liveModel.version,
          algorithm: liveModel.algorithm,
          trainAccuracy: liveModel.trainAccuracy,
          testAccuracy: liveModel.testAccuracy,
          brierScore: liveModel.brierScore,
          trainSize: liveModel.trainSize,
          testSize: liveModel.testSize,
          loadedAt: liveModel.loadedAt,
          metadata: liveModel.metadata,
        }
      : null,
    worker: getWorkerStats(),
    totalPredictionsLogged: predictionsCount,
    recentVersions: allVersions,
  });
});

/**
 * GET /api/analytics/scheduler-status
 * Возвращает состояние шедулера: последний замеченный патч, время следующей
 * запланированной тренировки, статистика проверок.
 */
router.get('/scheduler-status', async (_req, res) => {
  const state = await getSchedulerState();
  res.json({
    runtimeStats: getSchedulerStats(),
    persistedState: state,
    config: {
      checkIntervalHours: 24,
      retrainDelayAfterPatchDays: 7,
      regularRetrainIntervalDays: 30,
    },
  });
});

/**
 * POST /api/analytics/retrain
 * Ручной запуск пайплайна ingest + train. Защищён cookie-сессией админа
 * (выдаётся через POST /api/admin/login). Дублируется в POST /api/admin/retrain
 * для admin-web — оба пути идут через `requireAdminSession`.
 */
router.post('/retrain', requireAdminSession, async (_req, res) => {
  const result = await triggerManualRetrain();
  res.json(result);
});

/**
 * GET /api/analytics/ml-predict?radiantTeamId=X&direTeamId=Y
 * Прямой инференс ML-модели для пары команд (используется для отладки).
 */
router.get('/ml-predict', async (req, res) => {
  const parseTeamId = (raw: unknown): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0 || n > 1e10) return null;
    return n;
  };
  const radiantId = parseTeamId(req.query.radiantTeamId);
  const direId = parseTeamId(req.query.direTeamId);
  if (radiantId === null || direId === null) {
    res.status(400).json({
      error: 'Требуются положительные целые radiantTeamId и direTeamId',
    });
    return;
  }
  if (radiantId === direId) {
    res.status(400).json({ error: 'radiantTeamId и direTeamId должны различаться' });
    return;
  }
  const result = await mlPredictMatchWinner(radiantId, direId);
  if (!result) {
    res.status(404).json({
      error: 'Нет данных для предсказания',
      reason: 'Модель не загружена, или у одной из команд недостаточно матчей в рейтинге OpenDota.',
    });
    return;
  }
  res.json({
    radiantWinProbability: result.probRadiantWin,
    direWinProbability: 1 - result.probRadiantWin,
    modelVersion: result.modelVersion,
    features: result.features,
  });
});

/** Public forecasts use trained outputs only; missing evidence remains unavailable. */
router.post('/predict', async (req, res) => {
  try {
    res.json(await validatedAnalytics(req.body as MatchInput));
  } catch (err) {
    const invalid = err instanceof Error && err.message === 'invalid_prediction_input';
    if (!invalid) req.log.error({err}, 'Validated prediction unavailable');
    res.status(invalid ? 400 : 503).json({state: 'unavailable', predictions: [], error: invalid ? 'invalid_prediction_input' : 'prediction_service_unavailable'});
  }
});

/**
 * GET /api/analytics/bet-types
 * Каталог возможностей: поддержка контракта не означает доступность прогноза.
 */
/**
 * GET /api/analytics/popular-markets
 * Популярные рынки для режима «без букмекера». Принимает либо
 * ?radiantTeamId=&direTeamId= (прематч), либо тело POST с полным MatchInput.
 * Возвращает список рекомендуемых ставок с справедливыми коэффициентами.
 */
router.get('/popular-markets', async (req, res) => {
  const team1Id = positiveId(req.query.radiantTeamId);
  const team2Id = positiveId(req.query.direTeamId);
  if (!team1Id || !team2Id || team1Id === team2Id) { res.status(400).json({error:'invalid_team_ids'}); return; }
  try {
    const result = await validatedAnalytics({
      matchId: 'popular-query', status:'prematch', format: String(req.query.format ?? 'BO3') as MatchInput['format'],
      team1:{name:String(req.query.team1Name ?? 'Radiant'),teamId:team1Id,provider:'opendota'},
      team2:{name:String(req.query.team2Name ?? 'Dire'),teamId:team2Id,provider:'opendota'},
    });
    res.json({markets:buildPopularMarkets(result), state:result.state, generatedAt:result.generatedAt});
  } catch { res.status(503).json({markets:[],state:'unavailable'}); }
});

router.post('/popular-markets', async (req, res) => {
  try {
    const result = await validatedAnalytics(req.body as MatchInput);
    res.json({markets:buildPopularMarkets(result),state:result.state,generatedAt:result.generatedAt});
  } catch { res.status(503).json({markets:[],state:'unavailable'}); }
});


router.get('/bet-types', (_req, res) => {
  res.json(buildBetTypeCatalogue());
});

/**
 * GET /api/analytics/totals-ladder
 * Лестница тоталов — для UI «как у букмекеров». Возвращает несколько линий
 * (49.5, 50.5, …) с вероятностью ТБ/ТМ от модели.
 *   ?type=kills|duration                          (обязательно)
 *   ?radiantTeamId=X&direTeamId=Y                 (обязательно)
 *   ?format=BO1|BO3|BO5|unknown                   (по умолчанию unknown)
 *   ?status=live|prematch|finished|between_maps    (числа наблюдения берутся только с сервера)
 *   ?lineCount=7                                  (опц., 3..15, по умолчанию 7)
 */
router.get('/totals-ladder', async (req, res) => {
  const type = String(req.query.type ?? '');
  const bookmakerId=String(req.query.bookmakerId??'');
  if (bookmakerId && !['none','no_bookmaker'].includes(bookmakerId)) {
    if (!['kills','duration'].includes(type) || !getAllSourceIds().includes(bookmakerId)) {res.status(400).json({error:'invalid_market_input'});return;}
    try {
      const response=await serveBookmakerTotals({type:type as 'kills'|'duration',bookmakerId,eventId:String(req.query.eventId??'')},{
        readFeed:readProviderFeed,readEvents:async id=>usableBookmakerEvents(await readSource(id)),predict:validatedAnalytics,
      });
      res.json(response);
    } catch {res.status(503).json({lines:[],unavailable:true,unavailableReason:'Данные выбранной БК временно недоступны'});}
    return;
  }
  const team1Id = positiveId(req.query.radiantTeamId);
  const team2Id = positiveId(req.query.direTeamId);
  if (!['kills','duration'].includes(type) || !team1Id || !team2Id || team1Id === team2Id) {res.status(400).json({error:'invalid_market_input'});return;}
  const matchId = positiveId(req.query.matchId);
  // Legacy liveMinute is only a mode hint. Client numbers never become observations.
  const status = String(req.query.status ?? (req.query.liveMinute != null ? 'live' : 'prematch'));
  if (!['prematch','live','between_maps','finished'].includes(status)) {res.status(400).json({error:'invalid_status'});return;}
  try {
    const result = await validatedAnalytics({
      matchId: matchId ? 'od_' + matchId : 'ladder-query', matchSource: matchId ? 'opendota' : undefined,
      status:status as MatchInput['status'], format:String(req.query.format ?? 'unknown') as MatchInput['format'],
      team1:{name:'Radiant',teamId:team1Id,provider:'opendota'},team2:{name:'Dire',teamId:team2Id,provider:'opendota'},
    });
    const isLive = !!result.observedState || status === 'live';
    const pred = result.predictions.find(p => p.betType === (type === 'kills' ? 'total_kills' : 'total_duration'));
    const ladder = pred?.distribution ? totalsLadder(pred.distribution,Number(req.query.lineCount ?? 7)) : null;
    if (!ladder || !pred) {
      res.json({type,expectedValue:null,isLive,projection:null,lines:[],interval:null,confidence:null,modelVersion:'unavailable',unavailable:true,
        unavailableReason:'Нет проверенной модели с актуальными данными для этой карты',generatedAt:result.generatedAt});return;
    }
    const obs = result.observedState;
    res.json({type,...ladder,lineSource:'model',isLive,targetScope:'map',projection:obs ? {current:type === 'kills' ? obs.totalKills : obs.elapsedSeconds/60,
      minute:obs.elapsedSeconds/60,projected:ladder.expectedValue,remainingMin:type === 'duration' ? ladder.expectedValue-obs.elapsedSeconds/60 : null} : null,
      observedState:obs,confidence:null,modelVersion:pred.modelVersion,provenance:pred.provenance,
      liveSource:!!obs,generatedAt:pred.generatedAt,expiresAt:pred.expiresAt});
  } catch {res.status(503).json({lines:[],unavailable:true,unavailableReason:'Сервис прогноза временно недоступен'});}
});

/**
 * POST /api/analytics/batch
 * Предсказания для нескольких матчей сразу.
 */
router.post('/batch', async (req,res) => {
  const matches = req.body?.matches;
  if (!Array.isArray(matches) || !matches.length || matches.length > 20) {res.status(400).json({error:'matches must contain 1..20 entries'});return;}
  try {
    const results=[];
    // Bound the batch rather than issuing twenty model calls at once.
    for (const input of matches) results.push(await validatedAnalytics(input));
    res.json({results,count:results.length});
  } catch {res.status(503).json({results:[],state:'unavailable'});}
});

/**
 * GET /api/analytics/explain?radiantTeamId=&direTeamId=
 * Возвращает гуманизированное объяснение прогноза для пары команд.
 * Используется мобилкой во вкладке «Обзор» вместо сухой выгрузки фич.
 */
router.get('/explain', async (req, res) => {
  const t1=positiveId(req.query.radiantTeamId),t2=positiveId(req.query.direTeamId);
  if(!t1||!t2||t1===t2){res.status(400).json({error:'invalid_team_ids'});return;}
  const mid=positiveId(req.query.matchId);
  try {
    const result=await validatedAnalytics({matchId:mid?'od_'+mid:'explain-query',matchSource:mid?'opendota':undefined,status:req.query.status==='live'?'live':'prematch',format:String(req.query.format??'BO3') as MatchInput['format'],team1:{name:'Team 1',teamId:t1,provider:'opendota'},team2:{name:'Team 2',teamId:t2,provider:'opendota'}});
    const p=result.predictions.find(x=>x.betType==='map_winner');
    const summary=p?'Прогноз сохранённой модели; качество пока не подтверждено.':'Прогноз недоступен: нет подходящей модели или свежих данных.';
    res.json({state:result.state,winner:p?{radiantProb:p.probTeam1,direProb:p.probTeam2,favorite:{name:p.probTeam1>=.5?result.team1Name:result.team2Name,prob:Math.max(p.probTeam1,p.probTeam2)},summary,factors:[],modelVersion:p.modelVersion,provenance:p.provenance}:null,totals:{usedMlModel:false},oneLiner:summary,modelVersion:result.modelVersion,generatedAt:p?.generatedAt??result.generatedAt});
  } catch {res.status(503).json({state:'unavailable',winner:null});}
});

/**
 * POST /api/analytics/backtest
 * Бэктест на реальных prematch_outcomes.
 * Body: { minConfidence: 50..95, minOdds: 1.0..5.0, periodDays: 7..365 }
 * Ответ: KPI + equity-кривая + распределения по типам/уверенности.
 */
router.post('/backtest', async (req, res) => {
  const body = req.body as { minConfidence?: number; minOdds?: number; periodDays?: number };
  // NaN-guard: Number(undefined) и Number('abc') → NaN, Math.max/min их не отфильтрует.
  // Используем дефолты при невалидном/отсутствующем входе.
  const num = (v: unknown, def: number): number => {
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const minConf = Math.max(50, Math.min(95, num(body?.minConfidence, 60))) / 100;
  const minOdds = Math.max(1.01, Math.min(10, num(body?.minOdds, 1.5)));
  const periodDays = Math.max(7, Math.min(365, num(body?.periodDays, 90)));
  const fromDate = new Date(Date.now() - periodDays * 24 * 3600 * 1000);

  try {
    const [eligible, populations] = await Promise.all([
      db.execute(sql`${prematchValidationCte()}
        SELECT match_id AS "matchId", predicted_radiant_win_prob AS predicted,
          actual_radiant_win AS actual, predicted_at AS "predictedAt"
        FROM prematch_validation WHERE validation_reason = 'validated'
          AND actual_radiant_win IS NOT NULL AND predicted_at >= ${fromDate}
        ORDER BY predicted_at, match_id`),
      db.execute(sql`${prematchValidationCte()}
        SELECT validation_reason AS reason, COUNT(*)::int AS count FROM prematch_validation
        WHERE actual_radiant_win IS NOT NULL AND predicted_at >= ${fromDate}
        GROUP BY validation_reason ORDER BY count DESC`),
    ]);
    const rows = eligible.rows as Array<{matchId: number; predicted: number; actual: boolean; predictedAt: Date}>;
    const reasons = populations.rows as Array<{reason: string; count: number}>;
    const validation = {
      policy: PREMATCH_VALIDATION_POLICY, note: PREMATCH_VALIDATION_NOTE,
      validatedResolvedRecords: rows.length,
      unvalidatedRecords: reasons.filter(r => r.reason !== 'validated').reduce((n, r) => n + r.count, 0),
      excludedReasons: reasons.filter(r => r.reason !== 'validated'),
      scope: 'resolved_records_in_selected_period',
    };

    // Фильтр: только ставки с уверенностью >= minConf и подразумеваемым кэфом >= minOdds.
    // Для каждого исхода ставим на ту сторону, у которой p выше.
    type Bet = { date: Date; pickedRadiant: boolean; p: number; odds: number; won: boolean };
    const bets: Bet[] = [];
    for (const r of rows) {
      if (r.predicted == null || r.actual == null) continue;
      const p = Number(r.predicted);
      const pickRadiant = p >= 0.5;
      const pickProb = pickRadiant ? p : 1 - p;
      if (pickProb < minConf) continue;
      const odds = 1 / pickProb; // справедливый кэф (без маржи)
      if (odds < minOdds) continue;
      const won = pickRadiant ? r.actual === true : r.actual === false;
      bets.push({ date: r.predictedAt, pickedRadiant: pickRadiant, p: pickProb, odds, won });
    }

    if (bets.length === 0) {
      res.json({
        ok: true,
        params: { minConfidence: minConf, minOdds, periodDays },
        state: 'quality_unavailable', validation, oddsMode: 'synthetic_fair_odds',
        kpis: { numberOfBets: 0, hitRate: null, avgOdds: null, profitUnits: null, roi: null, maxDrawdown: null, brierScore: null },
        equityCurve: [],
        confidenceBuckets: [],
        message: 'Нет достаточного набора прогнозов, подтверждённых до фактического старта, под выбранные фильтры. Непроверенные записи исключены.',
      });
      return;
    }

    // Equity-кривая: ставка 1 юнит на каждую ставку, profit = (won ? odds-1 : -1)
    let bankroll = 0;
    let peak = 0;
    let maxDrawdown = 0;
    const equity: { date: string; units: number; bet: number; result: 'win' | 'loss' }[] = [];
    let wins = 0;
    let oddsSum = 0;
    let brierSum = 0;
    for (const b of bets) {
      const profit = b.won ? (b.odds - 1) : -1;
      bankroll += profit;
      peak = Math.max(peak, bankroll);
      maxDrawdown = Math.min(maxDrawdown, bankroll - peak);
      equity.push({ date: b.date.toISOString(), units: Math.round(bankroll * 100) / 100, bet: bets.indexOf(b) + 1, result: b.won ? 'win' : 'loss' });
      if (b.won) wins++;
      oddsSum += b.odds;
      brierSum += Math.pow(b.p - (b.won ? 1 : 0), 2);
    }
    const hitRate = wins / bets.length;
    const avgOdds = oddsSum / bets.length;
    const roi = bankroll / bets.length;
    const brierScore = brierSum / bets.length;

    // Гистограмма по уверенности
    const buckets = [
      { label: '50–60%', min: 0.5, max: 0.6, count: 0, wins: 0 },
      { label: '60–70%', min: 0.6, max: 0.7, count: 0, wins: 0 },
      { label: '70–80%', min: 0.7, max: 0.8, count: 0, wins: 0 },
      { label: '80–90%', min: 0.8, max: 0.9, count: 0, wins: 0 },
      { label: '90%+',   min: 0.9, max: 1.01, count: 0, wins: 0 },
    ];
    for (const b of bets) {
      const bk = buckets.find(x => b.p >= x.min && b.p < x.max);
      if (bk) { bk.count++; if (b.won) bk.wins++; }
    }
    const confidenceBuckets = buckets.map(b => ({
      label: b.label,
      count: b.count,
      hitRate: b.count > 0 ? b.wins / b.count : 0,
    }));

    res.json({
      ok: true,
      params: { minConfidence: minConf, minOdds, periodDays },
      state: 'validated_subset', validation, oddsMode: 'synthetic_fair_odds',
      message: 'Симуляция по справедливым коэффициентам 1/p; это не результат по историческим коэффициентам букмекера.',
      kpis: {
        numberOfBets: bets.length,
        hitRate,
        avgOdds: Math.round(avgOdds * 1000) / 1000,
        profitUnits: Math.round(bankroll * 100) / 100,
        roi: Math.round(roi * 10000) / 10000,
        maxDrawdown: Math.round(maxDrawdown * 100) / 100,
        brierScore: Math.round(brierScore * 10000) / 10000,
      },
      equityCurve: equity,
      confidenceBuckets,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, 'backtest failed');
    res.status(503).json({ ok: false, state: 'quality_unavailable', error: 'backtest_unavailable' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/analytics/draft-score
// ─────────────────────────────────────────────────────────────────────────
//
// Тело: { radiantHeroIds: number[5], direHeroIds: number[5] }
// Возвращает 4 фактора в шкале 0..100 на каждую сторону:
//   • synergy   — средний winRate всех C(5,2)=10 пар своей команды (hero_synergy)
//   • counter   — средний winRate 25 кросс-пар heroR vs heroD (hero_matchups)
//   • early     — среднее earlyGameScore × 100 (hero_stats, из Stratz roles)
//   • late      — среднее lateGameScore  × 100 (hero_stats, из Stratz roles)
//
// Используется на странице матча (вкладка «Драфт» → блок «Draft Score»).
// Если в БД нет данных по конкретной паре — она пропускается; если ВСЕ пары
// missing для метрики — поле = null с reason. UI должен показывать null честно.
router.post('/draft-score', async (req, res) => {
  try {
    const body = req.body as { radiantHeroIds?: unknown; direHeroIds?: unknown };
    const parseIds = (raw: unknown): number[] | null => {
      if (!Array.isArray(raw)) return null;
      const ids = raw.map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0 && n < 1000);
      return ids.length === 5 ? ids : null;
    };
    const rIds = parseIds(body.radiantHeroIds);
    const dIds = parseIds(body.direHeroIds);
    if (!rIds || !dIds) {
      res.status(400).json({ ok: false, error: 'radiantHeroIds & direHeroIds must be 5 hero ids each' });
      return;
    }
    // Уникальность внутри стороны и кросс-стороны — герой не может быть пикнут дважды.
    if (new Set(rIds).size !== 5 || new Set(dIds).size !== 5 || rIds.some(id => dIds.includes(id))) {
      res.status(400).json({ ok: false, error: 'hero ids must be unique within and across sides' });
      return;
    }

    const allIds = Array.from(new Set([...rIds, ...dIds]));

    // Один read из hero_stats: имена + early/late phase scores для всех 10.
    const heroRows = await db
      .select({
        heroId: heroStatsTable.heroId,
        name: heroStatsTable.name,
        early: heroStatsTable.earlyGameScore,
        late: heroStatsTable.lateGameScore,
      })
      .from(heroStatsTable)
      .where(inArray(heroStatsTable.heroId, allIds));

    const heroMap = new Map(heroRows.map(h => [h.heroId, h]));

    // Synergy: 10 same-team пар на сторону (C(5,2)=10).
    // hero_synergy симметрична семантически, но Stratz отдаёт топ-N асимметрично,
    // поэтому пробуем обе направленности и берём max(games) или среднее winRate.
    const synergyPairs: Array<[number, number]> = [];
    for (const ids of [rIds, dIds]) {
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) synergyPairs.push([ids[i], ids[j]]);
    }
    const synergyRows = synergyPairs.length
      ? await db
          .select({
            heroId: heroSynergyTable.heroId,
            withHeroId: heroSynergyTable.withHeroId,
            games: heroSynergyTable.games,
            winRate: heroSynergyTable.winRate,
          })
          .from(heroSynergyTable)
          .where(inArray(heroSynergyTable.heroId, allIds))
      : [];
    const synergyByPair = new Map<string, { games: number; winRate: number }>();
    for (const r of synergyRows) {
      const key = r.heroId < r.withHeroId ? `${r.heroId}_${r.withHeroId}` : `${r.withHeroId}_${r.heroId}`;
      const prev = synergyByPair.get(key);
      // Если уже есть запись для пары — берём ту, у которой больше games (надёжнее).
      if (!prev || r.games > prev.games) synergyByPair.set(key, { games: r.games, winRate: r.winRate });
    }

    // Counter: 25 кросс-пар heroR vs heroD из hero_matchups.
    const counterRows = await db
      .select({
        heroId: heroMatchupsTable.heroId,
        vsHeroId: heroMatchupsTable.vsHeroId,
        games: heroMatchupsTable.games,
        winRate: heroMatchupsTable.winRate,
      })
      .from(heroMatchupsTable)
      .where(and(
        inArray(heroMatchupsTable.heroId, allIds),
        inArray(heroMatchupsTable.vsHeroId, allIds),
      ));
    const counterByPair = new Map<string, { games: number; winRate: number }>();
    for (const r of counterRows) counterByPair.set(`${r.heroId}_${r.vsHeroId}`, { games: r.games, winRate: r.winRate });

    function computeSide(ownIds: number[], oppIds: number[]) {
      // Synergy: средний winRate всех C(5,2)=10 пар, взвешенный по log(games+1).
      let synWeight = 0, synSum = 0, synFound = 0;
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
        const a = ownIds[i], b = ownIds[j];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        const v = synergyByPair.get(key);
        if (v && v.games > 0) {
          const w = Math.log(v.games + 1);
          synWeight += w; synSum += v.winRate * w; synFound++;
        }
      }
      // Counter: 25 own-vs-opp пар. matchups.winRate — winRate героя heroId против vsHeroId.
      let cntWeight = 0, cntSum = 0, cntFound = 0;
      for (const own of ownIds) for (const opp of oppIds) {
        const v = counterByPair.get(`${own}_${opp}`);
        if (v && v.games > 0) {
          const w = Math.log(v.games + 1);
          cntWeight += w; cntSum += v.winRate * w; cntFound++;
        }
      }
      // Early/Late: среднее phase score по 5 героям.
      let earlySum = 0, lateSum = 0, phaseFound = 0;
      for (const id of ownIds) {
        const h = heroMap.get(id);
        if (h) { earlySum += h.early; lateSum += h.late; phaseFound++; }
      }

      const synergy = synWeight > 0 ? Math.round((synSum / synWeight) * 1000) / 10 : null;
      const counter = cntWeight > 0 ? Math.round((cntSum / cntWeight) * 1000) / 10 : null;
      const early = phaseFound > 0 ? Math.round((earlySum / phaseFound) * 1000) / 10 : null;
      const late  = phaseFound > 0 ? Math.round((lateSum  / phaseFound) * 1000) / 10 : null;
      return { synergy, counter, early, late, _meta: { synFound, cntFound, phaseFound } };
    }

    const radiant = computeSide(rIds, dIds);
    const dire = computeSide(dIds, rIds);

    res.json({
      ok: true,
      radiant: { synergy: radiant.synergy, counter: radiant.counter, early: radiant.early, late: radiant.late },
      dire:    { synergy: dire.synergy,    counter: dire.counter,    early: dire.early,    late: dire.late },
      meta: {
        heroesResolved: heroRows.length,
        synergyPairsFound: radiant._meta.synFound + dire._meta.synFound,
        counterPairsFound: radiant._meta.cntFound, // симметрично, считаем один раз
      },
    });
  } catch (err) {
    req.log.error({ err }, 'draft-score failed');
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/**
 * GET /api/analytics/team-profile?teamId=N
 * T3-T7: series momentum + dynamic form + ELO decomp + styles + entropy.
 * Возвращает всё сразу одним вызовом, fail-soft по секциям.
 * Использует только существующие таблицы — никаких ingest'ов на лету.
 */
router.get('/team-profile', async (req, res) => {
  const teamId = Number(req.query.teamId);
  if (!Number.isFinite(teamId) || teamId <= 0) {
    res.status(400).json({ error: 'teamId required (positive number)' });
    return;
  }
  try {
    const profile = await withCache(`team-profile:${teamId}`, 60_000, () => getTeamProfile(teamId));
    res.json(profile);
  } catch (err) {
    req.log.error({ err, teamId }, '[team-profile] failed');
    res.status(500).json({ error: 'team-profile failed', details: String(err) });
  }
});

/**
 * GET /api/analytics/team-compare?teamAId=N&teamBId=M
 * T8: A vs B — два TeamProfile параллельно + h2h + дифф-сводка.
 * Удобно для экрана сравнения в мобилке.
 */
router.get('/team-compare', async (req, res) => {
  const a = Number(req.query.teamAId);
  const b = Number(req.query.teamBId);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0 || a === b) {
    res.status(400).json({ error: 'teamAId/teamBId required (distinct positive numbers)' });
    return;
  }
  try {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const payload = await withCache(`team-compare:${low}:${high}:${a < b ? 'ab' : 'ba'}`, 60_000, async () => {
    const [profA, profB, h2hR] = await Promise.all([
      getTeamProfile(a),
      getTeamProfile(b),
      db.execute(sql`
        SELECT team_low_id, team_high_id, period_days, games, wins_low, computed_at
        FROM team_h2h
        WHERE team_low_id = ${low} AND team_high_id = ${high}
        ORDER BY period_days DESC LIMIT 1
      `).catch(() => ({ rows: [] as unknown[] })),
    ]);
    // Схема: wins_low относится к team_low_id; для A/B пересчитываем.
    let h2h: { winsA: number; winsB: number; games: number; periodDays: number; computedAt: string | null } | null = null;
    const row = h2hR.rows[0] as {
      team_low_id?: number | string; games?: number; wins_low?: number;
      period_days?: number; computed_at?: string | null;
    } | undefined;
    if (row && typeof row.games === 'number' && typeof row.wins_low === 'number') {
      const aIsLow = Number(row.team_low_id) === a;
      const winsLow = row.wins_low;
      const winsHigh = row.games - row.wins_low;
      h2h = {
        winsA: aIsLow ? winsLow : winsHigh,
        winsB: aIsLow ? winsHigh : winsLow,
        games: row.games,
        periodDays: row.period_days ?? 0,
        computedAt: row.computed_at ?? null,
      };
    }
    // Diff-сводка: только бесспорные численные сравнения, остальное даём как есть.
    const diff = {
      ratingDelta: (profA.teamRating != null && profB.teamRating != null)
        ? profA.teamRating - profB.teamRating : null,
      weightedFormDelta: (profA.dynamicForm?.weightedWinRate != null && profB.dynamicForm?.weightedWinRate != null)
        ? profA.dynamicForm.weightedWinRate - profB.dynamicForm.weightedWinRate : null,
      avgPlayerRatingDelta: (profA.eloDecomp?.avgPlayerRating != null && profB.eloDecomp?.avgPlayerRating != null)
        ? profA.eloDecomp.avgPlayerRating - profB.eloDecomp.avgPlayerRating : null,
      tierLevelA: profA.eloDecomp?.tierLevel ?? null,
      tierLevelB: profB.eloDecomp?.tierLevel ?? null,
    };
    return { teamA: profA, teamB: profB, h2h, diff };
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err, a, b }, '[team-compare] failed');
    res.status(500).json({ error: 'team-compare failed', details: String(err) });
  }
});

/**
 * GET /api/analytics/match-summary?matchId=N
 * T9: пост-матч сводка. Достаёт prematch_outcome (если резолвилось) +
 * последние live_snapshots + все предсказания по матчу.
 * Возвращает: predicted vs actual, calibration delta, market predictions list.
 */
router.get('/match-summary', async (req, res) => {
  const matchId = Number(req.query.matchId);
  if (!Number.isFinite(matchId) || matchId <= 0) {
    res.status(400).json({ error: 'matchId required (positive number)' });
    return;
  }
  try {
    const payload = await withCache(`match-summary:${matchId}`, 30_000, async () => {
    const [outcomeR, predsR, snapR] = await Promise.all([
      db.execute(sql`
        ${prematchValidationCte()}
        SELECT model_version, radiant_name, dire_name, league_name,
               predicted_radiant_win_prob, predicted_confidence,
               actual_radiant_win, actual_radiant_score, actual_dire_score,
               actual_duration_sec, predicted_at, resolved_at, validation_reason, verified_start_unix
        FROM prematch_validation WHERE match_id = ${matchId} LIMIT 1
      `).catch(() => ({ rows: [] as unknown[] })),
      db.execute(sql`
        SELECT market_type, model_version, model_prob_team1, model_prob_team2, predicted_at
        FROM predictions WHERE match_id = ${matchId}
        ORDER BY predicted_at DESC LIMIT 200
      `).catch(() => ({ rows: [] as unknown[] })),
      db.execute(sql`
        SELECT MIN(captured_at) first_at, MAX(captured_at) last_at,
               MAX(game_time_sec) last_game_time, COUNT(*) n
        FROM live_snapshots WHERE match_id = ${matchId}
      `).catch(() => ({ rows: [] as unknown[] })),
    ]);
    const outcome = outcomeR.rows[0] as {
      model_version?: string; radiant_name?: string | null; dire_name?: string | null;
      league_name?: string | null;
      predicted_radiant_win_prob?: number; predicted_confidence?: number | null;
      actual_radiant_win?: boolean | null; actual_radiant_score?: number | null;
      actual_dire_score?: number | null; actual_duration_sec?: number | null;
      predicted_at?: string; resolved_at?: string | null; validation_reason?: string; verified_start_unix?: string | null;
    } | undefined;
    let calibration: { hit: boolean; delta: number } | null = null;
    if (outcome?.validation_reason === 'validated' && outcome.actual_radiant_win != null && typeof outcome.predicted_radiant_win_prob === 'number') {
      const pred = outcome.predicted_radiant_win_prob;
      const actual = outcome.actual_radiant_win ? 1 : 0;
      calibration = { hit: (pred >= 0.5) === (actual === 1), delta: pred - actual };
    }
    // Сворачиваем market predictions: один market_type → последний прогноз.
    const marketLatest = new Map<string, { modelVersion: string; probTeam1: number | null; probTeam2: number | null; at: string }>();
    for (const p of predsR.rows as Array<{ market_type?: string; model_version?: string;
      model_prob_team1?: number | null; model_prob_team2?: number | null; predicted_at?: string }>) {
      const mt = p.market_type;
      if (!mt || mt === 'match_winner' || marketLatest.has(mt)) continue; // prematch probability comes only from the validated ledger // строки DESC, первый = последний
      marketLatest.set(mt, {
        modelVersion: p.model_version ?? '',
        probTeam1: p.model_prob_team1 ?? null,
        probTeam2: p.model_prob_team2 ?? null,
        at: p.predicted_at ?? '',
      });
    }
    const snap = snapR.rows[0] as { first_at?: string; last_at?: string; last_game_time?: number; n?: number } | undefined;
    return {
      matchId,
      outcome: outcome ? {
        modelVersion: outcome.model_version ?? null,
        radiantName: outcome.radiant_name ?? null,
        direName: outcome.dire_name ?? null,
        leagueName: outcome.league_name ?? null,
        predictedRadiantWinProb: outcome.validation_reason === 'validated' ? outcome.predicted_radiant_win_prob ?? null : null,
        predictedConfidence: outcome.validation_reason === 'validated' ? outcome.predicted_confidence ?? null : null,
        validation: { state: outcome.validation_reason === 'validated' ? 'validated' : 'unvalidated', reason: outcome.validation_reason ?? 'unknown', verifiedStartUnix: outcome.verified_start_unix ? Number(outcome.verified_start_unix) : null },
        actualRadiantWin: outcome.actual_radiant_win ?? null,
        actualScore: (outcome.actual_radiant_score != null && outcome.actual_dire_score != null)
          ? { radiant: outcome.actual_radiant_score, dire: outcome.actual_dire_score } : null,
        actualDurationSec: outcome.actual_duration_sec ?? null,
        predictedAt: outcome.predicted_at ?? null,
        resolvedAt: outcome.resolved_at ?? null,
      } : null,
      calibration,
      markets: [...marketLatest.entries()].map(([marketType, v]) => ({ marketType, ...v })),
      liveSnapshots: snap ? {
        firstAt: snap.first_at ?? null,
        lastAt: snap.last_at ?? null,
        lastGameTimeSec: snap.last_game_time ?? null,
        count: Number(snap.n ?? 0),
      } : null,
    };
    });
    res.json(payload);
  } catch (err) {
    req.log.error({ err, matchId }, '[match-summary] failed');
    res.status(500).json({ error: 'match-summary failed', details: String(err) });
  }
});

export default router;

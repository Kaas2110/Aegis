import { Router, type IRouter } from 'express';
import { runAnalytics, type MatchInput } from '../services/AnalyticsEngine';
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
import { db, predictionsTable, modelVersionsTable, prematchOutcomesTable, teamsTable } from '@workspace/db';
import { requireAdminSession } from './adminAuth';
import { eq, desc, sql, and, gte, isNotNull, inArray, ilike, or } from 'drizzle-orm';

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

/**
 * GET /api/analytics/predict-by-name?radiantTeamName=X&direTeamName=Y
 * Резолвит имена команд → teamId в нашей БД → запускает ML-предсказание.
 * Используется мобилкой для обогащения прематч-карточек с PandaScore,
 * где есть реальные имена команд, но нет OpenDota teamId.
 */
router.get('/predict-by-name', async (req, res) => {
  const radiantName = String(req.query.radiantTeamName ?? '').trim();
  const direName   = String(req.query.direTeamName   ?? '').trim();

  if (radiantName.length < 2 || direName.length < 2) {
    res.status(400).json({ error: 'radiantTeamName и direTeamName должны быть не менее 2 символов' });
    return;
  }

  const searchTeam = async (q: string) =>
    db.select({ teamId: teamsTable.teamId, name: teamsTable.name, rating: teamsTable.rating })
      .from(teamsTable)
      .where(or(ilike(teamsTable.name, `%${q}%`), ilike(teamsTable.tag, `%${q}%`)))
      .orderBy(desc(teamsTable.rating))
      .limit(1);

  const [radiantRows, direRows] = await Promise.all([
    searchTeam(radiantName),
    searchTeam(direName),
  ]);

  const radiantTeam = radiantRows[0];
  const direTeam    = direRows[0];

  if (!radiantTeam || !direTeam) {
    res.status(404).json({
      error: 'team_not_found',
      detail: !radiantTeam
        ? `"${radiantName}" не найдена в БД`
        : `"${direName}" не найдена в БД`,
    });
    return;
  }
  if (radiantTeam.teamId === direTeam.teamId) {
    res.status(400).json({ error: 'Оба имени указывают на одну и ту же команду' });
    return;
  }

  const result = await mlPredictMatchWinner(radiantTeam.teamId, direTeam.teamId);
  if (!result) {
    res.status(503).json({ error: 'no_model', detail: 'Нет активной ML-модели или недостаточно данных' });
    return;
  }

  res.json({
    radiantTeamId:          radiantTeam.teamId,
    radiantTeamName:        radiantTeam.name,
    direTeamId:             direTeam.teamId,
    direTeamName:           direTeam.name,
    radiantWinProbability:  result.probRadiantWin,
    direWinProbability:     1 - result.probRadiantWin,
    modelVersion:           result.modelVersion,
    features:               result.features,
  });
});

/**
 * POST /api/analytics/predict
 * Принимает данные матча, возвращает предсказания для всех 15 типов ставок.
 */
router.post('/predict', (req, res) => {
  try {
    const input = req.body as MatchInput & {
      bookmakerOdds?: { odds1: number; odds2: number };
    };

    if (!input.matchId || !input.team1 || !input.team2 || !input.format) {
      res.status(400).json({
        error: 'Требуются поля: matchId, team1, team2, format',
      });
      return;
    }

    const result = runAnalytics(input, input.bookmakerOdds);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, 'Analytics predict error');
    res.status(500).json({ error: 'Ошибка аналитики', details: String(err) });
  }
});

/**
 * GET /api/analytics/bet-types
 * Список всех поддерживаемых типов ставок с описаниями.
 */
/**
 * GET /api/analytics/popular-markets
 * Популярные рынки для режима «без букмекера». Принимает либо
 * ?radiantTeamId=&direTeamId= (прематч), либо тело POST с полным MatchInput.
 * Возвращает список рекомендуемых ставок с справедливыми коэффициентами.
 */
router.get('/popular-markets', async (req, res) => {
  const radiantId = Number(req.query.radiantTeamId);
  const direId = Number(req.query.direTeamId);
  const team1Name = String(req.query.team1Name ?? 'Radiant');
  const team2Name = String(req.query.team2Name ?? 'Dire');
  const formatRaw = String(req.query.format ?? 'BO3');

  // Валидация входа: положительные целые ID, разные команды, валидный формат
  if (!Number.isInteger(radiantId) || !Number.isInteger(direId) || radiantId <= 0 || direId <= 0) {
    res.status(400).json({ error: 'radiantTeamId & direTeamId must be positive integers' });
    return;
  }
  if (radiantId === direId) {
    res.status(400).json({ error: 'radiantTeamId and direTeamId must differ' });
    return;
  }
  if (formatRaw !== 'BO1' && formatRaw !== 'BO3' && formatRaw !== 'BO5') {
    res.status(400).json({ error: 'format must be BO1, BO3 or BO5' });
    return;
  }
  const format = formatRaw;

  const { buildPopularMarkets } = await import('../services/PopularMarkets');
  const { predictMatchWinner } = await import('../services/PredictionModel');
  const { predictMarketsFor } = await import('../services/MarketLgbm');

  // Опционально: подтягиваем ML-предсказание чтобы получить точный elo proxy.
  // Здесь упрощаем — feature vector с нейтральными значениями. Если есть ML-модель,
  // используем его prob чтобы сместить elo в наш FeatureVector.
  let elo1 = 1700;
  let elo2 = 1700;
  try {
    const mlPred = await predictMatchWinner(radiantId, direId);
    if (mlPred) {
      // Конвертируем prob в эквивалент ELO-разницы (обратная eloProb)
      const p = Math.min(0.99, Math.max(0.01, mlPred.probRadiantWin));
      const eloDiff = -400 * Math.log10(1 / p - 1);
      elo1 = 1700 + eloDiff / 2;
      elo2 = 1700 - eloDiff / 2;
    }
  } catch (err) {
    req.log.warn({ err }, 'ML predict failed for popular markets — using neutral ELO');
  }

  const lgbOverrides = await predictMarketsFor(radiantId, direId).catch(() => null);
  const cards = buildPopularMarkets({
    team1Name,
    team2Name,
    features: {
      elo1, elo2,
      form1: 0.55, form2: 0.5,
      h2hWinRate1: 0.5,
      draftSynergy1: 0.5, draftSynergy2: 0.5,
      draftCounter1: 0.5, draftCounter2: 0.5,
      scalingScore1: 0.5, scalingScore2: 0.5,
      earlyScore1: 0.5, earlyScore2: 0.5,
      matchFormat: format,
      tournamentTier: 1,
      isLive: false,
    },
    lgbOverrides: lgbOverrides ?? undefined,
  });

  res.json({
    matchInfo: { radiantId, direId, team1Name, team2Name, format },
    eloUsed: { elo1: Math.round(elo1), elo2: Math.round(elo2) },
    markets: cards,
    generatedAt: new Date().toISOString(),
  });
});

/**
 * POST /api/analytics/popular-markets
 * Полная версия с live-снапшотом — используется когда матч идёт.
 */
router.post('/popular-markets', async (req, res) => {
  try {
    const { runAnalytics } = await import('../services/AnalyticsEngine');
    const { buildPopularMarkets } = await import('../services/PopularMarkets');
    const input = req.body as Parameters<typeof runAnalytics>[0];
    // Минимальная валидация полей body (полная Zod-схема будет в OpenAPI спеке).
    if (!input || typeof input !== 'object' || !input.team1 || !input.team2 || !input.matchId) {
      res.status(400).json({ error: 'body must include matchId, team1, team2' });
      return;
    }
    const result = runAnalytics(input);
    const cards = buildPopularMarkets({
      team1Name: input.team1.name,
      team2Name: input.team2.name,
      features: result.featureVector,
    });
    res.json({
      matchId: input.matchId,
      markets: cards,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, 'popular-markets failed');
    res.status(500).json({ error: 'internal', details: String(err) });
  }
});

router.get('/bet-types', (_req, res) => {
  res.json({
    betTypes: [
      {
        id: 'match_winner',
        labelRu: 'Победитель матча',
        description: 'Кто выиграет весь матч (серию)',
        algorithm: 'ELO + форма (экспоненциальное взвешивание) + H2H + дрэфт + live-корректировка',
        features: ['elo1', 'elo2', 'form1', 'form2', 'h2hWinRate1', 'draft', 'liveSnapshot'],
        mlPlan: 'LightGBM на 48 фичах, горизонт 6 мес, переобучение раз в 14 дней',
      },
      {
        id: 'map_winner',
        labelRu: 'Победитель карты',
        description: 'Кто выиграет конкретную карту в серии',
        algorithm: 'Базовая вероятность матча + сторонний бонус (radiant +2.5% в про-играх)',
        features: ['match_winner_prob', 'side_advantage', 'map_pool_winrate'],
        mlPlan: 'Отдельная LightGBM с картовыми фичами (side, map_pool)',
      },
      {
        id: 'first_blood',
        labelRu: 'Первая кровь',
        description: 'Какая команда получит первую смерть',
        algorithm: 'Агрессивность команды (earlyScore) как Пуассоновский процесс',
        features: ['earlyScore1', 'earlyScore2', 'form'],
        mlPlan: 'XGBoost с временными фичами (время FB, роли героев)',
      },
      { id: 'first_tower', labelRu: 'Первая башня', description: 'Первая разрушенная башня', algorithm: 'Лайнинг-сила + дрэфт', features: ['earlyScore', 'draftSynergy'], mlPlan: 'LightGBM' },
      { id: 'first_roshan', labelRu: 'Первый Рошан', description: 'Первое убийство Рошана', algorithm: 'Ранняя сила + Roshan-приоритет дрэфта', features: ['earlyScore', 'draftSynergy'], mlPlan: 'LightGBM + таймерная фича' },
      { id: 'total_kills', labelRu: 'Тотал убийств', description: 'Суммарное число убийств на карте', algorithm: 'Темп команд × ожидаемое время', features: ['earlyScore', 'pace', 'duration_estimate'], mlPlan: 'Gradient Boosting Regressor → конвертация в Over/Under' },
      { id: 'total_duration', labelRu: 'Длительность карты', description: 'Сколько минут длится карта', algorithm: 'scalingScore (поздние герои) × базовая длительность 35 мин', features: ['scalingScore1', 'scalingScore2'], mlPlan: 'LightGBM Regressor' },
      { id: 'map_handicap', labelRu: 'Гандикап по картам', description: 'Победа с форой (напр. -1.5 карты)', algorithm: 'P(2-0) = p² из базовой вероятности матча', features: ['match_winner_prob'], mlPlan: 'Деривативная модель от match_winner' },
      { id: 'correct_score', labelRu: 'Точный счёт (BO3)', description: 'Точный счёт серии (2-0, 2-1, 1-2, 0-2)', algorithm: 'Биномиальное распределение по p_map', features: ['match_winner_prob'], mlPlan: 'Симуляционная модель Монте-Карло' },
      { id: 'comeback', labelRu: 'Камбэк (Live)', description: 'Вероятность победы проигрывающей команды (только live)', algorithm: 'σ(-k × NW_gap/5000 + time_remaining × 0.8)', features: ['netWorthLead', 'gameTimeSec', 'aegisHolder', 'buybackDisadv'], mlPlan: 'LSTM на временном ряду live-фичей' },
      { id: 'net_worth_lead', labelRu: 'Лидерство по NW', description: 'Кто будет лидировать по NetWorth в X мин', algorithm: 'earlyScore × draftSynergy (лайнинговая пара)', features: ['earlyScore', 'draftSynergy'], mlPlan: 'LightGBM с поминутными историческими данными' },
      { id: 'first_barracks', labelRu: 'Первые казармы', description: 'Первая разрушенная казарма', algorithm: 'Mid-game strength (scaling + synergy)', features: ['scalingScore', 'draftSynergy'], mlPlan: 'LightGBM' },
      { id: 'over_under_maps', labelRu: 'Тотал карт (BO3)', description: 'Больше или меньше 2.5 карт в BO3', algorithm: 'P(3 карты) = 2p(1-p) из биномиального', features: ['match_winner_prob'], mlPlan: 'Логистическая регрессия' },
      { id: 'kills_handicap', labelRu: 'Гандикап по убийствам', description: 'Разница убийств на карте', algorithm: 'Темп атак × ожидаемая продолжительность', features: ['earlyScore', 'pace'], mlPlan: 'LightGBM Regressor → бинаризация' },
      { id: 'draft_advantage', labelRu: 'Преимущество в дрэфте', description: 'Кто собрал более сильный дрэфт', algorithm: 'Взвешенный: synergy × 0.4 + counter × 0.35 + meta_tier × 0.25', features: ['draftSynergy', 'draftCounter', 'patchWinrate'], mlPlan: 'Hero2Vec embeddings → LightGBM' },
    ],
    mlRoadmap: {
      currentStage: 'mathematical_models',
      nextStage: 'lightgbm_per_bet_type',
      trainingData: 'OpenDota historical professional matches (last 6-12 months = 3-4 patches)',
      retrainingSchedule: 'every 14 days or after new patch',
      inferenceService: 'Python FastAPI at /api/ml/predict',
      expectedImprovement: '8-15% Brier score improvement over math models',
    },
  });
});

/**
 * GET /api/analytics/totals-ladder
 * Лестница тоталов — для UI «как у букмекеров». Возвращает несколько линий
 * (49.5, 50.5, …) с вероятностью ТБ/ТМ от модели.
 *   ?type=kills|duration                          (обязательно)
 *   ?radiantTeamId=X&direTeamId=Y                 (обязательно)
 *   ?format=BO1|BO3|BO5                           (по умолчанию BO3)
 *   ?liveCurrent=N&liveMinute=M                   (опц., для live-центрирования)
 *   ?lineCount=7                                  (опц., 3..15, по умолчанию 7)
 */
router.get('/totals-ladder', async (req, res) => {
  const type = String(req.query.type ?? '');
  if (type !== 'kills' && type !== 'duration') {
    res.status(400).json({ error: 'type must be "kills" or "duration"' });
    return;
  }
  const radiantId = Number(req.query.radiantTeamId);
  const direId = Number(req.query.direTeamId);
  if (!Number.isInteger(radiantId) || !Number.isInteger(direId) || radiantId <= 0 || direId <= 0 || radiantId === direId) {
    res.status(400).json({ error: 'radiantTeamId & direTeamId must be different positive integers' });
    return;
  }
  const formatRaw = String(req.query.format ?? 'BO3');
  if (formatRaw !== 'BO1' && formatRaw !== 'BO3' && formatRaw !== 'BO5') {
    res.status(400).json({ error: 'format must be BO1, BO3 or BO5' });
    return;
  }
  const formatNorm = formatRaw === 'BO1' ? 0 : formatRaw === 'BO5' ? 1 : 0.5;
  const rawLineCount = Number(req.query.lineCount);
  const lineCount = Math.min(15, Math.max(3, Number.isFinite(rawLineCount) && rawLineCount > 0 ? Math.floor(rawLineCount) : 7));
  const liveCurrent = req.query.liveCurrent != null ? Number(req.query.liveCurrent) : null;
  const liveMinute = req.query.liveMinute != null ? Number(req.query.liveMinute) : null;
  const isLive = liveCurrent != null && liveMinute != null && liveCurrent >= 0 && liveMinute > 0;

  // Опциональные букмекерские линии: ?lines=42.5,43.5,44.5
  // Если переданы — используем как есть (реальные линии бука), иначе генерируем синтетические.
  let bookmakerLines: number[] | null = null;
  let bookmakerSource: string | null = null;
  if (req.query.lines) {
    const parsed = String(req.query.lines)
      .split(',')
      .map(s => parseFloat(s.trim()))
      .filter(n => Number.isFinite(n) && n > 0 && n < 1000);
    if (parsed.length >= 2) {
      bookmakerLines = parsed;
      bookmakerSource = req.query.bookmakerSource ? String(req.query.bookmakerSource) : null;
    }
  }

  const { predictTotalKills, predictTotalDuration } = await import('../services/BetTypeModels');
  const { predictMatchWinner } = await import('../services/PredictionModel');

  // ELO-сдвиг как в /popular-markets (используем активную ML-модель)
  let elo1 = 1700;
  let elo2 = 1700;
  try {
    const mlPred = await predictMatchWinner(radiantId, direId);
    if (mlPred) {
      const p = Math.min(0.99, Math.max(0.01, mlPred.probRadiantWin));
      const eloDiff = -400 * Math.log10(1 / p - 1);
      elo1 = 1700 + eloDiff / 2;
      elo2 = 1700 - eloDiff / 2;
    }
  } catch (err) {
    req.log.warn({ err }, 'totals-ladder: ML predict failed, using neutral ELO');
  }

  const fv = {
    elo1, elo2,
    form1: 0.55, form2: 0.5,
    h2hWinRate1: 0.5,
    draftSynergy1: 0.5, draftSynergy2: 0.5,
    draftCounter1: 0.5, draftCounter2: 0.5,
    scalingScore1: 0.5, scalingScore2: 0.5,
    earlyScore1: 0.5, earlyScore2: 0.5,
    matchFormat: formatRaw as 'BO1' | 'BO3' | 'BO5',
    tournamentTier: 1 as 1 | 2 | 3,
    isLive,
    gameTimeSec: isLive ? (liveMinute as number) * 60 : undefined,
  };

  // Базовое μ модели (тот же расчёт, что внутри predictTotalKills/Duration)
  const pace = (fv.earlyScore1 * 0.7 + fv.form1 * 0.3 + fv.earlyScore2 * 0.7 + fv.form2 * 0.3) / 2;
  const baseExpectedKills = 38 + pace * 30;
  const scalingAvg = (fv.scalingScore1 + fv.scalingScore2) / 2;
  const baseExpectedDuration = 28 + scalingAvg * 24;

  // Live-проекция: текущий темп → ожидаемый финал
  let projection: { current: number; minute: number; projected: number; remainingMin: number } | null = null;
  if (isLive) {
    const currentVal = liveCurrent as number;
    const minute = liveMinute as number;
    if (type === 'kills') {
      const killsPerMin = Math.max(0.4, currentVal / Math.max(1, minute));
      const estimatedFinalMin = Math.max(minute + 5, baseExpectedDuration);
      const projectedKills = currentVal + killsPerMin * (estimatedFinalMin - minute);
      projection = { current: currentVal, minute, projected: projectedKills, remainingMin: estimatedFinalMin - minute };
    } else {
      projection = { current: minute, projected: Math.max(minute + 1, baseExpectedDuration), minute, remainingMin: Math.max(1, baseExpectedDuration - minute) };
    }
  }

  // Центр лестницы: для прематч — μ модели, для live — projection.projected
  const center = projection ? projection.projected : (type === 'kills' ? baseExpectedKills : baseExpectedDuration);
  const step = type === 'kills' ? 1 : 0.5;

  // Генерируем линии — или реальные от букмекера, или синтетические вокруг μ
  let lineValues: number[];
  const usingBookmakerLines = bookmakerLines !== null && bookmakerLines.length >= 2;
  if (usingBookmakerLines) {
    lineValues = bookmakerLines!;
  } else {
    let snappedCenter: number;
    if (type === 'kills') {
      snappedCenter = Math.round(center - 0.5) + 0.5;
    } else {
      snappedCenter = Math.round(center * 2) / 2;
    }
    const startOffset = -Math.floor(lineCount / 2);
    lineValues = [];
    for (let i = 0; i < lineCount; i++) {
      lineValues.push(snappedCenter + (startOffset + i) * step);
    }
  }

  // Wave 4 v2: LGB market-модель с 11 фичами (форма команд + patch_kpm + format)
  const { predictMarketsFor, probLogNormalOver } = await import('../services/MarketLgbm');
  const lgb = await predictMarketsFor(radiantId, direId, formatNorm).catch(() => null);
  const lgbLogN = type === 'kills' ? lgb?.totalKillsLogN ?? null : lgb?.totalDurationLogN ?? null;
  const linesScale = type === 'duration' ? 60 : 1;

  const lines = lineValues.map(line => {
    let pOver: number;
    if (lgbLogN) {
      pOver = probLogNormalOver(line * linesScale, lgbLogN.mean, lgbLogN.std);
    } else {
      const pred = type === 'kills' ? predictTotalKills(fv, line) : predictTotalDuration(fv, line);
      pOver = pred.probTeam1;
    }
    return {
      line: Number(line.toFixed(1)),
      pOver: Number(pOver.toFixed(4)),
      pUnder: Number((1 - pOver).toFixed(4)),
    };
  });

  const sample = type === 'kills' ? predictTotalKills(fv, lineValues[0] ?? center) : predictTotalDuration(fv, lineValues[0] ?? center);
  const confidence = lgbLogN ? 0.72 : sample.confidence;
  const modelVersion = lgbLogN ? 'lightgbm-market-v2' : sample.modelVersion;

  res.json({
    type,
    expectedValue: Number(center.toFixed(2)),
    isLive,
    projection,
    lines,
    confidence,
    modelVersion,
    bookmakerSource: bookmakerSource ?? undefined,
    linesSource: usingBookmakerLines ? 'bookmaker' : 'synthetic',
    generatedAt: new Date().toISOString(),
  });
});

/**
 * POST /api/analytics/batch
 * Предсказания для нескольких матчей сразу.
 */
router.post('/batch', (req, res) => {
  try {
    const { matches } = req.body as { matches: MatchInput[] };
    if (!Array.isArray(matches) || matches.length === 0) {
      res.status(400).json({ error: 'Требуется массив matches' });
      return;
    }
    if (matches.length > 20) {
      res.status(400).json({ error: 'Максимум 20 матчей за раз' });
      return;
    }
    const results = matches.map(m => runAnalytics(m));
    res.json({ results, count: results.length });
  } catch (err) {
    req.log.error({ err }, 'Analytics batch error');
    res.status(500).json({ error: 'Ошибка', details: String(err) });
  }
});

/**
 * GET /api/analytics/explain?radiantTeamId=&direTeamId=
 * Возвращает гуманизированное объяснение прогноза для пары команд.
 * Используется мобилкой во вкладке «Обзор» вместо сухой выгрузки фич.
 */
router.get('/explain', async (req, res) => {
  const parseId = (raw: unknown): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0 || n > 1e10) return null;
    return n;
  };
  const radiantId = parseId(req.query.radiantTeamId);
  const direId = parseId(req.query.direTeamId);
  if (radiantId === null || direId === null || radiantId === direId) {
    res.status(400).json({ error: 'Требуются разные положительные radiantTeamId и direTeamId' });
    return;
  }

  const result = await mlPredictMatchWinner(radiantId, direId);
  if (!result) {
    res.status(404).json({ error: 'Нет данных для объяснения' });
    return;
  }

  // Подтягиваем имена команд для гуманизации
  const teams = await db
    .select({ teamId: teamsTable.teamId, name: teamsTable.name, rating: teamsTable.rating })
    .from(teamsTable)
    .where(inArray(teamsTable.teamId, [radiantId, direId]));
  const tMap = new Map(teams.map(t => [t.teamId, t]));
  const tR = tMap.get(radiantId);
  const tD = tMap.get(direId);
  const nameR = (tR?.name ?? 'Radiant').trim();
  const nameD = (tD?.name ?? 'Dire').trim();
  const rR = tR?.rating ?? 1500;
  const rD = tD?.rating ?? 1500;

  const probR = result.probRadiantWin;
  const probD = 1 - probR;
  const favName = probR >= 0.5 ? nameR : nameD;
  const undName = probR >= 0.5 ? nameD : nameR;
  const favProb = Math.max(probR, probD);

  // Гуманизация фич — каждая по-русски + знак влияния на radiant
  const f = result.features;
  const factors: Array<{ label: string; impact: number; direction: 'radiant' | 'dire' | 'neutral'; description: string }> = [];

  if (typeof f['elo_diff_norm'] === 'number') {
    const v = f['elo_diff_norm'];
    factors.push({
      label: 'Рейтинг команд',
      impact: Math.abs(v),
      direction: v > 0.05 ? 'radiant' : v < -0.05 ? 'dire' : 'neutral',
      description: `Glicko ${Math.round(rR)} против ${Math.round(rD)} — ${
        v > 0.05 ? `${nameR} в среднем сильнее` :
        v < -0.05 ? `${nameD} в среднем сильнее` : 'команды равны'
      }`,
    });
  }
  if (typeof f['recent_form_diff'] === 'number') {
    const v = f['recent_form_diff'];
    factors.push({
      label: 'Форма за 30 дней',
      impact: Math.abs(v),
      direction: v > 0.03 ? 'radiant' : v < -0.03 ? 'dire' : 'neutral',
      description: v > 0.03 ? `${nameR} в лучшей форме` :
                   v < -0.03 ? `${nameD} в лучшей форме` : 'обе команды на равном уровне',
    });
  }
  if (typeof f['h2h_advantage_radiant'] === 'number') {
    const v = f['h2h_advantage_radiant'];
    if (v !== 0.5) {
      factors.push({
        label: 'Личные встречи (год)',
        impact: Math.abs(v - 0.5) * 2,
        direction: v > 0.55 ? 'radiant' : v < 0.45 ? 'dire' : 'neutral',
        description: `${nameR} ${Math.round(v * 100)}% побед в очных матчах`,
      });
    }
  }
  if (typeof f['player_skill_diff'] === 'number' && f['player_skill_diff'] !== 0) {
    const v = f['player_skill_diff'];
    factors.push({
      label: 'Игроки на их героях',
      impact: Math.abs(v),
      direction: v > 0.02 ? 'radiant' : v < -0.02 ? 'dire' : 'neutral',
      description: v > 0.02 ? `Состав ${nameR} лучше владеет своими героями` :
                   v < -0.02 ? `Состав ${nameD} лучше владеет своими героями` : 'паритет по комфорту героев',
    });
  }
  if (typeof f['draft_meta_strength_diff'] === 'number') {
    const v = f['draft_meta_strength_diff'];
    if (Math.abs(v) > 0.005) {
      factors.push({
        label: 'Сила пиков по патчу',
        impact: Math.abs(v) * 10,
        direction: v > 0 ? 'radiant' : 'dire',
        description: `${v > 0 ? nameR : nameD} взял героев с более высоким винрейтом в патче`,
      });
    }
  }
  if (typeof f['draft_matchup_advantage'] === 'number') {
    const v = f['draft_matchup_advantage'];
    if (Math.abs(v - 0.5) > 0.02) {
      factors.push({
        label: 'Контр-пики',
        impact: Math.abs(v - 0.5) * 2,
        direction: v > 0.5 ? 'radiant' : 'dire',
        description: `${v > 0.5 ? nameR : nameD} имеет преимущество по парным матчапам героев`,
      });
    }
  }

  factors.sort((a, b) => b.impact - a.impact);
  const top = factors.slice(0, 4);

  // Тотал убийств / длительность — пока без отдельной модели в инференсе:
  // используем грубое приближение чтобы UI мог показать ориентир
  const expectedKills = 50 + (rR + rD - 3000) * 0.005; // более сильные = меньше кб (быстрее закрывают)
  const expectedDurationMin = 36 - Math.abs(probR - 0.5) * 6; // равные команды дольше играют

  const oneLiner =
    favProb >= 0.65 ? `${favName} — уверенный фаворит (${Math.round(favProb * 100)}%)` :
    favProb >= 0.55 ? `${favName} в чуть выгодной позиции (${Math.round(favProb * 100)}%)` :
    `Матч близкий — ${nameR} ${Math.round(probR * 100)}% / ${nameD} ${Math.round(probD * 100)}%`;

  res.json({
    winner: {
      radiantProb: probR,
      direProb: probD,
      favorite: { name: favName, prob: favProb },
      underdog: { name: undName, prob: 1 - favProb },
      summary: oneLiner,
      factors: top,
    },
    totals: {
      kills: { expected: Math.round(expectedKills), low: Math.round(expectedKills - 8), high: Math.round(expectedKills + 8) },
      duration: { expectedMin: Math.round(expectedDurationMin), low: Math.round(expectedDurationMin - 5), high: Math.round(expectedDurationMin + 8) },
    },
    teams: {
      radiant: { id: radiantId, name: nameR, rating: rR },
      dire: { id: direId, name: nameD, rating: rD },
    },
    // Дублируем summary как top-level oneLiner для обратной совместимости с
    // клиентами, ожидающими его на корне ответа (см. T001 acceptance).
    oneLiner,
    modelVersion: result.modelVersion,
  });
});

/**
 * POST /api/analytics/backtest
 * Бэктест на реальных prematch_outcomes.
 * Body: { minConfidence: 50..95, minOdds: 1.0..5.0, periodDays: 7..365 }
 * Ответ: KPI + equity-кривая + распределения по типам/уверенности.
 */
// Простой in-memory rate-limit на /backtest: эндпоинт публичный (нет user-identity слоя),
// но премиум-замок в мобильном UI чисто конверсионный. Защищаем от тривиального DoS/скрейпа:
// 30 req/мин на IP. TODO(auth): когда появится identity, заменить на subscription gate.
const _backtestRl = new Map<string, { count: number; resetAt: number }>();
function backtestRateLimit(ip: string): boolean {
  const now = Date.now();
  const e = _backtestRl.get(ip);
  if (!e || e.resetAt < now) {
    _backtestRl.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  e.count += 1;
  return e.count > 30;
}

router.post('/backtest', async (req, res) => {
  const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').toString();
  if (backtestRateLimit(ip)) {
    res.status(429).json({ ok: false, message: 'Too many requests, try again in a minute' });
    return;
  }
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
    const rows = await db
      .select({
        matchId: prematchOutcomesTable.matchId,
        predicted: prematchOutcomesTable.predictedRadiantWinProb,
        actual: prematchOutcomesTable.actualRadiantWin,
        predictedAt: prematchOutcomesTable.predictedAt,
      })
      .from(prematchOutcomesTable)
      .where(and(
        isNotNull(prematchOutcomesTable.actualRadiantWin),
        gte(prematchOutcomesTable.predictedAt, fromDate),
      ))
      .orderBy(prematchOutcomesTable.predictedAt);

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
        kpis: { numberOfBets: 0, hitRate: 0, avgOdds: 0, profitUnits: 0, roi: 0, maxDrawdown: 0, brierScore: null },
        equityCurve: [],
        confidenceBuckets: [],
        message: 'Недостаточно резолвнутых исходов под выбранные фильтры',
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
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;

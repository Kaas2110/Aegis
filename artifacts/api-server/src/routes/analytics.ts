import { Router, type IRouter } from 'express';
import { runAnalytics, type MatchInput } from '../services/AnalyticsEngine';
import { withCache } from '../lib/responseCache';
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
import { db, predictionsTable, modelVersionsTable, prematchOutcomesTable, teamsTable, heroSynergyTable, heroMatchupsTable, heroStatsTable } from '@workspace/db';
import { getTeamProfile } from '../services/features/teamProfile';
import { requireAdminSession } from './adminAuth';
import { eq, desc, sql, and, gte, isNotNull, inArray, or, ilike } from 'drizzle-orm';

type TeamResolveEntry = { teamId: number; rating: number | null } | null;
const TEAM_RESOLVE_TTL_MS = 30 * 60 * 1000;
const TEAM_RESOLVE_MAX_ENTRIES = 2000;
const teamResolveCache = new Map<string, { value: TeamResolveEntry; exp: number }>();

function cacheGet(key: string): { hit: boolean; value: TeamResolveEntry } {
  const e = teamResolveCache.get(key);
  if (!e) return { hit: false, value: null };
  if (Date.now() > e.exp) {
    teamResolveCache.delete(key);
    return { hit: false, value: null };
  }
  teamResolveCache.delete(key);
  teamResolveCache.set(key, e);
  return { hit: true, value: e.value };
}

function cacheSet(key: string, value: TeamResolveEntry) {
  if (teamResolveCache.size >= TEAM_RESOLVE_MAX_ENTRIES) {
    const oldest = teamResolveCache.keys().next().value;
    if (oldest !== undefined) teamResolveCache.delete(oldest);
  }
  teamResolveCache.set(key, { value, exp: Date.now() + TEAM_RESOLVE_TTL_MS });
}

function normalizeTeamName(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

async function resolveOpenDotaTeam(name: string, providedId?: number): Promise<TeamResolveEntry> {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) return null;
  const norm = normalizeTeamName(trimmed);
  if (!norm) return null;
  const cacheKey = `${providedId ?? 0}|${norm}`;
  const c = cacheGet(cacheKey);
  if (c.hit) return c.value;
  let row: TeamResolveEntry = null;
  if (providedId && Number.isFinite(providedId) && providedId > 0 && providedId < 1e10) {
    const r = await db
      .select({ teamId: teamsTable.teamId, rating: teamsTable.rating, name: teamsTable.name, tag: teamsTable.tag })
      .from(teamsTable)
      .where(eq(teamsTable.teamId, providedId))
      .limit(1);
    if (r[0]) {
      const cn = normalizeTeamName(r[0].name ?? '');
      const ct = normalizeTeamName(r[0].tag ?? '');
      const idNameOk =
        cn === norm || ct === norm ||
        (norm.length >= 5 && (cn.includes(norm) || (cn.length >= 5 && norm.includes(cn))));
      if (idNameOk) row = { teamId: r[0].teamId, rating: r[0].rating };
    }
  }
  if (!row) {
    const wildcard = `%${trimmed.toLowerCase()}%`;
    const r = await db
      .select({ teamId: teamsTable.teamId, rating: teamsTable.rating, name: teamsTable.name, tag: teamsTable.tag })
      .from(teamsTable)
      .where(or(ilike(teamsTable.name, wildcard), ilike(teamsTable.tag, trimmed.toLowerCase())))
      .orderBy(desc(teamsTable.rating))
      .limit(20);
    const exactMatches = r.filter(c => {
      const cn = normalizeTeamName(c.name ?? '');
      const ct = normalizeTeamName(c.tag ?? '');
      return cn === norm || ct === norm;
    });
    let best: typeof r[number] | null = null;
    if (exactMatches.length > 0) {
      best = exactMatches[0] ?? null;
    } else if (norm.length >= 5) {
      for (const cand of r) {
        const cn = normalizeTeamName(cand.name ?? '');
        if (!cn) continue;
        if (cn.includes(norm) || (cn.length >= 5 && norm.includes(cn))) { best = cand; break; }
      }
    }
    if (best) row = { teamId: best.teamId, rating: best.rating };
  }
  cacheSet(cacheKey, row);
  return row;
}

async function enrichInputWithRealTeams(input: MatchInput, log?: { warn: (o: object, m?: string) => void }): Promise<MatchInput> {
  if (!input.team1?.name || !input.team2?.name) return input;
  const [t1raw, t2raw] = await Promise.all([
    resolveOpenDotaTeam(input.team1.name, input.team1.teamId),
    resolveOpenDotaTeam(input.team2.name, input.team2.teamId),
  ]);
  let t1 = t1raw;
  let t2 = t2raw;
  if (t1 && t2 && t1.teamId === t2.teamId) {
    const n1 = normalizeTeamName(input.team1.name);
    const n2 = normalizeTeamName(input.team2.name);
    if (n1 !== n2) {
      log?.warn?.({
        tag: 'predict',
        reason: 'team_resolve_collision',
        team1Name: input.team1.name,
        team2Name: input.team2.name,
        resolvedTeamId: t1.teamId,
      }, 'both teams resolved to same teamId; dropping resolutions');
      t1 = null;
      t2 = null;
    }
  }
  if (!t1 && !t2) return input;
  return {
    ...input,
    team1: {
      ...input.team1,
      teamId: t1?.teamId ?? input.team1.teamId,
      elo: input.team1.elo ?? (t1?.rating ?? undefined),
    },
    team2: {
      ...input.team2,
      teamId: t2?.teamId ?? input.team2.teamId,
      elo: input.team2.elo ?? (t2?.rating ?? undefined),
    },
  };
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

/**
 * POST /api/analytics/predict
 * Принимает данные матча, возвращает предсказания для всех 15 типов ставок.
 */
// TTL для прематч-кэша. Прематч-фичи меняются редко: ELO обновляется раз в
// сутки, ростер-замены — единичные случаи, h2h ещё реже. 4 часа — баланс между
// свежестью (~6 пересчётов в сутки) и экономией CPU/DB.
const PREMATCH_PREDICT_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Если переданы оба numeric teamId — вызываем активную ML-модель
 * (LightGBM v3 / LR fallback) и переопределяем `match_winner` в
 * математическом результате. Остальные 13 рынков остаются от математики
 * (для них пока нет ML). Если ML не вернул прогноз (модель не загружена,
 * мало матчей у команды и т.д.) — оставляем математику без изменений.
 */
function pruneWinnerMarkets(result: ReturnType<typeof runAnalytics>): void {
  // Удаляем match_winner+map_winner из predictions. Используется когда нет ML
  // или нет реальных фич — лучше отдать пустоту (UI: «прогноз недоступен»),
  // чем math-результат с дефолтным ELO 1700/1720 = 50/50.
  result.predictions = result.predictions.filter(
    p => p.betType !== 'match_winner' && p.betType !== 'map_winner',
  );
}

async function applyMlMatchWinner(
  result: ReturnType<typeof runAnalytics>,
  input: MatchInput,
): Promise<ReturnType<typeof runAnalytics>> {
  const t1 = input.team1.teamId;
  const t2 = input.team2.teamId;
  if (!t1 || !t2 || t1 === t2) {
    // Без teamId ML не вызвать → режем math winner вместо подсовывания 50/50.
    pruneWinnerMarkets(result);
    return result;
  }

  let ml;
  try {
    ml = await mlPredictMatchWinner(t1, t2);
  } catch (err) {
    pruneWinnerMarkets(result);
    return result;
  }
  if (!ml) {
    pruneWinnerMarkets(result);
    return result;
  }

  const idx = result.predictions.findIndex(p => p.betType === 'match_winner');
  if (idx === -1) return result;

  const old = result.predictions[idx];
  const probTeam1 = ml.probRadiantWin; // team1 = radiant в нашей нотации
  const probTeam2 = 1 - probTeam1;
  // Edge/EV пересчитываем относительно тех же букмекерских коэффициентов.
  const odds1 = old.bookmakerOdds1;
  const odds2 = old.bookmakerOdds2;
  let edge = 0;
  let ev = 0;
  if (odds1 && odds2) {
    const fairProb1 = (1 / odds1) / (1 / odds1 + 1 / odds2);
    edge = probTeam1 - fairProb1;
    ev = probTeam1 * (odds1 - 1) - (1 - probTeam1);
  }
  result.predictions[idx] = {
    ...old,
    probTeam1,
    probTeam2,
    confidence: Math.max(probTeam1, probTeam2),
    edge,
    ev,
    modelVersion: ml.modelVersion,
  };

  // Деривируем map_winner из ML-вероятности match_winner.
  // Без этого map_winner остаётся на математической модели с ELO 1720/1720
  // (мобилка hardcode-ит eloRating=1720 для всех) → 50/50 даже когда
  // match_winner честно говорит 76/24. predictMapWinner вызывает
  // predictMatchWinner внутри — нам нужно заменить его базу на ml.probRadiantWin.
  const mapIdx = result.predictions.findIndex(p => p.betType === 'map_winner');
  if (mapIdx !== -1) {
    const oldMap = result.predictions[mapIdx];
    // Небольшая корректировка на сторону radiant и стадию серии (аналог
    // predictMapWinner в BetTypeModels.ts, но база теперь ML, а не math).
    const fv = result.featureVector;
    const radiantBonus = fv.matchFormat !== 'BO1' ? 0.025 : 0.02;
    const earlyAdj = radiantBonus * ((fv.earlyScore1 ?? 0.5) - 0.5);
    const s1 = fv.seriesScore1 ?? 0;
    const s2 = fv.seriesScore2 ?? 0;
    const momentumAdj = s1 > s2 ? 0.025 : s2 > s1 ? -0.025 : 0;
    const rawP = probTeam1 + earlyAdj + momentumAdj;
    const clamp = (v: number) => Math.max(0.05, Math.min(0.95, v));
    const mapProb1 = clamp(rawP);
    result.predictions[mapIdx] = {
      ...oldMap,
      probTeam1: mapProb1,
      probTeam2: 1 - mapProb1,
      confidence: Math.max(mapProb1, 1 - mapProb1),
      modelVersion: `${ml.modelVersion}+derived`,
    };
  }

  // Помечаем что match_winner посчитан ML-моделью; остальные рынки — math.
  result.modelVersion = `${ml.modelVersion}+math_v1.0.0`;
  return result;
}

router.post('/predict', async (req, res) => {
  try {
    const rawInput = req.body as MatchInput & {
      bookmakerOdds?: { odds1: number; odds2: number };
    };

    if (!rawInput.matchId || !rawInput.team1 || !rawInput.team2 || !rawInput.format) {
      res.status(400).json({
        error: 'Требуются поля: matchId, team1, team2, format',
      });
      return;
    }

    const input = await enrichInputWithRealTeams(rawInput, req.log) as MatchInput & {
      bookmakerOdds?: { odds1: number; odds2: number };
    };
    input.bookmakerOdds = rawInput.bookmakerOdds;

    const isLive = !!input.liveSnapshot;
    if (isLive) {
      // Live-aware math по-прежнему считается (учитывает netWorthLead/
      // killsLead/tower/aegis из liveSnapshot), НО match_winner/map_winner
      // режем если у нас нет реального ELO команд — иначе мобилка с
      // hardcode eloRating=1720 для обеих сторон получит честное math 50/50,
      // что хуже, чем явное «прогноз недоступен». Live-winner ML-модель
      // считает LiveWorker отдельно и пишет в predictionsTable; мобилка
      // читает её через /api/matches/live → predictions.
      const result = runAnalytics(input, input.bookmakerOdds);
      // Режем winner-рынки если у нас нет реального ELO хотя бы одной команды.
      // Равные ELO у двух команд (e1===e2) — валидный кейс (реально равные пары),
      // НЕ режем. Мобилка теперь не шлёт 1720-stub, поэтому undefined elo
      // означает «нет данных в DB», а не «мобилка соврала».
      const e1 = input.team1.elo;
      const e2 = input.team2.elo;
      if (!e1 || !e2) {
        pruneWinnerMarkets(result);
      }
      res.json(result);
      return;
    }

    // Ключ кэша включает имена команд, формат, И teamId — на случай если апстрим
    // переиспользует matchId при ростер-замене или смене формата (BO3↔BO5).
    // teamId в ключе нужен потому что ML-вывод зависит от teamId, а не только
    // от имени; без него можно отдать stale-предикт после изменения id.
    // ВАЖНО: ключ включает seriesContext (счёт серии + номер карты), иначе
    // после смены карты в BO3/BO5 кэш на 4ч вернёт labelRu «карты 1» и
    // вероятность с устаревшим momentum. Без этого fix labelRu (mapNumber)
    // фактически не работает на cached path'е.
    const s1 = input.seriesContext?.seriesScore1 ?? 0;
    const s2 = input.seriesContext?.seriesScore2 ?? 0;
    const mapN = input.seriesContext?.currentMapNumber ?? (s1 + s2 + 1);
    const cacheKey =
      `predict:prematch:${input.matchId}:${input.team1.name}:${input.team2.name}` +
      `:${input.format}:${input.team1.teamId ?? 0}:${input.team2.teamId ?? 0}` +
      `:s${s1}-${s2}:m${mapN}`;
    const result = await withCache(
      cacheKey,
      PREMATCH_PREDICT_TTL_MS,
      async () => {
        const r = runAnalytics(input, input.bookmakerOdds);
        return applyMlMatchWinner(r, input);
      },
    );
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
  // Опциональный matchId — нужен для подмены прематч-LGB на T3.5 live-totals
  // предсказание из таблицы predictions. Без matchId или для прематч-вкладки
  // продолжаем отдавать прематч log-normal. Жёсткий safe-integer guard:
  // OpenDota match_id сейчас ~8·10⁹ (внутри Number.MAX_SAFE_INTEGER=9·10¹⁵),
  // но защищаемся на будущее от silent precision loss.
  const matchIdParam = req.query.matchId != null ? Number(req.query.matchId) : null;
  const matchId = matchIdParam != null && Number.isSafeInteger(matchIdParam) && matchIdParam > 0
    ? matchIdParam : null;
  const formatRaw = String(req.query.format ?? 'BO3');
  if (formatRaw !== 'BO1' && formatRaw !== 'BO3' && formatRaw !== 'BO5') {
    res.status(400).json({ error: 'format must be BO1, BO3 or BO5' });
    return;
  }
  const rawLineCount = Number(req.query.lineCount);
  const lineCount = Math.min(15, Math.max(3, Number.isFinite(rawLineCount) && rawLineCount > 0 ? Math.floor(rawLineCount) : 7));
  const liveCurrent = req.query.liveCurrent != null ? Number(req.query.liveCurrent) : null;
  const liveMinute = req.query.liveMinute != null ? Number(req.query.liveMinute) : null;
  const isLive = liveCurrent != null && liveMinute != null && liveCurrent >= 0 && liveMinute > 0;

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
      // duration: показываем, сколько уже прошло; «projected» = ожид. финал
      projection = { current: minute, projected: Math.max(minute + 1, baseExpectedDuration), minute, remainingMin: Math.max(1, baseExpectedDuration - minute) };
    }
  }

  // Центр лестницы: для прематч — μ модели, для live — projection.projected
  const center = projection ? projection.projected : (type === 'kills' ? baseExpectedKills : baseExpectedDuration);
  const step = type === 'kills' ? 1 : 0.5;
  // Линии у буков:
  //   kills — всегда X.5 (49.5, 50.5, 51.5...) — snap к ближайшему X.5
  //   duration — шаг 0.5, допускаются и .0 и .5 (42.0, 42.5, 43.0...) — snap к ближайшему .5
  let snappedCenter: number;
  if (type === 'kills') {
    snappedCenter = Math.round(center - 0.5) + 0.5;
  } else {
    snappedCenter = Math.round(center * 2) / 2;
  }
  const startOffset = -Math.floor(lineCount / 2);
  const lineValues: number[] = [];
  for (let i = 0; i < lineCount; i++) {
    lineValues.push(snappedCenter + (startOffset + i) * step);
  }

  // Wave 4: ТОЛЬКО LightGBM market-модель. Math-heuristic со stub-фичами 0.5
  // (form/synergy/scaling/early/h2h всё по 0.5) выдавал бы детерминированную
  // log-normal распределение вокруг базового μ — это фейк, не зависящий от
  // реальных команд. Если LGB не обучен для пары — возвращаем unavailable.
  const { predictMarketsFor, probLogNormalOver } = await import('../services/MarketLgbm');
  const lgb = await predictMarketsFor(radiantId, direId).catch(() => null);
  let lgbLogN = type === 'kills' ? lgb?.totalKillsLogN ?? null : lgb?.totalDurationLogN ?? null;
  const lgbQ25 = type === 'duration' ? lgb?.totalDurationLogQ25 ?? null : null;
  const lgbQ75 = type === 'duration' ? lgb?.totalDurationLogQ75 ?? null : null;
  const linesScale = type === 'duration' ? 60 : 1;  // log target = log(sec); UI line — мин

  // T3.5 override: для live-вкладки если есть свежее (≤180s) предсказание
  // `live_total_kills`/`live_total_duration` в таблице predictions — берём его
  // (mean,std) ВМЕСТО прематч-LGB. modelProbTeam1=mean, modelProbTeam2=std в
  // log-space (см. LiveWorker T3.5 блок). Запись идёт каждый poll (~60s).
  let modelVersion = 'lightgbm-market';
  let confidence = 0.72;
  let liveSource = false;
  if (isLive && matchId != null) {
    try {
      const marketType = type === 'kills' ? 'live_total_kills' : 'live_total_duration';
      const rows = await db
        .select({
          mean: predictionsTable.modelProbTeam1,
          std: predictionsTable.modelProbTeam2,
          version: predictionsTable.modelVersion,
          predictedAt: predictionsTable.predictedAt,
        })
        .from(predictionsTable)
        .where(and(
          eq(predictionsTable.matchId, matchId),
          eq(predictionsTable.marketType, marketType),
        ))
        .orderBy(desc(predictionsTable.predictedAt))
        .limit(1);
      if (rows.length > 0) {
        const ageSec = (Date.now() - new Date(rows[0].predictedAt).getTime()) / 1000;
        // Защита от мусора в БД: применяем override только если mean/std конечны
        // и std положительный. Иначе тихо падаем на прематч (а не ломаем UI).
        const meanOk = Number.isFinite(rows[0].mean);
        const stdOk = Number.isFinite(rows[0].std) && rows[0].std > 0;
        if (ageSec <= 180 && meanOk && stdOk) {
          lgbLogN = { mean: rows[0].mean, std: Math.max(1e-3, rows[0].std) };
          modelVersion = rows[0].version;
          confidence = 0.78; // live-фичи живут на свежем снапшоте, доверие чуть выше
          liveSource = true;
        }
      }
    } catch (err) {
      req.log.warn({ err, matchId, type }, 'totals-ladder: live override lookup failed');
    }
  }

  if (!lgbLogN) {
    res.json({
      type,
      expectedValue: Number(center.toFixed(2)),
      isLive,
      projection,
      lines: [],
      interval: null,
      confidence: 0,
      modelVersion: 'unavailable',
      unavailable: true,
      unavailableReason: type === 'kills'
        ? 'LightGBM total_kills модель не обучена для этой пары команд'
        : 'LightGBM total_duration модель не обучена для этой пары команд',
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  const lines = lineValues.map(line => {
    const pOver = probLogNormalOver(line * linesScale, lgbLogN.mean, lgbLogN.std);
    return {
      line: Number(line.toFixed(1)),
      pOver: Number(pOver.toFixed(4)),
      pUnder: Number((1 - pOver).toFixed(4)),
    };
  });

  res.json({
    type,
    expectedValue: Number(center.toFixed(2)),
    isLive,
    projection,
    lines,
    interval: type === 'duration' && lgbQ25 != null && lgbQ75 != null
      ? {
          q25: Number(Math.exp(lgbQ25).toFixed(2)),
          q75: Number(Math.exp(lgbQ75).toFixed(2)),
        }
      : null,
    confidence,
    modelVersion,
    liveSource,
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
    const results = matches.map(m => {
      const r = runAnalytics(m);
      // Тот же policy что и /predict: без реального ELO режем winner-рынки.
      if (!m.team1.elo || !m.team2.elo) pruneWinnerMarkets(r);
      return r;
    });
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
      description: v > 0.05 ? `${nameR} сильнее по рейтингу` :
                   v < -0.05 ? `${nameD} сильнее по рейтингу` : 'рейтинг команд примерно равен',
    });
  }
  if (typeof f['player_glicko_diff'] === 'number') {
    const v = f['player_glicko_diff'];
    if (Math.abs(v) > 0.1) {
      factors.push({
        label: 'Уровень игроков',
        impact: Math.abs(v),
        direction: v > 0.1 ? 'radiant' : v < -0.1 ? 'dire' : 'neutral',
        description: v > 0.1 ? `Состав ${nameR} сильнее в среднем по игрокам` :
                     `Состав ${nameD} сильнее в среднем по игрокам`,
      });
    }
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

  // Тотал убийств / длительность — LightGBM market-модели (Wave 4/5).
  // Если модели не загружены или ml-service недоступен — фолбэк на грубую эвристику.
  const { predictMarketsFor } = await import('../services/MarketLgbm');
  const mkt = await predictMarketsFor(radiantId, direId).catch(() => null);

  // log-normal (mean=μ, std=σ): медиана = exp(μ), 90% CI = exp(μ ± 1.645σ)
  let expectedKills: number;
  let killsLow: number;
  let killsHigh: number;
  if (mkt?.totalKillsLogN) {
    const { mean: mu, std: sigma } = mkt.totalKillsLogN;
    expectedKills = Math.exp(mu);
    killsLow = Math.exp(mu - 1.28 * sigma);
    killsHigh = Math.exp(mu + 1.28 * sigma);
  } else {
    expectedKills = 50 + (rR + rD - 3000) * 0.005;
    killsLow = expectedKills - 8;
    killsHigh = expectedKills + 8;
  }

  let expectedDurationSec: number;
  let durLow: number;
  let durHigh: number;
  if (mkt?.totalDurationLogN) {
    const { mean: mu, std: sigma } = mkt.totalDurationLogN;
    expectedDurationSec = Math.exp(mu);
    durLow = Math.exp(mu - 1.28 * sigma);
    durHigh = Math.exp(mu + 1.28 * sigma);
  } else {
    const fallbackMin = 36 - Math.abs(probR - 0.5) * 6;
    expectedDurationSec = fallbackMin * 60;
    durLow = (fallbackMin - 5) * 60;
    durHigh = (fallbackMin + 8) * 60;
  }

  const expectedDurationMin = expectedDurationSec / 60;
  const usedMlTotals = !!(mkt?.totalKillsLogN && mkt?.totalDurationLogN);

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
      kills: { expected: Math.round(expectedKills), low: Math.round(killsLow), high: Math.round(killsHigh) },
      duration: { expectedMin: Math.round(expectedDurationMin), low: Math.round(durLow / 60), high: Math.round(durHigh / 60) },
      usedMlModel: usedMlTotals,
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
        SELECT model_version, radiant_name, dire_name, league_name,
               predicted_radiant_win_prob, predicted_confidence,
               actual_radiant_win, actual_radiant_score, actual_dire_score,
               actual_duration_sec, predicted_at, resolved_at
        FROM prematch_outcomes WHERE match_id = ${matchId} LIMIT 1
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
      predicted_at?: string; resolved_at?: string | null;
    } | undefined;
    let calibration: { hit: boolean; delta: number } | null = null;
    if (outcome && outcome.actual_radiant_win != null && typeof outcome.predicted_radiant_win_prob === 'number') {
      const pred = outcome.predicted_radiant_win_prob;
      const actual = outcome.actual_radiant_win ? 1 : 0;
      calibration = { hit: (pred > 0.5) === (actual === 1), delta: pred - actual };
    }
    // Сворачиваем market predictions: один market_type → последний прогноз.
    const marketLatest = new Map<string, { modelVersion: string; probTeam1: number | null; probTeam2: number | null; at: string }>();
    for (const p of predsR.rows as Array<{ market_type?: string; model_version?: string;
      model_prob_team1?: number | null; model_prob_team2?: number | null; predicted_at?: string }>) {
      const mt = p.market_type;
      if (!mt || marketLatest.has(mt)) continue; // строки DESC, первый = последний
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
        predictedRadiantWinProb: outcome.predicted_radiant_win_prob ?? null,
        predictedConfidence: outcome.predicted_confidence ?? null,
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

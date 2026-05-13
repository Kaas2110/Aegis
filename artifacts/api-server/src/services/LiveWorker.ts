/**
 * Воркер, который раз в минуту опрашивает OpenDota /api/live,
 * сохраняет снапшоты в БД, и считает предсказания через активную ML-модель.
 *
 * Запускается из index.ts если ENABLE_LIVE_WORKER=true (по умолчанию включено в dev).
 */

import { db, liveSnapshotsTable, predictionsTable } from '@workspace/db';
import { logger } from '../lib/logger';
import { predictMatchWinner, loadActiveModel, getActiveModel, type DraftInput } from './PredictionModel';
import { loadActiveLiveModel, getActiveLiveModel, predictLiveWinner } from './LiveWinnerModel';
import { recordPrematchPrediction } from './OutcomeTracker';

const POLL_INTERVAL_MS = 60_000;
const OPENDOTA_LIVE_URL = 'https://api.opendota.com/api/live';

interface LiveMatch {
  match_id?: number;
  game_time?: number;
  team_id_radiant?: number;
  team_id_dire?: number;
  team_name_radiant?: string;
  team_name_dire?: string;
  radiant_score?: number;
  dire_score?: number;
  radiant_lead?: number;
  building_state?: number;
  // OpenDota /api/live раскрывает массив игроков с hero_id и team (0=R, 1=D)
  // как только драфт завершён. Используем это для v2-фичей.
  players?: Array<{ account_id?: number; hero_id?: number; team?: 0 | 1; team_slot?: number }>;
}

/**
 * Вытаскивает 5+5 hero_ids из /api/live payload или null если драфт неполный.
 *
 * `team` (0/1) — авторитетное поле, когда оно есть. Если поля нет, делаем
 * fallback на `team_slot`: значения 0..4 (или 1..5, в зависимости от формата
 * payload в данный момент) → radiant, всё остальное малое → dire. Используем
 * Steam-bitfield эвристику (>=128 = dire), которая совпадает с типичным
 * представлением player_slot в Dota API.
 */
function extractDraftFromLive(m: LiveMatch): DraftInput | null {
  if (!m.players || m.players.length < 10) return null;
  const radiantPicks: number[] = [];
  const direPicks: number[] = [];
  const radiantAccounts: number[] = [];
  const direAccounts: number[] = [];
  for (const p of m.players) {
    if (!p.hero_id || p.hero_id <= 0) continue;
    let side: 0 | 1 | null = null;
    if (p.team === 0 || p.team === 1) {
      side = p.team;
    } else if (typeof p.team_slot === 'number') {
      // Heuristic: либо 0..4/5..9, либо 0..4/128..132 (Steam bitfield).
      if (p.team_slot >= 128) side = 1;
      else if (p.team_slot >= 5) side = 1;
      else side = 0;
    }
    const acc = typeof p.account_id === 'number' && p.account_id > 0 ? p.account_id : 0;
    if (side === 0) {
      radiantPicks.push(p.hero_id);
      radiantAccounts.push(acc);
    } else if (side === 1) {
      direPicks.push(p.hero_id);
      direAccounts.push(acc);
    }
  }
  if (radiantPicks.length !== 5 || direPicks.length !== 5) return null;
  // Защита от смерт случая когда два игрока попали на ту же сторону: пики
  // должны быть уникальными (5 разных героев). Если коллизия — отдаём null,
  // лучше упасть в v1 чем кормить v2 битыми фичами.
  if (new Set(radiantPicks).size !== 5 || new Set(direPicks).size !== 5) return null;
  // Wave 3: account_ids идут параллельным массивом, выровненным по picks.
  // Если у игрока был анонимный аккаунт (account_id отсутствует/0), оставляем
  // 0 — buildExtraFeatures игнорирует такие записи. Если у обеих сторон ВСЕ
  // аккаунты нулевые, не передаём массивы (PredictionModel тогда упадёт в v2).
  const rHasAnyAcc = radiantAccounts.some(a => a > 0);
  const dHasAnyAcc = direAccounts.some(a => a > 0);
  // Баны /api/live не отдаёт. Фичи строятся с пустыми банами —
  // ban_priority_diff = 0, нейтральный вклад.
  return {
    radiantPicks,
    direPicks,
    radiantBans: [],
    direBans: [],
    radiantAccountIds: rHasAnyAcc ? radiantAccounts : null,
    direAccountIds: dHasAnyAcc ? direAccounts : null,
  };
}

let timeoutId: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let stopRequested = false;
let stats = {
  totalPolls: 0,
  totalSnapshots: 0,
  totalPredictions: 0,
  totalLivePredictions: 0,
  lastPollAt: null as Date | null,
  lastPollDurationMs: 0,
  lastError: null as string | null,
};

async function pollOnce(): Promise<void> {
  stats.totalPolls++;
  stats.lastPollAt = new Date();

  let matches: LiveMatch[] = [];
  try {
    const resp = await fetch(OPENDOTA_LIVE_URL, {
      headers: { 'User-Agent': 'DotaEdgeAnalyzer/1.0' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    matches = (await resp.json()) as LiveMatch[];
  } catch (err) {
    stats.lastError = String(err);
    logger.warn({ err }, '[LiveWorker] OpenDota fetch failed');
    return;
  }

  if (!Array.isArray(matches) || matches.length === 0) return;

  // Фильтруем матчи с командами и валидным id
  const valid = matches.filter(m => m.match_id && m.team_id_radiant && m.team_id_dire);
  if (valid.length === 0) return;

  // Сохраняем снапшоты
  try {
    const rows = valid.map(m => ({
      matchId: m.match_id!,
      gameTimeSec: m.game_time ?? null,
      radiantTeamId: m.team_id_radiant ?? null,
      direTeamId: m.team_id_dire ?? null,
      radiantScore: m.radiant_score ?? null,
      direScore: m.dire_score ?? null,
      radiantLead: m.radiant_lead ?? null,
      buildingState: m.building_state ?? null,
      rawPayload: m as unknown as Record<string, unknown>,
    }));
    await db.insert(liveSnapshotsTable).values(rows);
    stats.totalSnapshots += rows.length;
  } catch (err) {
    logger.error({ err }, '[LiveWorker] snapshot insert failed');
  }

  // Делаем предсказания если модель активна
  const model = getActiveModel();
  if (!model) return;

  for (const m of valid) {
    if (!m.team_id_radiant || !m.team_id_dire) continue;
    try {
      const draft = extractDraftFromLive(m);
      const pred = await predictMatchWinner(m.team_id_radiant, m.team_id_dire, draft);
      if (!pred) continue;

      await db.insert(predictionsTable).values({
        matchId: m.match_id!,
        modelVersion: pred.modelVersion,
        marketType: 'match_winner',
        modelProbTeam1: pred.probRadiantWin,
        modelProbTeam2: 1 - pred.probRadiantWin,
        confidence: 0.6, // упрощённо: пока константа, потом — функция от полноты данных
        features: pred.features,
      });
      stats.totalPredictions++;

      // LIVE-модель: если активна и матч уже идёт (game_time>=60), считаем
      // обновлённую вероятность с учётом текущего снапшота. Сохраняем как
      // отдельную строку в predictions с marketType='live_match_winner',
      // чтобы потом сравнивать и калибровать.
      const liveModel = getActiveLiveModel();
      if (liveModel && (m.game_time ?? -1) >= 60) {
        const livePred = predictLiveWinner(
          {
            gameTimeSec: m.game_time ?? null,
            radiantLead: m.radiant_lead ?? null,
            radiantScore: m.radiant_score ?? null,
            direScore: m.dire_score ?? null,
            buildingState: m.building_state ?? null,
            isRealLive: 1,
            hasDraft: draft !== null ? 1 : 0,
            recencyDaysNorm: 0.0,
          },
          pred.probRadiantWin,
        );
        if (livePred) {
          try {
            await db.insert(predictionsTable).values({
              matchId: m.match_id!,
              modelVersion: livePred.modelVersion,
              marketType: 'live_match_winner',
              modelProbTeam1: livePred.probRadiantWin,
              modelProbTeam2: 1 - livePred.probRadiantWin,
              confidence: 0.7,
              features: livePred.features,
            });
            stats.totalLivePredictions++;
          } catch (err) {
            logger.warn({ err, matchId: m.match_id }, '[LiveWorker] live prediction insert failed');
          }
        }
      }

      // Записываем прематч-прогноз в персистентный ledger.
      // Идемпотентно благодаря UNIQUE(match_id) + onConflictDoNothing —
      // поэтому пишем при ЛЮБОМ первом виде матча (отрицательное game_time =
      // драфт/пик-фаза, нулевое или положительное = матч начался). Запись
      // происходит ровно один раз — самая первая. После этого UNIQUE-ограничение
      // отбрасывает все последующие upsert'ы. Это гарантирует, что в ledger
      // попадают ВСЕ матчи, увиденные live-воркером, а не только те, у которых
      // game_time < 300.
      {
        // Стампим тир и features_version в features-снапшот ledger'а, чтобы
        // потом в админке можно было разбить out-of-sample метрики по тиру
        // _на момент предсказания_, а не по текущим рейтингам команд.
        const featuresStamped: Record<string, number> = {
          ...(pred.features as Record<string, number>),
          __features_version: pred.featuresVersion,
          __tier_t1: pred.tier === 't1' ? 1 : 0,
          __tier_t2: pred.tier === 't2' ? 1 : 0,
          __tier_t3: pred.tier === 't3' ? 1 : 0,
        };
        await recordPrematchPrediction({
          matchId: m.match_id!,
          modelVersion: pred.modelVersion,
          predictedRadiantWinProb: pred.probRadiantWin,
          predictedConfidence: 0.6,
          radiantTeamId: m.team_id_radiant ?? null,
          direTeamId: m.team_id_dire ?? null,
          radiantName: m.team_name_radiant ?? null,
          direName: m.team_name_dire ?? null,
          features: featuresStamped,
        });
      }
    } catch (err) {
      logger.error({ err, matchId: m.match_id }, '[LiveWorker] prediction insert failed');
    }
  }

  logger.info(
    { liveMatches: valid.length, totalPredictions: stats.totalPredictions, totalSnapshots: stats.totalSnapshots },
    '[LiveWorker] poll complete',
  );
}

/**
 * Self-rescheduling poller. setTimeout (а не setInterval) защищает от наложения
 * запусков, если один опрос занял дольше POLL_INTERVAL_MS (медленная сеть/БД).
 */
async function scheduleNextPoll(delayMs: number): Promise<void> {
  if (stopRequested) return;
  timeoutId = setTimeout(async () => {
    if (stopRequested) return;
    if (pollInFlight) {
      // На всякий случай: если предыдущий прогон ещё идёт — пропускаем тик.
      logger.warn('[LiveWorker] previous poll still in flight, skipping');
      void scheduleNextPoll(POLL_INTERVAL_MS);
      return;
    }
    pollInFlight = true;
    const startedAt = Date.now();
    try {
      await pollOnce();
    } catch (err) {
      logger.error({ err }, '[LiveWorker] poll error');
    } finally {
      stats.lastPollDurationMs = Date.now() - startedAt;
      pollInFlight = false;
      void scheduleNextPoll(POLL_INTERVAL_MS);
    }
  }, delayMs);
}

export function startLiveWorker(): void {
  if (timeoutId || stopRequested) return;
  logger.info({ intervalMs: POLL_INTERVAL_MS }, '[LiveWorker] starting');
  loadActiveModel().catch(err => logger.error({ err }, '[LiveWorker] initial model load failed'));
  loadActiveLiveModel().catch(err => logger.error({ err }, '[LiveWorker] initial live model load failed'));
  void scheduleNextPoll(5_000);

  // Wire shutdown hooks (один раз; повторные вызовы start() безвредны — node склеит).
  const shutdown = () => {
    logger.info('[LiveWorker] shutdown signal received');
    stopLiveWorker();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export function stopLiveWorker(): void {
  stopRequested = true;
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
    logger.info('[LiveWorker] stopped');
  }
}

export function getWorkerStats() {
  const live = getActiveLiveModel();
  return {
    ...stats,
    modelLoaded: !!getActiveModel(),
    modelVersion: getActiveModel()?.version ?? null,
    liveModelLoaded: !!live,
    liveModelVersion: live?.version ?? null,
  };
}

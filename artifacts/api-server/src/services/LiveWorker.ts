/**
 * Collect real OpenDota live packets and calculate the currently active models.
 * Only this collector refreshes OpenDota; HTTP readers use durable snapshots. Free-mode
 * polling is at least 120 seconds; idle polling is configured separately.
 *
 * STRATZ rich telemetry remains disabled: authenticated GraphQL works with
 * User-Agent STRATZ_API, but sampled live.match/playbackData were not populated.
 * Schema availability is not a coverage guarantee. Re-enabling enrichment
 * requires observed filled packets and a matching validated feature contract.
 */
import { db, liveSnapshotsTable, predictionsTable, proMatchesTable } from '@workspace/db';
import {and,inArray,sql} from 'drizzle-orm';
import { logger } from '../lib/logger';
import { predictMatchWinner, loadActiveModel, getActiveModel, type DraftInput } from './PredictionModel';
import { loadActiveLiveModel, getActiveLiveModel, predictLiveWinner } from './LiveWinnerModel';
import { loadActiveAsymLiveModel, getActiveAsymLiveModel, predictAsymLiveWinner } from './AsymLiveModel';
import { isAsymEligible } from './AsymPrematchModel';
import { recordPrematchPrediction } from './OutcomeTracker';
// DORMANT — Stratz live upstream пуст. Раскомментировать при восстановлении:
// import { fetchLiveMatchDetailBatch, type StratzLiveDetail } from '../lib/stratzLive';
import { predictLiveTotalsFor } from './MarketLgbm';
import {recordLiveTotalsRefusals} from './LiveTotalsDiagnostics';
import { refreshOpenDotaLiveFeed } from './OpenDotaLiveFeed';
import {planLiveCoverage,captureCoverageFeed,captureCoverageFailure,finishLiveCoverage,type PollCapture} from './LiveCoverageJournal';
import { recordHeartbeat } from './workerHeartbeats';
import { getAppSettings } from './AppSettings';
import {LiveJournalContext, flushLivePredictionJournal} from './LivePredictionJournal';
import {safeOpenDotaId} from '../lib/openDotaLiveIds';
import {livePacketShapeIssue,type LivePacketShapeIssue} from '../lib/livePacketShape';
import {enqueueLiveWinnerShadow} from './LiveWinnerShadow';
import {enqueuePostdraftPackets} from './PostdraftShadow';
import {enqueueHazardPackets} from './HazardShadow';
import {enqueueWidePackets,wideShadowStatus,stopWideShadow} from './WideShadow';
import {DEFAULT_LIVE_INTERVAL_MS, DEFAULT_IDLE_INTERVAL_MS, livePollMode,
  livePollBaseIntervalMs, livePollFailureBackoffMs, livePollNextDelayMs, livePollActivity} from '../lib/livePollSchedule';

// Дефолты live/idle (используются если БД недоступна). app_settings hot-reloadятся
// каждым tick'ом — admin правит из /admin-web/workers без рестарта.
// live = an identified map may still be running; idle = all identified maps are finished/inactive or none exist.

// Базовый интервал зависит от того, был ли валидный live на прошлом тике.
// При ошибке источника удваивается до 10 минут (livePollFailureBackoffMs).
// На любом успешном ответе
// сбрасывается к актуальному `getBaseIntervalMs()`, который читает app_settings.
let currentBackoffMs = DEFAULT_LIVE_INTERVAL_MS;
let lastValidLiveCount: number | null = null;

async function getBaseIntervalMs(): Promise<number> {
  try {
    const s = await getAppSettings();
    // Paid archive acceleration must not implicitly change the 120-second live cadence.
    return livePollBaseIntervalMs(lastValidLiveCount, s.liveWorkerLiveSec * 1000, s.liveWorkerIdleSec * 1000);
  } catch {
    return livePollBaseIntervalMs(lastValidLiveCount);
  }
}

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
  deactivate_time?: unknown;
  // OpenDota /api/live раскрывает массив игроков с hero_id и team (0=R, 1=D)
  // как только драфт завершён. Используем это для v2-фичей.
  players?: Array<{ account_id?: number; hero_id?: number; team?: 0 | 1; team_slot?: number }>;
}

/**
 * Вытаскивает 5+5 hero_ids из /api/live payload или null если драфт неполный.
 *
 * Only explicit team (0/1) identifies a side. team_slot is a position within
 * a team and must not be interpreted as the unrelated Steam player_slot.
 */
function extractDraftFromLive(m: LiveMatch): DraftInput | null {
  if (livePacketShapeIssue(m)) return null;
  if (!m.players || m.players.length !== 10) return null;
  const radiantPicks: number[] = [];
  const direPicks: number[] = [];
  const radiantAccounts: number[] = [];
  const direAccounts: number[] = [];
  for (const p of m.players) {
    if (!Number.isSafeInteger(p.hero_id) || !p.hero_id || p.hero_id <= 0) return null;
    let side: 0 | 1 | null = null;
    if (p.team === 0 || p.team === 1) {
      side = p.team;
    } else return null;
    const acc = safeOpenDotaId(p.account_id) ?? 0;
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
  if (new Set([...radiantPicks,...direPicks]).size !== 10) return null;
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
let scheduleInFlight = false;
let pendingCoverage: PollCapture | null = null;
let stopRequested = false;
let stats = {
  totalPolls: 0,
  totalSnapshots: 0,
  totalPredictions: 0,
  totalLivePredictions: 0,
  skippedUnchanged: 0,
  malformedPackets: 0,
  malformedPacketReasons: {} as Partial<Record<LivePacketShapeIssue,number>>,
  lastMalformedPacket: null as {matchId:number|null;reason:LivePacketShapeIssue;receivedAt:string}|null,
  lastCadenceOutcomeLookup: 'not_checked' as 'not_checked'|'not_needed'|'ok'|'failed',
  lastCadenceActiveMaps: 0,
  lastCadenceKnownFinishedMaps: 0,
  lastCadenceProviderInactiveMaps: 0,
  lastPollAt: null as Date | null,
  lastPollDurationMs: 0,
  lastError: null as string | null,
};

// Дедуп: последний хеш данных матча, по которому уже считали ML и писали
// снапшот. Если OpenDota вернул те же значения (game_time/kills/lead/draft
// не изменились), пропускаем повторную работу — детерминистическая модель
// даст тот же ответ. Сбрасывается при рестарте процесса (не страшно: первый
// poll после рестарта пройдёт без skip и снова проиндексирует все матчи).
// Размер ограничен числом активных live-матчей (типично 10-50), очищаем
// записи матчей, которых больше нет в текущем poll.
const lastSeenHash = new Map<number, string>();

/** Стабильный хеш ВСЕХ полей, влияющих на ML-предсказание и снапшот. */
function hashLiveMatch(m: LiveMatch): string {
  const shapeIssue=livePacketShapeIssue(m);
  if(shapeIssue)throw new Error(shapeIssue); // Caller admits whole packets; never sanitize a damaged roster.
  // Heroes сортируем чтобы изменение порядка игроков в payload не давало
  // ложный «изменился». Account_ids тоже — для идемпотентности draft fingerprint.
  const heroes = (m.players ?? [])
    .map(p => `${p.team ?? p.team_slot ?? '?'}:${p.hero_id ?? 0}:${p.account_id ?? 0}`)
    .sort()
    .join(',');
  return [
    m.game_time ?? '',
    m.radiant_score ?? '',
    m.dire_score ?? '',
    m.radiant_lead ?? '',
    m.building_state ?? '',
    heroes,
  ].join('|');
}

async function pollOnce(coverage: PollCapture): Promise<void> {
  stats.totalPolls++;
  stats.lastPollAt = new Date();
  await flushLivePredictionJournal([]); // Settle locally available outcomes even on idle polls.

  let matches: LiveMatch[] = [];
  let receivedAt: Date;
  try {
    coverage.attemptedAt=Date.now();
    const feed = await refreshOpenDotaLiveFeed();
    matches = feed.data as LiveMatch[];
    receivedAt = feed.fetchedAt;
    captureCoverageFeed(coverage,feed.data,receivedAt); // Before filtering and unchanged-packet dedup.
  } catch (err) {
    captureCoverageFailure(coverage,err);
    currentBackoffMs = livePollFailureBackoffMs(currentBackoffMs);
    stats.lastError = String(err);
    logger.warn({ err, backoffMs: currentBackoffMs }, '[LiveWorker] OpenDota fetch failed');
    throw err;
  }

  // Preserve the raw receipt in coverage/feed, then reject malformed packets as
  // a whole before ANY inference path. Filtering individual null players could
  // turn a damaged 11-entry roster into a falsely complete 5+5 draft.
  const identified=matches.filter(m=>m!==null&&typeof m==='object'&&!Array.isArray(m)
    &&safeOpenDotaId(m.match_id)&&safeOpenDotaId(m.team_id_radiant)&&safeOpenDotaId(m.team_id_dire));
  const valid:LiveMatch[]=[];
  for(const packet of matches){
    const reason=livePacketShapeIssue(packet);
    if(reason){
      const matchId=packet!==null&&typeof packet==='object'?safeOpenDotaId(packet.match_id)??null:null;
      stats.malformedPackets++;
      stats.malformedPacketReasons[reason]=(stats.malformedPacketReasons[reason]??0)+1;
      stats.lastMalformedPacket={matchId,reason,receivedAt:receivedAt.toISOString()};
      logger.warn({...stats.lastMalformedPacket},'[LiveWorker] malformed packet excluded from inference; other maps continue');
      continue;
    }
    if(identified.includes(packet))valid.push(packet);
  }
  // Read outcomes for cadence even when all packets are unchanged or malformed.
  // A later separate query still checks outcome availability for the journal;
  // cadence evidence must not replace that prediction-provenance check.
  const cadenceFinished=new Set<number>();
  let cadenceLookupFailed=false;
  stats.lastCadenceOutcomeLookup=identified.length?'ok':'not_needed';
  if(identified.length){
    try {
      const ids=[...new Set(identified.map(m=>m.match_id!))];
      const finished=await db.select({id:proMatchesTable.matchId}).from(proMatchesTable)
        .where(and(inArray(proMatchesTable.matchId,ids),
          sql`${proMatchesTable.radiantWin} IS NOT NULL AND ${proMatchesTable.duration}>0`));
      for(const row of finished)cadenceFinished.add(row.id);
    } catch(err){
      cadenceLookupFailed=true;
      stats.lastCadenceOutcomeLookup='failed';
      logger.warn({err},'[LiveWorker] cadence outcome lookup failed; unfinished candidates remain active with backoff');
    }
  }
  const activity=livePollActivity(identified.map(m=>({matchId:m.match_id!,deactivateTime:m.deactivate_time})),
    cadenceFinished,receivedAt.getTime());
  lastValidLiveCount=activity.activeMatchIds.length;
  stats.lastCadenceActiveMaps=lastValidLiveCount;
  stats.lastCadenceKnownFinishedMaps=activity.knownFinishedMaps;
  stats.lastCadenceProviderInactiveMaps=activity.providerInactiveMaps;
  // Determine the interval from THIS response, including the first active poll.
  const baseIntervalMs=await getBaseIntervalMs();
  currentBackoffMs=cadenceLookupFailed&&lastValidLiveCount>0
    ?livePollFailureBackoffMs(Math.max(currentBackoffMs,baseIntervalMs)):baseIntervalMs;
  stats.lastError = cadenceLookupFailed?'cadence_outcome_lookup_failed':null;
  await enqueueWidePackets(valid as unknown as Record<string,unknown>[],receivedAt);
  if (valid.length === 0) lastSeenHash.clear();
  if (valid.length === 0) return;

  // Early-phase diagnostics use every real receipt, including unchanged drafts
  // after cold-cache/refusal. Legacy snapshot and model dedup stays independent.
  await enqueuePostdraftPackets(valid as unknown as Record<string,unknown>[],receivedAt);
  await enqueueHazardPackets(valid as unknown as Record<string,unknown>[],receivedAt);

  // Чистим хеш-кэш от матчей, которых больше нет в эфире (закончились).
  // Без этого Map рос бы бесконечно по мере появления/исчезновения матчей.
  const currentIds = new Set(valid.map(m => m.match_id!));
  for (const id of lastSeenHash.keys()) {
    if (!currentIds.has(id)) lastSeenHash.delete(id);
  }

  // Дедуп: оставляем только матчи с изменившимися данными. Если хеш совпал
  // с прошлым poll'ом — OpenDota вернул те же значения, скипаем и snapshot,
  // и ML (детерминистическая модель даст тот же результат, БД будет писать
  // дубликаты).
  const changed = valid.filter(m => {
    const h = hashLiveMatch(m);
    const prev = lastSeenHash.get(m.match_id!);
    if (prev === h) {
      stats.skippedUnchanged++;
      return false;
    }
    return true;
  });

  if (changed.length === 0) {
    logger.info({ liveMatches: valid.length, skippedAll: true }, '[LiveWorker] no changes since last poll');
    return;
  }

  // ── Stratz live enrichment DORMANT ──────────────────────────────────────────
  // Stratz upstream пуст с 2026-05-16 (live.matches=[], live.match(id)=null).
  // Код оставлен в lib/stratzLive.ts — раскомментировать блок ниже и import
  // выше при восстановлении. Пять колонок в live_snapshots ждут своих данных.
  //
  // КАК ВКЛЮЧИТЬ: раскомментировать import вверху файла + блок ниже:
  // ─────────────────────────────────────────────────────────────────────────────
  // let stratzMap = new Map<number, StratzLiveDetail | null>();
  // let stratzEnriched = 0;
  // try {
  //   stratzMap = await fetchLiveMatchDetailBatch(changed.map(m => m.match_id!), 4);
  //   stratzEnriched = [...stratzMap.values()].filter(v => v !== null).length;
  //   logger.info({ tag: 'stratz-live', requested: changed.length, enriched: stratzEnriched },
  //     '[LiveWorker] Stratz enrichment');
  // } catch (err) {
  //   logger.warn({ tag: 'stratz-live', err: String(err) }, '[LiveWorker] Stratz batch failed');
  // }
  // ─────────────────────────────────────────────────────────────────────────────

  const journal = new Map<number, LiveJournalContext>();
  // Сохраняем снапшоты только для изменившихся матчей.
  try {
    const rows = changed.map(m => {
      return {
        matchId: m.match_id!,
        capturedAt: receivedAt,
        gameTimeSec: m.game_time ?? null,
        radiantTeamId: m.team_id_radiant ?? null,
        direTeamId: m.team_id_dire ?? null,
        radiantScore: m.radiant_score ?? null,
        direScore: m.dire_score ?? null,
        radiantLead: m.radiant_lead ?? null,
        buildingState: m.building_state ?? null,
        rawPayload: m as unknown as Record<string, unknown>,
        // DORMANT Stratz fields — остаются null пока upstream не восстановится.
        // При включении: sz?.meta, sz?.players, sz?.xpAdvantage, sz?.networthAdvantage
        stratzMatchMeta: null,
        stratzPlayers: null,
        xpAdvantage: null,
        networthAdvantage: null,
        stratzFetchedAt: null,
      };
    });
    const inserted = await db.insert(liveSnapshotsTable).values(rows)
      .returning({id:liveSnapshotsTable.id,matchId:liveSnapshotsTable.matchId});
    const packets = new Map(changed.map(m=>[m.match_id!,m]));
    const known = new Set((await db.select({id:proMatchesTable.matchId}).from(proMatchesTable)
      .where(and(inArray(proMatchesTable.matchId,[...packets.keys()]),
        sql`${proMatchesTable.radiantWin} IS NOT NULL AND ${proMatchesTable.duration}>0`))).map(r=>r.id));
    for (const row of inserted) {
      const packet = packets.get(row.matchId);
      if (packet) journal.set(row.matchId,new LiveJournalContext(packet as unknown as Record<string,unknown>,receivedAt,row.id,known.has(row.matchId)));
    }
    // Commit deduplication only after the snapshot batch is durable. A failed
    // write must be retried even if the provider repeats the same packet.
    for (const m of changed) lastSeenHash.set(m.match_id!, hashLiveMatch(m));
    stats.totalSnapshots += rows.length;
  } catch (err) {
    logger.error({ err }, '[LiveWorker] snapshot insert failed');
    throw err;
  }

  // Diagnostic inference uses durable observations and never depends on a prematch model.
  enqueueLiveWinnerShadow([...journal.values()]);

  // T3.5 — live totals: НЕЗАВИСИМЫЙ от prematch путь. Эти модели смотрят
  // только на live-снапшот, не требуют team-ratings и должны срабатывать
  // даже если prematch winner недоступен (architect-feedback: предыдущая
  // версия гейтилась на getActiveModel() и pred!=null, что блокировало
  // ~весь поток при любых проблемах с prematch).
  for (const m of changed) {
    try {
      // 3-tier: если у нас раскрытый драфт (10 героев) + оба team_id известны —
      // предпочитаем live_total_*_with_draft (snapshot7 + team4 + e1_live2).
      // Иначе MarketLgbm упадёт на pure live_total_* (snapshot7).
      const draft = extractDraftFromLive(m);
      const rTid = m.team_id_radiant;
      const dTid = m.team_id_dire;
      const draftHint = (draft && rTid && dTid)
        ? { radiantPicks: draft.radiantPicks, direPicks: draft.direPicks, radiantTeamId: rTid, direTeamId: dTid }
        : undefined;
      const lt = await predictLiveTotalsFor({
        gameTimeSec: m.game_time ?? null,
        radiantScore: m.radiant_score ?? null,
        direScore: m.dire_score ?? null,
        radiantLead: m.radiant_lead ?? null,
        buildingState: m.building_state ?? null,
      }, draftHint);
      recordLiveTotalsRefusals(lt,journal.get(m.match_id!));
      if (lt.totalKillsLogN && lt.modelVersions.kills && lt.evidence.kills) {
        journal.get(m.match_id!)?.predicted('live_total_kills',{modelVersion:lt.modelVersions.kills,
          evidence:lt.evidence.kills,output:{distribution:'legacy_log_normal',targetScope:'map',targetTransform:'log1p',nativeUnit:'kills',logMean:lt.totalKillsLogN.mean,logStd:lt.totalKillsLogN.std}});
        await db.insert(predictionsTable).values({
          matchId: m.match_id!,
          modelVersion: lt.modelVersions.kills,
          marketType: 'live_total_kills',
          // log-нормаль: mean/std в log-space; team1=mean, team2=std для
          // переиспользования existing колонок без миграции схемы.
          modelProbTeam1: lt.totalKillsLogN.mean,
          modelProbTeam2: lt.totalKillsLogN.std,
          confidence: null,
          features: { game_min: (m.game_time ?? 0) / 60, __source_received_unix: receivedAt.getTime() / 1000 },
        });
      }
      if (lt.totalDurationLogN && lt.modelVersions.duration && lt.evidence.duration) {
        journal.get(m.match_id!)?.predicted('live_total_duration',{modelVersion:lt.modelVersions.duration,
          evidence:lt.evidence.duration,output:{distribution:'legacy_log_normal',targetScope:'map',targetTransform:'log',nativeUnit:'seconds',logMean:lt.totalDurationLogN.mean,logStd:lt.totalDurationLogN.std}});
        await db.insert(predictionsTable).values({
          matchId: m.match_id!,
          modelVersion: lt.modelVersions.duration,
          marketType: 'live_total_duration',
          modelProbTeam1: lt.totalDurationLogN.mean,
          modelProbTeam2: lt.totalDurationLogN.std,
          confidence: null,
          features: { game_min: (m.game_time ?? 0) / 60, __source_received_unix: receivedAt.getTime() / 1000 },
        });
      }
    } catch (err) {
      journal.get(m.match_id!)?.unavailable('live_total_kills','totals_pipeline_error',true);
      journal.get(m.match_id!)?.unavailable('live_total_duration','totals_pipeline_error',true);
      logger.warn({ err, matchId: m.match_id }, '[LiveWorker] live totals insert failed');
    }
  }

  // Делаем предсказания если модель активна
  const model = getActiveModel();
  if (!model) { await flushLivePredictionJournal([...journal.values()]); return; }

  for (const m of changed) {
    if (!m.team_id_radiant || !m.team_id_dire) continue;
    try {
      const draft = extractDraftFromLive(m);
      const pred = await predictMatchWinner(m.team_id_radiant, m.team_id_dire, draft);
      if (!pred) {
        journal.get(m.match_id!)?.unavailable('prematch_context','model_or_team_features_unavailable');
        journal.get(m.match_id!)?.unavailable('live_winner','prematch_prior_unavailable');
        continue;
      }
      journal.get(m.match_id!)?.predicted('prematch_context', {modelVersion:pred.modelVersion,
        evidence:pred.evidence,output:{radiantWinProbability:pred.probRadiantWin,rawProbability:pred.rawProb}});

      await db.insert(predictionsTable).values({
        matchId: m.match_id!,
        modelVersion: pred.modelVersion,
        marketType: 'match_winner',
        modelProbTeam1: pred.probRadiantWin,
        modelProbTeam2: 1 - pred.probRadiantWin,
        confidence: null,
        features: { ...pred.features, __source_received_unix: receivedAt.getTime() / 1000 },
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
          journal.get(m.match_id!)?.predicted('live_winner',{modelVersion:livePred.modelVersion,
            evidence:livePred.evidence,output:{radiantWinProbability:livePred.probRadiantWin,
              priorModelVersion:pred.modelVersion,priorModelHash:pred.evidence.modelHash,
              priorProbability:pred.probRadiantWin}});
          try {
            await db.insert(predictionsTable).values({
              matchId: m.match_id!,
              modelVersion: livePred.modelVersion,
              marketType: 'live_match_winner',
              modelProbTeam1: livePred.probRadiantWin,
              modelProbTeam2: 1 - livePred.probRadiantWin,
              confidence: null,
              features: { ...livePred.features, __source_received_unix: receivedAt.getTime() / 1000 },
            });
            stats.totalLivePredictions++;
          } catch (err) {
            logger.warn({ err, matchId: m.match_id }, '[LiveWorker] live prediction insert failed');
          }
        }
      }

      // Этап C — asym live-winner. Параллельная запись marketType='live_match_winner_asym'
      // ТОЛЬКО для asym-eligible матчей (как в Этапе B для prematch). Не заменяет
      // main live, а накапливается отдельно для сравнения out-of-sample acc.
      const asymLiveModel = getActiveAsymLiveModel();
      if (asymLiveModel && (m.game_time ?? -1) >= 60 && draft && m.team_id_radiant && m.team_id_dire) {
        const rAcc = (draft.radiantAccountIds ?? null) as number[] | null;
        const dAcc = (draft.direAccountIds ?? null) as number[] | null;
        if (rAcc?.length || dAcc?.length) {
          const eligible = await isAsymEligible(
            m.team_id_radiant, m.team_id_dire, rAcc, dAcc,
          ).catch(() => false);
          if (eligible) {
            const asymPred = predictAsymLiveWinner(
              {
                gameTimeSec: m.game_time ?? null,
                radiantLead: m.radiant_lead ?? null,
                radiantScore: m.radiant_score ?? null,
                direScore: m.dire_score ?? null,
                buildingState: m.building_state ?? null,
                isRealLive: 1,
                hasDraft: 1,
                recencyDaysNorm: 0.0,
              },
              pred.probRadiantWin,
            );
            if (asymPred) {
              journal.get(m.match_id!)?.predicted('asym_live_winner',{modelVersion:asymPred.modelVersion,
                evidence:asymPred.evidence,output:{radiantWinProbability:asymPred.probRadiantWin,
                  priorModelVersion:pred.modelVersion,priorModelHash:pred.evidence.modelHash,
                  priorProbability:pred.probRadiantWin}});
              try {
                await db.insert(predictionsTable).values({
                  matchId: m.match_id!,
                  modelVersion: asymPred.modelVersion,
                  marketType: 'live_match_winner_asym',
                  modelProbTeam1: asymPred.probRadiantWin,
                  modelProbTeam2: 1 - asymPred.probRadiantWin,
                  confidence: null,
                  features: { ...asymPred.features, __source_received_unix: receivedAt.getTime() / 1000 },
                });
              } catch (err) {
                logger.warn({ err, matchId: m.match_id }, '[LiveWorker] asym-live prediction insert failed');
              }
            }
          }
        }
      }

      // Only an observed pre-start prediction belongs in the prematch ledger.
      // A first observation halfway through a game is not a prematch test.
      // Existing legacy rows have no such provenance and remain unvalidated.
      if (typeof m.game_time === 'number' && m.game_time < 0) {
        // Стампим тир и features_version в features-снапшот ledger'а, чтобы
        // потом в админке можно было разбить out-of-sample метрики по тиру
        // _на момент предсказания_, а не по текущим рейтингам команд.
        const featuresStamped: Record<string, number> = {
          ...(pred.features as Record<string, number>),
          __observed_game_time_sec: m.game_time,
          __source_received_unix: receivedAt.getTime() / 1000,
          __features_version: pred.featuresVersion,
          __tier_t1: pred.tier === 't1' ? 1 : 0,
          __tier_t2: pred.tier === 't2' ? 1 : 0,
          __tier_t3: pred.tier === 't3' ? 1 : 0,
        };
        await recordPrematchPrediction({
          matchId: m.match_id!,
          modelVersion: pred.modelVersion,
          predictedRadiantWinProb: pred.probRadiantWin,
          radiantTeamId: m.team_id_radiant ?? null,
          direTeamId: m.team_id_dire ?? null,
          radiantName: m.team_name_radiant ?? null,
          direName: m.team_name_dire ?? null,
          features: featuresStamped,
        });
      }
    } catch (err) {
      journal.get(m.match_id!)?.unavailable('prematch_context','winner_pipeline_error',true);
      journal.get(m.match_id!)?.unavailable('live_winner','winner_pipeline_error',true);
      journal.get(m.match_id!)?.unavailable('asym_live_winner','winner_pipeline_error',true);
      logger.error({ err, matchId: m.match_id }, '[LiveWorker] prediction insert failed');
    }
  }

  await flushLivePredictionJournal([...journal.values()]);

  logger.info(
    { liveMatches: valid.length, totalPredictions: stats.totalPredictions, totalSnapshots: stats.totalSnapshots },
    '[LiveWorker] poll complete',
  );
}

/**
 * Self-rescheduling poller. setTimeout (а не setInterval) защищает от наложения
 * запусков, если один опрос занял дольше POLL_INTERVAL_MS (медленная сеть/БД).
 */
async function scheduleNextPoll(delayMs: number, cause: PollCapture['ticket']['cause']='regular'): Promise<void> {
  if (stopRequested || scheduleInFlight) return;
  scheduleInFlight=true;
  let coverage: PollCapture;
  try { coverage=await planLiveCoverage(delayMs,livePollMode(lastValidLiveCount),cause); }
  finally { scheduleInFlight=false; }
  if(stopRequested){await finishLiveCoverage(coverage,'stopped');return;}
  pendingCoverage=coverage;
  // Durable planning does not add its fsync latency to the promised deadline.
  const actualDelayMs=Math.max(0,coverage.ticket.dueAt-Date.now());
  logger.info({nextDelayMs:actualDelayMs,mode:livePollMode(lastValidLiveCount),dueAt:coverage.ticket.dueAt}, '[LiveWorker] next poll scheduled');
  timeoutId = setTimeout(async () => {
    timeoutId=null;pendingCoverage=null;
    if (stopRequested) {await finishLiveCoverage(coverage,'stopped');return;}
    if (pollInFlight) {
      logger.warn('[LiveWorker] previous poll still in flight, skipping');
      await finishLiveCoverage(coverage,'skipped_overlap');
      void scheduleNextPoll(currentBackoffMs,'backoff');
      return;
    }
    pollInFlight = true;
    const startedAt = Date.now();
    let tickOk = true;
    let tickErr: string | null = null;
    try {
      await pollOnce(coverage);
    } catch (err) {
      tickOk = false;
      tickErr = err instanceof Error ? err.message : String(err);
      stats.lastError = tickErr;
      logger.error({ err }, '[LiveWorker] poll error');
    } finally {
      stats.lastPollDurationMs = Date.now() - startedAt;
      recordHeartbeat('liveWorker', { ok: tickOk, durationMs: stats.lastPollDurationMs, error: tickErr });
      await finishLiveCoverage(coverage,tickOk?'ok':'error');
      const base = await getBaseIntervalMs();
      const next = livePollNextDelayMs(base, currentBackoffMs);
      pollInFlight = false;
      void scheduleNextPoll(next,!tickOk?'backoff':livePollMode(lastValidLiveCount)==='idle'?'idle':'regular');
    }
  }, actualDelayMs);
}

export function startLiveWorker(): void {
  if (timeoutId || scheduleInFlight || pollInFlight || stopRequested) return;
  logger.info(
    {
      defaultLiveIntervalMs: DEFAULT_LIVE_INTERVAL_MS,
      defaultIdleIntervalMs: DEFAULT_IDLE_INTERVAL_MS,
      note: 'intervals are hot-reloaded from app_settings on every tick',
    },
    '[LiveWorker] starting',
  );
  loadActiveModel().catch(err => logger.error({ err }, '[LiveWorker] initial model load failed'));
  loadActiveLiveModel().catch(err => logger.error({ err }, '[LiveWorker] initial live model load failed'));
  loadActiveAsymLiveModel().catch(err => logger.error({ err }, '[LiveWorker] initial asym-live model load failed'));
  void scheduleNextPoll(5_000,'startup');

  // Wire shutdown hooks (один раз; повторные вызовы start() безвредны — node склеит).
  const shutdown = () => {
    logger.info('[LiveWorker] shutdown signal received');
    void stopWideShadow();
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
    if(pendingCoverage){void finishLiveCoverage(pendingCoverage,'stopped');pendingCoverage=null;}
    logger.info('[LiveWorker] stopped');
  }
}

export function getWorkerStats() {
  const live = getActiveLiveModel();
  const asymLive = getActiveAsymLiveModel();
  return {
    ...stats,
    wideShadow: wideShadowStatus(),
    modelLoaded: !!getActiveModel(),
    modelVersion: getActiveModel()?.version ?? null,
    liveModelLoaded: !!live,
    liveModelVersion: live?.version ?? null,
    asymLiveModelLoaded: !!asymLive,
    asymLiveModelVersion: asymLive?.version ?? null,
  };
}

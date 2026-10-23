import { guardServingMapOutcome } from './ServingOutcomeGuard';
import { logger } from '../lib/logger';
import {readProviderFeed} from './ProviderFeeds';
import { db, pool, predictionsTable, liveSnapshotsTable, matchDraftsTable, modelVersionsTable, liveObservationJournalTable, livePredictionJournalTable } from '@workspace/db';
import { eq, desc, inArray, and } from 'drizzle-orm';
import { getActiveLiveModel } from './LiveWinnerModel';
import { type MatchInput, type AnalyticsResult } from './AnalyticsEngine';
import { predictMatchWinner, getPredictionModelRevision, getAllActiveModels, type DraftInput } from './PredictionModel';
import { getMarketModelRevision, predictMarketsFor, isActiveMarketVersion } from './MarketLgbm';
import { resolveTeamPair } from './TeamIdentity';
import {createTeamIdentityReader,TEAM_IDENTITY_SQL,TEAM_IDENTITY_QUERY_TIMEOUT_MS} from './TeamIdentityStore';
import { openDotaMatchId, positiveId, supportedPredictions, probabilityInTeamOrder, freshPrediction, knownSeriesFormat, type ServingEvidence, betweenMapsContextFromServerFeed, isServerSeriesOnlyRequest } from './PredictionContract';
import {liveStateFreshness,liveStateHash,LIVE_STATE_MAX_AGE_MS} from '../lib/liveStateFreshness';
import {observedLiveDraft} from '../lib/observedLiveDraft';
import {selectObservedDraftPrediction} from '../lib/observedDraftPrediction';

export function servingModelRevision(): string {
  return `${getPredictionModelRevision()}::${getMarketModelRevision()}::${getActiveLiveModel()?.version ?? "no-live-model"}`;
}

const readIdentityRows=createTeamIdentityReader(async()=>{
  // pg8 supports per-query query_timeout; @types/pg QueryConfig omits it.
  const query={text:TEAM_IDENTITY_SQL,query_timeout:TEAM_IDENTITY_QUERY_TIMEOUT_MS};
  const result=await pool.query(query);
  return result.rows;
});

export async function resolveServingTeams(input: MatchInput): Promise<MatchInput> {
  const rows=await readIdentityRows();
  return resolveTeamPair(input,rows.catalogue,rows.history,rows.available);
}

export async function computeServingPredictions(input: MatchInput): Promise<AnalyticsResult> {
  // Scope selection is not admission: the core independently verifies a fresh
  // server-owned series context and emits no current-map markets for this scope.
  // A completed previous map must not veto a still-running, confirmed series.
  if (isServerSeriesOnlyRequest(input)) return computeServingPredictionsUnchecked(input);
  return guardServingMapOutcome(pool, input, () => computeServingPredictionsUnchecked(input),
    reason => logger.debug({ reason, matchId: openDotaMatchId(input) },
      '[ServingPredictions] map outcome guard refused'));
}

async function computeServingPredictionsUnchecked(input: MatchInput): Promise<AnalyticsResult> {
  const shell: AnalyticsResult = {matchId:input.matchId,team1Name:input.team1.name,team2Name:input.team2.name,predictions:[],featureVector:null,generatedAt:new Date().toISOString(),modelVersion:'unavailable',
    resolvedTeams:{team1Id:positiveId(input.team1.teamId),team2Id:positiveId(input.team2.teamId)},
    teamIdentity:{team1:input.team1.identity??null,team2:input.team2.identity??null}};
  // Heuristic functions remain available for comparison; they are not a
  // substitute for missing trained predictions in the public response.
  shell.predictions = [];
  const t1 = positiveId(input.team1.teamId);
  const t2 = positiveId(input.team2.teamId);
  const matchId = openDotaMatchId(input);
  const betweenMaps = isServerSeriesOnlyRequest(input);
  const seriesFeed = betweenMaps ? await readProviderFeed('pandascore_running').catch(()=>null) : null;
  const trustedBetweenMaps = betweenMaps ? betweenMapsContextFromServerFeed(input,seriesFeed) : null;
  if (betweenMaps && !trustedBetweenMaps) return {...shell,state:'unavailable',unavailableMarkets:[{betType:'all',reason:'confirmed_between_maps_series_context_unavailable'}]};
  if (trustedBetweenMaps) input = {...input,status:'between_maps',format:trustedBetweenMaps.format,liveSnapshot:undefined,
    seriesContext:{seriesScore1:trustedBetweenMaps.score1,seriesScore2:trustedBetweenMaps.score2,currentMapNumber:trustedBetweenMaps.nextMapNumber}};
  if (input.status === 'finished') return {...shell,state:'unavailable',unavailableMarkets:[{betType:'all',reason:'match_not_predictable'}]};
  const liveFeed = !betweenMaps && matchId ? await readProviderFeed('opendota_live') : null;
  const currentPacket = liveFeed?.data?.find((v:any)=>Number(v?.match_id) === matchId);
  const live = !betweenMaps && (input.status === 'live' || !!input.liveSnapshot || !!currentPacket);
  if (live && (!currentPacket || liveFeed?.error || !liveFeed?.receivedAt || !freshPrediction(liveFeed.receivedAt,180_000))) {
    return {...shell,state:'unavailable',unavailableMarkets:[{betType:'all',reason:'no_current_server_live_packet'}]};
  }
  if(live) {
    const freshness=liveStateFreshness(currentPacket as Record<string,unknown>,liveFeed!.receivedAt);
    shell.liveDataQuality=freshness;
    if(!freshness.eligibleForObservedStatePrediction)
      return {...shell,state:'unavailable',unavailableMarkets:[{betType:'all',reason:freshness.reason!}]};
  }
  if (live) input = {...input,status:'live'};
  let observedState: AnalyticsResult['observedState'];
  const evidence: ServingEvidence = {map: null, futureMap: null, kills: null, duration: null};
  let draft: DraftInput | null = null;

  // Validate side orientation against the stored OD snapshot before using a
  // prediction by match ID. PS event IDs cannot enter this query.
  let orientation: 'same' | 'flipped' | null = null;
  if (!betweenMaps && matchId && t1 && t2) {
    const rows = await db.select({r: liveSnapshotsTable.radiantTeamId, d: liveSnapshotsTable.direTeamId,
      source:liveSnapshotsTable.source,at:liveSnapshotsTable.capturedAt,
      gameTime:liveSnapshotsTable.gameTimeSec,scoreR:liveSnapshotsTable.radiantScore,scoreD:liveSnapshotsTable.direScore,
      lead:liveSnapshotsTable.radiantLead,buildings:liveSnapshotsTable.buildingState,raw:liveSnapshotsTable.rawPayload})
      .from(liveSnapshotsTable).where(eq(liveSnapshotsTable.matchId, matchId)).orderBy(desc(liveSnapshotsTable.capturedAt)).limit(1);
    const snapshot=rows[0];
    const earlyClock=(currentPacket as Record<string,unknown>|undefined)?.game_time;
    const observedDraft=live && typeof earlyClock==='number' && earlyClock<60
      ? observedLiveDraft(currentPacket as Record<string,unknown>,new Map(),liveFeed!.receivedAt!):null;
    const early=!!snapshot && typeof snapshot.gameTime==='number' && snapshot.gameTime>=-3600 && snapshot.gameTime<60
      && snapshot.gameTime===earlyClock && !!observedDraft;
    const packet=currentPacket as Record<string,unknown>|undefined;
    const samePacket=!!snapshot && snapshot.r===positiveId(packet?.team_id_radiant) && snapshot.d===positiveId(packet?.team_id_dire)
      && !!snapshot.raw && !!packet && liveStateHash(snapshot.raw)===liveStateHash(packet)
      && [[snapshot.gameTime,packet?.game_time],[snapshot.scoreR,packet?.radiant_score],[snapshot.scoreD,packet?.dire_score],
        [snapshot.lead,packet?.radiant_lead],[snapshot.buildings,packet?.building_state]].every(([stored,current])=>(stored??null)===(current??null));
    const usable=!live || (!!snapshot && samePacket && snapshot.source==='live' && freshPrediction(snapshot.at,180_000) && (early ||
      ([snapshot.gameTime,snapshot.scoreR,snapshot.scoreD,snapshot.lead,snapshot.buildings].every(v=>typeof v==='number'&&Number.isFinite(v)) && snapshot.gameTime!>=60 && Number.isInteger(snapshot.scoreR) && Number.isInteger(snapshot.scoreD) && snapshot.scoreR!>=0 && snapshot.scoreD!>=0)));
    if (usable && snapshot?.r === t1 && snapshot?.d === t2) orientation = 'same';
    else if (usable && snapshot?.r === t2 && snapshot?.d === t1) orientation = 'flipped';
    if (orientation && live && snapshot && snapshot.gameTime!>=0 && typeof snapshot.scoreR==='number' && typeof snapshot.scoreD==='number')
      observedState = {elapsedSeconds:snapshot.gameTime!,totalKills:snapshot.scoreR+snapshot.scoreD,receivedAt:snapshot.at.toISOString(),source:'opendota'};
    if(orientation && early) {
      const journalRows=await db.select({observation:liveObservationJournalTable,prediction:livePredictionJournalTable})
        .from(livePredictionJournalTable).innerJoin(liveObservationJournalTable,eq(livePredictionJournalTable.observationId,liveObservationJournalTable.id))
        .where(and(eq(liveObservationJournalTable.matchId,matchId),eq(livePredictionJournalTable.producer,'prematch_context')))
        .orderBy(desc(livePredictionJournalTable.predictedAt)).limit(5);
      evidence.map=selectObservedDraftPrediction(currentPacket as Record<string,unknown>,journalRows,
        getAllActiveModels().filter(m=>m.engine==='lightgbm').map(m=>({version:m.version,hash:m.artifactHash,featuresVersion:m.featuresVersion})),orientation);
    }
    if (orientation) {
      const drafts = await db.select().from(matchDraftsTable).where(eq(matchDraftsTable.matchId, matchId)).limit(1);
      const d = drafts[0];
      if (d?.radiantPicks?.length === 5 && d.direPicks?.length === 5) {
        draft = {
          radiantPicks: d.radiantPicks, direPicks: d.direPicks,
          radiantBans: d.radiantBans ?? [], direBans: d.direBans ?? [],
          radiantAccountIds: d.radiantAccountIds, direAccountIds: d.direAccountIds,
        };
      }
    }
  }

  if (knownSeriesFormat(input.format) && t1 && t2 && t1 !== t2 && input.status !== 'finished') {
    // Unknown BO must not become a made-up prematch feature. The separately
    // stored live map/total predictions below do not require series format.
    const currentMap = input.seriesContext?.currentMapNumber ?? (input.seriesContext?.seriesScore1??0)+(input.seriesContext?.seriesScore2??0)+1;
    const maxMaps = input.format === 'BO1' ? 1 : input.format === 'BO3' ? 3 : 5;
    const ctx = {format: input.format, mapNumber: live ? Math.min(maxMaps,currentMap+1) : currentMap};
    // Future maps have no known Radiant side. Average both side assignments.
    const [forward, reverse] = await Promise.all([
      predictMatchWinner(t1, t2, null, ctx).catch(() => null),
      predictMatchWinner(t2, t1, null, ctx).catch(() => null),
    ]);
    if (forward && reverse) {
      evidence.futureMap = {
        probability: (forward.probRadiantWin + 1 - reverse.probRadiantWin) / 2,
        rawProbability: (forward.rawProb + 1 - reverse.rawProb) / 2,
        modelVersion: [...new Set([forward.modelVersion, reverse.modelVersion])].join('+'),
        featuresVersion: forward.featuresVersion,
        predictedAt: new Date().toISOString(), calibrationMethod: 'side_average',
      };
    }
    if (!live && !betweenMaps) {
      evidence.map = evidence.futureMap;
      if (draft && orientation) {
        const flip = orientation === 'flipped';
        const pred = await predictMatchWinner(flip ? t2 : t1, flip ? t1 : t2, draft, ctx).catch(() => null);
        if (pred) evidence.map = {probability: flip ? 1-pred.probRadiantWin : pred.probRadiantWin, rawProbability: flip ? 1-pred.rawProb : pred.rawProb, modelVersion: pred.modelVersion, featuresVersion: pred.featuresVersion, predictedAt: new Date().toISOString(), calibrationMethod: 'model_bundle'};
      }
      const flip = orientation === 'flipped';
      const markets = await predictMarketsFor(flip ? t2 : t1, flip ? t1 : t2, draft ?? undefined).catch(() => null);
      if (markets?.totalKillsLogN && markets.versions.totalKills) evidence.kills = {...markets.totalKillsLogN, modelVersion: markets.versions.totalKills, predictedAt: new Date(markets.ts).toISOString(), logOffset: 0};
      if (markets?.totalDurationLogN && markets.versions.totalDuration) evidence.duration = {...markets.totalDurationLogN, modelVersion: markets.versions.totalDuration, predictedAt: new Date(markets.ts).toISOString(), logOffset: 0};
    }
  }

  if (live && matchId && orientation) {
    const stored = await db.select().from(predictionsTable).where(eq(predictionsTable.matchId, matchId)).orderBy(desc(predictionsTable.predictedAt)).limit(30);
    // Receipt time is separate from computation time: running a model over a
    // cached packet must not extend that packet's useful lifetime.
    const rows = stored.flatMap(row => {
      const received = row.features?.__source_received_unix;
      if (typeof received !== 'number' || !Number.isFinite(received) || received <= 0
          || received * 1000 > row.predictedAt.getTime() + 5_000) return [];
      const observedAt = new Date(received * 1000).toISOString();
      // A fresh prediction over an older packet cannot describe the newest clock/score.
      return observedState && Math.abs(Date.parse(observedAt)-Date.parse(observedState.receivedAt)) < 1
        && freshPrediction(observedAt,180_000) ? [{...row, observedAt}] : [];
    });
    const winner = rows.find(r => r.marketType === 'live_match_winner' && r.modelVersion === getActiveLiveModel()?.version);
    if (winner) evidence.map = {
      probability: probabilityInTeamOrder(winner.modelProbTeam1, orientation),
      modelVersion: winner.modelVersion, predictedAt: winner.predictedAt.toISOString(), observedAt: winner.observedAt, calibrationMethod: 'model_bundle',
    };
    for (const [market, target, offset] of [['live_total_kills', 'kills', 1], ['live_total_duration', 'duration', 0]] as const) {
      const row = rows.find(r => r.marketType === market && isActiveMarketVersion(r.modelVersion,market));
      if (row) evidence[target] = {mean: row.modelProbTeam1, std: row.modelProbTeam2, modelVersion: row.modelVersion, predictedAt: row.predictedAt.toISOString(), observedAt: row.observedAt, logOffset: offset, observedMinimum: target === 'kills' ? observedState!.totalKills : observedState!.elapsedSeconds};
    }
  }
  const supported = supportedPredictions(input, evidence,Date.now(),trustedBetweenMaps ?? undefined);
  if(shell.liveDataQuality?.lastStateChangeReceivedAt) {
    const stateExpiry=Date.parse(shell.liveDataQuality.lastStateChangeReceivedAt)+LIVE_STATE_MAX_AGE_MS;
    for(const p of supported.predictions) p.expiresAt=new Date(Math.min(stateExpiry,Date.parse(p.expiresAt!))).toISOString();
  }
  const versions = [...new Set(supported.predictions.flatMap(p => p.modelVersion.split('+').filter(v => v !== 'series-forward')))];
  const metadata = versions.length ? await db.select({version:modelVersionsTable.version,createdAt:modelVersionsTable.createdAt,brier:modelVersionsTable.brierScore})
    .from(modelVersionsTable).where(inArray(modelVersionsTable.version,versions)).catch(()=>[]) : [];
  for (const p of supported.predictions) {
    if (!p.provenance) continue;
    const used = metadata.filter(m=>p.modelVersion.split('+').includes(m.version));
    p.provenance.modelVersions = p.modelVersion.split('+').filter(v=>v!=='series-forward');
    p.provenance.modelCreatedAt = used.length ? new Date(Math.min(...used.map(m=>m.createdAt.getTime()))).toISOString() : null;
    // Historical metrics have not passed the current independent audit.
    p.provenance.reportedBrierScore = !p.betType.startsWith('total_') && used.length === 1 ? used[0].brier : null;
    p.provenance.trainingDataAsOf = null;
  }
  return {...shell, ...supported, observedState, resolvedTeams: {team1Id: t1, team2Id: t2}};
}

import {sameTeamIdentity,verifiedRunningSeriesIdentity} from './BookmakerMatcher';
import {totalsLadder, type TotalsDistribution} from './TotalsDistribution';
import { createHash } from 'node:crypto';
import type { MatchInput, AnalyticsResult, EnrichedPrediction } from './AnalyticsEngine';
import { seriesWinProb } from './BetTypeModels';

export function knownSeriesFormat(format: unknown): format is 'BO1' | 'BO3' | 'BO5' {
  return format === 'BO1' || format === 'BO3' || format === 'BO5';
}

export function validatePredictionInput(raw: MatchInput): void {
  if (!raw || !raw.matchId || !raw.team1?.name || !raw.team2?.name || (!knownSeriesFormat(raw.format) && raw.format !== 'unknown')) throw new Error('invalid_prediction_input');
  if (raw.status && !['prematch','live','between_maps','finished'].includes(raw.status)) throw new Error('invalid_prediction_input');
  // Unknown format has no inferred winning score. Still reject nonsensical
  // counters; these values are descriptive and never drive series arithmetic.
  const maxWins = raw.format === 'unknown' ? 99 : raw.format === 'BO1' ? 1 : raw.format === 'BO3' ? 2 : 3;
  const context = raw.seriesContext;
  if (context && (![context.seriesScore1,context.seriesScore2].every(v=>Number.isInteger(v)&&v>=0&&v<=maxWins)
    || (context.currentMapNumber!=null && (!Number.isInteger(context.currentMapNumber)||context.currentMapNumber<1||context.currentMapNumber>maxWins*2-1)))) throw new Error('invalid_prediction_input');
  if(context && knownSeriesFormat(raw.format) && context.currentMapNumber!=null
    && context.currentMapNumber!==context.seriesScore1+context.seriesScore2+1) throw new Error('invalid_prediction_input');
}

export function positiveId(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function openDotaMatchId(input: Pick<MatchInput, 'matchId' | 'matchSource'>): number | null {
  if (input.matchSource && input.matchSource !== 'opendota') return null;
  const match = /^od_([1-9]\d*)$/.exec(String(input.matchId));
  if (match) return positiveId(match[1]);
  return input.matchSource === 'opendota' ? positiveId(input.matchId) : null;
}

export function validProbability(p: unknown): p is number {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
}

export function probabilityInTeamOrder(radiantProbability: number, orientation: 'same' | 'flipped'): number {
  return orientation === 'flipped' ? 1-radiantProbability : radiantProbability;
}

export function freshPrediction(at: string | Date, maxAgeMs: number, now = Date.now()): boolean {
  const ts = new Date(at).getTime();
  return Number.isFinite(ts) && ts <= now + 5_000 && now - ts < maxAgeMs;
}

export function predictionCacheKey(input: MatchInput, revision: string): string {
  return `predict:validated:${createHash('sha256').update(JSON.stringify({input, revision})).digest('hex')}`;
}

export interface SupportedEstimate {
  probability: number;
  rawProbability?: number;
  modelVersion: string;
  predictedAt: string;
  observedAt?: string;
  featuresVersion?: number;
  calibrationMethod?: string;
  basis?: string;
}

export interface TotalsEstimate {
  mean: number;
  std: number;
  modelVersion: string;
  predictedAt: string;
  observedAt?: string;
  logOffset: 0 | 1;
  observedMinimum?: number;
}

export interface ServingEvidence {
  // For upcoming matches both side assignments are averaged by the caller.
  map: SupportedEstimate | null;
  futureMap: SupportedEstimate | null;
  kills: TotalsEstimate | null;
  duration: TotalsEstimate | null;
}

/** Server-owned saved-feed evidence; never trust client status/score as proof. */
export type TrustedBetweenMapsContext = Readonly<{
  seriesId: number; team1Id: number; team2Id: number;
  format: 'BO1' | 'BO3' | 'BO5'; score1: number; score2: number; nextMapNumber: number;
  sourceReceivedAt: string; latestFinishedAt: string; normalizedSourceSha256: string; expiresAt: number;
}>;
const trustedBetweenMapsContexts = new WeakSet<object>();

/** Request scope only: fresh server evidence is still mandatory below. */
export function isServerSeriesOnlyRequest(input: MatchInput): boolean {
  return input.status === 'between_maps' || (input.status === 'live' && !input.liveSnapshot
    && input.matchSource !== 'opendota' && !/^od_/.test(String(input.matchId)) && openDotaMatchId(input) === null);
}

export function betweenMapsContextFromServerFeed(
  input: MatchInput,
  feed: {data: unknown; receivedAt: unknown; error: unknown} | null,
  now = Date.now(),
): TrustedBetweenMapsContext | null {
  if (!isServerSeriesOnlyRequest(input) || !feed || feed.error !== null || !Array.isArray(feed.data)
    || typeof feed.receivedAt !== 'string' || !Number.isFinite(now)) return null;
  const received = Date.parse(feed.receivedAt);
  if (!Number.isFinite(received) || received > now || now - received >= 180_000) return null;
  const a = positiveId(input.team1.teamId), b = positiveId(input.team2.teamId);
  if (!a || !b || a === b || input.team1.identity?.status !== 'resolved' || input.team2.identity?.status !== 'resolved'
    || input.team1.identity.resolvedTeamId !== a || input.team2.identity.resolvedTeamId !== b) return null;
  const records = feed.data.filter((x): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x));
  const identity = verifiedRunningSeriesIdentity(input.team1.name, input.team2.name, records as any[], now);
  if (!identity || positiveId(identity.id) !== identity.id) return null;
  const matches = records.filter(m => positiveId(m.id) === identity.id);
  if (matches.length !== 1) return null;
  const m = matches[0]!;
  if (m.status !== 'running' || m.winner != null || m.winner_id != null || !Array.isArray(m.opponents) || m.opponents.length !== 2) return null;
  const format = m.number_of_games === 1 ? 'BO1' : m.number_of_games === 3 ? 'BO3' : m.number_of_games === 5 ? 'BO5' : null;
  if (!format || (input.format !== 'unknown' && input.format !== format)) return null;
  const maxMaps = format === 'BO1' ? 1 : format === 'BO3' ? 3 : 5, need = Math.floor(maxMaps / 2) + 1;
  const started = Date.parse(identity.startsAt);
  if (!Number.isFinite(started) || started > received) return null;
  if (input.matchSource === 'pandascore') {
    const raw = /^(?:pslive_|ps_|up_)?([1-9]\d*)$/.exec(String(input.matchId));
    if (!raw || positiveId(raw[1]) !== identity.id) return null;
  } else if ((input.matchSource === 'opendota' || /^od_/.test(String(input.matchId))) && openDotaMatchId(input) === null) return null;
  const opponents = m.opponents.map((o: any) => o?.opponent);
  if (opponents.some((o: any) => !o || !positiveId(o.id) || typeof o.name !== 'string')
    || positiveId(opponents[0].id) === positiveId(opponents[1].id)) return null;
  const first = opponents.filter((o: any) => sameTeamIdentity(o.name, input.team1.name));
  const second = opponents.filter((o: any) => sameTeamIdentity(o.name, input.team2.name));
  if (first.length !== 1 || second.length !== 1 || first[0] === second[0]) return null;
  const pa = positiveId(first[0].id)!, pb = positiveId(second[0].id)!;
  if (!Array.isArray(m.games) || m.games.length < 1 || m.games.length > maxMaps) return null;
  const positions = new Set<number>(), gameIds = new Set<number>();
  const finished: Array<{id:number;position:number;winnerId:number;endAt:string}> = [];
  for (const g of m.games) {
    if (!g || typeof g !== 'object' || !positiveId(g.id) || gameIds.has(positiveId(g.id)!)
      || !Number.isInteger(g.position) || g.position < 1 || g.position > maxMaps || positions.has(g.position)) return null;
    positions.add(g.position); gameIds.add(positiveId(g.id)!);
    if (g.status === 'not_started') { if (g.winner != null || g.winner_id != null) return null; continue; }
    // No running/loading map is interpreted as a confirmed gap between maps.
    if (g.status !== 'finished') return null;
    const winner = positiveId(g.winner?.id), end = Date.parse(g.end_at ?? '');
    if ((winner !== pa && winner !== pb) || !Number.isFinite(end) || end < started || end > received) return null;
    finished.push({id:positiveId(g.id)!,position:g.position,winnerId:winner,endAt:new Date(end).toISOString()});
  }
  finished.sort((x,y) => x.position - y.position);
  if (!finished.length || finished.some((g,i) => g.position !== i+1)) return null;
  if ([...positions].some(p => p <= finished.length && !finished.some(g => g.position === p))) return null;
  const score1 = finished.filter(g => g.winnerId === pa).length, score2 = finished.filter(g => g.winnerId === pb).length;
  if (score1 >= need || score2 >= need || score1+score2 >= maxMaps) return null;
  // Explicit results, when present, must agree; never use them to fill missing winners.
  if (m.results != null) {
    if (!Array.isArray(m.results) || m.results.length !== 2) return null;
    const results = new Map<number,number>();
    for (const r of m.results) {
      const id = positiveId(r?.team_id);
      if (!id || (id !== pa && id !== pb) || results.has(id) || !Number.isInteger(r.score) || r.score < 0) return null;
      results.set(id,r.score);
    }
    if (results.get(pa) !== score1 || results.get(pb) !== score2) return null;
  }
  const latest = Math.max(...finished.map(g => Date.parse(g.endAt)));
  if (now - latest >= 20*60_000) return null;
  const context = Object.freeze({seriesId:identity.id,team1Id:a,team2Id:b,format,score1,score2,nextMapNumber:finished.length+1,
    sourceReceivedAt:feed.receivedAt,latestFinishedAt:new Date(latest).toISOString(),
    normalizedSourceSha256:createHash('sha256').update(JSON.stringify({seriesId:identity.id,startsAt:identity.startsAt,opponents,finished,format,sourceReceivedAt:feed.receivedAt})).digest('hex'),
    expiresAt:Math.min(received+180_000,latest+20*60_000)});
  trustedBetweenMapsContexts.add(context); return context;
}

function verifiedBetweenMapsContext(input: MatchInput, value: TrustedBetweenMapsContext | undefined, now: number): value is TrustedBetweenMapsContext {
  return !!value && trustedBetweenMapsContexts.has(value) && Object.isFrozen(value) && value.expiresAt > now
    && input.status === 'between_maps' && input.format === value.format
    && positiveId(input.team1.teamId) === value.team1Id && positiveId(input.team2.teamId) === value.team2Id
    && input.seriesContext?.seriesScore1 === value.score1 && input.seriesContext?.seriesScore2 === value.score2
    && input.seriesContext?.currentMapNumber === value.nextMapNumber;
}

export function supportedPredictions(
  input: MatchInput,
  evidence: ServingEvidence,
  now = Date.now(),
  trustedBetweenMaps?: TrustedBetweenMapsContext,
): Pick<AnalyticsResult, 'predictions' | 'unavailableMarkets' | 'state' | 'modelVersion'> {
  const predictions: EnrichedPrediction[] = [];
  const unavailableMarkets: NonNullable<AnalyticsResult['unavailableMarkets']> = [];
  const betweenMaps = input.status === 'between_maps';
  if (betweenMaps && !verifiedBetweenMapsContext(input,trustedBetweenMaps,now))
    return {predictions:[],unavailableMarkets:[{betType:'all',reason:'confirmed_between_maps_series_context_unavailable'}],state:'unavailable',modelVersion:'unavailable'};
  const live = !betweenMaps && (input.status === 'live' || !!input.liveSnapshot);
  const maxAge = live ? 180_000 : 60_000;
  const s1 = input.seriesContext?.seriesScore1 ?? 0;
  const s2 = input.seriesContext?.seriesScore2 ?? 0;
  const mapNo = input.seriesContext?.currentMapNumber ?? s1+s2+1;
  const formatKnown = knownSeriesFormat(input.format);
  const maxWins = !formatKnown ? Infinity : input.format === 'BO1' ? 1 : input.format === 'BO3' ? 2 : 3;
  if (input.status === 'finished' || ![s1,s2].every(s=>Number.isInteger(s)&&s>=0&&s<maxWins)) {
    return {predictions:[],unavailableMarkets:[{betType:'all',reason:'match_not_predictable'}],state:'unavailable',modelVersion:'unavailable'};
  }
  if (!formatKnown && !live) {
    return {predictions:[],unavailableMarkets:[{betType:'all',reason:'series_format_unknown'}],state:'unavailable',modelVersion:'unavailable'};
  }
  if(formatKnown && mapNo!==s1+s2+1) {
    return {predictions:[],unavailableMarkets:[{betType:'all',reason:'series_score_map_number_mismatch'}],state:'unavailable',modelVersion:'unavailable'};
  }
  const timely = (estimate: {predictedAt: string; observedAt?: string}) =>
    freshPrediction(estimate.predictedAt, maxAge, now)
    && (!estimate.observedAt || freshPrediction(estimate.observedAt, maxAge, now));
  const expiry = (estimate: {predictedAt: string; observedAt?: string}) =>
    new Date(Math.min(Date.parse(estimate.predictedAt), Date.parse(estimate.observedAt ?? estimate.predictedAt)) + maxAge).toISOString();
  const valid = (estimate: SupportedEstimate | null): estimate is SupportedEstimate =>
    !!estimate && validProbability(estimate.probability) && timely(estimate);
  const add = (type: string, label: string, estimate: SupportedEstimate, source: 'trained' | 'derived', basis: string) => {
    predictions.push({
      betType: type, label: type, labelRu: label,
      probTeam1: estimate.probability, probTeam2: 1 - estimate.probability,
      // Outcome probability is not a measured estimate of model quality.
      confidence: null, mainFactors: [], modelVersion: estimate.modelVersion,
      isLiveOnly: false, matchId: input.matchId,
      edge: null, ev: null, generatedAt: estimate.predictedAt,
      expiresAt: expiry(estimate),
      rawProbability: estimate.rawProbability ?? null,
      calibrationMethod: estimate.calibrationMethod ?? 'unknown',
      provenance: {source, basis, featuresVersion: estimate.featuresVersion ?? null, qualityStatus: 'legacy_unvalidated'},
    });
  };
  if (!betweenMaps && valid(evidence.map)) {
    add('map_winner', `Победитель карты ${mapNo}`, evidence.map, 'trained', evidence.map.basis ?? (live ? 'live_snapshot' : 'prematch_map'));
  } else unavailableMarkets.push({betType: 'map_winner', reason: betweenMaps ? 'no_current_map_observation_between_maps' : live ? 'no_fresh_live_prediction' : 'model_or_features_unavailable'});

  const decisiveMap = input.format === 'BO1' || (formatKnown && s1 === maxWins-1 && s2 === maxWins-1);
  const currentMapValid = !betweenMaps && valid(evidence.map);
  if (decisiveMap && currentMapValid) {
    add('match_winner', input.format === 'BO1' ? 'Победитель матча' : 'Победитель серии', evidence.map!, 'trained', 'deciding_map');
  } else if (knownSeriesFormat(input.format) && valid(evidence.futureMap) && (!live || valid(evidence.map))) {
    const p = evidence.futureMap.probability;
    // The trained target is one map. Never invert it as if it were a series.
    const pSeries = currentMapValid
      ? evidence.map!.probability * seriesWinProb(p, input.format, s1 + 1, s2)
        + (1 - evidence.map!.probability) * seriesWinProb(p, input.format, s1, s2 + 1)
      : seriesWinProb(p, input.format, s1, s2);
    add('match_winner', input.format === 'BO1' ? 'Победитель матча' : 'Победитель серии', {
      ...evidence.futureMap, probability: pSeries, rawProbability: undefined,
      observedAt: currentMapValid
        ? new Date(Math.min(Date.parse(evidence.map!.observedAt ?? evidence.map!.predictedAt), Date.parse(evidence.futureMap.observedAt ?? evidence.futureMap.predictedAt))).toISOString()
        : evidence.futureMap.observedAt,
      calibrationMethod: 'derived',
      modelVersion: [...new Set([...(currentMapValid ? [evidence.map!.modelVersion] : []),evidence.futureMap.modelVersion])].join('+') + '+series-forward',
    }, 'derived', currentMapValid ? (live ? 'live_map_and_independent_future_maps' : 'current_map_and_independent_future_maps') : betweenMaps ? 'confirmed_between_maps_score_and_independent_future_maps' : 'independent_maps');
    if (betweenMaps && trustedBetweenMaps) {
      const row = predictions[predictions.length-1]!;
      row.expiresAt = new Date(Math.min(Date.parse(row.expiresAt!),trustedBetweenMaps.expiresAt)).toISOString();
      Object.assign(row.provenance!,{targetScope:'series',seriesId:trustedBetweenMaps.seriesId,seriesScore1:s1,seriesScore2:s2,
        seriesContextSource:'server_saved_pandascore_running_finished_games',seriesContextReceivedAt:trustedBetweenMaps.sourceReceivedAt,
        normalizedSeriesSourceSha256:trustedBetweenMaps.normalizedSourceSha256,currentMapObserved:false});
    }
  } else unavailableMarkets.push({betType: 'match_winner', reason: formatKnown ? 'model_or_features_unavailable' : 'series_format_unknown'});

  for (const [betType, estimate, unit, title] of [
    ['total_kills', evidence.kills, 'kills', 'Тотал убийств'],
    ['total_duration', evidence.duration, 'seconds', 'Длительность'],
  ] as const) {
    if (betweenMaps) { unavailableMarkets.push({betType,reason:'no_current_map_observation_between_maps'}); continue; }
    if (!estimate || !timely(estimate) || (live && (estimate.observedMinimum === undefined || !estimate.observedAt))) {
      unavailableMarkets.push({betType, reason: live ? 'no_fresh_live_prediction' : 'model_or_features_unavailable'});
      continue;
    }
    const distribution: TotalsDistribution = {kind:'conditional_discrete_lognormal_v1',logMean:estimate.mean,
      logStd:estimate.std,logOffset:estimate.logOffset,unit,observedMinimum:estimate.observedMinimum};
    const ladder = totalsLadder(distribution,3);
    if (!ladder) {unavailableMarkets.push({betType,reason:'invalid_or_unsupported_distribution'});continue;}
    const row = ladder.lines[1];
    add(betType, title + ' О/У ' + row.line.toFixed(1) + (unit === 'seconds' ? ' мин' : ''),
      {probability:row.pOver, modelVersion:estimate.modelVersion,predictedAt:estimate.predictedAt,observedAt:estimate.observedAt,
        calibrationMethod:'conditional_discrete_lognormal_v1'}, 'derived',live ? 'live_conditioned_distribution' : 'prematch_distribution');
    const prediction = predictions[predictions.length-1];
    prediction.probTeam2 = row.pUnder;
    prediction.pPush = row.pPush;
    prediction.distribution = distribution;
    prediction.provenance!.qualityStatus = 'validated';
  }
  unavailableMarkets.push({betType: 'first_blood', reason: 'training_target_not_validated'});
  return {
    predictions, unavailableMarkets, state: predictions.length ? 'ready' : 'unavailable',
    modelVersion: [...new Set(predictions.map(p => p.modelVersion))].join('|') || 'unavailable',
  };
}

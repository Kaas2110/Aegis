/** Read-only DB export for a raw-replayed observed-draft prefix.
 * Late identity changes selectors, never the first-draft history cutoff.
 * The caller owns the transaction, DB timeout and connection lifecycle.
 */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {replayPinnedDraftPrefix} from './observedDraftHistory.mjs';
import {PRIOR_MAP_SELECTION_SQL,convertPriorMapRows} from './historicalFactsDb.mjs';
export const DRAFT_DB_CONTRACT='aegis.draft-historical-context-db-inputs.v1';
const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x),account=x=>id(x)&&BigInt(x)<4294967295n;
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
const check=signal=>{if(signal?.aborted)throw Error('draft_history_db_aborted');};
const pin=(payload,path,max=64*1024*1024)=>{const utf8=JSON.stringify(payload),bytes=Buffer.byteLength(utf8);if(bytes>max)throw Error('draft_history_db_payload_bound');return{utf8,pin:{path,bytes,sha256:sha(utf8)}};};
const NATIVE_SQL=`SELECT normalized_observation FROM steam_dynamic_diagnostic_v1
 WHERE match_id=ANY($1::bigint[]) AND source_profile=$2 AND phase_code=5 AND known_at<=$3::timestamptz
 ORDER BY known_at,observation_id LIMIT $4`;
async function query(db,sql,args,signal){check(signal);const result=await db.query(sql,args);check(signal);return result;}
export async function loadDraftHistoricalContextInputs(db,{draftPrefixInputs,matchId,computedAt,maxMaps=20000,maxFrames=10000,signal=null}={}){
 if(typeof db?.query!=='function'||!Number.isSafeInteger(maxMaps)||maxMaps<1||maxMaps>50000||!Number.isSafeInteger(maxFrames)||maxFrames<1||maxFrames>20000||signal!==null&&(typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'))throw Error('draft_history_db_input_contract');
 check(signal);
 const replay=replayPinnedDraftPrefix({draftPrefixInputs,matchId,computedAt});await new Promise(resolve=>setImmediate(resolve));check(signal);
 if(!replay.accepted)throw Error('draft_history_db_prefix_not_accepted:'+replay.reason);
 // Own copies prevent the caller from changing selectors while a query is pending.
 const state=structuredClone(replay.state),bindings=structuredClone(replay.bindings),cutoffAt=state.historyCutoffAt,cutoff=instantNs(cutoffAt);
 const roster=state.identity.players;
 if(cutoff===null||!Array.isArray(roster)||roster.length!==10||roster.some(p=>p.accountId!==null&&!account(p.accountId)||p.teamId!==null&&!id(p.teamId)))throw Error('draft_history_db_replayed_identity');
 const teams=[...new Set(roster.map(p=>p.teamId).filter(id))].sort(),accounts=[...new Set(roster.map(p=>p.accountId).filter(account))].sort();
 const heroes=[...new Set(roster.map(p=>Number(p.heroId)))].sort((a,b)=>a-b);
 if(heroes.length!==10||heroes.some(h=>!Number.isSafeInteger(h)||h<1||h>250))throw Error('draft_history_db_hero_identity');
 const selected=await query(db,PRIOR_MAP_SELECTION_SQL,[cutoffAt,matchId,teams,accounts,heroes.map(String),maxMaps+1],signal);
 if(!Array.isArray(selected?.rows)||selected.rows.length>maxMaps)throw Error('draft_history_db_map_bound');
 if(selected.rows.some(row=>!Array.isArray(row?.players)||row.players.length>10))throw Error('draft_history_db_prior_roster_bound');
 const {maps,seen}=convertPriorMapRows(selected.rows,{targetMapId:matchId,cutoffAt});
 let exportedBytes=0;
 for(let i=0;i<maps.length;i++){
  if(i%256===0){await new Promise(resolve=>setImmediate(resolve));check(signal);}
  const m=maps[i],ended=instantNs(m.endedAt);
  if(ended<cutoff-90n*86400n*1000000000n||typeof m.radiantWon!=='boolean'||!finite(m.durationSeconds)||m.durationSeconds<=0||[m.radiantKills,m.direKills].some(x=>x!==null&&(!Number.isSafeInteger(x)||x<0)))throw Error('draft_history_db_fact_values_or_window');
  if(!teams.includes(m.radiantTeamId)&&!teams.includes(m.direTeamId)&&!m.players.some(p=>accounts.includes(p.accountId))&&!m.heroes.some(p=>heroes.includes(Number(p.heroId))))throw Error('draft_history_db_fact_outside_selection');
  exportedBytes+=Buffer.byteLength(JSON.stringify(m));if(exportedBytes>64*1024*1024)throw Error('draft_history_db_payload_bound');
 }
 const observations=[],nativeCandidates=[],observedIds=new Set();
 if(maps.length){
  const selectedNative=await query(db,NATIVE_SQL,[maps.map(m=>m.matchId),PROFILE,cutoffAt,maxFrames+1],signal);
  if(!Array.isArray(selectedNative?.rows)||selectedNative.rows.length>maxFrames)throw Error('draft_history_db_native_bound');
  for(let i=0;i<selectedNative.rows.length;i++){
   if(i%128===0){await new Promise(resolve=>setImmediate(resolve));check(signal);}
   const raw=selectedNative.rows[i]?.normalized_observation;
   const bytes=typeof raw==='string'?Buffer.byteLength(raw):Buffer.byteLength(JSON.stringify(raw??null));
   if(bytes>262144)throw Error('draft_history_db_normalized_row_bound');
   exportedBytes+=bytes;if(exportedBytes>64*1024*1024)throw Error('draft_history_db_payload_bound');
   let o;try{o=typeof raw==='string'?JSON.parse(raw):structuredClone(raw);}catch{throw Error('draft_history_db_normalized_json');}
   const capture=o?.source?.capture,at=instantNs(capture?.receivedAt),phase=o?.dynamic?.phase;
   if(o?.contract!=='steam-live-scoreboard-candidate.v1'||!seen.has(o?.matchId)||o.matchId===matchId||at===null||at>cutoff||o.dynamic?.sourceProfile!==PROFILE||capture?.endpoint!=='GetLiveLeagueGames/v1'||!hash(o.observationId)||observedIds.has(o.observationId)||!hash(capture.rawSha256)||capture.originalPayloadRef!=='journal:'+capture.rawSha256||phase?.missing!==false||phase.value!==5||phase.status!=='observed'||o.sourceQualityReasons?.includes('outcome_marker_present'))throw Error('draft_history_db_native_identity_phase_or_future');
   observedIds.add(o.observationId);observations.push(o);
   nativeCandidates.push({matchId:o.matchId,observationId:o.observationId,phaseBasis:'explicit_phase5_candidate',
    observationInput:pin(o,'db-draft-asof/native-'+o.observationId+'.json',262144),
    rawCaptureRequired:{sha256:capture.rawSha256,reference:capture.originalPayloadRef},requiresPinnedEligibility:true});
  }
 }
 check(signal);
 const scope={contract:'aegis.prior-map-selection-scope.v1',sourceUniverse:'local_pro_matches_join_match_parsed',asOf:cutoffAt,windowDays:90,selection:'target_teams_or_accounts_or_heroes',targetTeamIds:teams,targetAccountIds:accounts,targetHeroIds:heroes,heroRosterBasis:'parsed_hero_id_and_explicit_side',completeWithinSource:true,truncated:false,rowCount:maps.length,queryEvidenceRef:'postgres:bounded-draft-prior-map-selection.v1',selectionSqlSha256:sha(PRIOR_MAP_SELECTION_SQL)};
 return{contract:DRAFT_DB_CONTRACT,draftState:state,draftPrefixBindings:bindings,
  factsInput:pin({contract:'aegis.prior-map-facts.v1',scope,maps},'db-draft-asof/prior-map-facts.json'),
  nativeInput:pin({contract:'aegis.pinned-native-economy-observations.v1',observations},'db-draft-asof/native-observations.json'),nativeCandidates,
  audit:{maps:maps.length,nativeFrames:observations.length,historyCutoffAt:cutoffAt,selectorsValidFrom:state.validFrom,computedAt,
   knownTargetAccounts:accounts.length,unknownTargetAccounts:roster.filter(p=>p.accountId===null).length,knownTargetTeams:teams.length,
   selectionScope:scope,windowDays:90,availabilityBasis:'database_timestamp_reconstruction',independentFieldAvailabilityAttested:false,
   rawDraftBytesVerified:true,priorNativeRawBytesVerified:false,nativeEvidencePolicy:'raw_replay_required_even_for_explicit_phase5',
   nativeSelectionSqlSha256:sha(NATIVE_SQL),currentMapExcluded:true,historyCutoffImmutable:true,zeroProviderCalls:true},
  eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
}

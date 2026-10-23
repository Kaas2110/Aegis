/** Bounded read-only facts export for the pure frozen-context producer.
 * Existing DB timestamps are reconstruction evidence, not independent proof that
 * an old forecast was recorded. Never exposes credentials or queries providers.
 */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
import {readPinnedHistoricalJson,PROFILE} from './historicalAlignment.mjs';
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const account=x=>id(x)&&BigInt(x)<4294967295n;
const pin=(payload,name)=>{const utf8=JSON.stringify(payload);return{utf8,pin:{path:name,bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')}};};
const ISO=`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export const PRIOR_MAP_SELECTION_SQL=`SELECT p.match_id::text AS "matchId",p.radiant_team_id::text AS "radiantTeamId",p.dire_team_id::text AS "direTeamId",p.duration AS "durationSeconds",p.radiant_score AS "radiantKills",p.dire_score AS "direKills",p.radiant_win AS "radiantWon",
 (SELECT coalesce(jsonb_agg(jsonb_build_object('account_id',j.player->'account_id','hero_id',j.player->'hero_id','player_slot',j.player->'player_slot')),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(mp.players)='array' THEN mp.players ELSE '[]'::jsonb END) AS j(player)) AS players,
 to_char(to_timestamp(p.start_time+p.duration) AT TIME ZONE 'UTC',${ISO}) AS "endedAt",
 to_char(greatest(to_timestamp(p.start_time+p.duration),p.ingested_at,mp.parsed_at) AT TIME ZONE 'UTC',${ISO}) AS "outcomeKnownAt",
 to_char(greatest(to_timestamp(p.start_time+p.duration),p.ingested_at,mp.parsed_at) AT TIME ZONE 'UTC',${ISO}) AS "playersKnownAt"
 FROM pro_matches p JOIN match_parsed mp ON mp.match_id=p.match_id
 WHERE p.match_id<>$2::bigint AND p.radiant_win IS NOT NULL AND p.duration>0
 AND greatest(to_timestamp(p.start_time+p.duration),p.ingested_at,mp.parsed_at)<=$1::timestamptz
 AND mp.parsed_at<=$1::timestamptz AND to_timestamp(p.start_time+p.duration)>=$1::timestamptz-interval '90 days'
 AND (p.radiant_team_id::text=ANY($3::text[]) OR p.dire_team_id::text=ANY($3::text[])
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(mp.players)='array' THEN mp.players ELSE '[]'::jsonb END) AS j(player) WHERE j.player->>'account_id'=ANY($4::text[]) OR j.player->>'hero_id'=ANY($5::text[])))
 ORDER BY p.match_id LIMIT $6`;
export function convertPriorMapRows(rows,{targetMapId,cutoffAt}={}){
 const cutoff=instantNs(cutoffAt);if(!Array.isArray(rows)||!id(targetMapId)||cutoff===null)throw Error('historical_db_row_conversion_contract');
 const seen=new Set(),maps=rows.map(row=>{
  const ended=instantNs(row.endedAt),known=instantNs(row.outcomeKnownAt),playersAt=instantNs(row.playersKnownAt);
  if(!id(row.matchId)||row.matchId===targetMapId||seen.has(row.matchId)||ended===null||known===null||playersAt===null||ended>known||known>cutoff||playersAt>cutoff||playersAt<known)throw Error('historical_db_identity_or_future');
  seen.add(row.matchId);
  const players=[],heroes=[];for(const p of Array.isArray(row.players)?row.players:[]){
   const slot=p.player_slot,side=Number.isSafeInteger(slot)&&slot>=0&&slot<=4?'radiant':Number.isSafeInteger(slot)&&slot>=128&&slot<=132?'dire':null;
   const a=String(p.account_id??''),h=String(p.hero_id??'');
   if(side&&id(h)&&Number(h)<=250)heroes.push({heroId:h,side});
   if(side&&account(a)&&id(h))players.push({accountId:a,heroId:h,side});
  }
  return {matchId:row.matchId,endedAt:row.endedAt,outcomeKnownAt:row.outcomeKnownAt,playersKnownAt:row.playersKnownAt,heroesKnownAt:row.playersKnownAt,
   radiantTeamId:id(row.radiantTeamId)?row.radiantTeamId:null,direTeamId:id(row.direTeamId)?row.direTeamId:null,
   durationSeconds:row.durationSeconds,radiantKills:row.radiantKills,direKills:row.direKills,radiantWon:row.radiantWon,players,heroes,evidenceRef:'postgres:pro_matches+match_parsed/'+row.matchId};
 });
 return {maps,seen};
}

export async function loadHistoricalContextInputs(db,{target,maxMaps=20000,maxFrames=10000}={}){
 const cutoff=instantNs(target?.knownAt),freeze=instantNs(target?.frozenBeforeMapAt),receipt=instantNs(target?.receivedAt);
 if(typeof db?.query!=='function'||!id(target?.matchId)||cutoff===null||freeze===null||receipt===null||cutoff>freeze||freeze>receipt||!Array.isArray(target.players)||target.players.length!==10||target.players.some(p=>!account(p?.accountId))||!Number.isInteger(maxMaps)||maxMaps<1||maxMaps>50000||!Number.isInteger(maxFrames)||maxFrames<1||maxFrames>20000)throw Error('historical_db_input_contract');
 const teams=[...new Set(target.players.map(p=>p.teamId).filter(id))].sort(),accounts=[...new Set(target.players.map(p=>p.accountId))].sort();
 const heroes=[...new Set(target.players.map(p=>Number(p.heroId)))].sort((a,b)=>a-b);
 if(heroes.length!==10||heroes.some(h=>!Number.isSafeInteger(h)||h<1||h>250))throw Error('historical_db_hero_identity');
 if(accounts.length!==10)throw Error('historical_db_duplicate_roster');
 const sql=PRIOR_MAP_SELECTION_SQL;
 const rows=await db.query(sql,[target.knownAt,target.matchId,teams,accounts,heroes.map(String),maxMaps+1]);
 if(!Array.isArray(rows?.rows)||rows.rows.length>maxMaps)throw Error('historical_db_map_bound');
 const {maps,seen}=convertPriorMapRows(rows.rows,{targetMapId:target.matchId,cutoffAt:target.knownAt});
 let observations=[];
 if(maps.length){
  const native=await db.query(`SELECT normalized_observation FROM steam_dynamic_diagnostic_v1 WHERE match_id=ANY($1::bigint[]) AND source_profile=$2 AND phase_code=5 AND known_at<=$3::timestamptz ORDER BY known_at,observation_id LIMIT $4`,[maps.map(m=>m.matchId),'steam.GetLiveLeagueGames.v1.scoreboard',target.knownAt,maxFrames+1]);
  if(!Array.isArray(native?.rows)||native.rows.length>maxFrames)throw Error('historical_db_native_bound');
  observations=native.rows.map(row=>{const o=typeof row.normalized_observation==='string'?JSON.parse(row.normalized_observation):row.normalized_observation,at=instantNs(o?.source?.capture?.receivedAt);
   if(!seen.has(o?.matchId)||at===null||at>cutoff||o.dynamic?.sourceProfile!=='steam.GetLiveLeagueGames.v1.scoreboard'||o.dynamic?.phase?.value!==5||o.dynamic?.phase?.missing!==false)throw Error('historical_db_native_identity_or_future');return o;
  });
 }
 const scope={contract:'aegis.prior-map-selection-scope.v1',sourceUniverse:'local_pro_matches_join_match_parsed',asOf:target.knownAt,windowDays:90,selection:'target_teams_or_accounts_or_heroes',targetTeamIds:teams,targetAccountIds:accounts,targetHeroIds:heroes,heroRosterBasis:'parsed_hero_id_and_explicit_side',completeWithinSource:true,truncated:false,rowCount:maps.length,queryEvidenceRef:'postgres:bounded-prior-map-selection.v2',selectionSqlSha256:createHash('sha256').update(sql).digest('hex')};
 return {contract:'aegis.historical-context-db-inputs.v2',factsInput:pin({contract:'aegis.prior-map-facts.v1',scope,maps},'db-asof/prior-map-facts.json'),nativeInput:pin({contract:'aegis.pinned-native-economy-observations.v1',observations},'db-asof/native-observations.json'),
  audit:{maps:maps.length,nativeFrames:observations.length,cutoff:target.knownAt,windowDays:90,availabilityBasis:'database_timestamp_reconstruction',independentFieldAvailabilityAttested:false,playerSideFromExplicitSlot:true,zeroProviderCalls:true},eligibleForServing:false,eligibleForTraining:false};
}

/** Separate opt-in candidate export. The strict phase=5 loader above is unchanged.
 * Reads only retained normalized observations for already pinned PRIOR map facts.
 * This export is NOT evidence admission: original raw bytes and reviewed profile/
 * alignment sidecars must be verified through evaluatePinnedNativeHistory later.
 */
export async function loadHistoricalNativeCandidates(db,{factsExport,targetMapId,historyCutoffAt,maxFrames=10000,enableHistoricalAlignmentCandidates=false}={}){
 if(enableHistoricalAlignmentCandidates!==true)throw Error('historical_alignment_export_opt_in_required');
 const cutoff=instantNs(historyCutoffAt);
 if(typeof db?.query!=='function'||!id(targetMapId)||cutoff===null||!Number.isSafeInteger(maxFrames)||maxFrames<1||maxFrames>20000||factsExport?.contract!=='aegis.historical-context-db-inputs.v2'||factsExport.audit?.availabilityBasis!=='database_timestamp_reconstruction'||instantNs(factsExport.audit?.cutoff)!==cutoff)throw Error('historical_alignment_db_contract');
 const facts=readPinnedHistoricalJson(factsExport.factsInput),maps=facts.data.maps,scope=facts.data.scope;
 if(facts.data.contract!=='aegis.prior-map-facts.v1'||!Array.isArray(maps)||maps.length>50000||!scope||instantNs(scope.asOf)!==cutoff||scope.completeWithinSource!==true||scope.truncated!==false||scope.rowCount!==maps.length)throw Error('historical_alignment_facts_scope');
 const seen=new Set(),priorMapInputs=[];
 for(const m of maps){
  const ended=instantNs(m?.endedAt),known=instantNs(m?.outcomeKnownAt),roster=instantNs(m?.playersKnownAt),heroes=instantNs(m?.heroesKnownAt);
  if(!id(m?.matchId)||m.matchId===targetMapId||seen.has(m.matchId)||ended===null||known===null||roster===null||heroes===null||ended>known||known>cutoff||roster>cutoff||heroes>cutoff||typeof m.radiantWon!=='boolean'||typeof m.durationSeconds!=='number'||!Number.isFinite(m.durationSeconds)||m.durationSeconds<=0)throw Error('historical_alignment_prior_fact_invalid');
  seen.add(m.matchId);
  // The existing DB exporter reads duration/outcome/roster in the same SQL row and
  // uses max(end, ingestion, parsed_at). Keep this conservative reconstruction basis.
  // It is not an actual provider receipt, and must not be presented as one.
  const priorMap={...m,heroes:Array.isArray(m.heroes)?m.heroes.map(h=>({...h,heroId:Number(h.heroId)})):m.heroes,players:Array.isArray(m.players)?m.players.map(p=>({...p,heroId:Number(p.heroId)})):m.players,durationKnownAt:m.outcomeKnownAt,durationAvailabilityBasis:'database_same_row_max_end_ingested_parsed',priorFactsCollectionSha256:facts.pin.sha256,availabilityBasis:'database_timestamp_reconstruction'};
  priorMapInputs.push({matchId:m.matchId,input:pin(priorMap,'db-asof/prior-map-'+m.matchId+'.json')});
 }
 const sql=`SELECT normalized_observation FROM steam_dynamic_diagnostic_v1
 WHERE match_id=ANY($1::bigint[]) AND source_profile=$2 AND known_at<=$3::timestamptz
 AND (phase_code=5 OR (phase_code IS NULL AND normalized_observation #>> '{dynamic,phase,status}'='absent'))
 ORDER BY known_at,observation_id LIMIT $4`;
 let rows=[];if(maps.length){const result=await db.query(sql,[[...seen],PROFILE,historyCutoffAt,maxFrames+1]);if(!Array.isArray(result?.rows)||result.rows.length>maxFrames)throw Error('historical_alignment_native_bound');rows=result.rows;}
 const candidates=[],ids=new Map(),rejections=[];
 for(const row of rows){
  const o=typeof row.normalized_observation==='string'?JSON.parse(row.normalized_observation):row.normalized_observation,at=instantNs(o?.source?.capture?.receivedAt);
  if(!o||o.contract!=='steam-live-scoreboard-candidate.v1'||!seen.has(o.matchId)||at===null||at>cutoff||o.dynamic?.sourceProfile!==PROFILE||o.source?.capture?.endpoint!=='GetLiveLeagueGames/v1'||!/^([a-f0-9]{64})$/.test(o.observationId??'')||!/^([a-f0-9]{64})$/.test(o.source.capture.rawSha256??'')||o.source.capture.originalPayloadRef!=='journal:'+o.source.capture.rawSha256)throw Error('historical_alignment_native_identity_or_future');
  const normalized=pin(o,'db-asof/native-'+o.observationId+'.json'),prior=ids.get(o.observationId);
  if(prior&&prior!==normalized.pin.sha256)throw Error('historical_alignment_conflicting_observation');
  if(prior)continue;ids.set(o.observationId,normalized.pin.sha256);
  const phase=o.dynamic.phase,explicit=phase?.missing===false&&phase.value===5&&phase.status==='observed',absent=phase?.missing===true&&phase.status==='absent'&&phase.value===null&&phase.rawValue===null;
  if((!explicit&&!absent)||o.sourceQualityReasons?.includes('outcome_marker_present')){rejections.push({observationId:o.observationId,reason:'explicit_nonlive_invalid_or_terminal'});continue;}
  candidates.push({matchId:o.matchId,observationId:o.observationId,phaseBasis:explicit?'explicit_phase5_candidate':'phase_absent_unreviewed_candidate',observationInput:normalized,rawCaptureRequired:{sha256:o.source.capture.rawSha256,reference:o.source.capture.originalPayloadRef},requiresPinnedEligibility:true});
 }
 return{contract:'aegis.historical-native-candidate-export.v1',factsCollection:facts.pin,priorMapInputs,candidates,rejections,audit:{maps:maps.length,returnedRows:rows.length,candidates:candidates.length,historyCutoffAt,sourceProfile:PROFILE,selectionSqlSha256:createHash('sha256').update(sql).digest('hex'),availabilityBasis:'database_timestamp_reconstruction',rawBytesVerified:false,phaseRewritten:false,zeroProviderCalls:true},eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
}

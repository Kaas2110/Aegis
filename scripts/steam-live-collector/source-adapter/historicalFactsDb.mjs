/** Bounded read-only facts export for the pure frozen-context producer.
 * Existing DB timestamps are reconstruction evidence, not independent proof that
 * an old forecast was recorded. Never exposes credentials or queries providers.
 */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const account=x=>id(x)&&BigInt(x)<4294967295n;
const pin=(payload,name)=>{const utf8=JSON.stringify(payload);return{utf8,pin:{path:name,bytes:Buffer.byteLength(utf8),sha256:createHash('sha256').update(utf8).digest('hex')}};};
const ISO=`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export async function loadHistoricalContextInputs(db,{target,maxMaps=5000,maxFrames=10000}={}){
 const cutoff=instantNs(target?.knownAt),freeze=instantNs(target?.frozenBeforeMapAt),receipt=instantNs(target?.receivedAt);
 if(typeof db?.query!=='function'||!id(target?.matchId)||cutoff===null||freeze===null||receipt===null||cutoff>freeze||freeze>receipt||!Array.isArray(target.players)||target.players.length!==10||target.players.some(p=>!account(p?.accountId))||!Number.isInteger(maxMaps)||maxMaps<1||maxMaps>50000||!Number.isInteger(maxFrames)||maxFrames<1||maxFrames>20000)throw Error('historical_db_input_contract');
 const teams=[...new Set(target.players.map(p=>p.teamId).filter(id))],accounts=[...new Set(target.players.map(p=>p.accountId))];
 if(accounts.length!==10)throw Error('historical_db_duplicate_roster');
 const rows=await db.query(`SELECT p.match_id::text AS "matchId",p.radiant_team_id::text AS "radiantTeamId",p.dire_team_id::text AS "direTeamId",p.duration AS "durationSeconds",p.radiant_score AS "radiantKills",p.dire_score AS "direKills",p.radiant_win AS "radiantWon",mp.players,
 to_char(to_timestamp(p.start_time+p.duration) AT TIME ZONE 'UTC',${ISO}) AS "endedAt",
 to_char(greatest(to_timestamp(p.start_time+p.duration),p.ingested_at,mp.parsed_at) AT TIME ZONE 'UTC',${ISO}) AS "outcomeKnownAt",
 to_char(greatest(to_timestamp(p.start_time+p.duration),p.ingested_at,mp.parsed_at) AT TIME ZONE 'UTC',${ISO}) AS "playersKnownAt"
 FROM pro_matches p JOIN match_parsed mp ON mp.match_id=p.match_id
 WHERE p.match_id<>$2::bigint AND p.radiant_win IS NOT NULL AND p.duration>0
 AND greatest(to_timestamp(p.start_time+p.duration),p.ingested_at,mp.parsed_at)<=$1::timestamptz
 AND mp.parsed_at<=$1::timestamptz AND to_timestamp(p.start_time+p.duration)>=$1::timestamptz-interval '90 days'
 AND (p.radiant_team_id::text=ANY($3::text[]) OR p.dire_team_id::text=ANY($3::text[])
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(mp.players)='array' THEN mp.players ELSE '[]'::jsonb END) AS j(player) WHERE j.player->>'account_id'=ANY($4::text[])))
 ORDER BY p.match_id LIMIT $5`,[target.knownAt,target.matchId,teams,accounts,maxMaps+1]);
 if(!Array.isArray(rows?.rows)||rows.rows.length>maxMaps)throw Error('historical_db_map_bound');
 const seen=new Set(),maps=rows.rows.map(row=>{
  const ended=instantNs(row.endedAt),known=instantNs(row.outcomeKnownAt),playersAt=instantNs(row.playersKnownAt);
  if(!id(row.matchId)||row.matchId===target.matchId||seen.has(row.matchId)||ended===null||known===null||playersAt===null||ended>known||known>cutoff||playersAt>cutoff||playersAt<known)throw Error('historical_db_identity_or_future');
  seen.add(row.matchId);
  const players=[];for(const p of Array.isArray(row.players)?row.players:[]){
   const slot=p.player_slot,side=Number.isSafeInteger(slot)&&slot>=0&&slot<=4?'radiant':Number.isSafeInteger(slot)&&slot>=128&&slot<=132?'dire':null;
   const a=String(p.account_id??''),h=String(p.hero_id??'');
   if(side&&account(a)&&id(h))players.push({accountId:a,heroId:h,side});
  }
  return {matchId:row.matchId,endedAt:row.endedAt,outcomeKnownAt:row.outcomeKnownAt,playersKnownAt:row.playersKnownAt,
   radiantTeamId:id(row.radiantTeamId)?row.radiantTeamId:null,direTeamId:id(row.direTeamId)?row.direTeamId:null,
   durationSeconds:row.durationSeconds,radiantKills:row.radiantKills,direKills:row.direKills,radiantWon:row.radiantWon,players,evidenceRef:'postgres:pro_matches+match_parsed/'+row.matchId};
 });
 let observations=[];
 if(maps.length){
  const native=await db.query(`SELECT normalized_observation FROM steam_dynamic_diagnostic_v1 WHERE match_id=ANY($1::bigint[]) AND source_profile=$2 AND phase_code=5 AND known_at<=$3::timestamptz ORDER BY known_at,observation_id LIMIT $4`,[maps.map(m=>m.matchId),'steam.GetLiveLeagueGames.v1.scoreboard',target.knownAt,maxFrames+1]);
  if(!Array.isArray(native?.rows)||native.rows.length>maxFrames)throw Error('historical_db_native_bound');
  observations=native.rows.map(row=>{const o=typeof row.normalized_observation==='string'?JSON.parse(row.normalized_observation):row.normalized_observation,at=instantNs(o?.source?.capture?.receivedAt);
   if(!seen.has(o?.matchId)||at===null||at>cutoff||o.dynamic?.sourceProfile!=='steam.GetLiveLeagueGames.v1.scoreboard'||o.dynamic?.phase?.value!==5||o.dynamic?.phase?.missing!==false)throw Error('historical_db_native_identity_or_future');return o;
  });
 }
 return {contract:'aegis.historical-context-db-inputs.v1',factsInput:pin({contract:'aegis.prior-map-facts.v1',maps},'db-asof/prior-map-facts.json'),nativeInput:pin({contract:'aegis.pinned-native-economy-observations.v1',observations},'db-asof/native-observations.json'),
  audit:{maps:maps.length,nativeFrames:observations.length,cutoff:target.knownAt,windowDays:90,availabilityBasis:'database_timestamp_reconstruction',independentFieldAvailabilityAttested:false,playerSideFromExplicitSlot:true,zeroProviderCalls:true},eligibleForServing:false,eligibleForTraining:false};
}

/** Staged pure local response adapter. No credentials, HTTP client or poller.
 * League paths measured in one authenticated local capture, not a source SLA.
 * Raw source captures use a separate schema; they cannot rewrite OpenDota rows.
 */
import {createHash} from 'node:crypto';
import {DecimalNumber,parseLosslessJson} from './losslessJson.mjs';
import {DYNAMIC_CONTRACT,dynamicPlayer,dynamicGame,draftFields} from './dynamicFields.mjs';

export const CONTRACT='steam-live-scoreboard-candidate.v1';
export const SOURCE_CONTRACT='steam-live-scoreboard-source.v1';
export const SCHEMA_EVIDENCE=Object.freeze({status:'MEASURED_ONE_AUTHENTICATED_CAPTURE',measuredAuthenticatedSchema:true,
  evidenceSha256:'eefede1578ea99e75d0add41df3b928a479300145c3c0d5880497497bad60e5d',measuredUtc:'2026-10-19T19:43:40.274491+00:00',
  measuredGames:28,measuredScoreboards:28,measuredPlayerRecords:280,completenessOrLatencyGuarantee:false});
const MAX_BODY=6*1024*1024,MAX_SOURCE=65536,MAX_GAMES=512,MAX_SAFE=Number.MAX_SAFE_INTEGER,UINT64=(1n<<64n)-1n;
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
export function canonical(x){
  const sort=v=>Array.isArray(v)?v.map(sort):record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
  return JSON.stringify(sort(x));
}
export const sha=x=>createHash('sha256').update(x).digest('hex');
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const nonnegative=x=>finite(x)&&x>=0;
const integer=x=>nonnegative(x)&&Number.isSafeInteger(x);
function time(value,name){
  if(typeof value!=='string'||value.length>64||!/(Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('invalid_'+name);
  return Date.parse(value);
}
export function decimalId(value,{anonymous=false}={}){
  if(anonymous&&(value===null||value===0||value==='0'||value===4294967295||value==='4294967295'))return null;
  const text=typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)?value:
    typeof value==='number'&&Number.isSafeInteger(value)&&value>0?String(value):null;
  if(text===null||BigInt(text)>UINT64)throw Error('invalid_decimal_identity');
  return text;
}
function account(value){
  if(value===undefined||value===null||value===0||value==='0'||value===4294967295||value==='4294967295')return null;
  const id=decimalId(value);if(BigInt(id)>=4294967295n)throw Error('invalid_account_identity');return id;
}
function nullableId(object,key,{anonymous=false}={}){
  if(!own(object,key)||object[key]===null)return null;
  return decimalId(object[key],{anonymous});
}
function scalar(x){
  if(x instanceof DecimalNumber)return x.value;
  if(x===null||typeof x==='boolean'||finite(x)||typeof x==='string'&&x.length<=128)return x;
  throw Error('raw_scalar_bound');
}
function rawPick(raw,keys){
  const out={};for(const key of keys)if(own(raw,key))out[key]=scalar(raw[key]);return out;
}
function metric(raw,key,validate=nonnegative){
  if(!own(raw,key))return {value:null,missing:true,status:'absent',sourceField:key,semantics:'UNCONFIRMED'};
  if(raw[key]===null)return {value:null,missing:true,status:'null',sourceField:key,semantics:'UNCONFIRMED'};
  const value=scalar(raw[key]);
  return {value:validate(value)?value:null,missing:!validate(value),status:validate(value)?'observed':'invalid',sourceField:key,semantics:'observed named provider field; no cross-field inference'};
}
const PLAYER_KEYS=['account_id','hero_id','player_slot','team_slot','level','gold_per_min','xp_per_min','net_worth','gold','net_gold',
  'item0','item1','item2','item3','item4','item5','has_buyback','buyback_cooldown','respawn_timer','kills','death','assists','last_hits','denies',
  'position_x','position_y','ultimate_state','ultimate_cooldown'];
const GAME_KEYS=['match_id','lobby_id','server_steam_id','league_id','series_id','stream_delay_s','timestamp','last_update_time','time','game_state'];
function player(raw,side,path,teamId,capture){
  if(!record(raw))throw Error('invalid_player_object');
  const accountId=account(raw.account_id),heroId=nullableId(raw,'hero_id',{anonymous:true});
  const items=Array.from({length:6},(_,i)=>{
    const key=`item${i}`,item=metric(raw,key,integer),rawValue=own(raw,key)?scalar(raw[key]):null;
    if(typeof rawValue==='number'&&rawValue<0)item.status='negative_source_sentinel';
    return {providerField:key,...item,rawValue};
  });
  const rawSlot=own(raw,'player_slot')?scalar(raw.player_slot):null;
  const compatible=typeof raw.player_slot==='number'&&Number.isSafeInteger(rawSlot)&&(side==='radiant'?[0,1,2,3,4]:[128,129,130,131,132]).includes(rawSlot);
  return {
    identity:{accountId,heroId,teamId,side,providerSteamPlayerSlot:null,providerPlayerSlotRaw:rawSlot,providerPlayerSlotSideCompatible:compatible,
      providerTeamSlotRaw:own(raw,'team_slot')?scalar(raw.team_slot):null,slotSemantics:'observed explicit player_slot; no team_slot conversion or role inference'},
    level:metric(raw,'level',integer),goldPerMinute:metric(raw,'gold_per_min'),experiencePerMinute:metric(raw,'xp_per_min'),
    netWorth:metric(raw,'net_worth'),gold:metric(raw,'gold'),netGoldRaw:metric(raw,'net_gold'),
    observedItemFields:items,itemInventoryComplete:null,itemIdsSemantics:'raw observed IDs only; zero is preserved without empty-slot inference',
    buybackAvailable:null,buybackSemantics:'UNCONFIRMED; no inference from cooldown/gold/items',role:null,
    sourcePlayerPath:path,canJoinPlayerHistory:accountId!==null&&heroId!==null,
    rawFieldPresence:Object.fromEntries(PLAYER_KEYS.map(k=>[k,!own(raw,k)?'absent':raw[k]===null?'null':'present'])),
    rawSource:rawPick(raw,PLAYER_KEYS),dynamic:dynamicPlayer(raw,path,capture)
  };
}
function normalizeGame(raw,index,capture,expected){
  if(!record(raw))throw Error('invalid_game_object');
  const matchId=decimalId(raw.match_id),serverSteamId=nullableId(raw,'server_steam_id');
  if(expected?.matchId!==undefined&&decimalId(expected.matchId)!==matchId)throw Error('expected_match_mismatch');
  if(expected?.serverSteamId!==undefined&&decimalId(expected.serverSteamId)!==serverSteamId)throw Error('expected_server_mismatch');
  const scoreboard=record(raw.scoreboard)?raw.scoreboard:null;
  const quality=['one_capture_schema_only','event_time_unverified','timely_coverage_unproved'];
  if(!scoreboard)quality.push('scoreboard_absent');
  const rawSource=rawPick(raw,GAME_KEYS),sides={},players=[];
  if(own(raw,'scoreboard'))rawSource.scoreboard=scoreboard?{}:scalar(raw.scoreboard);
  for(const side of ['radiant','dire']){
    const t=record(raw[side+'_team'])?raw[side+'_team']:{};
    const teamId=nullableId(t,'team_id',{anonymous:true});
    if(teamId===null)quality.push(side+'_team_identity_unknown');
    const data=scoreboard&&record(scoreboard[side])?scoreboard[side]:{};
    if(data.players!==undefined&&data.players!==null&&(!Array.isArray(data.players)||data.players.length>5))throw Error('side_player_count_or_shape');
    const sourcePlayers=Array.isArray(data.players)?data.players:[];
    const normalized=sourcePlayers.map((p,j)=>player(p,side,`result.games[${index}].scoreboard.${side}.players[${j}]`,teamId,capture));
    players.push(...normalized);
    sides[side]={teamId,score:metric(data,'score',integer),towerMaskRaw:metric(data,'tower_state',x=>integer(x)&&x<=0xffffffff),
      barracksMaskRaw:metric(data,'barracks_state',x=>integer(x)&&x<=0xffffffff),buildingMaskSemantics:'UNCONFIRMED_OPAQUE_UINT32',
      players:normalized,rosterComplete:normalized.length===5&&normalized.every(p=>p.identity.accountId!==null&&p.identity.heroId!==null),
      playerArrayStatus:!own(data,'players')?'absent':data.players===null?'null':'observed',draft: draftFields(data,`result.games[${index}].scoreboard.${side}`,capture)};
    if(own(raw,side+'_team'))rawSource[side+'_team']=record(raw[side+'_team'])?rawPick(t,['team_id']):scalar(raw[side+'_team']);
    if(scoreboard&&own(scoreboard,side))rawSource.scoreboard[side]=record(scoreboard[side])?{...rawPick(data,['score','tower_state','barracks_state']),
      ...(own(data,'players')?{players:data.players===null?null:normalized.map(p=>p.rawSource)}:{})}:scalar(scoreboard[side]);
  }
  const known=players.map(p=>p.identity.accountId).filter(x=>x!==null),heroes=players.map(p=>p.identity.heroId).filter(x=>x!==null);
  if(new Set(known).size!==known.length||new Set(heroes).size!==heroes.length)throw Error('duplicate_player_identity');
  if(sides.radiant.teamId!==null&&sides.radiant.teamId===sides.dire.teamId)throw Error('same_team_identity');
  if(!Object.values(sides).every(s=>s.rosterComplete))quality.push('roster_incomplete');
  if(players.some(p=>p.identity.providerPlayerSlotRaw!==null&&!p.identity.providerPlayerSlotSideCompatible))quality.push('provider_player_slot_side_mismatch');
  const clock=scoreboard?metric(scoreboard,'duration',x=>finite(x)&&x>=-3600):{value:null,missing:true,status:'absent',sourceField:'duration',semantics:'UNCONFIRMED'};
  if(scoreboard&&own(scoreboard,'duration'))rawSource.scoreboard.duration=scalar(scoreboard.duration);
  if(scoreboard&&own(scoreboard,'roshan_respawn_timer'))rawSource.scoreboard.roshan_respawn_timer=scalar(scoreboard.roshan_respawn_timer);
  for(const side of ['radiant','dire'])if(record(rawSource.scoreboard?.[side]))for(const key of ['picks','bans']){
    const value=sides[side].draft[key];if(value.status==='observed')rawSource.scoreboard[side][key]=value.value.map(x=>({hero_id:x.rawValue}));
  }
  const delay=metric(raw,'stream_delay_s');if(delay.value===null)quality.push('declared_delay_unknown');
  if(delay.value!==null&&delay.value>300)quality.push('declared_delay_exceeds_300s');
  if(own(raw,'radiant_win')||own(raw,'winner')||own(raw,'final_score')||own(raw,'match_outcome'))quality.push('outcome_marker_present');
  if(Buffer.byteLength(canonical(rawSource))>MAX_SOURCE)throw Error('source_game_bytes_bound');
  const source={contract:SOURCE_CONTRACT,endpoint:capture.endpoint,endpointVersion:'v1',schemaEvidence:SCHEMA_EVIDENCE,capture,rawPacket:rawSource};
  const inputHash=sha(canonical(source));
  return {contract:CONTRACT,dynamicContract:DYNAMIC_CONTRACT,dynamic:dynamicGame(raw,scoreboard,index,capture),status:'normalized_measured_schema_diagnostic',schemaEvidence:SCHEMA_EVIDENCE,matchId,serverSteamId,
    lobbyId:nullableId(raw,'lobby_id'),leagueId:nullableId(raw,'league_id',{anonymous:true}),seriesId:nullableId(raw,'series_id',{anonymous:true}),
    providerGameClockSeconds:clock,providerTimestampRaw:rawPick(raw,['timestamp','last_update_time','time']),providerEventAt:null,
    providerTimestampUnits:null,declaredBroadcastDelaySeconds:delay,measuredEventToReceiptSeconds:null,
    declaredDelayWithin300s:delay.value===null?null:delay.value<=300,eventLagWithin300s:null,
    delaySemantics:'UNCONFIRMED; declared delay is not measured total source age',sides,
    joinIdentityComplete:Object.values(sides).every(s=>s.teamId!==null&&s.rosterComplete),explicitGamePhase:dynamicGame(raw,scoreboard,index,capture).phase.name,
    rawFieldPresence:{scoreboard:!own(raw,'scoreboard')?'absent':raw.scoreboard===null?'null':'present',
      ...Object.fromEntries(GAME_KEYS.map(k=>[k,!own(raw,k)?'absent':raw[k]===null?'null':'present']))},
    sourceQualityReasons:quality,source,inputHash,observationId:sha(canonical({contract:SOURCE_CONTRACT,inputHash,receivedAt:capture.receivedAt})),
    sourceSchemaHash:sha(canonical({contract:SOURCE_CONTRACT,dynamicContract:DYNAMIC_CONTRACT,schemaEvidence:SCHEMA_EVIDENCE,candidatePaths:'historical_scoreboard_nested_sides_dynamic_v1'})),
    eligibleForServing:false,eligibleForPromotion:false,modelFeatureMapping:null,prediction:null};
}

/** Accept bytes and safe local metadata ONLY. No request URL/header/auth input. */
export function normalizeLocalCapture(input){
  if(!record(input)||!(input.body instanceof Uint8Array)||input.body.byteLength>MAX_BODY)throw Error('response_body_bound');
  if(!['GetLiveLeagueGames/v1','GetRealtimeStats/v1'].includes(input.endpoint))throw Error('endpoint_contract');
  const started=time(input.requestStartedAt,'request_started_at'),received=time(input.receivedAt,'received_at'),persisted=time(input.persistedAt,'persisted_at');
  if(!(started<=received&&received<=persisted))throw Error('capture_time_order');
  if(!Number.isSafeInteger(input.httpStatus)||input.httpStatus<100||input.httpStatus>599)throw Error('http_status');
  const hash=sha(input.body);
  if(input.rawSha256!==hash||input.payloadRef!=='journal:'+hash)throw Error('raw_capture_pin_or_ref');
  const capture={provider:'steam',endpoint:input.endpoint,endpointVersion:'v1',httpStatus:input.httpStatus,requestStartedAt:input.requestStartedAt,
    receivedAt:input.receivedAt,persistedAt:input.persistedAt,rawSha256:hash,originalPayloadRef:input.payloadRef,
    authenticatedAttempt:input.authenticatedAttempt===true,originalProviderEventTimeProven:false};
  const base={contract:CONTRACT,capture,schemaEvidence:SCHEMA_EVIDENCE,observations:[],rejections:[],eligibleForServing:false};
  if(input.httpStatus!==200)return {...base,status:'http_error',reason:'http_'+input.httpStatus};
  const duplicateUnconsumedFields=[];
  let body;try{body=parseLosslessJson(new TextDecoder('utf-8',{fatal:true}).decode(input.body),{onDuplicate:(path,key)=>{
    // Actual Valve capture repeats the unused abilities key on scoreboard sides.
    // No duplicate identity, score, clock or metric key is silently accepted.
    const allowed=key==='abilities'&&path.length===5&&path[0]==='result'&&path[1]==='games'&&typeof path[2]==='number'&&path[3]==='scoreboard'&&['radiant','dire'].includes(path[4]);
    if(allowed)duplicateUnconsumedFields.push({gameIndex:path[2],side:path[4],key});return allowed;
  }});}catch{return {...base,status:'invalid_json',reason:'bounded_json_decode_failed'};}
  base.duplicateUnconsumedFields=duplicateUnconsumedFields;
  if(input.endpoint==='GetRealtimeStats/v1')return {...base,schemaEvidence:{status:'UNCONFIRMED',measuredAuthenticatedSchema:false,evidenceSha256:null},status:'schema_UNCONFIRMED',reason:'realtime_http_json_mapping_unmeasured'};
  if(record(body)&&record(body.result)&&own(body.result,'status')&&body.result.status!==200)return {...base,status:'provider_error',reason:'provider_result_status_not_200'};
  if(!record(body)||!record(body.result)||!Array.isArray(body.result.games))return {...base,status:'schema_UNCONFIRMED',reason:'result_games_shape_unmeasured'};
  if(body.result.games.length>MAX_GAMES)throw Error('response_game_count_bound');
  const counts=new Map();for(const game of body.result.games){try{const id=decimalId(game?.match_id);counts.set(id,(counts.get(id)??0)+1);}catch{}}
  for(let i=0;i<body.result.games.length;i++){
    try{
      const game=body.result.games[i];if(counts.get(decimalId(game?.match_id))>1)throw Error('duplicate_match_in_capture');
      const observation=normalizeGame(game,i,capture,input.expected);
      const duplicates=duplicateUnconsumedFields.filter(d=>d.gameIndex===i);
      if(duplicates.length){observation.sourceQualityReasons.push('duplicate_unconsumed_abilities_in_provider_json');observation.duplicateUnconsumedFields=duplicates;}
      base.observations.push(observation);
    }catch(error){base.rejections.push({index:i,reason:error instanceof Error?error.message:'invalid_game'});}
  }
  return {...base,status:body.result.games.length===0?'empty_games_diagnostic':'normalized_capture_diagnostic'};
}

/** Shared local worker callback; host persists original body before calling.
 * appendSource receives a separate source schema; no application route here.
 */
export function consumeLocalCapture(localCaptureCallback,appendSource){
  const result=normalizeLocalCapture(localCaptureCallback());
  for(const observation of result.observations)appendSource(observation);
  return result;
}

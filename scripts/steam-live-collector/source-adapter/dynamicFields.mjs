/** Additive, loss-aware GLG fields. This is source evidence, not serving approval. */
export const DYNAMIC_CONTRACT='steam-glg-dynamic-observation.v1';
export const PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const number=x=>x&&typeof x==='object'&&typeof x.value==='number'?x.value:x;
export function field(raw,key,path,capture,units,valid=finite){
 const base={sourceField:path+'.'+key,sourceProfile:PROFILE,knownAt:capture.receivedAt,units};
 if(!own(raw,key))return {...base,value:null,rawValue:null,missing:true,status:'absent'};
 const v=number(raw[key]),ok=valid(v);
 return {...base,value:ok?v:null,rawValue:typeof v==='number'||typeof v==='boolean'||v===null?v:null,missing:!ok,status:ok?'observed':v===null?'source_null':'invalid'};
}
export function dynamicPlayer(raw,path,capture){
 const nn=x=>finite(x)&&x>=0,int=x=>nn(x)&&Number.isSafeInteger(x);
 return {
  kills:field(raw,'kills',path,capture,'kills',int),deaths:field(raw,'death',path,capture,'deaths',int),assists:field(raw,'assists',path,capture,'assists',int),
  lastHits:field(raw,'last_hits',path,capture,'last_hits',int),denies:field(raw,'denies',path,capture,'denies',int),
  positionX:field(raw,'position_x',path,capture,'provider_coordinate_unverified'),positionY:field(raw,'position_y',path,capture,'provider_coordinate_unverified'),
  respawnTimer:field(raw,'respawn_timer',path,capture,'provider_timer_seconds_candidate',nn),
  ultimateState:field(raw,'ultimate_state',path,capture,'opaque_provider_enum',int),ultimateCooldown:field(raw,'ultimate_cooldown',path,capture,'provider_timer_seconds_candidate',nn),
  hasBuyback:field(raw,'has_buyback',path,capture,'provider_boolean',x=>typeof x==='boolean'),
  buybackCooldown:field(raw,'buyback_cooldown',path,capture,'provider_timer_seconds_candidate',nn),
  alive:null,positionSemantics:'unverified coordinate system',zeroTimerMeansAlive:false,
 };
}
export function dynamicGame(raw,scoreboard,index,capture){
 const p=`result.games[${index}]`,board=scoreboard??{},nn=x=>finite(x)&&x>=0;
 const phase=field(raw,'game_state',p,capture,'DOTA_GameState',x=>Number.isSafeInteger(x)&&x>=0&&x<=13);
 const names={2:'HERO_SELECTION',3:'STRATEGY_TIME',4:'PRE_GAME',5:'GAME_IN_PROGRESS',6:'POST_GAME'};
 const timer=field(board,'roshan_respawn_timer',p+'.scoreboard',capture,'provider_timer_seconds_candidate',nn);
 return {contract:DYNAMIC_CONTRACT,sourceProfile:PROFILE,knownAt:capture.receivedAt,phase:{...phase,name:names[phase.value]??null,clockDoesNotProvePhase:true},
  roshan:{respawnTimer:timer,alive:null,deathGameTimeSeconds:null,respawnAtGameTimeSeconds:null,zeroMeaning:'unknown',
   semantics:'literal provider timer; decreasing examples exist; exact event target and zero semantics not established'},
  patch:{value:null,source:null,knownAt:null},eventEvidence:[],
  evidence:{catalog:'steam-api-catalog-20261023-r1',corpusScoreboardsWithTimer:8251,positiveTimerRecords:1281,
   timelyCoverageProven:false,rawSha256:capture.rawSha256,originalPayloadRef:capture.originalPayloadRef},
  eligibleForServing:false,eligibleForTraining:false};
}
export function draftFields(raw,path,capture){
 const out={};
 for(const key of ['picks','bans']){
  if(!own(raw,key)){out[key]={value:null,missing:true,status:'absent',sourceField:path+'.'+key,knownAt:capture.receivedAt};continue;}
  if(!Array.isArray(raw[key])||raw[key].length>100){out[key]={value:null,missing:true,status:'invalid',sourceField:path+'.'+key,knownAt:capture.receivedAt};continue;}
  out[key]={value:raw[key].map((x,i)=>field(x??{},'hero_id',`${path}.${key}[${i}]`,capture,'hero_id',v=>Number.isSafeInteger(v)&&v>0)),missing:false,status:'observed',sourceField:path+'.'+key,knownAt:capture.receivedAt};
 }
 return out;
}

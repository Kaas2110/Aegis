/** Durable source for recomputing the existing collector freshness policy.
 * Not provider event-time verification. No model feature or source-input rewrite.
 */
export const LIVE_STATE_SOURCE_CONTRACT='collector-live-state-source.v1';
export const LIVE_STATE_SOURCE_MAX_BYTES=65536;
const packetKeys=['match_id','team_id_radiant','team_id_dire','league_id','game_time','radiant_score','dire_score',
 'radiant_lead','building_state','delay','last_update_time','activate_time','deactivate_time'];
const playerKeys=['hero_id','account_id','team','team_slot'];
const stateKeys=['version','stateHash','firstReceivedAt','lastStateChangeReceivedAt','lastReceivedAt',
 'hasObservedProgress','highGameClock','highRadiantScore','highDireScore','lastKnownRadiantLead',
 'lastKnownBuildingState','hasConfirmedCompleteDraft','lastChangeBasis','regressed'];
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function scalar(v:unknown):unknown {
 if(v===undefined)return undefined;
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='string'&&v.length<=128)return v;
 if(typeof v==='number'&&Number.isFinite(v))return v;
 throw Error('live_state_source_scalar_invalid');
}
function pick(raw:Record<string,unknown>,keys:string[]):Record<string,unknown>{
 const result:Record<string,unknown>={};for(const k of keys){const v=scalar(raw[k]);if(v!==undefined)result[k]=v;}return result;
}
export function captureLiveStateSource(packet:Record<string,unknown>){
 const raw=pick(packet,packetKeys);
 if(Array.isArray(packet.players)){
  if(packet.players.length>10)throw Error('live_state_source_players_bound');
  raw.players=packet.players.map(p=>{if(!record(p))throw Error('live_state_source_player_invalid');return pick(p,playerKeys);});
 }else if(packet.players!==undefined&&packet.players!==null)throw Error('live_state_source_players_invalid');
 if(record(packet.__aegis_live_state))raw.__aegis_live_state=pick(packet.__aegis_live_state,stateKeys);
 else if(packet.__aegis_live_state!==undefined&&packet.__aegis_live_state!==null)throw Error('live_state_source_state_invalid');
 const source={contract:LIVE_STATE_SOURCE_CONTRACT,rawPacket:raw};
 const encoded=JSON.stringify(source);
 if(Buffer.byteLength(encoded)>LIVE_STATE_SOURCE_MAX_BYTES)throw Error('live_state_source_bytes_bound');
 return JSON.parse(encoded) as {contract:string;rawPacket:Record<string,unknown>};
}

import {safeOpenDotaId} from './openDotaLiveIds';

/** Structural admission, not a freshness/draft-completeness or model-quality claim.
 * Missing/unrevealed values keep their old meaning. Never repair/filter a roster.
 */
export type LivePacketShapeIssue = 'live_packet_not_object' | 'live_packet_numeric_field_invalid'
  | 'live_packet_players_not_array' | 'live_packet_players_bound' | 'live_packet_player_not_object'
  | 'live_packet_player_field_invalid';
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const missing=(v:unknown)=>v===undefined||v===null;
const integer=(v:unknown,min:number,max=2147483647)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
export function livePacketShapeIssue(raw:unknown):LivePacketShapeIssue|null {
  if(!record(raw))return 'live_packet_not_object';
  // These values enter the shared PostgreSQL snapshot insert or model calls.
  for(const key of ['game_time','radiant_score','dire_score','radiant_lead','building_state']){
    const v=raw[key];if(missing(v))continue;
    if(!integer(v,key==='game_time'||key==='radiant_lead'?-2147483648:0))return 'live_packet_numeric_field_invalid';
  }
  const players=raw.players;if(missing(players))return null;
  if(!Array.isArray(players))return 'live_packet_players_not_array';
  if(players.length>10)return 'live_packet_players_bound';
  for(const p of players){
    if(!record(p))return 'live_packet_player_not_object';
    if(!missing(p.hero_id)&&!integer(p.hero_id,0))return 'live_packet_player_field_invalid';
    if(!missing(p.team_slot)&&!integer(p.team_slot,0))return 'live_packet_player_field_invalid';
    if(!missing(p.team)&&p.team!==0&&p.team!==1)return 'live_packet_player_field_invalid';
    if(!missing(p.account_id)&&p.account_id!==0&&p.account_id!=='0'&&!safeOpenDotaId(p.account_id))
      return 'live_packet_player_field_invalid';
  }
  return null;
}

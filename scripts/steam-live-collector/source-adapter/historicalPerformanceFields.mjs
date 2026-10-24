/** Optional native final statistics of PRIOR completed maps only. No live values,
 * role inference, learned state or substitution of earned gold/net worth/GPM. */
import {instantNs} from './causalTime.mjs';
export const PERFORMANCE_CONTRACT='aegis.prior-player-native-performance.v1';
export const PERFORMANCE_FIELDS=Object.freeze({gpm:'gold_per_min',xpm:'xp_per_min',kills:'kills',deaths:'deaths',assists:'assists',lastHits:'last_hits',denies:'denies',heroDamage:'hero_damage',towerDamage:'tower_damage',heroHealing:'hero_healing',level:'level',netWorth:'net_worth',goldSpent:'gold_spent',totalGold:'total_gold',totalXp:'total_xp',observerWardsPlaced:'obs_placed',sentryWardsPlaced:'sen_placed',observerWardsKilled:'observer_kills',sentryWardsKilled:'sentry_kills'});
const IDENTIFIERS="'account_id',j.player->'account_id','hero_id',j.player->'hero_id','player_slot',j.player->'player_slot'";
const id=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x);
const fail=x=>{throw Error('prior_performance:'+x);};
export function performanceSelectionSql(baseSql){
 if(typeof baseSql!=='string'||baseSql.split(IDENTIFIERS).length!==2)fail('sql_base_revision');
 const fields=Object.values(PERFORMANCE_FIELDS).map(field=>"'"+field+"',j.player->'"+field+"'").join(',');
 return baseSql.replace(IDENTIFIERS,IDENTIFIERS+",'historical_performance',jsonb_build_object("+fields+")");
}
export function attachPriorPlayerPerformance(maps,sourceRows,{historyCutoffAt,currentMapId}={}){
 const cutoff=instantNs(historyCutoffAt);
 if(cutoff===null||!id(currentMapId)||!Array.isArray(maps)||!Array.isArray(sourceRows)||maps.length!==sourceRows.length||maps.length>50000)fail('input_contract');
 const byId=new Map(sourceRows.map(r=>[r?.matchId,r]));if(byId.size!==sourceRows.length||new Set(maps.map(m=>m.matchId)).size!==maps.length)fail('duplicate_map');
 return maps.map(m=>{
  const row=byId.get(m.matchId),known=instantNs(m.playersKnownAt),outcome=instantNs(m.outcomeKnownAt);
  if(!row||m.matchId===currentMapId||known===null||outcome===null||known<outcome||known>cutoff||!Array.isArray(row.players)||row.players.length>10)fail('map_availability_or_identity');
  const seenHeroes=new Set(),seenAccounts=new Set(),seenSlots=new Set(),sideCounts={radiant:0,dire:0},heroPerformances=[];
  for(const p of row.players){
   const slot=p?.player_slot,side=Number.isInteger(slot)&&slot>=0&&slot<=4?'radiant':Number.isInteger(slot)&&slot>=128&&slot<=132?'dire':null;
   const heroId=typeof p?.hero_id==='number'?p.hero_id:typeof p?.hero_id==='string'&&/^[1-9]\d*$/.test(p.hero_id)?Number(p.hero_id):null;
   if(!side||!Number.isSafeInteger(heroId)||heroId<1||heroId>250)continue;
   const a=String(p.account_id??''),accountId=id(a)&&BigInt(a)<4294967295n?a:null;
   if(seenSlots.has(slot)||seenHeroes.has(heroId)||accountId!==null&&seenAccounts.has(accountId)||++sideCounts[side]>5)fail('roster_conflict');
   if(!m.heroes.some(h=>Number(h.heroId)===heroId&&h.side===side))fail('hero_side_conflict');
   const known=(m.players??[]).find(p=>Number(p.heroId)===heroId||p.accountId===accountId&&accountId!==null);
   if(known&&(known.accountId!==accountId||Number(known.heroId)!==heroId||known.side!==side))fail('known_player_conflict');
   seenSlots.add(slot);seenHeroes.add(heroId);if(accountId!==null)seenAccounts.add(accountId);
   const source=p.historical_performance;
   if(source===undefined)fail('selected_namespace_missing');
   if(source===null||typeof source!=='object'||Array.isArray(source))fail('metric_namespace');
   const metrics={},invalidFields=[];
   for(const [name,field] of Object.entries(PERFORMANCE_FIELDS)){
    const value=source[field],valid=typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER;
    metrics[name]=valid?value:null;
    if(value!==null&&value!==undefined&&!valid)invalidFields.push(field);
   }
   heroPerformances.push({contract:PERFORMANCE_CONTRACT,accountId,heroId,side,knownAt:m.playersKnownAt,metrics,invalidFields,
    sourceProfile:'opendota.completed-map.parsed-player',sourceFields:PERFORMANCE_FIELDS,availabilityBasis:'database_timestamp_reconstruction'});
  }
  return{...m,heroPerformances};
 });
}

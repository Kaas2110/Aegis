/** Local diagnostic reader. Receipt time, not later ingest time, selects a prefix. */
import {instantNs} from './causalTime.mjs';
import {advanceSteamFeatureBundle} from './steamFeatureBundle.mjs';
export async function loadSteamFeatureBundlePrefix(db,{matchId,sourceProfile,asOf,limit=4096,featureOptions={}}){
 const cutoff=instantNs(asOf);
 if(typeof db?.query!=='function'||typeof matchId!=='string'||!/^[1-9]\d{0,19}$/.test(matchId)||sourceProfile!=='steam.GetLiveLeagueGames.v1.scoreboard'||cutoff===null||!Number.isInteger(limit)||limit<1||limit>10000)throw Error('steam_feature_reader_contract');
 const result=await db.query('SELECT normalized_observation FROM steam_dynamic_diagnostic_v1 WHERE match_id=$1 AND source_profile=$2 AND known_at<=$3 ORDER BY known_at,observation_id LIMIT $4',[matchId,sourceProfile,asOf,limit+1]);
 if(!Array.isArray(result?.rows)||result.rows.length>limit)throw Error('steam_feature_prefix_bound');
 // timestamptz is microsecond precision. The original JSON time remains decisive
 // for the exact nanosecond cutoff; never silently accept a rounded future row.
 const rows=result.rows.map(row=>{
  const o=typeof row.normalized_observation==='string'?JSON.parse(row.normalized_observation):row.normalized_observation;
  const time=instantNs(o?.source?.capture?.receivedAt);
  if(o?.matchId!==matchId||o.dynamic?.sourceProfile!==sourceProfile||time===null||time>cutoff)throw Error('steam_feature_reader_identity_or_future');
  return {o,time};
 }).sort((a,b)=>a.time<b.time?-1:a.time>b.time?1:String(a.o.observationId).localeCompare(String(b.o.observationId)));
 let state=null,frame=null;
 for(const {o} of rows){frame=advanceSteamFeatureBundle(state,o,featureOptions);state=frame.state;}
 return {status:frame?'diagnostic_features_ready':'no_observations',observations:rows.length,frame,eligibleForServing:false,eligibleForTraining:false,publicPromotion:false};
}

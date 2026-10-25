/** Shared declaration algebra. Templates are source-code contracts, not source
 * receipts. Every policy is supplied explicitly by its actual numeric emitter. */
import {types} from 'node:util';
const text=x=>typeof x==='string'&&x.trim().length>0;
// A weak certification cache retains no graph by itself. Only recursively
// inspected immutable plain data can cross calls by reference. Mutable input
// is copied once per binding, preserving DAG sharing within that snapshot.
const immutableData=new WeakSet();
function snapshot(value,memo=new Map(),active=new Set()){
 if(value===null||typeof value!=='object')return value;if(types.isProxy(value))throw Error('feature_semantics:plain_data_required');
 if(immutableData.has(value))return value;if(active.has(value))throw Error('feature_semantics:cyclic_data');if(memo.has(value))return memo.get(value);
 if(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)throw Error('feature_semantics:plain_data_required');
 active.add(value);const out=Array.isArray(value)?[]:{},keys=Array.isArray(value)?Array.from({length:value.length},(_,i)=>String(i)):Object.keys(value);let canBorrow=Object.isFrozen(value);
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d))throw Error('feature_semantics:data_property_required');const next=snapshot(d.value,memo,active);out[key]=next;if(next!==d.value)canBorrow=false;}
 active.delete(value);const result=canBorrow?value:Object.freeze(out);immutableData.add(result);memo.set(value,result);return result;
}
export {snapshot as snapshotFeatureSemanticData};
export const SEMANTIC_POLICY_FIELDS=Object.freeze(['supportUnit','supportPolicy','populationPolicy','eventTimePolicy','availabilityTimePolicy','gameClockPolicy','rolePolicy','patchPolicy','phasePolicy','missingReasonPolicy','windowPolicy','weightPolicy','tiePolicy','variancePolicy','quantilePolicy','coordinate','orientation']);
export function defineFeatureSemanticTemplate({templateId,policies,parameters={}}={}){
 if(!text(templateId)||!policies||SEMANTIC_POLICY_FIELDS.some(k=>!text(policies[k]))||!parameters||Object.getPrototypeOf(parameters)!==Object.prototype)throw Error('feature_semantics:explicit_template_policies_required');
 return snapshot({templateId,policies,parameters});
}
/** All input operands must be bound by the caller's SAME metric/formula branch.
 * No name-derived unit, support, source availability or role is invented here. */
export function bindFeatureSemanticTemplate(template,{inputBindings,formulaParameters={},minimumSupport=null,historyWindowDays=null,semanticVerification='authoritative_template'}={}){
 if(!template||!text(template.templateId)||!Array.isArray(inputBindings)||!inputBindings.length||inputBindings.some(x=>!x||['normalizedField','rawField','sourceProfile','sourceKind','units','availabilityPolicy'].some(k=>!text(x[k]))))throw Error('feature_semantics:exact_input_bindings_required');
 for(const [key,value]of Object.entries({minimumSupport,historyWindowDays}))if(value!==null&&!(typeof value==='number'&&Number.isFinite(value)&&value>=0))throw Error('feature_semantics:'+key);
 if(!['authoritative_template','parameter_binding_required','unverified_legacy_semantics','unverified_native_semantics'].includes(semanticVerification))throw Error('feature_semantics:verification');
 return snapshot({...template.policies,inputBindings,formulaParameters:{templateId:template.templateId,...template.parameters,...formulaParameters},minimumSupport,historyWindowDays,learnedStateBinding:null,semanticVerification});
}
export const STEAM_SCOREBOARD_PROFILE='steam.GetLiveLeagueGames.v1.scoreboard';
const sourceFields={netWorth:['net_worth','gold'],goldPerMinute:['gold_per_min','gold_per_minute'],experiencePerMinute:['xp_per_min','experience_per_minute'],level:['level','level'],heroId:['hero_id','nominal_hero_id'],accountId:['account_id','nominal_account_id'],teamId:['team_id','nominal_team_id']};
/** Literal binding dictionary. Does not claim that an observed endpoint value
 * is timely, complete, cross-provider equivalent or in a qualified population. */
export function steamPlayerInputBinding(normalizedField,metric){
 const f=sourceFields[metric];if(!f)throw Error('feature_semantics:unknown_native_field');
 return{normalizedField,rawField:metric==='teamId'?'result.games[*].{radiant_team,dire_team}.team_id':`result.games[*].scoreboard.{radiant,dire}.players[*].${f[0]}`,sourceProfile:STEAM_SCOREBOARD_PROFILE,sourceKind:'coherent_current_steam_capture',units:f[1],availabilityPolicy:'exact bound capture source.capture.receivedAt <= decisionAt; no source-event latency inferred'};
}
export const steamClockInputBinding=()=>({normalizedField:'providerGameClockSeconds.value',rawField:'result.games[*].scoreboard.duration',sourceProfile:STEAM_SCOREBOARD_PROFILE,sourceKind:'coherent_current_steam_capture',units:'seconds',availabilityPolicy:'same admitted capture receipt <= decisionAt; clock progression separately qualified'});

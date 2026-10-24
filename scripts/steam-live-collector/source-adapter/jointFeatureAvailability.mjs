/** Profile-specific joint input audit. Retained completeness is not event-lag
 * proof, a scheduled denominator or prospective model admission. */
import {instantNs} from './causalTime.mjs';
export function auditJointFeatureAvailability({expectedSlots,observations,requiredFeatures,profile,windowStart,windowEnd,maxReceiptAgeSeconds=180,minimumFraction=.95}={}){
 if(!Array.isArray(expectedSlots)||expectedSlots.length<1||expectedSlots.length>100000||!Array.isArray(observations)||observations.length>100000||!Array.isArray(requiredFeatures)||!requiredFeatures.length||requiredFeatures.length>150000||new Set(requiredFeatures).size!==requiredFeatures.length||requiredFeatures.some(n=>typeof n!=='string'||!n.length)||typeof profile!=='string'||!profile.length||instantNs(windowStart)===null||instantNs(windowEnd)===null||instantNs(windowStart)>instantNs(windowEnd)||!Number.isFinite(maxReceiptAgeSeconds)||maxReceiptAgeSeconds<=0||maxReceiptAgeSeconds>3600||!Number.isFinite(minimumFraction)||minimumFraction<=0||minimumFraction>1)throw Error('joint_availability:configuration');
 const key=s=>JSON.stringify([s.matchId,s.slotId]),slots=new Map(),rows=new Map();
 for(const s of expectedSlots){if(typeof s?.matchId!=='string'||typeof s.slotId!=='string'||instantNs(s.decisionAt)===null||instantNs(s.decisionAt)<instantNs(windowStart)||instantNs(s.decisionAt)>instantNs(windowEnd)||slots.has(key(s)))throw Error('joint_availability:slot_identity');slots.set(key(s),s);}
 for(const o of observations){if(!slots.has(key(o))||rows.has(key(o)))throw Error('joint_availability:duplicate_or_unexpected_observation');rows.set(key(o),o);}
 let joint=0;const rejected={},fieldObserved=Object.fromEntries(requiredFeatures.map(n=>[n,0]));
 for(const[k,s]of slots){const o=rows.get(k);let reason=null;
  if(!o)reason='missing_expected_slot';
  else if(o.profile!==profile)reason='source_profile_mismatch';
  else if(instantNs(o.receivedAt)===null||instantNs(o.receivedAt)>instantNs(s.decisionAt)||instantNs(s.decisionAt)-instantNs(o.receivedAt)>BigInt(Math.floor(maxReceiptAgeSeconds*1e9)))reason='receipt_age_or_future';
  else if(!o.features||typeof o.features!=='object')reason='missing_feature_row';
  else{let complete=true;for(const n of requiredFeatures){const v=o.features[n];if(typeof v==='number'&&Number.isFinite(v))fieldObserved[n]++;else complete=false;}if(complete)joint++;else reason='joint_required_fields_missing';}
  if(reason)rejected[reason]=(rejected[reason]??0)+1;
 }
 const fraction=joint/slots.size;
 return{contract:'aegis.joint-feature-availability-audit.v1',profile,windowStart,windowEnd,expectedSlots:slots.size,receivedSlots:rows.size,jointCompleteTimelySlots:joint,jointFraction:fraction,minimumFraction,meetsRetainedAuditThreshold:fraction>=minimumFraction,fieldObserved,rejected,denominatorBasis:'explicit_owned_expected_slots_not_inferred_from_successes',absoluteEventLagMeasured:false,prospectiveAvailabilityProven:false,eligibleForServing:false,eligibleForTraining:false};
}

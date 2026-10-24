/** Explicit catalogue correction for historical subsets available before draft.
 * Family eligibility is a union, never proof that each member is phase-safe.
 * The unchanged executable definition/projection checks still reject current
 * draft/live/label inputs in PRE. No IO, feature selection or runtime activation.
 */
import {FAMILY_IDS,TARGET_IDS} from './registry-contract.mjs';
export const HISTORICAL_TARGET_ELIGIBILITY_POLICY=Object.freeze({
 contract:'aegis.historical-target-eligibility-policy.v1',version:'2026-10-24',
 familyIds:Object.freeze(['H10','H11','H12','H14','P01','P05']),
 addedTargets:Object.freeze(['PRE_MAP_WIN','PRE_KILLS','PRE_DURATION','SERIES_PRE']),
 guard:'Individual definitions still require phase-available scopes; current_draft/current_live/current_map_label remain prohibited in PRE.'
});
const fail=x=>{throw Error('historical_target_eligibility:'+x);};
const unique=a=>Array.isArray(a)&&a.every(x=>typeof x==='string')&&new Set(a).size===a.length;
export function applyHistoricalTargetEligibility({familyDocument,targetDocument}={}){
 const families=familyDocument?.families,targets=targetDocument?.targets;
 if(familyDocument?.contract!=='aegis.unified-feature-families.v1'||targetDocument?.contract!=='aegis.twelve-logical-targets.v1'||!Array.isArray(families)||!Array.isArray(targets)||!unique(families.map(f=>f.id))||families.length!==FAMILY_IDS.length||families.some(f=>!FAMILY_IDS.includes(f.id))||!unique(targets.map(t=>t.id))||targets.length!==TARGET_IDS.length||targets.some(t=>!TARGET_IDS.includes(t.id)))fail('catalogue_identity');
 for(const f of families)if(!unique(f.eligibleTargets)||f.eligibleTargets.some(t=>!TARGET_IDS.includes(t)))fail('family_targets');
 for(const t of targets){
  const expected=families.filter(f=>f.eligibleTargets.includes(t.id)).map(f=>f.id);
  if(!unique(t.eligibleFamilyIds)||t.eligibleFamilyIds.length!==expected.length||t.eligibleFamilyIds.some(f=>!expected.includes(f)))fail('input_target_family_mismatch');
 }
 const out=structuredClone({familyDocument,targetDocument});
 for(const f of out.familyDocument.families){
  if(HISTORICAL_TARGET_ELIGIBILITY_POLICY.familyIds.includes(f.id)){
   if(['label_only','presentation_context'].includes(f.kind))fail('unsafe_family_kind');
   f.eligibleTargets=TARGET_IDS.filter(t=>f.eligibleTargets.includes(t)||HISTORICAL_TARGET_ELIGIBILITY_POLICY.addedTargets.includes(t));
  }
  f.eligiblePhases=[...new Set(f.eligibleTargets.map(id=>out.targetDocument.targets.find(t=>t.id===id).phase))];
 }
 for(const t of out.targetDocument.targets)t.eligibleFamilyIds=out.familyDocument.families.filter(f=>f.eligibleTargets.includes(t.id)).map(f=>f.id);
 out.familyDocument.targetEligibilityPolicy=structuredClone(HISTORICAL_TARGET_ELIGIBILITY_POLICY);
 out.targetDocument.targetEligibilityPolicy=structuredClone(HISTORICAL_TARGET_ELIGIBILITY_POLICY);
 return out;
}

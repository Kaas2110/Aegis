// Synthetic structural fixtures only. These do not describe actual feature
// formulas, source coverage, current corpus membership or predictive quality.
import {CATALOGUE_IDS,FAMILY_IDS,TARGET_IDS} from './registry-contract.mjs';
const H='a'.repeat(64),LIVE=['LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'];
export function syntheticRegistry() {
 const targets=TARGET_IDS.map(id=>({id,phase:id.startsWith('SERIES_')?id:id.split('_')[0],target:id.startsWith('SERIES_')?'series_team1_win':id.endsWith('_WIN')?'map_radiant_win':id.endsWith('_KILLS')?(id.startsWith('LIVE_')?'remaining_kills_distribution':'map_total_kills_distribution'):(id.startsWith('LIVE_')?'remaining_duration_seconds_distribution':'map_total_duration_seconds_distribution'),stateModes:id==='SERIES_LIVE'?['observed_postdraft','observed_live']:[id.startsWith('SERIES_')?id:id.split('_')[0]]}));
 const families=FAMILY_IDS.map(id=>{
  let kind='history',eligibleTargets=[...TARGET_IDS];
  if(id==='O04'){kind='label_only';eligibleTargets=[];}
  else if(id==='T04'){kind='presentation_context';eligibleTargets=TARGET_IDS.filter(x=>/_(KILLS|DURATION)$/.test(x));}
  else if(id==='T03'){kind='model_axis';eligibleTargets=TARGET_IDS.filter(x=>/_(KILLS|DURATION)$/.test(x));}
  else if(id==='Q02'){kind='series_history';eligibleTargets=['SERIES_BETWEEN','SERIES_LIVE'];}
  else if(id.startsWith('L')||id.startsWith('R')){kind='dynamic';eligibleTargets=LIVE;}
  else if(id.startsWith('D')){kind='draft';eligibleTargets=TARGET_IDS.filter(x=>x.startsWith('POST_')||LIVE.includes(x));}
  return {id,kind,formula:'synthetic_formula',units:'synthetic_units',status:'synthetic_test_only',missingPolicy:'null_and_mask',availabilityGate:'synthetic_gate',eligibleTargets,eligiblePhases:[...new Set(eligibleTargets.map(x=>targets.find(t=>t.id===x).phase))]};
 });
 for(const t of targets)t.eligibleFamilyIds=families.filter(f=>f.eligibleTargets.includes(t.id)).map(f=>f.id);
 const catalogues=CATALOGUE_IDS.map(id=>({id,count:1,namesPin:{path:id+'.synthetic.json',sha256:H,bytes:1},orderedNameHash:H,source:{path:'synthetic.js',bytes:1,sha256:H}}));
 return [{contract:'aegis.unified-feature-catalogue-index.v1',catalogues,featureFamilyCount:79,logicalTargets:12,totalCatalogues:14,catalogueOccurrenceCount:14},{contract:'aegis.unified-feature-families.v1',families},{contract:'aegis.twelve-logical-targets.v1',targets}];
}

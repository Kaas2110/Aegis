/** Explicit selected-hero identity axes from an owned, raw-backed history proof.
 * Hero indices are nominal dictionary coordinates, never ordinal hero strength.
 * The existing adapter supports slots1..250; this is not a current hero catalogue.
 */
import {readDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {HERO_IDS,evidenceHash} from './playerHeroEconomyFeatures.mjs';
export const DRAFT_IDENTITY_CONTRACT='aegis.confirmed-draft-identity-features.v1';
const TARGETS=['POST_MAP_WIN','POST_KILLS','POST_DURATION','LIVE_MAP_WIN','LIVE_KILLS','LIVE_DURATION','SERIES_LIVE'];
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const dictionary=freeze({contract:'aegis.adapter-nominal-hero-coordinate.v1',heroIds:[...HERO_IDS],basis:'existing_adapter_supported_identity_range_not_current_roster_or_power_order'});
export const DRAFT_HERO_DICTIONARY_SHA256=evidenceHash(dictionary);
export function produceDraftIdentityFeatures({historyProof,matchId,decisionAt}={}){
 const h=readDynamicHistoryProof(historyProof,{matchId,decisionAt});
 if(!h.accepted)throw Error('draft_identity:'+h.reason);
 const d=h.context.draftState,players=d.identity.players;
 if(players.length!==10||new Set(players.map(p=>Number(p.heroId))).size!==10||players.some(p=>!HERO_IDS.includes(Number(p.heroId))))throw Error('draft_identity:complete_supported_draft_required');
 const names=[],values=[],masks=[],definitions=[],byHero=new Map(players.map(p=>[Number(p.heroId),p]));
 const add=(name,value,formula,units='boolean')=>{names.push(name);values.push(value);masks.push(0);definitions.push({name,familyId:'D01',formula,formulaVersion:DRAFT_IDENTITY_CONTRACT,units,dtype:'float64',missingPolicy:'complete observed draft: known unpicked hero is structural zero; no prediction from partial draft',inputScopes:['current_draft'],allowedTargets:TARGETS,dictionarySha256:DRAFT_HERO_DICTIONARY_SHA256});};
 for(const hero of HERO_IDS){const p=byHero.get(hero),prefix='draft_identity.hero.'+hero+'.';
  add(prefix+'radiant_picked',Number(p?.side==='radiant'),'one if the confirmed selected hero belongs to Radiant, otherwise zero');
  add(prefix+'dire_picked',Number(p?.side==='dire'),'one if the confirmed selected hero belongs to Dire, otherwise zero');
  add(prefix+'picked',Number(p!==undefined),'one if the hero is in the confirmed ten-hero draft, otherwise zero');
  add(prefix+'side_sign',p?(p.side==='radiant'?1:-1):0,'Radiant selected +1, Dire selected -1, known unpicked0','side_sign');
  add(prefix+'selected_account_known',Number(p!==undefined&&p.accountId!==null),'one if selected and account ID was disclosed in this identity revision');
  add(prefix+'selected_team_known',Number(p!==undefined&&p.teamId!==null),'one if selected and team ID was disclosed in this identity revision');
 }
 const schemaHash=evidenceHash({contract:DRAFT_IDENTITY_CONTRACT,dictionary,definitions});
 return freeze({contract:DRAFT_IDENTITY_CONTRACT,status:'diagnostic_produced',matchId,knownAt:h.context.validFrom,historyCutoffAt:h.context.historyCutoffAt,historyContextHash:h.context.contentHash,draftHash:d.identity.draftHash,rosterHash:d.identity.rosterHash,identityRevision:d.revision,dictionarySha256:DRAFT_HERO_DICTIONARY_SHA256,schemaHash,names,values,masks,definitions,contentHash:evidenceHash({schemaHash,values,historyContextHash:h.context.contentHash}),sourceAuthenticity:'owned_history_proof_from_retained_raw_not_provider_signature',eligibleForTraining:false,eligibleForServing:false,recordedPrediction:false});
}

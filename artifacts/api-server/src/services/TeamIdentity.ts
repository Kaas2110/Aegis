import type { MatchInput } from './AnalyticsEngine';
import { normalizeTeamName, sameTeamIdentity } from './BookmakerMatcher';
import { positiveId } from './PredictionContract';

export type TeamCatalogueRow = {teamId:number;name:string|null;tag:string|null;rating:number|null};
/** Names and positive OD IDs recorded together in trusted, completed pro_matches. */
export type TeamHistoryIdentityRow = {teamId:number;name:string;lastSeenAt:number;matches:number};
export type TeamIdentityEvidence = {
  status:'resolved'|'unresolved';
  method:'provider_id'|'catalogue_exact_name'|'history_exact_name'|'catalogue_alias'|null;
  reason:'resolved'|'name_missing'|'name_ambiguous'|'name_not_found'|'identity_source_unavailable'|'invalid_provider_id'|'same_team_on_both_sides';
  sourceProvider:'opendota'|'pandascore'|null;
  sourceTeamId:number|null;
  resolvedTeamId:number|null;
  candidateTeamIds:number[];
  cataloguePresent:boolean;
  ratingAvailable:boolean;
  historyMatches:number;
  historyLastSeenAt:number|null;
  // Name equivalence is evidence, not an externally verified cross-provider ID link.
  crossProviderVerified:false;
};
type ResolvedTeam = MatchInput['team1'] & {identity:TeamIdentityEvidence};
const UNKNOWN_NAMES=new Set(['','unknown','tbd','tba','tobeannounced','tobedetermined']);

/** Exact names are checked across BOTH sources before any catalogue alias fallback.
 * A stale catalogue entry cannot silently defeat a conflicting history ID.
 */
export function resolveTeamFromRows(team:MatchInput['team1'],rows:readonly TeamCatalogueRow[],
  history:readonly TeamHistoryIdentityRow[]=[],sourcesAvailable=true):ResolvedTeam {
  const name=normalizeTeamName(team.name||'');
  const originalId=positiveId(team.teamId);
  const catalogue=rows.filter(r=>positiveId(r.teamId)!==null);
  const historical=history.filter(r=>positiveId(r.teamId)!==null && r.matches>0 && Number.isFinite(r.lastSeenAt));
  const evidence:TeamIdentityEvidence={status:'unresolved',method:null,reason:'name_not_found',
    sourceProvider:team.provider??null,sourceTeamId:originalId,resolvedTeamId:null,candidateTeamIds:[],
    cataloguePresent:false,ratingAvailable:false,historyMatches:0,historyLastSeenAt:null,crossProviderVerified:false};
  const finish=(id:number|null,method:TeamIdentityEvidence['method'],reason:TeamIdentityEvidence['reason']):ResolvedTeam=>{
    const row=id===null?undefined:catalogue.find(r=>r.teamId===id);
    const prior=id===null?[]:historical.filter(r=>r.teamId===id && normalizeTeamName(r.name)===name);
    const rating=row?.rating;
    const ratingAvailable=typeof rating==='number'&&Number.isFinite(rating);
    return {...team,name:row?.name??team.name,teamId:id??undefined,provider:id===null?team.provider:'opendota',
      elo:ratingAvailable?rating:undefined,identity:{...evidence,status:id===null?'unresolved':'resolved',method,reason,
        resolvedTeamId:id,cataloguePresent:!!row,ratingAvailable,
        historyMatches:prior.reduce((s,r)=>s+r.matches,0),
        historyLastSeenAt:prior.length?Math.max(...prior.map(r=>r.lastSeenAt)):null}};
  };
  // Explicit OD identity is authoritative; PS numeric IDs never enter this branch.
  if(team.provider==='opendota' && team.teamId!=null) {
    if(!originalId)return finish(null,null,'invalid_provider_id');
    evidence.candidateTeamIds=[originalId];
    return finish(originalId,'provider_id','resolved');
  }
  if(UNKNOWN_NAMES.has(name))return finish(null,null,'name_missing');
  if(!sourcesAvailable)return finish(null,null,'identity_source_unavailable');
  const exactCatalogue=catalogue.filter(r=>normalizeTeamName(r.name||'')===name || normalizeTeamName(r.tag||'')===name);
  const exactHistory=historical.filter(r=>normalizeTeamName(r.name)===name);
  let candidates=[...new Set([...exactCatalogue,...exactHistory].map(r=>r.teamId))].sort((a,b)=>a-b);
  let method:TeamIdentityEvidence['method']=exactCatalogue.length?'catalogue_exact_name':'history_exact_name';
  if(!candidates.length) {
    const aliases=catalogue.filter(r=>!!r.name&&sameTeamIdentity(r.name,team.name));
    const aliasHistory=historical.filter(r=>sameTeamIdentity(r.name,team.name));
    candidates=[...new Set([...aliases,...aliasHistory].map(r=>r.teamId))].sort((a,b)=>a-b);
    method='catalogue_alias';
    // Existing catalogue aliases only: no new alias mapping from historical names.
    if(!aliases.length)candidates=[];
  }
  evidence.candidateTeamIds=candidates;
  if(candidates.length!==1)return finish(null,null,candidates.length?'name_ambiguous':'name_not_found');
  return finish(candidates[0]!,method,'resolved');
}

export function resolveTeamPair(input:MatchInput,rows:readonly TeamCatalogueRow[],history:readonly TeamHistoryIdentityRow[]=[],sourcesAvailable=true):MatchInput {
  const team1=resolveTeamFromRows(input.team1,rows,history,sourcesAvailable);
  const team2=resolveTeamFromRows(input.team2,rows,history,sourcesAvailable);
  if(team1.teamId && team1.teamId===team2.teamId) {
    for(const team of [team1,team2]) {
      team.teamId=undefined;team.elo=undefined;
      team.identity={...team.identity,status:'unresolved',method:null,reason:'same_team_on_both_sides',resolvedTeamId:null};
    }
  }
  return {...input,team1,team2};
}

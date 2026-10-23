/** A causal trajectory identity, independent of player-array order and economy rank.
 * Null -> disclosed identity changes the key; it does not rewrite earlier frames.
 */
import {createHash} from 'node:crypto';
export const IDENTITY_CONTRACT='aegis.steam-player-side-team-identity.v1';
// This guard compares existing identities; the source normalizer validates native
// decimal IDs. Legacy synthetic/projected inputs may carry opaque proven team IDs.
const id=x=>x===null||x===undefined?null:typeof x==='string'&&x.length>0&&x.length<=128?x:
 typeof x==='number'&&Number.isSafeInteger(x)&&x>0?String(x):undefined;
export function steamObservationIdentity(observation){
 const sides=[],issues=[];
 for(const side of ['radiant','dire']){
  const data=observation?.sides?.[side],teamId=id(data?.teamId);
  if(teamId===undefined)issues.push(side+'_invalid_team_id');
  if(!Array.isArray(data?.players)||data.players.length>5){issues.push(side+'_player_shape');continue;}
  const players=[],knownPlayerTeams=new Set();
  for(const p of data.players){
   const x=p?.identity,accountId=id(x?.accountId),heroId=id(x?.heroId),playerTeamId=id(x?.teamId);
   if(x?.side!==side||accountId===undefined||heroId===undefined||playerTeamId===undefined||teamId!==null&&playerTeamId!==null&&playerTeamId!==teamId)issues.push(side+'_player_identity_conflict');
   if(playerTeamId!==null&&playerTeamId!==undefined)knownPlayerTeams.add(playerTeamId);
   players.push([accountId??null,heroId??null,playerTeamId??null]);
  }
  if(knownPlayerTeams.size>1)issues.push(side+'_multiple_player_teams');
  players.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  sides.push([side,teamId??null,players]);
 }
 return{contract:IDENTITY_CONTRACT,key:issues.length?null:createHash('sha256').update(JSON.stringify(sides)).digest('hex'),issues};
}

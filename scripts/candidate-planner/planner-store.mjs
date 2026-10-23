/** Small immutable intent ledger. Not a native-fit lock and not an executor. */
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash,stable,timestamp,VERSION} from './candidate-planner.mjs';
const parse=p=>{if(lstatSync(p).isSymbolicLink()||lstatSync(p).size>2*1024**2)throw Error('planner_record_bound');return JSON.parse(readFileSync(p,'utf8'));};
export function loadLedger(directory){
 const intents=[],events=[];
 for(const [folder,target] of [['intents',intents],['events',events]]){
  if(!existsSync(join(directory,folder)))continue;const names=readdirSync(join(directory,folder));if(names.length>20000)throw Error('planner_ledger_bound');
  for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))throw Error('unrecognized_ledger_file');const r=parse(join(directory,folder,name));const key=folder==='intents'?r.intentId:r.eventId;if(key!==name.slice(0,-5)||r.version!==VERSION)throw Error('planner_record_identity');target.push(r);}
 }
 const seen=new Set();for(const i of intents){const {contentHash,...content}=i;if(seen.has(i.intentId)||hash(i.identity)!==i.intentId||hash(content)!==contentHash||i.candidateOnly!==true||i.dispatchEnabled!==false||i.publicPromotion!==false||timestamp(i.createdAt)===null||stable(i.identity.triggerIds)!==stable(i.triggers.map(t=>t.triggerId).sort()))throw Error('invalid_saved_intent');seen.add(i.intentId);}
 const states={},pending=new Map(events.map(e=>[e.eventId,e]));
 for(const e of events){if(!seen.has(e.intentId)||timestamp(e.observedAt)===null||hash(e.semantic)!==e.eventId)throw Error('invalid_saved_event');const {version,eventId,semantic,...body}=e;if(stable({...body,observedAt:undefined})!==stable(semantic))throw Error('event_semantic_binding');}
 while(pending.size){let progressed=false;for(const [id,e] of pending){const prior=states[e.intentId];if((e.previousEventId??null)!==(prior?.eventId??null))continue;if(prior&&timestamp(e.observedAt)<timestamp(prior.observedAt))throw Error('event_clock_regressed');const {version,eventId,semantic,...body}=e;states[e.intentId]={...body,eventId};pending.delete(id);progressed=true;}if(!progressed)throw Error('planner_event_chain_conflict_or_missing_parent');}
 return {intents,intentStates:states};
}
function writeImmutable(file,row,identity){
 try{writeFileSync(file,JSON.stringify(row,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});return row;}
 catch(e){if(e.code!=='EEXIST')throw e;const old=parse(file);if(!identity(old,row))throw Error('immutable_ledger_conflict');return old;}
}
export function savePlan(directory,report){
 mkdirSync(join(directory,'intents'),{recursive:true});mkdirSync(join(directory,'events'),{recursive:true});
 for(const i of report.newIntents){const content={...i,version:VERSION};writeImmutable(join(directory,'intents',i.intentId+'.json'),{...content,contentHash:hash(content)},(a,b)=>stable(a.identity)===stable(b.identity)&&stable(a.triggers)===stable(b.triggers));}
 for(const transition of report.transitions){const semantic={...transition};delete semantic.observedAt;const eventId=hash(semantic);writeImmutable(join(directory,'events',eventId+'.json'),{version:VERSION,...transition,semantic,eventId},(a,b)=>stable(a.semantic)===stable(b.semantic));}
 const tmp=join(directory,'CURRENT.'+randomUUID()+'.tmp');writeFileSync(tmp,JSON.stringify({...report,newIntents:report.newIntents.map(i=>i.intentId)},null,2)+'\n',{flag:'wx',mode:0o600,flush:true});renameSync(tmp,join(directory,'CURRENT.json'));
 return loadLedger(directory);
}

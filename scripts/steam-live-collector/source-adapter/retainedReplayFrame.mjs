/** Owned retained-byte replay authority. This is a reconstruction horizon,
 * never an assertion that an old frame is currently live or was predicted then. */
import {createHash} from 'node:crypto';
import {instantNs} from './causalTime.mjs';
const held=new WeakMap(),hash=x=>createHash('sha256').update(x).digest('hex');
const fail=x=>{throw Error('retained_replay_frame:'+x);};
function pin(p,max){if(!p||typeof p.utf8!=='string'||p.pin?.bytes!==Buffer.byteLength(p.utf8)||p.pin.bytes>max||hash(p.utf8)!==p.pin.sha256)fail('actual_pinned_bytes_required');return JSON.parse(p.utf8);}
export function createRetainedReplayFrameProof({rawInput,receiptInput,reconstructedAt}){
 const r=pin(receiptInput,65536);pin(rawInput,4*1024*1024);
 const t=instantNs(reconstructedAt),received=instantNs(r.receivedAt),persisted=instantNs(r.rawPersistedAt),complete=instantNs(r.completedAt);
 if(r.version!=='steam-live-diagnostic-collector.v1'||r.endpoint!=='GetLiveLeagueGames/v1'||r.status!=='captured_diagnostic'||r.httpStatus!==200||r.diagnosticOnly!==true||r.servingEnabled!==false||r.trainingEnabled!==false||r.publicPromotion!==false||r.rawSha256!==rawInput.pin.sha256||[t,received,persisted,complete].some(x=>x===null)||received>persisted||persisted>complete||complete>t)fail('owned_capture_chronology');
 const state=Object.freeze({rawSha256:rawInput.pin.sha256,receiptSha256:receiptInput.pin.sha256,receivedAt:r.receivedAt,sourceDecisionAt:r.completedAt,reconstructedAt,originalPredictionTimingClaimed:false,diagnosticOnly:true});
 const proof=Object.freeze({contract:'aegis.retained-replay-frame.private.v1'});held.set(proof,state);return proof;
}
export function readRetainedReplayFrameProof(proof,{rawSha256,receivedAt,decisionAt}={}){
 const p=held.get(proof);if(!p||p.rawSha256!==rawSha256||instantNs(p.receivedAt)!==instantNs(receivedAt)||instantNs(decisionAt)===null||instantNs(p.reconstructedAt)>instantNs(decisionAt)||instantNs(p.sourceDecisionAt)>instantNs(decisionAt))fail('private_replay_frame_binding');return p;
}

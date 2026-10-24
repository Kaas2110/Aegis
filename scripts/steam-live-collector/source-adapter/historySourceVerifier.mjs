/** One contract dispatcher for old reconstruction and retained-response exports.
 * Both branches re-verify exact bytes and recompute their own source proof. */
import {verifyHistorySourceExport as verifyDatabaseExport} from './historySourceExport.mjs';
import {verifyRetainedHistorySourceExport,RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT} from './retainedHistorySourceExport.mjs';
import {instantNs} from './causalTime.mjs';
import {draftHash} from './observedDraft.mjs';
export {HISTORY_EXPORT_REFERENCE_CONTRACT,MAX_HISTORY_EXPORT_BYTES} from './historySourceExport.mjs';
export const VERIFIED_HISTORY_SOURCE_HANDLE_CONTRACT='aegis.verified-history-source-handle.v1';
export const MAX_VERIFIED_HISTORY_SOURCE_DESCRIPTOR_BYTES=16*1024;
// No strong/global cache of tokens or source bytes. The host owns reachable
// handles under its map/pending-work bounds; each handle retains compact metadata
// only. Disk reads/restarts must mint again from reverified original bytes.
const handles=new WeakMap(),HASH=/^[a-f0-9]{64}$/,ID=/^[1-9]\d{0,19}$/;
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const fail=reason=>{throw Error('history_source_handle:'+reason);};
export function verifyHistorySourceExport(envelopeInput,options={}){
 // This peek selects a verifier only. Neither branch accepts the peek as proof.
 if(typeof envelopeInput?.utf8!=='string'||Buffer.byteLength(envelopeInput.utf8)>64*1024*1024)throw Error('history_source_verifier:envelope_bound');
 let body;try{body=JSON.parse(envelopeInput.utf8);}catch{return verifyDatabaseExport(envelopeInput,options);}
 return body?.contract===RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT?verifyRetainedHistorySourceExport(envelopeInput,options):verifyDatabaseExport(envelopeInput,options);
}

/** Mint only after actual original envelope replay. This API deliberately does
 * not accept a previously returned JSON export or a claimed "verified" hash. */
export function createVerifiedHistorySourceHandle(envelopeInput,{expectedSourceSnapshotHash,matchId,decisionAt}={}){
 if(!HASH.test(expectedSourceSnapshotHash??'')||!ID.test(matchId??'')||instantNs(decisionAt)===null)fail('mint_identity_or_time');
 const verified=verifyHistorySourceExport(envelopeInput,{expectedSourceSnapshotHash,matchId,decisionAt,readMode:'recorded'}),body=JSON.parse(verified.envelopeInput.utf8);
 const descriptor={contract:'aegis.verified-history-source-descriptor.v1',sourceContract:verified.contract,sourceSnapshotHash:verified.sourceSnapshotHash,reference:structuredClone(verified.reference),identity:structuredClone(verified.identity),population:structuredClone(verified.population),factsSha256:body.factsInput?.pin?.sha256??null,nativeSha256:body.nativeInput?.pin?.sha256??null,draftPrefixBindingHash:draftHash(body.draftPrefixInputs.map(p=>({raw:p.rawInput.pin.sha256,metadata:p.metadataInput.pin.sha256}))),computedAt:body.computedAt,exportedAt:body.exportedAt,eligibleForServing:false,eligibleForTraining:false,recordedPrediction:false};
 let descriptorBytes=0,nextBytes=Buffer.byteLength(JSON.stringify({...descriptor,descriptorBytes}));
 while(nextBytes!==descriptorBytes){descriptorBytes=nextBytes;nextBytes=Buffer.byteLength(JSON.stringify({...descriptor,descriptorBytes}));}
 if(descriptorBytes>MAX_VERIFIED_HISTORY_SOURCE_DESCRIPTOR_BYTES)fail('descriptor_bound');
 const token=Object.freeze({contract:VERIFIED_HISTORY_SOURCE_HANDLE_CONTRACT});
 handles.set(token,freeze({...descriptor,descriptorBytes}));
 return token;
}

/** Per-use binding/availability checks are cheap and cannot be bypassed with a
 * serialized token. The returned metadata is recursively immutable and owns no
 * envelope, retained raw input, facts array or arbitrary caller object. */
export function readVerifiedHistorySourceHandle(token,{expectedSourceSnapshotHash,matchId,decisionAt}={}){
 const descriptor=handles.get(token);
 if(!descriptor)fail('owned_token_required');
 if(!HASH.test(expectedSourceSnapshotHash??'')||expectedSourceSnapshotHash!==descriptor.sourceSnapshotHash||!ID.test(matchId??'')||matchId!==descriptor.identity.matchId)fail('identity_binding');
 const decision=instantNs(decisionAt);
 if(decision===null||decision<instantNs(descriptor.identity.validFrom)||decision<instantNs(descriptor.exportedAt))fail('not_available_at_decision');
 return descriptor;
}

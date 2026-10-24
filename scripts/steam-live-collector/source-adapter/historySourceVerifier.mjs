/** One contract dispatcher for old reconstruction and retained-response exports.
 * Both branches re-verify exact bytes and recompute their own source proof. */
import {verifyHistorySourceExport as verifyDatabaseExport} from './historySourceExport.mjs';
import {verifyRetainedHistorySourceExport,RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT} from './retainedHistorySourceExport.mjs';
export {HISTORY_EXPORT_REFERENCE_CONTRACT,MAX_HISTORY_EXPORT_BYTES} from './historySourceExport.mjs';
export function verifyHistorySourceExport(envelopeInput,options={}){
 // This peek selects a verifier only. Neither branch accepts the peek as proof.
 if(typeof envelopeInput?.utf8!=='string'||Buffer.byteLength(envelopeInput.utf8)>64*1024*1024)throw Error('history_source_verifier:envelope_bound');
 let body;try{body=JSON.parse(envelopeInput.utf8);}catch{return verifyDatabaseExport(envelopeInput,options);}
 return body?.contract===RETAINED_HISTORY_SOURCE_EXPORT_CONTRACT?verifyRetainedHistorySourceExport(envelopeInput,options):verifyDatabaseExport(envelopeInput,options);
}

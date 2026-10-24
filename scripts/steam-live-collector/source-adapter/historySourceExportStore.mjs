/** Explicit-directory append-only CAS adapter. No DB or schedule changes.
 * Atomic hard-link publication never overwrites an existing export. Filesystem
 * administrators can still alter files; every read therefore verifies the bytes.
 */
import {open,lstat,link,unlink,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HISTORY_EXPORT_REFERENCE_CONTRACT,MAX_HISTORY_EXPORT_BYTES,verifyHistorySourceExport} from './historySourceVerifier.mjs';
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fileName=sha256=>sha256+'.history-source.json';
function reference(r){if(r?.contract!==HISTORY_EXPORT_REFERENCE_CONTRACT||!hash(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>MAX_HISTORY_EXPORT_BYTES||Object.keys(r).some(k=>!['contract','sha256','bytes'].includes(k)))throw Error('history_source_store_reference');return structuredClone(r);}
/** The root must already exist; callers choose an authorized private data folder.
 * No reference-supplied file path is followed. It is never a public source asset.
 */
export async function createHistorySourceExportStore(directory){
 if(typeof directory!=='string'||directory.length<1)throw Error('history_source_store_directory');
 const root=resolve(directory),stat=await lstat(root);
 if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(root)!==root)throw Error('history_source_store_plain_directory_required');
 const assertRoot=async()=>{const s=await lstat(root);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(root)!==root)throw Error('history_source_store_directory_changed');};
 async function load(ref,options={}){
  ref=reference(ref);await assertRoot();const path=join(root,fileName(ref.sha256)),st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.size!==ref.bytes)throw Error('history_source_store_file_bound');
  const handle=await open(path,'r');let utf8;
  try{const s=await handle.stat();if(!s.isFile()||s.size!==ref.bytes||s.size>MAX_HISTORY_EXPORT_BYTES)throw Error('history_source_store_file_bound');utf8=await handle.readFile('utf8');}
  finally{await handle.close();}
  return verifyHistorySourceExport({utf8,pin:{path:'history-source/cas/'+fileName(ref.sha256),bytes:ref.bytes,sha256:ref.sha256}},{...options,expectedSourceSnapshotHash:ref.sha256});
 }
 return{
  async put(exported){
   const checked=verifyHistorySourceExport(exported?.envelopeInput,{expectedSourceSnapshotHash:exported?.sourceSnapshotHash});
   const ref=checked.reference;await assertRoot();const destination=join(root,fileName(ref.sha256)),temporary=join(root,'.'+randomUUID()+'.tmp');
   let created=false,handle;
   try{
    handle=await open(temporary,'wx',0o600);created=true;await handle.writeFile(checked.envelopeInput.utf8,'utf8');await handle.sync();await handle.close();handle=null;
    await assertRoot();
    try{await link(temporary,destination);}catch(error){if(error.code!=='EEXIST')throw error;await load(ref);}
   }finally{if(handle)await handle.close();if(created)await unlink(temporary);}
   const stored=await load(ref);return{reference:stored.reference,sourceSnapshotHash:stored.sourceSnapshotHash,appendOnlyAdapter:true,overwroteExisting:false};
  },
  load
 };
}

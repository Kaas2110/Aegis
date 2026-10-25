/** Explicit saved-reader ownership. Importing opens no store or helper.
 * Compact readers take the existing exclusive lease; no read/write overlap or
 * collector/model/provider activation is implied. v1 remains the default. */
import {lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createWindowsArtifactWriterLeaseProvider} from './artifactWriterLeaseWindows.mjs';
import {createDiagnosticResourceArena} from './diagnosticResourceArena.mjs';
import {createRetainedStaticHistoryInputStore} from './retainedStaticHistoryInputStore.mjs';
import {createRetainedStaticHistoryTargetStore} from './retainedStaticHistoryTarget.mjs';
import {createCompactDiagnosticHostJournal} from './compactDiagnosticHostJournal.mjs';
export async function openSavedDiagnosticReader({format='v1',directory,pythonExecutable=null,leaseProvider=null,resourceArena=null,journalOptions={}}={}){
 if(!['v1','compact_v2'].includes(format)||typeof directory!=='string'||!isAbsolute(directory))throw Error('saved_diagnostic_reader:configuration');
 if(format==='v1')return Object.freeze({format,journal:createDiagnosticFeatureJournal({directory}),async close(){}});
 // A GET may inspect an existing root, never initialize a new compact store.
 const root=await lstat(join(directory,'ROOT.json'));if(!root.isFile()||root.isSymbolicLink())throw Error('saved_diagnostic_reader:existing_root_required');
 const arena=resourceArena??createDiagnosticResourceArena({maxBytes:4*1024**3});
 let writer=null,store=null,journal=null,targets=null,closed=false;
 try{
  writer=await createPersistentArtifactWriter({directory,leaseProvider:leaseProvider??createWindowsArtifactWriterLeaseProvider({pythonExecutable})});
  targets=createRetainedStaticHistoryTargetStore({writer,resourceArena:arena});
  store=createRetainedStaticHistoryInputStore({writer,resourceArena:arena,targetDerivationStore:targets});
  journal=createCompactDiagnosticHostJournal({writer,resourceArena:arena,historicalInputStore:store,journalOptions});
  // Expose read ports only. Mutations remain owned by the separate host.
  return Object.freeze({format,journal:Object.freeze({contract:journal.contract,loadTrace:journal.loadTrace,loadSchema:journal.loadSchema,hasCommittedTrace:journal.hasCommittedTrace}),resourceStatus:()=>arena.status(),async close(){if(closed)return;closed=true;try{await journal.close();}finally{try{store.close();}finally{try{targets.close();}finally{await writer.close();}}}}});
 }catch(error){try{await journal?.close();}finally{try{store?.close();}finally{try{targets?.close();}finally{await writer?.close();}}}throw error;}
}

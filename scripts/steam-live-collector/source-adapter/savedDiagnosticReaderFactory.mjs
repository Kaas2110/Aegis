/** Explicit saved-reader ownership. Importing opens no store or helper.
 * Compact readers take the existing exclusive lease; no read/write overlap or
 * collector/model/provider activation is implied. v1 remains the default. */
import {lstat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createDiagnosticFeatureJournal} from './diagnosticFeatureJournal.mjs';
import {createPersistentArtifactWriter} from './persistentArtifactWriter.mjs';
import {createWindowsArtifactWriterLeaseProvider} from './artifactWriterLeaseWindows.mjs';
import {selectDiagnosticResourceConfiguration,LEGACY_READER_RESOURCE_PROFILE,LEGACY_HOST_RESOURCE_PROFILE,RICH_DIAGNOSTIC_RESOURCE_PROFILE} from './diagnosticResourceConfiguration.mjs';
import {createRetainedStaticHistoryInputStore} from './retainedStaticHistoryInputStore.mjs';
import {createRetainedStaticHistoryTargetStore} from './retainedStaticHistoryTarget.mjs';
import {createCompactDiagnosticHostJournal} from './compactDiagnosticHostJournal.mjs';
export async function openSavedDiagnosticReader({format='v1',directory,pythonExecutable=null,leaseProvider=null,resourceArena=null,journalOptions={},resourceProfile=null,resourceConfiguration=null}={}){
 if(!['v1','compact_v2'].includes(format)||typeof directory!=='string'||!isAbsolute(directory))throw Error('saved_diagnostic_reader:configuration');
 const resources=selectDiagnosticResourceConfiguration({resourceConfiguration,resourceProfile,resourceArena,journalOptions,legacyDefault:format==='v1'?LEGACY_HOST_RESOURCE_PROFILE:LEGACY_READER_RESOURCE_PROFILE});
 if(format==='v1'&&resources.descriptor.profileId===RICH_DIAGNOSTIC_RESOURCE_PROFILE)throw Error('saved_diagnostic_reader:rich_profile_requires_compact');
 if(format==='v1')return Object.freeze({format,journal:createDiagnosticFeatureJournal({directory,resourceArena:resources.resourceArena}),resourceConfiguration:resources,resourceProfile:resources.descriptor,resourceStatus:()=>resources.resourceArena.status(),async close(){}});
 // A GET may inspect an existing root, never initialize a new compact store.
 const root=await lstat(join(directory,'ROOT.json'));if(!root.isFile()||root.isSymbolicLink())throw Error('saved_diagnostic_reader:existing_root_required');
 const arena=resources.resourceArena;
 let writer=null,store=null,journal=null,targets=null,closePromise=null;
 try{
  writer=await createPersistentArtifactWriter({directory,leaseProvider:leaseProvider??createWindowsArtifactWriterLeaseProvider({pythonExecutable})});
  targets=createRetainedStaticHistoryTargetStore({writer,resourceArena:arena});
  store=createRetainedStaticHistoryInputStore({writer,resourceArena:arena,targetDerivationStore:targets});
  journal=createCompactDiagnosticHostJournal({writer,resourceArena:arena,historicalInputStore:store,journalOptions:resources.journalOptions});
  // Expose read ports only. Mutations remain owned by the separate host.
  return Object.freeze({format,journal:Object.freeze({contract:journal.contract,loadTrace:journal.loadTrace,loadSchema:journal.loadSchema,hasCommittedTrace:journal.hasCommittedTrace}),resourceConfiguration:resources,resourceProfile:resources.descriptor,resourceStatus:()=>arena.status(),async close(){if(closePromise)return closePromise;closePromise=(async()=>{try{await journal.close();}finally{try{store.close();}finally{try{targets.close();}finally{await writer.close();}}}})();return closePromise;}});
 }catch(error){try{await journal?.close();}finally{try{store?.close();}finally{try{targets?.close();}finally{await writer?.close();}}}throw error;}
}

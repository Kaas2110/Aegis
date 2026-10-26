/** Explicit in-process resource wiring. A named profile is not an OS supervisor
 * and two processes selecting the same name do not share an arena or lease. */
import {createDiagnosticResourceArena,snapshotPlainRecord} from './diagnosticResourceArena.mjs';
const GiB=1024**3,MiB=1024**2,owned=new WeakSet(),fail=x=>{throw Error('diagnostic_resource_configuration:'+x);};
export const RICH_DIAGNOSTIC_RESOURCE_PROFILE='R8_RICH_8G';
export const LEGACY_HOST_RESOURCE_PROFILE='LEGACY_HOST_2G';
export const LEGACY_READER_RESOURCE_PROFILE='LEGACY_SAVED_READER_4G';
export const LEGACY_EXPLICIT_RESOURCE_PROFILE='LEGACY_EXPLICIT_ARENA';
export const DIAGNOSTIC_RESOURCE_PROFILES=Object.freeze(Object.fromEntries([
 [RICH_DIAGNOSTIC_RESOURCE_PROFILE,8*GiB,2*GiB],[LEGACY_HOST_RESOURCE_PROFILE,2*GiB,512*MiB],[LEGACY_READER_RESOURCE_PROFILE,4*GiB,512*MiB],[LEGACY_EXPLICIT_RESOURCE_PROFILE,8*GiB,512*MiB]
].map(([id,sharedArenaBytes,assetWorkingBytes])=>[id,Object.freeze({id,sharedArenaBytes,assetWorkingBytes,producerWorkingBytes:id===RICH_DIAGNOSTIC_RESOURCE_PROFILE?256*MiB:128*MiB,compilerWorkingBytes:id===RICH_DIAGNOSTIC_RESOURCE_PROFILE?256*MiB:128*MiB,operationWorkingBytes:128*MiB,maxWireBytes:256*MiB})])));
export function createDiagnosticResourceConfiguration({profile=LEGACY_HOST_RESOURCE_PROFILE,resourceArena=null,journalOptions={}}={}){
 if(typeof profile!=='string'||!Object.hasOwn(DIAGNOSTIC_RESOURCE_PROFILES,profile)||profile===LEGACY_EXPLICIT_RESOURCE_PROFILE&&resourceArena===null)fail('named_profile');const p=DIAGNOSTIC_RESOURCE_PROFILES[profile];
 if(resourceArena!==null&&(typeof resourceArena?.reserve!=='function'||typeof resourceArena?.retainAsset!=='function'||typeof resourceArena?.status!=='function'))fail('arena');
 const arena=resourceArena??createDiagnosticResourceArena({maxBytes:p.sharedArenaBytes}),status=arena.status();if(!Number.isSafeInteger(status.maxBytes)||status.maxBytes<1024||status.maxBytes>p.sharedArenaBytes)fail('arena_exceeds_profile');
 const caller=snapshotPlainRecord(journalOptions,{maxKeys:24}),effective={...caller};
 for(const key of ['assetWorkingBytes','operationWorkingBytes','maxWireBytes']){const value=Object.hasOwn(caller,key)?caller[key]:p[key];if(!Number.isSafeInteger(value)||value<1024||value>p[key])fail('caller_limit:'+key);effective[key]=value;}
 const descriptor=Object.freeze({contract:'aegis.diagnostic-resource-configuration.v1',profileId:p.id,profileSharedArenaBytes:p.sharedArenaBytes,effectiveSharedArenaBytes:status.maxBytes,assetWorkingBytes:effective.assetWorkingBytes,producerWorkingBytes:Math.min(p.producerWorkingBytes,effective.assetWorkingBytes),compilerWorkingBytes:Math.min(p.compilerWorkingBytes,effective.assetWorkingBytes),operationWorkingBytes:effective.operationWorkingBytes,maxWireBytes:effective.maxWireBytes,sharedScope:'same_owned_host_JS_objects_only',osSupervision:false,globalAggregateSupervision:false,activation:false});
 const result=Object.freeze({descriptor,resourceArena:arena,journalOptions:Object.freeze(effective)});owned.add(result);return result;
}
export function requireDiagnosticResourceConfiguration(value){if(!owned.has(value))fail('private_configuration_required');return value;}
export function selectDiagnosticResourceConfiguration({resourceConfiguration=null,resourceProfile=null,resourceArena=null,journalOptions={},legacyDefault=LEGACY_HOST_RESOURCE_PROFILE}={}){
 if(resourceConfiguration===null)return createDiagnosticResourceConfiguration({profile:resourceProfile??(resourceArena===null?legacyDefault:LEGACY_EXPLICIT_RESOURCE_PROFILE),resourceArena,journalOptions});
 const config=requireDiagnosticResourceConfiguration(resourceConfiguration);if(resourceProfile!==null&&resourceProfile!==config.descriptor.profileId||resourceArena!==null&&resourceArena!==config.resourceArena)fail('configuration_conflict');
 const caller=snapshotPlainRecord(journalOptions,{maxKeys:24});if(!Object.keys(caller).length)return config;
 if(Object.keys(caller).every(key=>caller[key]===config.journalOptions[key]))return config;
 for(const key of ['assetWorkingBytes','operationWorkingBytes','maxWireBytes'])if(caller[key]!==undefined&&caller[key]>config.journalOptions[key])fail('caller_raises_existing_limit:'+key);
 return createDiagnosticResourceConfiguration({profile:config.descriptor.profileId,resourceArena:config.resourceArena,journalOptions:{...config.journalOptions,...caller}});
}
/** A borrowed read port uses its host's existing journal/writer/arena. It never
 * acquires another native lease or owns host shutdown. Close waits for its reads. */
export function createBorrowedDiagnosticReader({journal,resourceConfiguration,format='compact_v2',shouldContinue=()=>true,onClosed=()=>{}}={}){
 const config=requireDiagnosticResourceConfiguration(resourceConfiguration);if(typeof journal?.loadTrace!=='function'||typeof shouldContinue!=='function'||typeof onClosed!=='function')fail('borrowed_ports');
 let closed=false,pending=0,idle=null,closing=null;const ensure=()=>{if(closed||shouldContinue()!==true)fail('borrowed_reader_closed');};
 const done=()=>{pending--;if(pending===0){idle?.();idle=null;}};
 const read=fn=>async(...args)=>{ensure();pending++;let transferred=false;try{const result=await fn(...args);try{ensure();}catch(error){result?.release?.();throw error;}if(result&&typeof result.release==='function'){let active=true;transferred=true;return Object.freeze({...result,release(){if(!active)return false;active=false;try{return result.release();}finally{done();}}});}return result;}finally{if(!transferred)done();}};
 const port={contract:journal.contract,loadTrace:read(journal.loadTrace),...(typeof journal.loadSchema==='function'?{loadSchema:read(journal.loadSchema)}:{}),...(typeof journal.hasCommittedTrace==='function'?{hasCommittedTrace:read(journal.hasCommittedTrace)}:{})};
 return Object.freeze({format,journal:Object.freeze(port),resourceConfiguration:config,resourceProfile:config.descriptor,resourceStatus:()=>config.resourceArena.status(),borrowedFromOwnedHost:true,async close(){if(closing)return closing;closed=true;closing=(async()=>{if(pending)await new Promise(done=>idle=done);onClosed();})();return closing;}});
}

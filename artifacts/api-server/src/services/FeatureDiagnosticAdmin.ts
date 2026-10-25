/** Opt-in saved feature inspection. No provider, model, collector or host start.
 * Only explicit operator configuration chooses local directories and code root;
 * request paths can select a hash/target/page, never a filesystem path. */
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {lstat,realpath} from 'node:fs/promises';

type Result={status:number;headers:Record<string,string>;body:unknown};
type ReadApi={handle:(input:{method:string;url:string;signal?:AbortSignal|null})=>Promise<Result>};
type ReaderOwner={journal:unknown;close:()=>void|Promise<void>};
type RuntimeModules={createDiagnosticFeatureJournal:(options:{directory:string})=>unknown;createDiagnosticFeatureReadApi:(options:{journal:unknown;enabled:boolean;basePath:string})=>ReadApi;openSavedDiagnosticReader?:(options:{format:string;directory:string;pythonExecutable:string|null})=>Promise<ReaderOwner>};
const unavailable=(status:number):Result=>({status,headers:{'Cache-Control':'no-store'},body:{status:'unavailable',diagnosticOnly:true,recordedPrediction:false,eligibleForTraining:false,eligibleForServing:false}});
const busy=():Result=>({...unavailable(429),headers:{'Cache-Control':'no-store','Retry-After':'1'}});
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
async function plainDirectory(directory:string){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||!same(await realpath(directory),directory))throw Error('plain_local_directory_required');}
export async function loadFeatureDiagnosticModules(appRoot:string):Promise<RuntimeModules>{
 await plainDirectory(appRoot);
 const directory=join(appRoot,'scripts/steam-live-collector/source-adapter');await plainDirectory(directory);
 const journalModule=await import(pathToFileURL(join(directory,'diagnosticFeatureJournal.mjs')).href);
 const apiModule=await import(pathToFileURL(join(directory,'diagnosticFeatureReadApi.mjs')).href);
 const readerModule=await import(pathToFileURL(join(directory,'savedDiagnosticReaderFactory.mjs')).href);
 if(typeof journalModule.createDiagnosticFeatureJournal!=='function'||typeof apiModule.createDiagnosticFeatureReadApi!=='function')throw Error('diagnostic_reader_modules_unavailable');
 return{createDiagnosticFeatureJournal:journalModule.createDiagnosticFeatureJournal,createDiagnosticFeatureReadApi:apiModule.createDiagnosticFeatureReadApi,openSavedDiagnosticReader:readerModule.openSavedDiagnosticReader};
}
export function createFeatureDiagnosticAdminService({environment=()=>process.env,loadModules=loadFeatureDiagnosticModules,maxPendingReads=4,maxInitializationWaitMs=2000}:{environment?:()=>NodeJS.ProcessEnv;loadModules?:(root:string)=>Promise<RuntimeModules>;maxPendingReads?:number;maxInitializationWaitMs?:number}={}){
 if(!Number.isSafeInteger(maxPendingReads)||maxPendingReads<1||maxPendingReads>4||!Number.isSafeInteger(maxInitializationWaitMs)||maxInitializationWaitMs<1||maxInitializationWaitMs>2000)throw Error('diagnostic_admin_admission_configuration');
 type State={key:string;retired:boolean;reads:number;ready:Promise<{api:ReadApi;owner:ReaderOwner}>;idle:(()=>void)|null;close:Promise<void>|null};
 let active:State|null=null,retirement:Promise<void>=Promise.resolve();
 function retire(state:State|null):Promise<void>{
  if(state===null)return Promise.resolve();if(state.close)return state.close;
  state.retired=true;
  state.close=(async()=>{const loaded=await state.ready.catch(()=>null);if(state.reads)await new Promise<void>(done=>{state.idle=done;});await loaded?.owner.close();})();
  retirement=state.close.catch(()=>{});
  return state.close;
 }
 async function unavailableAndClose(status:number){const previous=active;active=null;await retire(previous).catch(()=>{});return unavailable(status);}
 return Object.freeze({async close(){const previous=active;active=null;await retire(previous);},async handle(input:{method:string;url:string;signal?:AbortSignal|null}):Promise<Result>{
  const env=environment();
  if(env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED!=='1')return unavailableAndClose(404);
  const directory=env.AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY,appRoot=env.AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT;
  if(!directory||!appRoot||!isAbsolute(directory)||!isAbsolute(appRoot)||directory.startsWith('\\\\')||appRoot.startsWith('\\\\'))return unavailableAndClose(503);
  if(typeof input.method!=='string'||typeof input.url!=='string'||input.url.length>2048)return unavailable(400);
  if(input.signal!==undefined&&input.signal!==null&&!(input.signal instanceof AbortSignal))return unavailable(400);if(input.signal?.aborted)return unavailable(499);
  const format=env.AEGIS_FEATURE_DIAGNOSTICS_FORMAT??'v1',pythonExecutable=env.AEGIS_FEATURE_DIAGNOSTICS_PYTHON??null;
  if(!['v1','compact_v2'].includes(format)||format==='compact_v2'&&(!pythonExecutable||!isAbsolute(pythonExecutable)))return unavailableAndClose(503);
  const key=JSON.stringify([resolve(directory),resolve(appRoot),format,pythonExecutable]);let state:State|null=null,counted=false;
  try{
   if(key!==active?.key){
    const previous=active,previousRetirement=retirement;
    const next:State={key,retired:false,reads:0,idle:null,close:null,ready:Promise.resolve(null as never)};
    next.ready=(async()=>{await previousRetirement;await retire(previous);await plainDirectory(resolve(directory));const modules=await loadModules(resolve(appRoot));let owner:ReaderOwner|null=null;try{if(format==='compact_v2'&&!modules.openSavedDiagnosticReader)throw Error('compact_reader_factory_required');owner=modules.openSavedDiagnosticReader?await modules.openSavedDiagnosticReader({format,directory:resolve(directory),pythonExecutable}):{journal:modules.createDiagnosticFeatureJournal({directory:resolve(directory)}),close(){}};return{owner,api:modules.createDiagnosticFeatureReadApi({journal:owner.journal,enabled:true,basePath:'/admin/feature-diagnostics'})};}catch(error){await owner?.close();throw error;}})();
    active=next;
   }
   state=active!;if(state.reads>=maxPendingReads)return busy();state.reads++;counted=true;
   let timer:ReturnType<typeof setTimeout>|undefined,cancel:(()=>void)|null=null;
   const pendingReady=new Promise<null>(done=>{timer=setTimeout(()=>done(null),maxInitializationWaitMs);if(input.signal){cancel=()=>done(null);input.signal.addEventListener('abort',cancel,{once:true});}});
   let loaded:Awaited<State['ready']>|null;try{loaded=await Promise.race([state.ready,pendingReady]);}finally{clearTimeout(timer);if(cancel)input.signal?.removeEventListener('abort',cancel);}
   if(input.signal?.aborted)return unavailable(499);if(loaded===null)return busy();if(state.retired||active!==state)return unavailable(503);
   const result=await loaded.api.handle(input);return state.retired||active!==state?unavailable(503):result;
  }catch{if(active===state){active=null;void retire(state).catch(()=>{});}return unavailable(503);}
  finally{if(state&&counted){state.reads--;if(state.reads===0){state.idle?.();state.idle=null;}}}
 }});
}
export const featureDiagnosticAdmin=createFeatureDiagnosticAdminService();

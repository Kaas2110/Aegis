/** Opt-in saved feature inspection. No provider, model, collector or host start.
 * Only explicit operator configuration chooses local directories and code root;
 * request paths can select a hash/target/page, never a filesystem path. */
import {isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {lstat,realpath} from 'node:fs/promises';

type Result={status:number;headers:Record<string,string>;body:unknown};
type ReadApi={handle:(input:{method:string;url:string})=>Promise<Result>};
type RuntimeModules={createDiagnosticFeatureJournal:(options:{directory:string})=>unknown;createDiagnosticFeatureReadApi:(options:{journal:unknown;enabled:boolean;basePath:string})=>ReadApi};
const unavailable=(status:number):Result=>({status,headers:{'Cache-Control':'no-store'},body:{status:'unavailable',diagnosticOnly:true,recordedPrediction:false,eligibleForTraining:false,eligibleForServing:false}});
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
async function plainDirectory(directory:string){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||!same(await realpath(directory),directory))throw Error('plain_local_directory_required');}
export async function loadFeatureDiagnosticModules(appRoot:string):Promise<RuntimeModules>{
 await plainDirectory(appRoot);
 const directory=join(appRoot,'scripts/steam-live-collector/source-adapter');await plainDirectory(directory);
 const journalModule=await import(pathToFileURL(join(directory,'diagnosticFeatureJournal.mjs')).href);
 const apiModule=await import(pathToFileURL(join(directory,'diagnosticFeatureReadApi.mjs')).href);
 if(typeof journalModule.createDiagnosticFeatureJournal!=='function'||typeof apiModule.createDiagnosticFeatureReadApi!=='function')throw Error('diagnostic_reader_modules_unavailable');
 return{createDiagnosticFeatureJournal:journalModule.createDiagnosticFeatureJournal,createDiagnosticFeatureReadApi:apiModule.createDiagnosticFeatureReadApi};
}
export function createFeatureDiagnosticAdminService({environment=()=>process.env,loadModules=loadFeatureDiagnosticModules}:{environment?:()=>NodeJS.ProcessEnv;loadModules?:(root:string)=>Promise<RuntimeModules>}={}){
 let activeKey:string|null=null,pending:Promise<ReadApi>|null=null;
 return Object.freeze({async handle(input:{method:string;url:string}):Promise<Result>{
  const env=environment();
  if(env.AEGIS_FEATURE_DIAGNOSTICS_ENABLED!=='1')return unavailable(404);
  const directory=env.AEGIS_FEATURE_DIAGNOSTICS_DIRECTORY,appRoot=env.AEGIS_FEATURE_DIAGNOSTICS_APP_ROOT;
  if(!directory||!appRoot||!isAbsolute(directory)||!isAbsolute(appRoot)||directory.startsWith('\\\\')||appRoot.startsWith('\\\\'))return unavailable(503);
  if(typeof input.method!=='string'||typeof input.url!=='string'||input.url.length>2048)return unavailable(400);
  const key=JSON.stringify([resolve(directory),resolve(appRoot)]);
  try{
   if(key!==activeKey||pending===null){
    activeKey=key;
    pending=(async()=>{await plainDirectory(resolve(directory));const modules=await loadModules(resolve(appRoot));return modules.createDiagnosticFeatureReadApi({journal:modules.createDiagnosticFeatureJournal({directory:resolve(directory)}),enabled:true,basePath:'/admin/feature-diagnostics'});})();
   }
   return await(await pending).handle(input);
  }catch{pending=null;return unavailable(503);}
 }});
}
export const featureDiagnosticAdmin=createFeatureDiagnosticAdminService();

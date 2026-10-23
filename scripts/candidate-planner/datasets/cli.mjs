#!/usr/bin/env node
/** Explicit local compiler, never emits an approval or dispatches a fit. */
import {readFileSync} from 'node:fs';
import {localFile,digest,sha} from '../evidence.mjs';
import {inspectInputs,compileDataset,verifyDataset} from './compiler.mjs';
const need=(ok,why)=>{if(!ok)throw Error(why);};
function read(path,hash){need(digest(hash),'exact_cli_sha256_required');localFile(path,4*1024**2);const b=readFileSync(path);need(sha(b)===hash,'cli_input_sha_changed');return JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));}
try{
 const [action,...args]=process.argv.slice(2),options={};need(['inspect','compile','verify'].includes(action)&&args.length%2===0,'explicit_cli_action');for(let n=0;n<args.length;n+=2){need(!Object.hasOwn(options,args[n]),'duplicate_cli_option');options[args[n]]=args[n+1];}
 const keys=action==='verify'?['--config','--sha256','--manifest','--manifest-sha256']:['--config','--sha256'];need(JSON.stringify(Object.keys(options).sort())===JSON.stringify(keys.sort()),'exact_cli_options');
 const bundle=read(options['--config'],options['--sha256']),now=new Date().toISOString();let result;
 if(action==='compile')result=compileDataset(bundle,now);
 else if(action==='verify'){const path=options['--manifest'];localFile(path,4*1024**2);const b=readFileSync(path);result=verifyDataset(bundle,{path,bytes:b.length,sha256:options['--manifest-sha256']},now);}
 else{const r=inspectInputs(bundle,now);result={status:'existing_evidence_verified',family:bundle.family,coveredTriggerIds:r.covered,features:r.features.stateFeatures,samples:r.adapter.sampleRows,heads:r.adapter.heads,expectedFamilyNativeFits:r.adapter.heads.length*4,verifiedBytes:r.verifiedBytes,rootReviewRequired:true,ready:false,nativeFits:0,providerCalls:0,featureAlgebraExecuted:false,dispatchEnabled:false,publicPromotion:false};}
 process.stdout.write(JSON.stringify(result)+'\n');
}catch(error){const reason=/^[a-z0-9_]{1,160}$/.test(error?.message)?error.message:['ENOENT','EACCES','EPERM','EEXIST'].includes(error?.code)?error.code:'invalid_local_dataset_evidence';process.stderr.write(JSON.stringify({status:'rejected',reason,nativeFits:0,providerCalls:0,dispatchEnabled:false,publicPromotion:false})+'\n');process.exitCode=1;}

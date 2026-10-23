#!/usr/bin/env node
/** Offline only. No planner registration, dispatch, API calls, or model loading. */
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,existsSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {review,writeReceipt,descriptor,digest,need} from './receipt.mjs';
import {assembleConfig} from './assembly.mjs';

const HELP='Usage: node receipt/cli.mjs verify|write --config ABS --sha256 SHA256\n       node receipt/cli.mjs assemble --input ABS --sha256 SHA256 --output NEW_ABS_CONFIG\nAll evidence is local and pinned. This command never registers a monthly anchor or dispatches training.';
function regularAncestors(file,requireLeaf){
 need(typeof file==='string'&&isAbsolute(file),'absolute_cli_path_required');
 let p=resolve(file),leaf=true;
 while(true){if(existsSync(p)){const s=lstatSync(p);need(!s.isSymbolicLink(),'cli_reparse_path_rejected');need(leaf?!requireLeaf||s.isFile():s.isDirectory(),'cli_regular_path_required');}else need(leaf&&!requireLeaf,'cli_missing_path');const up=dirname(p);if(up===p)break;p=up;leaf=false;}
}
function pinnedJSON(file,expected){
 need(digest(expected),'cli_sha256_required');regularAncestors(file,true);const s=lstatSync(file);need(s.isFile()&&s.size<=4*1024**2,'bounded_cli_input');const b=readFileSync(file);need(createHash('sha256').update(b).digest('hex')===expected,'cli_input_hash_changed');return JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));
}
function parse(argv){
 const [action,...rest]=argv;need(['verify','write','assemble'].includes(action),'cli_action_required');const options={};
 need(rest.length%2===0,'cli_option_value_required');for(let n=0;n<rest.length;n+=2){const key=rest[n];need(key.startsWith('--')&&!Object.hasOwn(options,key),'cli_duplicate_or_invalid_option');options[key]=rest[n+1];}
 const expected=action==='assemble'?['--input','--sha256','--output']:['--config','--sha256'];need(JSON.stringify(Object.keys(options).sort())===JSON.stringify(expected.sort()),'cli_exact_options_required');return{action,options};
}
try{
 if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){process.stdout.write(HELP+'\n');}
 else{
  const {action,options}=parse(process.argv.slice(2)),now=new Date().toISOString();
  if(action==='assemble'){
   regularAncestors(options['--output'],false);need(!existsSync(options['--output']),'new_assembly_config_required');
   const input=pinnedJSON(options['--input'],options['--sha256']),result=assembleConfig(input,now);
   need(!input.stopMarkerPaths.some(p=>existsSync(p)),'manual_stop_before_config');
   writeFileSync(options['--output'],JSON.stringify(result.config,null,2)+'\n',{flag:'wx',encoding:'utf8'});
   process.stdout.write(JSON.stringify({...result.summary,config:descriptor(options['--output'])})+'\n');
  }else{
   const config=pinnedJSON(options['--config'],options['--sha256']);
   if(action==='verify'){const r=review(config,now);process.stdout.write(JSON.stringify({status:'complete_evidence_verified',policyId:config.policyId,intentId:config.intentId,closedFits:r.summaries.length,families:Object.keys(r.familyReports).length,completedAt:r.completedAt,verifiedAt:now,newNativeFits:0,providerCalls:0,modelLoads:0,monthlyAnchorCreated:false,receiptWritten:false,publicPromotion:false})+'\n');}
   else{const r=writeReceipt(config,now);process.stdout.write(JSON.stringify({status:'receipt_written',...r,newNativeFits:0,providerCalls:0,modelLoads:0,monthlyAnchorCreated:false,plannerRegistrationChanged:false,publicPromotion:false})+'\n');}
  }
 }
}catch(error){const reason=error?.code&&['ENOENT','EACCES','EPERM','EEXIST'].includes(error.code)?error.code:/^[a-z0-9_]{1,160}$/.test(error?.message)?error.message:'invalid_or_incomplete_local_evidence';process.stderr.write(JSON.stringify({status:'rejected',reason,newNativeFits:0,providerCalls:0,monthlyAnchorCreated:false,publicPromotion:false})+'\n');process.exitCode=1;}

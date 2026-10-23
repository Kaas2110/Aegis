/** Explicit bounded task-capable CLI. No default run, autorun, task registration or retry. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {boundedFile,sha} from './store.mjs';
import {validateConfig,runCycle} from './collector.mjs';
export function argumentsFor(argv){
 const o={};for(let i=0;i<argv.length;i++){const arg=argv[i];if(['--once','--loop'].includes(arg)){if(o.mode)throw Error('one_explicit_mode_required');o.mode=arg;}else if(['--config','--config-sha256'].includes(arg)&&argv[i+1]&&!o[arg])o[arg]=argv[++i];else throw Error('explicit_mode_config_pin_required');}
 if(!o.mode||!o['--config']||! /^[a-f0-9]{64}$/.test(o['--config-sha256']??''))throw Error('explicit_mode_config_pin_required');return o;
}
export async function main(argv=process.argv.slice(2),dependencies={}){
 const {cycle=runCycle,sleep=delay,...cycleDependencies}=dependencies;
 const o=argumentsFor(argv),bytes=boundedFile(o['--config']);if(sha(bytes)!==o['--config-sha256'])throw Error('config_pin_changed');const config=validateConfig(JSON.parse(bytes));
 const controller=new AbortController(),start=Date.now(),wallTimer=setTimeout(()=>controller.abort(),config.wallCapSeconds*1000);let attempted=0,last=null,busyDeferrals=0;
 const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  do {
   if(controller.signal.aborted)break;
   last=await cycle(config,{...cycleDependencies,signal:controller.signal});if(last.attempted)attempted++;
   if(last.reason==='collector_lock_busy'){busyDeferrals++;if(busyDeferrals>3){last={...last,reason:'collector_lock_requires_manual_review',requiresManualReview:true};}}else busyDeferrals=0;
   // Only a fixed safe summary reaches stdout. Raw provider errors/headers never do.
   console.log(JSON.stringify({status:last.status,reason:last.reason??null,attempted:last.attempted,requestId:last.requestId??null,nextAttemptAt:last.nextAttemptAt??null,diagnosticOnly:true,servingEnabled:false}));
   if(o.mode==='--once'||attempted>=config.maxRequests||last.status==='blocked'&&!['cadence_or_backoff','collector_lock_busy'].includes(last.reason)||last.requiresManualReview||[403,429].includes(last.httpStatus))break;
   const remaining=start+config.wallCapSeconds*1000-Date.now(),wait=Math.max(1000,Date.parse(last.nextAttemptAt??'')-Date.now());if(!Number.isFinite(wait)||wait>=remaining)break;
   try{await sleep(wait,undefined,{signal:controller.signal});}catch{break;}
  }while(!controller.signal.aborted);
  return controller.signal.aborted?130:last?.status==='blocked'?10:last?.status==='degraded'?20:0;
 }finally{clearTimeout(wallTimer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{process.exitCode=await main();}catch{console.error('steam_diagnostic_collector_failed');process.exitCode=1;}}

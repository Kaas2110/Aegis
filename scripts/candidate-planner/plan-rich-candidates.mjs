/** One local intent-planning cycle; never schedules timers or starts native fits. */
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {plan,DEFAULT_POLICY,timestamp} from './candidate-planner.mjs';
import {loadLedger,savePlan} from './planner-store.mjs';
import {officialFromSaved,readVerified,evaluationReceipts,bytesHash} from './saved-inputs.mjs';
import {produceInputs} from './produce-inputs.mjs';
export function runOnce(config,now){
 const explicitNow=now;now??=new Date().toISOString();
 if(!isAbsolute(config.stateDir)||!isAbsolute(config.outputDir)||config.stateDir===config.outputDir)throw Error('separate_absolute_state_and_planner_dirs_required');
 const ledger=loadLedger(config.outputDir);let receipts=[],receiptProblem=null;
 try{receipts=evaluationReceipts(config.evaluationReceipts??[]);}catch{receiptProblem='blocked_evaluation_receipt_verification';}
 const get=key=>{try{return readVerified(config[key]);}catch{return null;}};
 const policy=config.policy??DEFAULT_POLICY,official=officialFromSaved(config.stateDir),base={now,policy,official,...ledger,evaluationReceipts:receipts,inputValidationProblems:receiptProblem?[receiptProblem]:[]};
 let observed={manualControl:get('manualControl'),fitObservation:get('fitObservation'),dataReadiness:get('dataReadiness'),runnerBindings:get('runnerBindings')};
 if(config.producerConfig){
  if(explicitNow!==undefined)throw Error('dynamic_producers_require_real_clock');
  if(['manualControl','fitObservation','dataReadiness','runnerBindings'].some(k=>config[k]!=null))throw Error('mixed_snapshot_and_dynamic_producers_rejected');
  // Derive trigger identity first; this planning pass is pure and is never persisted.
  const preview=plan({...base,...observed}),intent=preview.newIntents.find(i=>i.intentId===preview.currentIntentId)??ledger.intents.find(i=>i.intentId===preview.currentIntentId)??null;
  try{observed=produceInputs(config.producerConfig,undefined,intent);base.now=new Date().toISOString();}catch(error){base.inputValidationProblems.push('blocked_producer_verification:'+(/^[a-z0-9_:.]+$/i.test(error.message)?error.message:'producer_operation_failed'));observed={};}
 }
 const report=plan({...base,...observed});
 savePlan(config.outputDir,report);return report;
}
export function main(argv=process.argv.slice(2)){
 const options={};for(let i=0;i<argv.length;i+=2){if(!['--config','--config-sha256','--now'].includes(argv[i])||!argv[i+1])throw Error('config_and_hash_required');options[argv[i]]=argv[i+1];}
 options['--config']??=process.env.AEGIS_CANDIDATE_PLANNER_CONFIG;options['--config-sha256']??=process.env.AEGIS_CANDIDATE_PLANNER_CONFIG_SHA256;
 if(!options['--config']||!options['--config-sha256']){console.log(JSON.stringify({status:'blocked',reason:'blocked_planner_config_unavailable',nativeFits:0,publicPromotion:false}));return 10;}
 const b=readFileSync(options['--config']);if(b.length>1024**2||bytesHash(b)!==options['--config-sha256'])throw Error('planner_config_pin');
 const report=runOnce(JSON.parse(b),options['--now']);console.log(JSON.stringify(report));return report.status==='blocked'?10:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{process.exitCode=main();}catch(error){console.error('candidate_planner_failed:'+error.message);process.exitCode=1;}}

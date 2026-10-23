/** One bounded observation cycle. No native fit, schedule mutation or provider. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fileHash,fresh,pinned,sha,valueSha} from './evidence.mjs';
import {observeFit,observeManual} from './observations.mjs';
import {observeBindings,observeReadiness} from './readiness.mjs';
const H=dirname(fileURLToPath(import.meta.url));
export function collectHost(spec,config){
 if(process.platform!=='win32')throw Error('windows_observer_required');
 if(config.hostCollectorSha256!==fileHash(join(H,'collect-host.ps1')))throw Error('host_collector_source_pin');
 const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 // Windows PowerShell must not inherit pwsh7-only module search paths.
 const env={...process.env,PSModulePath:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
 let b;try{b=execFileSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(H,'collect-host.ps1'),'-ConfigPath',spec.path,'-ConfigSha256',spec.sha256],{env,windowsHide:true,shell:false,timeout:30000,maxBuffer:4*1024**2,stdio:['ignore','pipe','pipe']});}catch{throw Error('host_observation_command_failed');}
 return JSON.parse(b.toString('utf8').replace(/^\uFEFF/,''));
}
export function produceInputs(spec,now,intent,{hostCollector=collectHost,saveEvidence=true}={}){
 const config=pinned(spec);if(config.contract!=='aegis.candidate-producers.v1'||!isAbsolute(config.evidenceDir)||!Array.isArray(config.nativeLockPaths)||!config.nativeLockPaths.length||config.nativeLockPaths.length>64||!Array.isArray(config.lifecycle)||config.lifecycle.length>128)throw Error('producer_configuration_contract');
 const host=hostCollector(spec,config);now??=new Date().toISOString();if(!fresh(host.observedAt,now))throw Error('fresh_host_observation_required');
 const manualControl=observeManual(config,host,now),fitObservation=observeFit(config,host,now),dataReadiness=observeReadiness(config,intent,now),runnerBindings=observeBindings(config,dataReadiness,now);
 const inputs={manualControl,fitObservation,dataReadiness,runnerBindings};
 if(saveEvidence){
  const directory=join(config.evidenceDir,new Date().toISOString().replaceAll(':','-')+'-'+randomUUID());mkdirSync(directory,{recursive:true});
  for(const [name,doc] of Object.entries({HOST:host,...inputs}))writeFileSync(join(directory,name+'.json'),JSON.stringify(doc,null,2)+'\n',{flag:'wx',flush:true});
  writeFileSync(join(directory,'RECEIPT.json'),JSON.stringify({contract:config.contract,producerConfigSha256:spec.sha256,observedAt:now,hostSha256:valueSha(host),inputsSha256:valueSha(inputs),nativeFits:0,taskMutations:0,processMutations:0,monthlyAnchorCreated:false},null,2)+'\n',{flag:'wx',flush:true});
 }
 return inputs;
}
export function main(argv=process.argv.slice(2)){
 if(argv.length!==6||argv[0]!=='--config'||argv[2]!=='--sha256'||argv[4]!=='--intent')throw Error('usage_config_sha256_intent');
 const intent=JSON.parse(readFileSync(argv[5],'utf8'));const now=new Date().toISOString();const result=produceInputs({path:resolve(argv[1]),sha256:argv[3]},now,intent);console.log(JSON.stringify(result));return 0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{process.exitCode=main();}catch(e){console.error('candidate_observation_failed:'+e.message);process.exitCode=1;}}

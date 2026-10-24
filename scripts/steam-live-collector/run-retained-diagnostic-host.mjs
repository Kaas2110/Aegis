/** Run only with an explicitly supplied local config. No schedules/listeners. */
import {readRetainedDiagnosticHostConfig,runRetainedDiagnosticHost} from './source-adapter/retainedDiagnosticHost.mjs';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--config'){
 process.stderr.write('Usage: node scripts/steam-live-collector/run-retained-diagnostic-host.mjs --config <absolute-local-config.json>\n');process.exitCode=2;
}else{
 const control=new AbortController(),abort=()=>control.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
 try{
  const config=await readRetainedDiagnosticHostConfig(args[1]);
  let pipelineFactory;
  if(config.enabled===true)pipelineFactory=(await import('./source-adapter/retainedDiagnosticBootstrap.mjs')).createRetainedDiagnosticHostPorts;
  const out=await runRetainedDiagnosticHost(config,{pipelineFactory,signal:control.signal});
  process.stdout.write(JSON.stringify(out)+'\n');if(['failed','blocked'].includes(out.status))process.exitCode=1;
 }catch{process.stderr.write('Retained diagnostic host configuration or local evidence unavailable.\n');process.exitCode=1;}
 finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}

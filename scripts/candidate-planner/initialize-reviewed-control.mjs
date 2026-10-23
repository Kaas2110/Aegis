/** Root-invoked one-time initialization, never called by observer or executor. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pinned} from './evidence.mjs';
import {initializeControlJournal} from './persistent-policies.mjs';
export function main(args=process.argv.slice(2)){
 if(args.length!==7||args[0]!=='--initialize-reviewed-control-state')throw Error('explicit_initialize_policy_path_sha_config_path_sha_host_path_sha_required');
 const spec={path:resolve(args[1]),sha256:args[2]},config=pinned({path:resolve(args[3]),sha256:args[4]}),host=pinned({path:resolve(args[5]),sha256:args[6]});
 if(config.manualControlReceipt||config.persistentCandidateControlPolicy?.path!==spec.path||config.persistentCandidateControlPolicy?.sha256!==spec.sha256)throw Error('exact_configured_control_authority_required');
 const state=initializeControlJournal(spec,config,new Date().toISOString(),host);
 console.log(JSON.stringify({status:'EXPLICIT_REVIEWED_STATE_INITIALIZED',policySha256:spec.sha256,sequence:state.sequence,taskMutations:0,nativeFits:0,dispatchEnabled:false}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main();}catch{console.error('reviewed_control_initialization_refused');process.exitCode=10;}}

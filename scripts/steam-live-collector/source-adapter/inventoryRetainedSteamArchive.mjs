/** Explicit retained-only CLI. Root supplies its owned process/memory guard.
 * No provider clients, credentials, DB connection or background task. */
import {writeFile,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,isAbsolute,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inventoryRetainedSteamArchive} from './retainedSteamArchiveIntake.mjs';

export async function main(args){
 const flags=new Map(),allowed=new Set(['--archive','--report','--max-captures','--max-read-mib','--stop-file']);for(let i=0;i<args.length;i++){const key=args[i];if(!allowed.has(key)||flags.has(key)||i+1>=args.length)throw Error('inventory_arguments');flags.set(key,args[++i]);}
 const archive=flags.get('--archive'),reportPath=flags.get('--report'),stopFile=flags.get('--stop-file')??null;if(!isAbsolute(archive??'')||!isAbsolute(reportPath??'')||stopFile!==null&&!isAbsolute(stopFile))throw Error('inventory_absolute_paths');
 const parent=await lstat(dirname(reportPath));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('inventory_plain_output_parent');
 const limits={};if(flags.has('--max-captures'))limits.maxCaptures=Number(flags.get('--max-captures'));if(flags.has('--max-read-mib'))limits.maxTotalReadBytes=Number(flags.get('--max-read-mib'))*1024**2;
 const report=await inventoryRetainedSteamArchive({archive,limits,shouldContinue:()=>stopFile===null||!existsSync(stopFile)});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
 const summary={contract:report.contract,complete:report.complete,capturesEnumerated:report.capturesEnumerated,capturesVerified:report.capturesVerified,capturesRejected:report.capturesRejected,capturesDegraded:report.capturesDegraded,observationsVerified:report.observationsVerified,maps:report.maps.length,receiptSpan:report.receiptSpan,inventorySha256:report.inventorySha256,providerCalls:0,trainingRuns:0,source95Claimed:false};console.log(JSON.stringify(summary));return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main(process.argv.slice(2)).catch(()=>{console.error('retained_steam_inventory_failed; no provider call or source mutation performed');process.exitCode=1;});

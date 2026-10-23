import {build} from '../artifacts/api-server/node_modules/esbuild/lib/main.js';
import {spawnSync} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');const output=await mkdtemp(path.join(tmpdir(),'aegis-totals-tests-'));const fixture=path.join(root,'tests/fixtures/totals-serving.ts');
const alias={name:'offline-totals',setup(b){b.onResolve({filter:/^(?:@workspace\/db|drizzle-orm)$|\/(?:ProviderFeeds|LiveWinnerModel|PredictionModel|MarketLgbm)$/},()=>({path:fixture}));}};
try{
 await build({entryPoints:[path.join(root,'tests/totals-serving.test.ts')],outfile:path.join(output,'totals-serving.cjs'),platform:'node',format:'cjs',bundle:true,plugins:[alias],logLevel:'warning'});
 await build({entryPoints:['tests/totals-distribution.test.ts','tests/prediction-contract.test.ts','tests/bookmaker-selection.test.ts'].map(p=>path.join(root,p)),outdir:output,platform:'node',format:'cjs',bundle:true,logLevel:'warning'});
 const r=spawnSync(process.execPath,['--test',path.join(output,'totals-serving.cjs'),path.join(output,'totals-distribution.test.js'),path.join(output,'prediction-contract.test.js'),path.join(output,'bookmaker-selection.test.js')],{stdio:'inherit',env:{...process.env,NODE_ENV:'production'}});process.exitCode=r.status??1;
}finally{await rm(output,{recursive:true,force:true});}

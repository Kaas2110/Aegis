import {build} from '../artifacts/api-server/node_modules/esbuild/lib/main.js';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const output=await mkdtemp(path.join(tmpdir(),'aegis-observed-draft-tests-'));
const fixture=path.join(root,'tests/fixtures/serving-observed-draft.ts');
try {
 await build({entryPoints:[path.join(root,'tests/serving-observed-draft.test.ts')],outdir:output,platform:'node',format:'cjs',bundle:true,
   plugins:[{name:'offline-fixtures',setup(b){
    b.onResolve({filter:/^@workspace\/db$/},()=>({path:fixture}));
    b.onResolve({filter:/\/(ProviderFeeds|PredictionModel|LiveWinnerModel|MarketLgbm)$/},()=>({path:fixture}));
   }}],logLevel:'warning'});
 process.exitCode=spawnSync(process.execPath,['--test',path.join(output,'serving-observed-draft.test.js')],{stdio:'inherit'}).status??1;
} finally {await rm(output,{recursive:true,force:true});}

import {build} from '../artifacts/api-server/node_modules/esbuild/lib/main.js';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const output=await mkdtemp(path.join(tmpdir(),'aegis-background-tests-'));
const fixtures=path.join(root,'tests/fixtures');
const alias={name:'offline-fixtures',setup(b){
 b.onResolve({filter:/^@workspace\/db$/},()=>({path:path.join(fixtures,'background-feed-db.ts')}));
 b.onResolve({filter:/\/ProviderFeeds$/},()=>({path:path.join(fixtures,'background-feed-provider.ts')}));
 b.onResolve({filter:/\/AppSettings$/},()=>({path:path.join(fixtures,'background-feed-settings.ts')}));
 b.onResolve({filter:/\/logger$/},()=>({path:path.join(fixtures,'background-feed-logger.ts')}));
}};
try {
 await build({entryPoints:['tests/background-feed.test.ts','tests/background-only-routes.test.ts','tests/background-quota.test.ts'].map(p=>path.join(root,p)),outdir:output,platform:'node',format:'cjs',bundle:true,plugins:[alias],logLevel:'warning'});
 const result=spawnSync(process.execPath,['--test',path.join(output,'background-feed.test.js'),path.join(output,'background-only-routes.test.js'),path.join(output,'background-quota.test.js')],{stdio:'inherit',env:{...process.env,BOOKMAKERS_ENABLED:'true',BOOKMAKER_SOURCES:'bovada'}});
 process.exitCode=result.status??1;
}finally{await rm(output,{recursive:true,force:true});}

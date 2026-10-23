import {build} from '../artifacts/api-server/node_modules/esbuild/lib/main.js';
import {spawnSync} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');const output=await mkdtemp(path.join(tmpdir(),'aegis-api-db-pool-tests-'));
try{
 const file=path.join(output,'api-db-pool.test.cjs');
 await build({entryPoints:[path.join(root,'tests/api-db-pool.test.ts')],outfile:file,platform:'node',format:'cjs',bundle:true,external:['pg-native'],logLevel:'warning'});
 const result=spawnSync(process.execPath,['--test',file],{stdio:'inherit',env:process.env});process.exitCode=result.status??1;
}finally{await rm(output,{recursive:true,force:true});}

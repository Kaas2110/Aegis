import {build} from '../artifacts/api-server/node_modules/esbuild/lib/main.js';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const dir=await mkdtemp(path.join(tmpdir(),'aegis-market-expiry-'));
try{
 const output=path.join(dir,'test.cjs');
 await build({entryPoints:[path.join(import.meta.dirname,'market-expiry.test.ts')],outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'warning'});
 process.exitCode=spawnSync(process.execPath,['--test',output],{stdio:'inherit'}).status??1;
}finally{await rm(dir,{recursive:true,force:true});}

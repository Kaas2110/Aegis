/** Explicitly configured Windows OS lease port. Nothing launches at import.
 * Callers supply an absolute approved Python executable; no PATH discovery or
 * shell. The child is owned, hidden, finite-startup and closes with the writer.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createOwnedArtifactWriterLeaseProvider} from './artifactWriterLease.mjs';
const helper=fileURLToPath(new URL('./artifactWriterLeaseWindows.py',import.meta.url));
const fail=x=>{throw Error('windows_artifact_lease:'+x);};
export function createWindowsArtifactWriterLeaseProvider({pythonExecutable,timeoutMs=5000}={}){
 if(process.platform!=='win32')fail('windows_required');
 if(typeof pythonExecutable!=='string'||!path.isAbsolute(pythonExecutable)||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>5000)fail('configuration');
 return createOwnedArtifactWriterLeaseProvider({acquireExclusive:async({directory})=>{
  const child=spawn(pythonExecutable,['-I',helper,directory],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot||'',WINDIR:process.env.WINDIR||'',PYTHONIOENCODING:'utf-8'}});
  let stopped=false,buffer='',id=0,pending=null;
  let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  function rejectAll(reason){stopped=true;const e=Error('windows_artifact_lease:'+reason);readyReject(e);if(pending){clearTimeout(pending.timer);pending.reject(e);pending=null;}}
  function abort(reason){if(stopped)return;rejectAll(reason);child.stdin.destroy();if(child.exitCode===null)child.kill();}
  const timer=setTimeout(()=>abort('startup_timeout'),timeoutMs);
  child.on('error',()=>abort('spawn_failed'));child.on('exit',()=>{clearTimeout(timer);rejectAll('released_or_exited');});
  child.stdin.on('error',()=>abort('pipe_failed'));
  child.stderr.on('data',()=>{});
  child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
   buffer+=chunk;if(buffer.length>8192){abort('protocol_limit');return;}
   while(buffer.includes('\n')){const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);let value;try{value=JSON.parse(line);}catch{abort('protocol_json');return;}
    if(value.error){abort('acquire_or_assert_failed');return;}
    if(value.ready===true&&value.contract==='aegis.windows-held-artifact-lease.v1'){clearTimeout(timer);readyResolve();continue;}
    if(!pending||value.id!==pending.id){abort('protocol_identity');return;}
    const p=pending;pending=null;clearTimeout(p.timer);p.resolve(value);
   }
  });
  await ready;
  async function request(operation){
   if(stopped||pending)fail('not_held_or_concurrent_request');
   return new Promise((resolve,reject)=>{const current=++id;pending={id:current,resolve,reject,timer:setTimeout(()=>abort('request_timeout'),timeoutMs)};child.stdin.write(JSON.stringify({id:current,operation})+'\n',error=>{if(error)abort('pipe_failed');});});
  }
  return Object.freeze({assertHeld:async()=>{const value=await request('assert');if(value.held!==true)fail('not_held');},release:async()=>{
   if(stopped)return;try{await request('release');}finally{stopped=true;child.stdin.end();}
   if(child.exitCode===null)await new Promise(resolve=>{const expiry=setTimeout(()=>{if(child.exitCode===null)child.kill();resolve();},timeoutMs);child.once('exit',()=>{clearTimeout(expiry);resolve();});});
  }});
 }});
}

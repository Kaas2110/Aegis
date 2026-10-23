/** Bounded local metadata pins only. No APP imports or activation. */
import {createHash}from'node:crypto';
import {openSync,closeSync,fstatSync,readSync,lstatSync,realpathSync}from'node:fs';
import {isAbsolute,resolve}from'node:path';
import {CONTRACT,record,verifyComponentFolds}from'./strict_folds.mjs';
export const MANIFEST_CONTRACT='aegis.whole-component-fold-manifest.v2';
const MAX_FILE=32*1024*1024,MAX_TOTAL=128*1024*1024;
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function pinned(spec,budget){
 record(spec,['path','bytes','sha256'],'pin_shape');
 need(typeof spec.path==='string'&&isAbsolute(spec.path)&&Number.isSafeInteger(spec.bytes)&&spec.bytes>0&&spec.bytes<=MAX_FILE&&/^[0-9a-f]{64}$/.test(spec.sha256),'bounded_absolute_pin_required');
 need((budget.used+=spec.bytes)<=MAX_TOTAL,'metadata_total_limit');
 need(lstatSync(spec.path).isFile()&&!lstatSync(spec.path).isSymbolicLink()&&resolve(realpathSync(spec.path)).toLowerCase()===resolve(spec.path).toLowerCase(),'regular_unaliased_metadata_file_required');
 const fd=openSync(spec.path,'r');let bytes;
 try{
  need(fstatSync(fd).size===spec.bytes,'metadata_size_changed');
  const buffer=Buffer.alloc(spec.bytes+1);let offset=0,count;
  while(offset<buffer.length&&(count=readSync(fd,buffer,offset,buffer.length-offset,null))>0)offset+=count;
  need(offset===spec.bytes,'metadata_size_changed');bytes=buffer.subarray(0,offset);
 }finally{closeSync(fd);}
 need(sha(bytes)===spec.sha256,'metadata_sha_changed');
 return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
}
export function verifyBoundManifest(manifestSpec){
 const budget={used:0},m=pinned(manifestSpec,budget);
 record(m,['contract','family','scope','componentMembers','mapRows','folds','candidateOnly','fitAuthorized','dispatchEnabled','publicPromotion']);
 need(m.contract===MANIFEST_CONTRACT&&m.candidateOnly===true&&m.fitAuthorized===false&&m.dispatchEnabled===false&&m.publicPromotion===false,'metadata_candidate_manifest_required');
 const result=verifyComponentFolds({contract:CONTRACT,family:m.family,scope:m.scope,componentMembers:pinned(m.componentMembers,budget),mapRows:pinned(m.mapRows,budget),folds:pinned(m.folds,budget)});
 return {...result,manifestSha256:manifestSpec.sha256,metadataBytesVerified:budget.used,bindings:{componentMembersSha256:m.componentMembers.sha256,mapRowsSha256:m.mapRows.sha256,foldsSha256:m.folds.sha256,sourceManifestSha256:m.scope.sourceManifestSha256,componentIdentityPolicySha256:m.scope.componentIdentityPolicySha256,protectionPolicySha256:m.scope.protectionPolicySha256}};
}

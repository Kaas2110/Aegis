/** Optional admin diagnostics from one root-approved, finite worker namespace.
 * Authorization covers the producer/configuration, never individual predictions.
 * No provider, model, database, task or public-serving imports.
 */
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,opendirSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {Options,Saved} from './ExactHazardCurrent';
type Obj=Record<string,any>;
type Ref={path:string;bytes:number;sha256:string};
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const object=(v:unknown):v is Obj=>!!v&&typeof v==='object'&&!Array.isArray(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown,min=1,max=Number.MAX_SAFE_INTEGER):v is number=>
  typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
function need(ok:unknown,why:string):asserts ok{if(!ok)throw Error('finite_hazard_'+why);}
const normalized=(p:string)=>resolve(p).toLowerCase();
const samePath=(a:string,b:string)=>normalized(a)===normalized(b);
const stamp=(s:unknown)=>typeof s==='string'?Date.parse(s):NaN;
function safePath(file:unknown):asserts file is string{
  need(typeof file==='string'&&isAbsolute(file)&&!file.includes('\0'),'absolute_path');
  let p=resolve(file);
  for(;;){
    const s=lstatSync(p);need(!s.isSymbolicLink(),'reparse_path');
    need(normalized(realpathSync(p))===normalized(p),'redirected_path');
    const parent=dirname(p);if(parent===p)break;p=parent;
  }
}
function contained(base:string,file:string){
  const rel=relative(resolve(base),resolve(file));
  need(rel!==''&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep),'path_containment');
}
function stableBytes(file:unknown,max:number):Buffer{
  safePath(file);const before=lstatSync(file,{bigint:true});
  need(before.isFile()&&before.size>0n&&before.size<=BigInt(max),'file_bound');
  const b=readFileSync(file),after=lstatSync(file,{bigint:true});
  need(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&
    before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs&&BigInt(b.length)===before.size,'file_changed');
  safePath(file);return b;
}
function pinned(ref:unknown,max:number):{value:Obj;bytes:Buffer}{
  need(object(ref)&&typeof ref.path==='string'&&integer(ref.bytes,1,max)&&hex(ref.sha256),'ref_contract');
  const b=stableBytes(ref.path,max);need(b.length===ref.bytes&&hash(b)===ref.sha256,'ref_pin');
  const v:unknown=JSON.parse(b.toString('utf8'));need(object(v),'object');return {value:v,bytes:b};
}
const disabled=(v:Obj)=>['active','eligibleForServing','eligibleForPromotion','eligibleForQualityClaims',
  'coverage95Validated','eventLatencyVerified'].every(k=>v[k]===false);

/** Check canonical key order/duplicate keys without reserializing Python floats.
 * Python keeps e.g. 1.0 and escapes Unicode; JS would otherwise change the digest.
 * The exact original result token span, plus LF, is what the worker hashes.
 */
export function parseFiniteEnvelope(bytes:Buffer):{envelope:Obj;resultSha256:string}{
  const s=bytes.toString('utf8');need(Buffer.from(s,'utf8').equals(bytes)&&s.endsWith('\n'),'utf8_newline');
  let i=0,tokens=0,resultRaw:string|null=null;
  function string():string{
    need(s[i]==='"','json_string');const start=i++;
    while(i<s.length){
      const c=s[i++]!;if(c==='"')return JSON.parse(s.slice(start,i)) as string;
      if(c==='\\')i++;else need(c.charCodeAt(0)>=32&&c.charCodeAt(0)<=127,'canonical_ascii');
    }throw Error('finite_hazard_unfinished_string');
  }
  function value(depth:number):void{
    need(depth<=80&&++tokens<=2_000_000,'json_bound');
    if(s[i]==='{'){
      i++;let previous:string|null=null;
      if(s[i]==='}'){i++;return;}
      for(;;){
        const key=string();need(/^[\x00-\x7f]*$/.test(key)&&(previous===null||key>previous),'duplicate_or_unsorted_key');
        previous=key;need(s[i++]===':','json_colon');const start=i;value(depth+1);
        if(depth===0&&key==='result')resultRaw=s.slice(start,i);
        const end=s[i++];if(end==='}')break;need(end===',','json_object');
      }return;
    }
    if(s[i]==='['){
      i++;if(s[i]===']'){i++;return;}
      for(;;){value(depth+1);const end=s[i++];if(end===']')break;need(end===',','json_array');}return;
    }
    if(s[i]==='"'){string();return;}
    for(const literal of ['null','true','false'])if(s.startsWith(literal,i)){i+=literal.length;return;}
    const m=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    need(m&&Number.isFinite(Number(m[0])),'json_number');i+=m[0].length;
  }
  value(0);need(i===s.length-1&&resultRaw!==null,'canonical_complete');
  const envelope:unknown=JSON.parse(s);need(object(envelope),'envelope_object');
  return {envelope,resultSha256:hash(resultRaw+'\n')};
}
function listResults(directory:string,max:number):string[]{
  safePath(directory);need(lstatSync(directory).isDirectory(),'output_directory');
  const handle=opendirSync(directory),result:string[]=[];let count=0;
  try{
    for(;;){
      const e=handle.readSync();if(!e)break;need(++count<=8192,'directory_entry_bound');
      if(e.name.startsWith('.RESULT-')||e.name.startsWith('RESULT-')){
        need(/^RESULT-000[1-8]-[a-f0-9]{64}\.json$/.test(e.name)&&e.isFile()&&!e.isSymbolicLink(),'partial_or_invalid_result');
        result.push(e.name);need(result.length<=max,'result_count_bound');
      }
    }
  }finally{handle.closeSync();}
  result.sort();
  result.forEach((n,index)=>need(Number(n.slice(7,11))===index+1,'noncontiguous_results'));
  need(result.length>0,'no_result');return result;
}
function controls(c:Obj){
  need(typeof c.stopFile==='string'&&isAbsolute(c.stopFile),'stop_path');
  safePath(dirname(c.stopFile));need(!existsSync(c.stopFile),'manual_stop');
  const control=JSON.parse(stableBytes(c.controlFile,65536).toString('utf8'));
  need(control.version===1&&control.enabled===true&&control.paused===false,'manual_control');
}
function guardEvidence(r:Obj,mid:number,publishedAt:number){
  const g=r.knownOutcomeGuard;
  need(object(g)&&g.contract==='c2_phase_before_after_outcome_presence.v1'&&
    g.outcomeValuesInFeatures===false,'source_outcome_guard');
  for(const key of ['before','after']){
    const p=g[key];need(object(p)&&p.contract==='local_known_outcome_presence.v1'&&
      p.matchId===mid&&p.known===false&&p.readOnly===true&&p.outcomeValueRead===false&&
      Number.isFinite(stamp(p.checkedAt))&&stamp(p.checkedAt)<=publishedAt,'source_outcome_presence');
  }
  need(stamp(g.before.checkedAt)<=stamp(g.after.checkedAt),'source_outcome_order');
}
export function readFiniteAuthorizedResult(options:Options,env:NodeJS.ProcessEnv,
  validate:(envelope:Obj,identity:Obj)=>Saved,now:()=>number=Date.now):Saved {
  need(env.AEGIS_EXACT_HAZARD_FINITE_CONFIG&&hex(env.AEGIS_EXACT_HAZARD_FINITE_CONFIG_SHA256),'policy_unconfigured');
  const policyPath=env.AEGIS_EXACT_HAZARD_FINITE_CONFIG;
  const policyBytes=stableBytes(policyPath,65536);
  need(hash(policyBytes)===env.AEGIS_EXACT_HAZARD_FINITE_CONFIG_SHA256,'policy_pin');
  const policyValue:unknown=JSON.parse(policyBytes.toString('utf8'));
  need(object(policyValue),'policy_object');const policy=policyValue;
  need(policy.contract==='aegis.approved-finite-exact-hazard-producer.v1'&&
    policy.rootApproved===true&&policy.approvedBy==='root'&&policy.diagnosticOnly===true&&
    policy.publicPromotion===false&&integer(policy.maxResults,1,8)&&typeof policy.namespaceId==='string'&&
    /^[a-f0-9]{32}$/.test(policy.namespaceId),'policy_authorization');
  const policyNow=()=>need(Number.isFinite(now())&&Number.isFinite(stamp(policy.approvedAt))&&
    Number.isFinite(stamp(policy.expiresAt))&&stamp(policy.approvedAt)<=now()&&now()<stamp(policy.expiresAt)&&
    stamp(policy.expiresAt)-stamp(policy.approvedAt)<=7200_000,'policy_expired_or_future');
  policyNow();
  const wc=pinned(policy.workerConfig,100000),c=wc.value;
  need(c.contract==='c2_finite_phase_standalone_worker.v1'&&c.enabled===true&&c.rootReviewed===true&&
    c.approvedBy==='root'&&c.diagnosticInferenceAuthorized===true&&c.ownedJobCallerRequired===true&&
    c.maxNotifications===policy.maxResults,'worker_config_authorization');
  const p=c.publication;
  need(object(p)&&p.contract==='c2_finite_publication_scope.v1'&&p.namespaceId===policy.namespaceId&&
    p.workerSourceManifestSha256===policy.workerSourceManifest?.sha256&&
    p.approvedAt===policy.approvedAt&&p.expiresAt===policy.expiresAt&&
    typeof policy.outputDirectory==='string'&&samePath(c.outputDirectory,policy.outputDirectory),'worker_publication_scope');
  const source=pinned(policy.workerSourceManifest,65536),sourceRoot=dirname(policy.workerSourceManifest.path);
  need(source.value.contract==='c2_finite_publication_source.v1'&&object(source.value.files)&&
    Object.keys(source.value.files).sort().join('|')===
      ['EXECUTED-SOURCE-PINS.json','finite_publication.py','safe_failures.py','worker.py'].sort().join('|'),'worker_source_allowlist');
  const sourcePins:Ref[]=[];
  for(const [name,x] of Object.entries(source.value.files)){
    need(object(x),'worker_source_ref');const file=join(sourceRoot,name);contained(sourceRoot,file);
    const b=stableBytes(file,2*1024*1024);need(b.length===x.bytes&&hash(b)===x.sha256,'worker_source_pin');
    sourcePins.push({path:file,bytes:b.length,sha256:hash(b)});
  }
  const phase=pinned(c.receiptPhaseConfig,65536).value,intake=pinned(c.steamIntakeConfig,65536).value;
  need(phase.contract==='c2_steam_receipt_phase_hook.v2'&&phase.rootReviewed===true&&phase.enabled===true&&
    phase.approvedBy==='root'&&hex(phase.hookSourceManifestSha256),'phase_scope');
  need(intake.contract==='c2_steam_phase_committed_intake_startup.v1'&&intake.rootReviewed===true&&
    intake.enabled===true&&intake.approvedBy==='root'&&intake.maxNotifications===policy.maxResults,'intake_scope');
  controls(c);
  const directory=resolve(c.outputDirectory),selected=listResults(directory,policy.maxResults);
  const invocationBytes=stableBytes(join(directory,'INVOCATION.json'),65536);
  const invocation=JSON.parse(invocationBytes.toString('utf8'));
  function authorization(a:unknown){
    need(object(a)&&a.contract==='c2_finite_producer_authorization.v1'&&a.kind==='root_approved_finite_producer'&&
      a.individualResultReviewed===false&&a.namespaceId===policy.namespaceId&&
      a.configSha256===policy.workerConfig.sha256&&a.workerSourceManifestSha256===policy.workerSourceManifest.sha256&&
      samePath(a.outputDirectory,directory)&&a.maxResults===policy.maxResults&&
      stamp(a.publishedAt)>=stamp(policy.approvedAt)&&stamp(a.publishedAt)<stamp(policy.expiresAt)&&
      stamp(a.publishedAt)<=now(),'producer_binding');
  }
  need(invocation.contract==='c2_standalone_invocation.v1'&&invocation.configSha256===policy.workerConfig.sha256&&
    invocation.maxNotifications===policy.maxResults&&disabled(invocation),'invocation_binding');
  authorization(invocation.producerAuthorization);
  let newest:Obj|null=null,newestRaw:Buffer|null=null,totalBytes=0;
  let previousPublication=stamp(invocation.producerAuthorization.publishedAt);
  const resultPins:Record<string,string>={};
  for(let index=0;index<selected.length;index++){
    const file=join(directory,selected[index]!);contained(directory,file);
    const raw=stableBytes(file,16*1024*1024);totalBytes+=raw.length;need(totalBytes<=128*1024*1024,'total_result_bytes_bound');
    const parsed=parseFiniteEnvelope(raw),e=parsed.envelope;
    need(e.contract==='c2_authorized_finite_result.v1'&&disabled(e)&&e.prediction===null&&e.modelHash===null&&
      e.sequence===index+1&&e.resultSha256===parsed.resultSha256&&
      selected[index]===`RESULT-${String(e.sequence).padStart(4,'0')}-${parsed.resultSha256}.json`&&
      hex(e.readerSha256)&&hex(e.dispatchSha256)&&object(e.result),'result_binding');
    authorization(e.producerAuthorization);
    need(stamp(e.producerAuthorization.publishedAt)>=previousPublication,'publication_order');
    previousPublication=stamp(e.producerAuthorization.publishedAt);
    resultPins[selected[index]!]=hash(raw);
    newest=e;newestRaw=raw;
  }
  need(newest&&newestRaw,'no_result');const e=newest,r=e.result;
  need(object(r)&&integer(r.matchId)&&disabled(r),'result_identity');
  guardEvidence(r,r.matchId,stamp(e.producerAuthorization.publishedAt));
  const intakeProof=r.steamCommittedIntake;
  need(object(intakeProof)&&intakeProof.notificationSha256===e.dispatchSha256&&
    intakeProof.readerSha256===e.readerSha256&&intakeProof.originalReceiptPreserved===true&&
    intakeProof.providerCalls===0,'intake_result_binding');
  const notificationFile=join(intake.inboxDirectory,e.dispatchSha256+'.dispatch.json');
  contained(intake.inboxDirectory,notificationFile);
  const notificationRaw=stableBytes(notificationFile,10000);
  need(hash(notificationRaw)===e.dispatchSha256,'notification_pin');
  const notification=JSON.parse(notificationRaw.toString('utf8'));
  need(notification.contract==='c2_steam_phase_committed_archive_notification.v1'&&
    notification.outcomeKnownAtDispatch===false&&notification.completeSha256===intakeProof.archiveCompleteSha256&&
    typeof notification.archiveDirectory==='string'&&samePath(notification.archiveDirectory,intakeProof.archiveDirectory),'notification_binding');
  need(stamp(notification.publishedAt)>=stamp(invocation.producerAuthorization.publishedAt)&&
    stamp(notification.publishedAt)<=stamp(r.knownOutcomeGuard.before.checkedAt),'dispatch_chronology');
  contained(intake.allowedArchiveRoot,notification.archiveDirectory);
  const complete=stableBytes(join(notification.archiveDirectory,'COMPLETE.json'),65536);
  need(hash(complete)===notification.completeSha256,'archive_completion_pin');
  const ready=stableBytes(join(intake.inboxDirectory,'READY.json'),10000);
  need(hash(ready)===notification.readySha256&&notification.readySha256===intakeProof.readySha256,'ready_binding');
  const identity:Obj={result:{path:join(directory,selected.at(-1)!),sha256:hash(newestRaw)},
    sourceInputSha256:e.readerSha256,dispatchSha256:e.dispatchSha256,matchId:r.matchId,
    phaseHookSourceManifestSha256:phase.hookSourceManifestSha256};
  if(options.candidate==='prematch'||options.candidate==='postdraft'){
    const v=r.phaseDiagnostics?.[options.candidate],sides=v?.phaseProjection?.observedSides;
    need(object(sides)&&integer(sides.radiantTeamId)&&integer(sides.direTeamId),'phase_identity_unavailable');
    identity.radiantTeamId=sides.radiantTeamId;identity.direTeamId=sides.direTeamId;
    if(r.retention!==null&&r.retention!==undefined)identity.phaseSourceInputSha256=r.retention.originalObservation?.readerSha256;
  }else{
    const sides=r.steamPerPacketStartEvidence?.sourceIdentity;
    need(object(sides)&&/^[1-9]\d*$/.test(sides.radiantTeamIdDecimal)&&
      /^[1-9]\d*$/.test(sides.direTeamIdDecimal),'live_identity_unavailable');
    identity.radiantTeamId=Number(sides.radiantTeamIdDecimal);identity.direTeamId=Number(sides.direTeamIdDecimal);
  }
  need(integer(identity.radiantTeamId)&&integer(identity.direTeamId)&&identity.radiantTeamId!==identity.direTeamId,'distinct_teams');
  const saved=validate(e,identity);
  const revalidate=()=>{
    policyNow();controls(c);
    need(hash(stableBytes(policyPath,65536))===hash(policyBytes),'policy_changed');
    need(hash(stableBytes(policy.workerConfig.path,100000))===policy.workerConfig.sha256,'config_changed');
    pinned(policy.workerSourceManifest,65536);pinned(c.receiptPhaseConfig,65536);pinned(c.steamIntakeConfig,65536);
    for(const x of sourcePins)need(hash(stableBytes(x.path,2*1024*1024))===x.sha256,'source_changed');
    need(hash(stableBytes(notificationFile,10000))===e.dispatchSha256,'dispatch_changed');
    need(hash(stableBytes(join(notification.archiveDirectory,'COMPLETE.json'),65536))===notification.completeSha256,'completion_changed');
    need(hash(stableBytes(join(intake.inboxDirectory,'READY.json'),10000))===notification.readySha256,'ready_changed');
    need(hash(stableBytes(join(directory,'INVOCATION.json'),65536))===hash(invocationBytes),'invocation_changed');
    const current=listResults(directory,policy.maxResults);
    need(current.join('|')===selected.join('|'),'newer_or_changed_result');
    for(const name of selected)need(hash(stableBytes(join(directory,name),16*1024*1024))===resultPins[name],'result_changed');
  };
  revalidate();
  return {...saved,authorization:{kind:'root_approved_finite_producer',individualResultReviewed:false,
    namespaceId:policy.namespaceId,configSha256:policy.workerConfig.sha256,sequence:e.sequence},revalidateSource:revalidate};
}

import {createHash} from 'node:crypto';

export const COVERAGE_POLICY = Object.freeze({version:'known-opendota-maps-v1',cadenceMs:120_000,
  responseWindowMs:30_000,scopeIdleExpiryMs:21_600_000,maxMaps:10_000,maxPackets:1_000});
export type PacketSummary={matchId:number|null,radiantTeamId:number|null,direTeamId:number|null,
  gameTime:number|null,radiantScore:number|null,direScore:number|null,packetHash:string,
  state6FieldsComplete:boolean,passesLocalSourceGuard:boolean,freshnessReason:string|null,declaredDelaySeconds:number|null};
export type PollTicket={id:string,runId:string,plannedAt:number,dueAt:number,delayMs:number,
  mode:'unknown'|'live'|'idle',cause:'startup'|'regular'|'backoff'|'idle'};
export type CoverageOperation={id:string,sequence:string,at:number,ticket:PollTicket,
  kind:'plan'|'poll',attemptedAt?:number|null,receivedAt?:number|null,
  sourceOutcome?:'success'|'empty'|'no_eligible_maps'|'error'|'not_attempted',
  workerOutcome?:'ok'|'error'|'skipped_overlap'|'stopped',packets?:PacketSummary[],
  diagnosticStatus?:'ok'|'packet_summary_failed',
  errorCategory?:'http'|'network'|'timeout'|'aborted'|'quota_deferred'|'invalid_payload'|'unknown'|null};
type Scope={id:string,matchId:number,radiantTeamId:number,direTeamId:number,enrolledAt:number,
  lastProgressAt:number,expiresAt:number,nextDueAt:number,highClock:number|null,
  highRadiant:number|null,highDire:number|null,lastHash:string,closedAt:number|null,knownOutcomeAt:number|null,
  closeReason:'monitoring_unconfirmed_timeout'|'local_outcome_known'|null};
export type CoverageState={version:1,policyVersion:string,lastSequence:string,lastOperationAt:number,
  scopes:Record<string,Scope>,pending:Record<string,PollTicket>};
export type CoverageEvent={id:string,kind:'plan'|'poll'|'scope_enter'|'scope_exit'|'expectations'|'map_poll'|'integrity_gap',
  occurredAt:number,scopeId:string|null,pollId:string|null,matchId:number|null,detail:Record<string,unknown>};
export function emptyCoverageState():CoverageState{return {version:1,policyVersion:COVERAGE_POLICY.version,
  lastSequence:'0',lastOperationAt:0,scopes:{},pending:{}};}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const time=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;
const finite=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n);
function assertTicket(t:PollTicket){
  if(!t||typeof t.id!=='string'||typeof t.runId!=='string'||!time(t.plannedAt)||!time(t.dueAt)
    ||!time(t.delayMs)||t.dueAt!==t.plannedAt+t.delayMs||t.delayMs>86_400_000
    ||!['unknown','live','idle'].includes(t.mode)||!['startup','regular','backoff','idle'].includes(t.cause))
    throw new Error('invalid_coverage_ticket');
}
export function applyCoverageOperation(previous:CoverageState,op:CoverageOperation,
  context:{databaseNow:number,knownOutcomeIds:number[]}):{state:CoverageState,events:CoverageEvent[]} {
  assertTicket(op.ticket);
  if(previous.version!==1||previous.policyVersion!==COVERAGE_POLICY.version)throw new Error('coverage_state_version');
  if(!/^\d{1,20}$/.test(op.sequence)||BigInt(op.sequence)<=BigInt(previous.lastSequence))throw new Error('coverage_sequence_regressed');
  if(!time(op.at)||!time(context.databaseNow)||op.at<previous.lastOperationAt||op.at>context.databaseNow+5_000)
    throw new Error('coverage_clock_invalid');
  if(!['plan','poll'].includes(op.kind)||!Array.isArray(context.knownOutcomeIds))throw new Error('coverage_operation_invalid');
  if(![undefined,'ok','packet_summary_failed'].includes(op.diagnosticStatus))throw new Error('coverage_diagnostic_status');
  const state:CoverageState=structuredClone(previous),events:CoverageEvent[]=[];
  state.lastSequence=op.sequence;state.lastOperationAt=op.at;
  const emit=(kind:CoverageEvent['kind'],detail:Record<string,unknown>,scope:Scope|null=null,pollId:string|null=op.ticket.id,at=op.at)=>{
    events.push({id:hash([op.id,events.length,kind,scope?.id??null]),kind,occurredAt:at,scopeId:scope?.id??null,
      pollId,matchId:scope?.matchId??null,detail:{policyVersion:COVERAGE_POLICY.version,...detail,
        eventLatencyVerified:false,meetsVerifiedLiveLatencyPolicy:false}});
  };
  const close=(scope:Scope,at:number,reason:Scope['closeReason'])=>{
    if(scope.closedAt!==null)return;
    scope.closedAt=at;scope.closeReason=reason;
    if(reason!=='local_outcome_known')emit('scope_exit',{effectiveAt:at,reason,priorExpectationsPreserved:true},scope,null,context.databaseNow);
  };
  // A result known at replay time must not erase earlier persisted receipts.
  // Keep its prospective boundary separate from the reducer's causal timeline.
  const markKnown=(scope:Scope,at:number)=>{
    if(scope.knownOutcomeAt!==null)return;
    scope.knownOutcomeAt=at;
    emit('scope_exit',{effectiveAt:at,reason:'local_outcome_known',priorExpectationsPreserved:true},scope,null,context.databaseNow);
  };
  const known=new Set(context.knownOutcomeIds);
  const materialize=(scope:Scope,until:number)=>{
    const end=Math.min(until,scope.expiresAt,scope.closedAt??Infinity,scope.knownOutcomeAt??Infinity);
    if(scope.nextDueAt>end)return;
    const count=Math.floor((end-scope.nextDueAt)/COVERAGE_POLICY.cadenceMs)+1;
    if(count>10_000)throw new Error('coverage_backfill_sanity_cap');
    const first=scope.nextDueAt;
    // Split retrospective recovery from expectations planned before their due time.
    const recovered=Math.min(count,Math.max(0,Math.ceil((op.at-first)/COVERAGE_POLICY.cadenceMs)));
    for(const [offset,n,origin] of [[0,recovered,'recovered_from_durable_scope'],[recovered,count-recovered,'planned']] as const){
      if(!n)continue;
      emit('expectations',{firstDueAt:first+offset*COVERAGE_POLICY.cadenceMs,count:n,cadenceMs:COVERAGE_POLICY.cadenceMs,
        responseWindowMs:COVERAGE_POLICY.responseWindowMs,origin,scheduledPollDueAt:op.ticket.dueAt,
        scheduleCause:op.ticket.cause,knownMapScope:true,globalDiscoveryCoverage:false},scope);
    }
    scope.nextDueAt=first+count*COVERAGE_POLICY.cadenceMs;
  };
  for(const scope of Object.values(state.scopes)){
    if(known.has(scope.matchId))markKnown(scope,context.databaseNow);
    // Expiry is the prospectively fixed policy deadline, not a guessed match end.
    const deadline=Math.min(scope.expiresAt,scope.knownOutcomeAt??Infinity);
    if(scope.closedAt===null&&deadline<=op.at){materialize(scope,deadline);close(scope,deadline,
      deadline===scope.knownOutcomeAt?'local_outcome_known':'monitoring_unconfirmed_timeout');}
  }
  if(op.kind==='plan'){
    for(const [id,pending] of Object.entries(state.pending))if(pending.runId!==op.ticket.runId){
      emit('poll',{ticket:pending,sourceOutcome:'not_attempted',workerOutcome:'process_interrupted',
        attemptedAt:null,receivedAt:null,recoveredOnRestart:true},null,id);delete state.pending[id];
    }
    if(state.pending[op.ticket.id])throw new Error('duplicate_coverage_plan');
    emit('plan',{ticket:op.ticket,scope:'previously_observed_team_identified_opendota_maps',
      maxEventLagSeconds:300,maxLocalStateAgeSeconds:180,unknownEventLagNeverPasses:true});
    state.pending[op.ticket.id]=op.ticket;
    for(const scope of Object.values(state.scopes))materialize(scope,scope.expiresAt);
    return {state,events};
  }
  const packets=op.packets??[];
  if(!Array.isArray(packets)||packets.length>COVERAGE_POLICY.maxPackets)throw new Error('coverage_packet_limit');
  if(!['success','empty','no_eligible_maps','error','not_attempted'].includes(op.sourceOutcome??'')
    ||!['ok','error','skipped_overlap','stopped'].includes(op.workerOutcome??''))throw new Error('coverage_poll_status');
  const received=op.receivedAt??null,attempted=op.attemptedAt??null;
  if((received!==null&&(!time(received)||received>op.at||attempted===null||received<attempted))
    ||(attempted!==null&&(!time(attempted)||attempted>op.at)))throw new Error('coverage_receipt_invalid');
  if(['error','not_attempted'].includes(op.sourceOutcome!)&&(received!==null||packets.length))throw new Error('error_cannot_have_packets');
  if(![null,undefined,'http','network','timeout','aborted','quota_deferred','invalid_payload','unknown'].includes(op.errorCategory))throw new Error('coverage_error_category');
  if(['success','empty','no_eligible_maps'].includes(op.sourceOutcome!)&&received===null)throw new Error('successful_poll_missing_receipt');
  if(op.sourceOutcome==='empty'&&packets.length)throw new Error('empty_poll_has_packets');
  const byId=new Map<number,PacketSummary>();const duplicates=new Set<number>();
  for(const p of packets){
    if(!p||typeof p.packetHash!=='string'||!/^[a-f0-9]{64}$/.test(p.packetHash))throw new Error('coverage_packet_hash');
    if(typeof p.state6FieldsComplete!=='boolean'||typeof p.passesLocalSourceGuard!=='boolean'
      ||[p.gameTime,p.radiantScore,p.direScore,p.declaredDelaySeconds].some(v=>v!==null&&!finite(v))
      ||[p.matchId,p.radiantTeamId,p.direTeamId].some(v=>v!==null&&!positive(v))
      ||(p.freshnessReason!==null&&(!/^[a-z0-9_]{1,80}$/.test(p.freshnessReason))))throw new Error('coverage_packet_shape');
    if(positive(p.matchId)){if(byId.has(p.matchId))duplicates.add(p.matchId);byId.set(p.matchId,p);}
  }
  emit('poll',{ticket:op.ticket,sourceOutcome:op.sourceOutcome,workerOutcome:op.workerOutcome,
    attemptedAt:attempted,receivedAt:received,packetCount:packets.length,duplicateMapIds:duplicates.size,
    errorCategory:op.errorCategory??null,diagnosticStatus:op.diagnosticStatus??'ok',planWasPresent:Boolean(state.pending[op.ticket.id])});
  if(op.diagnosticStatus==='packet_summary_failed')emit('integrity_gap',{reason:'packet_summary_failed',packetAvailabilityUnverified:true});
  delete state.pending[op.ticket.id];
  const oldScopes=Object.values(state.scopes);
  for(const scope of oldScopes){
    const assessmentAt=received??op.at;
    if(scope.enrolledAt>assessmentAt||(scope.closedAt!==null&&scope.closedAt<assessmentAt))continue;
    materialize(scope,op.at);
    const packet=byId.get(scope.matchId),identity=!!packet&&!duplicates.has(scope.matchId)
      &&packet.radiantTeamId===scope.radiantTeamId&&packet.direTeamId===scope.direTeamId;
    const due=received===null?null:scope.enrolledAt+Math.floor((received-scope.enrolledAt)/COVERAGE_POLICY.cadenceMs)*COVERAGE_POLICY.cadenceMs;
    const slotDue=due!==null&&due>=scope.enrolledAt+COVERAGE_POLICY.cadenceMs&&due<scope.nextDueAt&&due<=scope.expiresAt?due:null;
    const inWindow=slotDue!==null&&received!==null&&received>=slotDue&&received<=slotDue+COVERAGE_POLICY.responseWindowMs;
    emit('map_poll',{expectedKnownMap:true,packetPresent:!!packet,identityMatches:identity,
      packetChanged:identity?packet!.packetHash!==scope.lastHash:null,slotDueAt:slotDue,responseInWindow:inWindow,
      state6FieldsComplete:identity&&packet!.state6FieldsComplete,passesLocalSourceGuard:identity&&packet!.passesLocalSourceGuard,
      receivedAt:received,reason:!packet?'map_missing_from_poll':!identity?'map_identity_invalid':packet!.freshnessReason,
      declaredDelaySeconds:identity?packet!.declaredDelaySeconds:null,measuredEventToPredictionSeconds:null,availableUsableCachedStateAtFixedSlot:null,cachedStateAvailabilityMeasured:false},scope);
  }
  if(received===null)return {state,events};
  for(const packet of byId.values()){
    if(!positive(packet.matchId)||!positive(packet.radiantTeamId)||!positive(packet.direTeamId)
      ||packet.radiantTeamId===packet.direTeamId||duplicates.has(packet.matchId))continue;
    const prior=state.scopes[String(packet.matchId)];
    if(prior?.knownOutcomeAt!==null&&prior?.knownOutcomeAt!==undefined&&received>=prior.knownOutcomeAt)continue;
    const regressed=!!prior&&[[packet.gameTime,prior.highClock],[packet.radiantScore,prior.highRadiant],[packet.direScore,prior.highDire]]
      .some(([a,b])=>finite(a)&&finite(b)&&a<b);
    const progressed=!!prior&&!regressed&&[[packet.gameTime,prior.highClock],[packet.radiantScore,prior.highRadiant],[packet.direScore,prior.highDire]]
      .some(([a,b])=>finite(a)&&finite(b)&&a>b);
    if(prior&&prior.closedAt!==null){
      if(prior.closeReason==='local_outcome_known'||!progressed||received<=prior.closedAt)continue;
    }
    if(!prior||prior.closedAt!==null){
      if(!prior&&Object.keys(state.scopes).length>=COVERAGE_POLICY.maxMaps){
        emit('integrity_gap',{reason:'scope_registry_capacity_exceeded',discoveryNotEnrolled:true,matchId:packet.matchId});continue;
      }
      const scope:Scope={id:hash([prior?.id??null,packet.matchId,received]),matchId:packet.matchId,
        radiantTeamId:packet.radiantTeamId,direTeamId:packet.direTeamId,enrolledAt:received,lastProgressAt:received,
        expiresAt:received+COVERAGE_POLICY.scopeIdleExpiryMs,nextDueAt:received+COVERAGE_POLICY.cadenceMs,
        highClock:packet.gameTime,highRadiant:packet.radiantScore,highDire:packet.direScore,
        lastHash:packet.packetHash,closedAt:null,knownOutcomeAt:null,closeReason:null};
      state.scopes[String(packet.matchId)]=scope;
      emit('scope_enter',{enrolledAt:received,expiresAt:scope.expiresAt,radiantTeamId:scope.radiantTeamId,
        direTeamId:scope.direTeamId,firstDiscoveryNotInEarlierDenominators:true,
        priorScopeId:prior?.id??null,initialState6FieldsComplete:packet.state6FieldsComplete},scope,null);
      if(prior?.knownOutcomeAt!=null||known.has(scope.matchId))markKnown(scope,prior?.knownOutcomeAt??context.databaseNow);
      // Commit the complete finite lease now: expired windows remain visible
      // while the process is offline, even before any restart reconciliation.
      materialize(scope,scope.expiresAt);continue;
    }
    if(packet.radiantTeamId!==prior.radiantTeamId||packet.direTeamId!==prior.direTeamId)continue;
    if(progressed){prior.lastProgressAt=received;prior.expiresAt=received+COVERAGE_POLICY.scopeIdleExpiryMs;}
    const high=(a:number|null,b:number|null)=>finite(a)?b===null?a:Math.max(a,b):b;
    if(!regressed){prior.highClock=high(packet.gameTime,prior.highClock);prior.highRadiant=high(packet.radiantScore,prior.highRadiant);
      prior.highDire=high(packet.direScore,prior.highDire);}
    prior.lastHash=packet.packetHash;
    materialize(prior,prior.expiresAt);
  }
  return {state,events};
}

/** Candidate diagnostics only. Never accepted by the public lognormal contract.
 * Arrays are the original hazard log atoms/CDF/survival, not a fitted approximation.
 */
export const CONTRACT = 'aegis.exact_discrete_hazard_transport.v1';
export const FLAGS = Object.freeze({diagnosticOnly:true, active:false,
  eligibleForServing:false, eligibleForPromotion:false, eligibleForQualityClaims:false,
  probabilitiesArePublic:false});
export type Target = 'kills'|'duration';
export interface HazardTransport {
  contract:typeof CONTRACT; diagnosticOnly:true; active:false; eligibleForServing:false;
  eligibleForPromotion:false; eligibleForQualityClaims:false; probabilitiesArePublic:false;
  scope:'map'; target:Target; phase:'live'|'prematch'|'postdraft'; unit:'kills'|'seconds';
  coordinate:'remaining'|'final_total_origin_zero'; coordinateOffset:number;
  observedFinalFloor:number|null; support:[number,number];
  atomLogProbabilities:number[]; survivalLogProbabilities:number[]; cdfLogProbabilities:number[];
  tail:{aboveCoordinate:number;unsplit:true;allocatedToLastBin:false;logProbability:number;probability:number};
  metadata:{matchId:number;candidate:string;modelSha256:string;stateFloat32Sha256:string;
    rawLogitsSha256:string;sourceInputSha256:string;modelBindingSha256:string};
}
const need=(ok:unknown,why:string):void=>{if(!ok)throw new Error('hazard_transport_'+why);};
const integer=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(x:Record<string,unknown>, expected:string[])=>Object.keys(x).sort().join('|')===expected.sort().join('|');
const logadd=(a:number,b:number)=>Math.max(a,b)+Math.log1p(Math.exp(Math.min(a,b)-Math.max(a,b)));
const near=(a:number,b:number)=>Math.abs(a-b)<=1e-8;
const checked = new WeakSet<object>();
const TOP = ['contract',...Object.keys(FLAGS),'scope','target','phase','unit','coordinate','coordinateOffset',
  'observedFinalFloor','support','atomLogProbabilities','survivalLogProbabilities','cdfLogProbabilities','tail','metadata'];
/** Parse once and copy/freeze everything: later caller mutations cannot alter a checked CDF. */
export function parseHazardTransport(input:unknown):HazardTransport {
  need(object(input),'object');
  const d=input as unknown as HazardTransport, o=input as Record<string,unknown>;
  need(keys(o,TOP)&&d.contract===CONTRACT&&d.scope==='map','contract_keys');
  need(Object.entries(FLAGS).every(([k,v])=>o[k]===v),'diagnostic_gates');
  need(['kills','duration'].includes(d.target)&&['live','prematch','postdraft'].includes(d.phase),'target_phase');
  need(d.unit===(d.target==='kills'?'kills':'seconds'),'native_unit');
  need(d.coordinate===(d.phase==='live'?'remaining':'final_total_origin_zero'),'coordinate');
  need(integer(d.coordinateOffset)&&d.coordinateOffset<=2**24,'offset');
  need(d.phase==='live'?d.observedFinalFloor===d.coordinateOffset:
    d.coordinateOffset===0&&d.observedFinalFloor===null,'physical_floor');
  const lower=d.target==='kills'?0:1, max=d.target==='kills'?120:5400;
  need(Array.isArray(d.support)&&d.support.length===2&&d.support[0]===lower&&
    integer(d.support[1],lower)&&d.support[1]<=max,'support');
  const upper=d.support[1], n=upper-lower+1;
  const arrays=[d.atomLogProbabilities,d.survivalLogProbabilities,d.cdfLogProbabilities];
  need(arrays.every(a=>Array.isArray(a)&&a.length===n&&a.every(v=>typeof v==='number'&&Number.isFinite(v)&&v<=1e-9)),'arrays');
  let ps=0, pc:number|null=null;
  for(let i=0;i<n;i++) {
    const p=d.atomLogProbabilities[i]!, s=d.survivalLogProbabilities[i]!, c=d.cdfLogProbabilities[i]!;
    need(s<=ps+1e-9&&near(logadd(p,s),ps),'atom_survival_recurrence');
    need(near(c,pc===null?p:logadd(pc,p))&&near(logadd(c,s),0),'cdf_mass_recurrence');
    ps=s;pc=c;
  }
  need(object(d.tail)&&keys(d.tail as unknown as Record<string,unknown>,
    ['aboveCoordinate','unsplit','allocatedToLastBin','logProbability','probability']),'tail_keys');
  need(d.tail.aboveCoordinate===upper&&d.tail.unsplit===true&&d.tail.allocatedToLastBin===false&&
    d.tail.logProbability===ps&&typeof d.tail.probability==='number'&&Number.isFinite(d.tail.probability)&&
    d.tail.probability>=0&&d.tail.probability<=1&&
    Math.abs(d.tail.probability-Math.exp(ps))<=Math.max(Number.MIN_VALUE,Math.exp(ps)*2e-14),'unsplit_tail');
  const m=d.metadata;
  need(object(m)&&keys(m as unknown as Record<string,unknown>,
    ['matchId','candidate','modelSha256','stateFloat32Sha256','rawLogitsSha256','sourceInputSha256','modelBindingSha256']),'metadata_keys');
  need(integer(m.matchId,1)&&(d.phase==='live'?['live.C1','live.C2'].includes(m.candidate):m.candidate===d.phase),'identity_phase');
  need(['modelSha256','stateFloat32Sha256','rawLogitsSha256','sourceInputSha256','modelBindingSha256']
    .every(k=>typeof m[k as keyof typeof m]==='string'&&/^[a-f0-9]{64}$/.test(String(m[k as keyof typeof m]))),'pins');
  const copy={...d,support:Object.freeze([...d.support]),
    atomLogProbabilities:Object.freeze([...d.atomLogProbabilities]),
    survivalLogProbabilities:Object.freeze([...d.survivalLogProbabilities]),
    cdfLogProbabilities:Object.freeze([...d.cdfLogProbabilities]),
    metadata:Object.freeze({...m}),tail:Object.freeze({...d.tail})};
  Object.freeze(copy);checked.add(copy);
  return copy as unknown as HazardTransport;
}
function parsed(d:HazardTransport):HazardTransport { return checked.has(d)?d:parseHazardTransport(d); }
const unavailable=(reason:string)=>({...FLAGS,available:false,reason,probabilities:null,logProbabilities:null});
/** All arguments here use native final units. Offset subtraction happens exactly here. */
export function hazardNativeLine(input:HazardTransport,finalLine:number) {
  const d=parsed(input);
  if(typeof finalLine!=='number'||!Number.isFinite(finalLine)||finalLine<0||finalLine>Number.MAX_SAFE_INTEGER)
    return unavailable('nonnegative_finite_native_line_required');
  if(d.target==='kills'?!Number.isSafeInteger(finalLine*2):!Number.isSafeInteger(finalLine))
    return unavailable(d.target==='kills'?'integer_or_half_kills_line_required':'integer_exact_seconds_required');
  const residual=finalLine-d.coordinateOffset, at=Math.floor(residual), before=Math.ceil(residual)-1;
  const [lo,hi]=d.support;
  if(at>hi||before>hi)return {...unavailable('residual_support_exceeded'),line:finalLine,coordinateLine:residual};
  const lu=before>=lo?d.cdfLogProbabilities[before-lo]!:null;
  const lp=residual===at&&at>=lo?d.atomLogProbabilities[at-lo]!:null;
  const lv=at>=lo?d.survivalLogProbabilities[at-lo]!:0;
  const pUnder=lu===null?0:Math.exp(lu), pPush=lp===null?0:Math.exp(lp), pOver=Math.exp(lv);
  need(Math.abs(pUnder+pPush+pOver-1)<=1e-8,'line_mass');
  return {...FLAGS,available:true,reason:null,line:finalLine,coordinateLine:residual,
    probabilities:{pUnder,pPush,pOver},
    logProbabilities:{under:lu,push:lp,over:lv},
    structurallyImpossible:{under:lu===null,push:lp===null,over:false},
    resolvedByObservedLowerBound:residual<lo,CDFatFinalLine:pUnder+pPush};
}
export function hazardFinalQuantile(input:HazardTransport,q:number):number|null {
  const d=parsed(input);need(typeof q==='number'&&q>0&&q<1,'quantile_probability');
  const i=d.cdfLogProbabilities.findIndex(v=>v>=Math.log(q));
  return i<0?null:d.coordinateOffset+d.support[0]+i;
}
function summary(d:HazardTransport) {
  const scale=d.target==='duration'?60:1;
  const display=(q:number)=>{const v=hazardFinalQuantile(d,q);return v===null?null:v/scale;};
  return {displayUnit:d.target==='duration'?'minutes' as const:'kills' as const,
    statistic:'median' as const,expectedValue:display(.5),interval:{q25:display(.25),q75:display(.75)},
    tailUnsplit:true,tailProbability:d.tail.probability,tailAboveFinalNative:d.coordinateOffset+d.support[1]};
}
/** Seven deterministic own lines. Unsupported rows stay unavailable; never move tail mass. */
export function ownHazardDiagnosticLadder(input:HazardTransport) {
  const d=parsed(input), info=summary(d), median=hazardFinalQuantile(d,.5);
  if(median===null)return {...FLAGS,...info,lineSource:'own_diagnostic_grid',available:false,
    reason:'median_in_unsplit_tail',lines:[]};
  const kills=d.target==='kills', scale=kills?1:60, step=kills?1:.5;
  const center=kills?median+.5:Math.round(median/30)*.5;
  const floor=d.observedFinalFloor??0;
  const first=Math.max(kills?floor+.5:Math.max(.5,(Math.floor(floor/30)+1)*.5),center-3*step);
  const lines=Array.from({length:7},(_,i)=>{
    const line=first+i*step, result=hazardNativeLine(d,line*scale);
    return {...result,line,nativeLine:line*scale,unit:info.displayUnit};
  });
  return {...FLAGS,...info,lineSource:'own_diagnostic_grid',available:lines.some(r=>r.available),
    reason:null,lines};
}
export interface DiagnosticBookContext {
  matchId:number;mapNumber:number;bookmakerId:string;eventId:string;
}
export interface DiagnosticBookQuote extends DiagnosticBookContext {
  target:Target;scope:'map'|'series';unit:'kills'|'minutes';line:number;
  oddsOver:number|null;oddsUnder:number|null;receivedAt:string;expiresAt:string;
  settlement:'integer_kills_push'|'exact_seconds_push'|'unknown';
}
/** Caller supplies server-resolved actual quotes. This pure function is NOT identity
 * admission or a provider client. Output stays diagnostic even with matching fields.
 * Preserve bookmaker order, exact displayed lines and odds; never make own fallback.
 */
export function bookmakerHazardDiagnosticLadder(input:HazardTransport,context:DiagnosticBookContext,
                                               quotes:DiagnosticBookQuote[],now:number) {
  const d=parsed(input);need(Number.isFinite(now),'now');need(Array.isArray(quotes)&&quotes.length<=128,'bounded_quotes');
  const contextValid=object(context)&&context.matchId===d.metadata.matchId&&integer(context.mapNumber,1)&&
    typeof context.bookmakerId==='string'&&context.bookmakerId.length>0&&
    typeof context.eventId==='string'&&context.eventId.length>0;
  const duplicates=new Map<string,number>();
  for(const r of quotes){const k=JSON.stringify([r?.target,r?.scope,r?.mapNumber,r?.unit,r?.line]);duplicates.set(k,(duplicates.get(k)??0)+1);}
  const lines=quotes.map(r=>{
    let reason:string|null=null;
    const key=JSON.stringify([r?.target,r?.scope,r?.mapNumber,r?.unit,r?.line]);
    if(!contextValid||!object(r)||r.matchId!==context.matchId||r.mapNumber!==context.mapNumber||
      r.bookmakerId!==context.bookmakerId||r.eventId!==context.eventId||r.scope!=='map'||r.target!==d.target)
      reason='server_map_or_book_identity_unconfirmed';
    else if(duplicates.get(key)!==1)reason='duplicate_bookmaker_line';
    else if(r.unit!==(d.target==='kills'?'kills':'minutes'))reason='bookmaker_unit_mismatch';
    else if(![r.oddsOver,r.oddsUnder].every(v=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>1))||
      (r.oddsOver===null&&r.oddsUnder===null))reason='quote_prices_unavailable';
    else if(!Number.isFinite(Date.parse(r.receivedAt))||!Number.isFinite(Date.parse(r.expiresAt))||
      Date.parse(r.receivedAt)>now||Date.parse(r.expiresAt)<=now||Date.parse(r.expiresAt)<=Date.parse(r.receivedAt))
      reason='quote_stale_or_future';
    else if(r.settlement!==(d.target==='kills'?'integer_kills_push':'exact_seconds_push'))
      reason='settlement_unconfirmed';
    const rawNative=typeof r?.line==='number'?r.line*(d.target==='duration'?60:1):NaN;
    const native=d.target==='duration'&&Math.abs(rawNative-Math.round(rawNative))<1e-7?Math.round(rawNative):rawNative;
    const p=reason?unavailable(reason):hazardNativeLine(d,native);
    return {...p,line:r?.line,unit:r?.unit,nativeLine:Number.isFinite(native)?native:null,
      oddsOver:r?.oddsOver??null,oddsUnder:r?.oddsUnder??null,settlement:r?.settlement??'unknown',
      quoteReceivedAt:r?.receivedAt??null,quoteExpiresAt:r?.expiresAt??null};
  });
  return {...FLAGS,...summary(d),lineSource:'bookmaker',bookmakerId:context?.bookmakerId??null,
    eventId:context?.eventId??null,mapNumber:context?.mapNumber??null,actualQuoteProvenanceVerifiedByThisAdapter:false,
    available:lines.some(r=>r.available),lines};
}

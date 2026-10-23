import { createHash } from 'node:crypto';

export type ShadowDiagnosticCode = 'shadow_input_contract_rejected'|'shadow_request_rejected'|'shadow_service_unavailable'
  |'shadow_service_unauthorized'|'shadow_service_timeout'|'shadow_service_token_missing'|'shadow_response_contract_rejected'
  |'shadow_clock_inconsistent';
export class ShadowDiagnosticError extends Error {
  constructor(readonly code:ShadowDiagnosticCode,readonly diagnostics:Record<string,unknown>={}){super(code);}
}
const fixedUpstreamReasons=new Set([
  'invalid_shadow_request','shadow_request_too_large','invalid_content_length','shadow_busy','shadow_package_unavailable',
  'shadow_inference_unavailable','history_not_monotone_in_receipt_order','current_score_regressed',
  'history_recorded_after_current_cutoff','history_clock_not_strictly_past','history_side_identity_mismatch',
  'duplicate_observation_identity','history_limit_exceeded','history_list_required','history_observation_required',
  'future_or_inconsistent_receipt','synthetic_or_backfill_observation','missing_or_invalid_match_id',
  'missing_or_invalid_expected_match_id','current_map_identity_mismatch','missing_or_invalid_radiant_team_id',
  'missing_or_invalid_dire_team_id','same_team_on_both_sides','missing_or_invalid_raw_provider_lead',
  'missing_or_invalid_game_clock','missing_or_invalid_radiant_score','missing_or_invalid_dire_score',
  'hero_outside_pinned_schema','timestamp_required','invalid_timestamp','timezone_required','input_object_required',
  'observation_required','observation_id_required','source_scope_or_units_mismatch:source',
  'source_scope_or_units_mismatch:targetScope','source_scope_or_units_mismatch:clockUnit','source_scope_or_units_mismatch:scoreUnit',
  'positive_feature_clock_required','invalid_model_probability',
]);
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function httpFailure(status:number,text:string,truncated=false):ShadowDiagnosticError {
  let upstreamReason='unrecognized_or_missing_reason';
  if(!truncated)try {const raw=JSON.parse(text);const reason=record(raw)&&record(raw.detail)?raw.detail.reason:null;
    if(typeof reason==='string'&&fixedUpstreamReasons.has(reason))upstreamReason=reason;
  }catch{/* Never store arbitrary pages or exception strings. */}
  const code=status===401||status===403?'shadow_service_unauthorized':status===422?'shadow_input_contract_rejected'
    :status===400||status===413?'shadow_request_rejected':'shadow_service_unavailable';
  return new ShadowDiagnosticError(code,{httpStatus:status,upstreamReason,bodyTruncated:truncated,
    observedBodyBytes:Buffer.byteLength(text),observedBodySha256:createHash('sha256').update(text).digest('hex')});
}
/** Read at most limit bytes. The diagnostic contains hashes, never arbitrary text. */
export async function boundedResponseText(response:Response,limit:number):Promise<{text:string;truncated:boolean}> {
  const reader=response.body?.getReader();if(!reader)return{text:'',truncated:false};
  const chunks:Uint8Array[]=[];let size=0,truncated=false;
  try{
    while(true){const part=await reader.read();if(part.done)break;
      if(part.value.length>limit-size){chunks.push(part.value.subarray(0,limit-size));size=limit;truncated=true;await reader.cancel();break;}
      chunks.push(part.value);size+=part.value.length;
    }
  }finally{reader.releaseLock();}
  return{text:Buffer.concat(chunks.map(c=>Buffer.from(c)),size).toString('utf8'),truncated};
}
/** Safe rejected-response evidence excludes all predictions, vectors, free text and nested payloads. */
export function safeResponseMetadata(raw:unknown):Record<string,unknown> {
  if(!record(raw))return{shape:'not_object'};
  const result:Record<string,unknown>={shape:'object'};
  for(const key of ['observationId','requestBodySha256','modelSha256','manifestSha256','featureSchemaHash'])
    if(typeof raw[key]==='string'&&/^[a-f0-9]{64}$/.test(raw[key] as string))result[key]=raw[key];
  for(const key of ['computedAt','receivedAt','recordedAt'])
    if(typeof raw[key]==='string'&&(raw[key] as string).length<=64&&Number.isFinite(Date.parse(raw[key] as string)))
      result[key]=new Date(raw[key] as string).toISOString();
  for(const key of ['featureValues','missingMask','featureNames'])
    if(Array.isArray(raw[key]))result[key+'Length']=(raw[key] as unknown[]).length;
  if(raw.status==='shadow_predicted'||raw.status==='unavailable')result.status=raw.status;
  return result;
}

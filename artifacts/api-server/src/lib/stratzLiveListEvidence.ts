import {createHash} from 'node:crypto';

export const STRATZ_LIST_EVIDENCE_VERSION='stratz_list_raw_filter_v1';
export const MAX_STRATZ_LIST_ARCHIVE_BYTES=131_072;
type Query=(text:string,values:unknown[])=>Promise<unknown>;
function digest(value:string){return createHash('sha256').update(value).digest('hex');}
export function stratzLiveListEvidence(rawMatches:unknown[],normalizedCount:number,query:string,receivedAt:string){
 if(!Number.isFinite(Date.parse(receivedAt)))throw Error('invalid_stratz_receipt');
 const reasons={invalidRow:0,invalidMatchId:0,completed:0,noLeagueOrTeams:0,accepted:0};
 for(const row of rawMatches){
  if(!row||typeof row!=='object'||Array.isArray(row)){reasons.invalidRow++;continue;}
  const m=row as Record<string,unknown>;
  if(!Number.isSafeInteger(m.matchId)||(m.matchId as number)<=0){reasons.invalidMatchId++;continue;}
  if(m.completed===true){reasons.completed++;continue;}
  // Mirror the existing public filter's numeric comparison exactly; changing its
  // ID normalization is a separate change, not an observability side effect.
  if(!['leagueId','radiantTeamId','direTeamId'].some(k=>Number(m[k]??0)>0)){reasons.noLeagueOrTeams++;continue;}
  reasons.accepted++;
 }
 if(!Number.isSafeInteger(normalizedCount)||normalizedCount<0||normalizedCount!==reasons.accepted)throw Error('stratz_filter_count_disagreement');
 const raw=JSON.stringify(rawMatches),rawBytes=Buffer.byteLength(raw),rawSha256=digest(raw),querySha256=digest(query);
 const rawStored=rawBytes<=MAX_STRATZ_LIST_ARCHIVE_BYTES;
 return {id:digest(JSON.stringify([STRATZ_LIST_EVIDENCE_VERSION,receivedAt,querySha256,rawSha256])),
  version:STRATZ_LIST_EVIDENCE_VERSION,receivedAt,querySha256,rawSha256,rawBytes,
  rawCount:rawMatches.length,normalizedCount,reasons,
  status:rawMatches.length===0?'upstream_empty':normalizedCount===0?'all_filtered':'matches_available',
  rawStored,rawMatches:rawStored?structuredClone(rawMatches):null,
  rawNotStoredReason:rawStored?null:'payload_exceeds_archive_bound',
  sourceScope:'GraphQL data.live.matches selected fields before Aegis filters; no HTTP headers or credentials',
  providerObservedAt:null};
}
export type StratzLiveListEvidence=ReturnType<typeof stratzLiveListEvidence>;
/** Additional local persistence only. A failure never triggers a provider retry. */
export async function writeStratzLiveListEvidence(query:Query,e:StratzLiveListEvidence){
 await query(`INSERT INTO stratz_live_list_observations
  (id,received_at,contract_version,query_sha256,raw_sha256,raw_bytes,raw_count,normalized_count,status,filter_reasons,raw_matches,raw_not_stored_reason)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) ON CONFLICT(id) DO NOTHING`,
  [e.id,e.receivedAt,e.version,e.querySha256,e.rawSha256,e.rawBytes,e.rawCount,e.normalizedCount,e.status,JSON.stringify(e.reasons),e.rawStored?JSON.stringify(e.rawMatches):null,e.rawNotStoredReason]);
}

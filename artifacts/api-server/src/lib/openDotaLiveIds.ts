/** Providers may serialize 64-bit IDs as JSON strings. Never round an ID. */
export function safeOpenDotaId(value: unknown): number | undefined {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[1-9]\d*$/.test(value))) return undefined;
  const id=Number(value);
  return Number.isSafeInteger(id) && id>0 ? id : undefined;
}

export function normalizeOpenDotaLiveIds(row: unknown): unknown {
  // Preserve malformed rows for worker admission and receipt accounting. Never
  // turn null/scalars/arrays into invented map objects or silently remove them.
  if(row===null||typeof row!=='object'||Array.isArray(row))return row;
  const record=row as Record<string,unknown>,normalized={...record};
  for(const key of ['match_id','team_id_radiant','team_id_dire','league_id']) normalized[key]=safeOpenDotaId(record[key]);
  // lobby_id / Steam server IDs can exceed JS safe integers and are untouched.
  return normalized;
}

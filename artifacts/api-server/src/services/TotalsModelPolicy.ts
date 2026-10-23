/** Explicit audited serving approval; an old is_active flag is insufficient. */
export function eligibleTotalsModel(kind: string, metadata: Record<string, unknown>): boolean {
  if (!kind.includes('total_')) return true;
  const c = metadata.totalsContract as Record<string,unknown> | undefined;
  const liveKills = kind.startsWith('live_') && kind.includes('kills');
  return metadata.validationStatus === 'validated' && metadata.eligibleForServing === true
    && typeof metadata.validationReport === 'string' && metadata.validationReport.length > 0
    && c?.version === 'conditional_discrete_lognormal_v1' && c.targetScope === 'map'
    && c.unit === (kind.includes('duration') ? 'seconds' : 'kills')
    && c.targetTransform === (liveKills ? 'log1p' : 'log')
    && c.outOfTimeCalibrationValidated === true;
}

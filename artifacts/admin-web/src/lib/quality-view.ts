export function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function countText(value: unknown): string {
  return finiteCount(value)?.toLocaleString('ru-RU') ?? '—';
}

export function rateText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? `${(value * 100).toFixed(1)}%` : '—';
}

export function outcomeCoverageView(value: unknown) {
  const data = objectValue(value);
  const validatedResolved = finiteCount(data.validatedResolved);
  const threshold = finiteCount(data.liveTrainReadyThreshold);
  return {
    total: finiteCount(data.total), last30d: finiteCount(data.last30d),
    validated: finiteCount(data.validated), validatedResolved,
    unvalidated: finiteCount(data.unvalidated), threshold,
    sampleProgress: validatedResolved !== null && threshold !== null && threshold > 0
      ? Math.min(100, Math.max(0, 100 * validatedResolved / threshold)) : null,
  };
}

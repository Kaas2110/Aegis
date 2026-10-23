/** Select training rows; a training window is never a data-retention policy. */
export function trainingSinceUnix(windowDays: number, nowMs = Date.now(), patchCutoffUnix?: number): number {
  if (!Number.isFinite(windowDays) || windowDays <= 0 || !Number.isFinite(nowMs)) throw new Error('Invalid training window');
  const calendarCutoff = Math.floor(nowMs / 1000 - windowDays * 86_400);
  return patchCutoffUnix !== undefined && Number.isFinite(patchCutoffUnix)
    ? Math.max(calendarCutoff, Math.floor(patchCutoffUnix)) : calendarCutoff;
}

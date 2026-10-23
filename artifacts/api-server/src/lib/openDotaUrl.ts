/** Shared PostgreSQL policy is authoritative; URL builders never attach keys. */
import {
  openDotaLedger,
  OD_LIMITS,
  OD_PAID_CEILING,
  effectiveOdProfile
} from '@workspace/db/opendota';
export function setOdRuntimeConfig(_cfg: { premium: boolean | null; dailyLimit: number }): void {}
export type OdPremiumSource = 'env' | 'db' | 'default';
// Legacy pacing hint only; spend/authentication is decided atomically per request.
export function isOpenDotaPremium(): boolean {
  return !!process.env.OPENDOTA_API_KEY;
}
export function hasOpenDotaKey(): boolean {
  return !!process.env.OPENDOTA_API_KEY;
}
export type OdCallKind = 'user' | 'background';
export function tryAcquireOd(_kind: OdCallKind): boolean {
  return true;
}
export function withOpenDotaKey(url: string): string {
  return url;
}
export async function getOdUsageStats() {
  const { state, now } = await openDotaLedger.snapshot();
  const todayKey = new Date(now).toISOString().slice(0, 10),
    month = todayKey.slice(0, 7);
  const cutoff7 = new Date(now - 6 * 86400_000).toISOString().slice(0, 10),
    cutoff30 = new Date(now - 29 * 86400_000).toISOString().slice(0, 10);
  const days = [...new Set([...Object.keys(state.days), ...Object.keys(state.paid?.days ?? {})])]
    .filter((d) => d >= cutoff30)
    .sort();
  const history = days.map((date) => {
    const free = state.days[date] ?? { calls: 0, units: 0 };
    const paidUnits = state.paid?.days[date] ?? 0;
    return {
      date,
      count: free.calls + paidUnits,
      quotaUnits: free.units + paidUnits,
      freeUnits: free.units,
      paidUnits,
      estimatedCostUsd: paidUnits * OD_PAID_CEILING.usdPerUnit
    };
  });
  const today = history.find((d) => d.date === todayKey);
  const premium = effectiveOdProfile(state, now) === 'paid';
  return {
    today: today?.count ?? 0,
    last7d: history.filter((d) => d.date >= cutoff7).reduce((n, d) => n + d.count, 0),
    last30d: history.reduce((n, d) => n + d.count, 0),
    estimatedCostUsdToday: today?.estimatedCostUsd ?? 0,
    estimatedCostUsdLast30d: history.reduce((n, d) => n + d.estimatedCostUsd, 0),
    hasKey: hasOpenDotaKey(),
    premium,
    premiumSource: 'db' as OdPremiumSource,
    freeBudget: {
      dailyLimit: OD_LIMITS.daily,
      usedToday: state.days[todayKey]?.units ?? 0,
      minuteUsed: state.recent.reduce((n, d) => n + d.units, 0),
      minuteLimit: premium ? state.paid!.minute : OD_LIMITS.minute,
      hourUsed: state.backgroundHour.units,
      hourBudget: OD_LIMITS.backgroundHour
    },
    paidBudget: state.paid
      ? {
          enabled: state.paid.enabled,
          activeMode: premium ? 'paid' : 'free',
          monthlyUnits: state.paid.months[month]?.units ?? 0,
          monthlyLimitUnits: state.paid.monthlyLimitUnits,
          monthlyCostUsd: (state.paid.months[month]?.units ?? 0) * 0.0001,
          archiveUnits: state.paid.archiveUnits,
          archiveLimitUnits: state.paid.archiveLimitUnits,
          archiveCostUsd: state.paid.archiveUnits * 0.0001,
          minuteLimit: state.paid.minute
        }
      : null,
    blockedUntil: state.blockedUntil > now ? new Date(state.blockedUntil).toISOString() : null,
    blockedReason: state.blockedUntil > now ? state.blockedReason : null,
    history,
    note: 'Shared persistent ledger; UTC calendar month. Monthly $20 cap includes archive; lifetime archive $20. Conservative charge before every attempt; replay POST reserves10units. Monetary exhaustion uses unkeyed free with independent counters; upstream403/429 never triggers fallback. Other programs/account charges are not counted.'
  };
}

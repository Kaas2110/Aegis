/** Native targets are integer kills or integer seconds for one map, never series totals.
 * This is a distribution adapter, not evidence that a model is calibrated.
 * A serving model must validate this exact conditioning/rounding policy out of time.
 */
export interface TotalsDistribution {
  kind: 'conditional_discrete_lognormal_v1';
  logMean: number;
  logStd: number;
  logOffset: 0 | 1;
  unit: 'kills' | 'seconds';
  observedMinimum?: number;
}
export interface TotalsLine { line: number; pOver: number; pUnder: number; pPush: number }

// Normal survival evaluated directly, avoiding cancellation in 1 - CDF(z).
function survival(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + .3275911 * x);
  const tail = .5 * (((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x);
  return z >= 0 ? tail : 1 - tail;
}
function context(d: TotalsDistribution) {
  if (d.kind !== 'conditional_discrete_lognormal_v1' || !Number.isFinite(d.logMean) || !Number.isFinite(d.logStd) || d.logStd <= 0
    || ![0,1].includes(d.logOffset) || !['kills','seconds'].includes(d.unit)
    || (d.observedMinimum !== undefined && (!Number.isFinite(d.observedMinimum) || d.observedMinimum < 0))) return null;
  // An ongoing map cannot finish at/before the observed clock. Kills may stay unchanged.
  const min = d.observedMinimum === undefined ? 0 : d.unit === 'seconds' ? Math.floor(d.observedMinimum) + 1 : Math.ceil(d.observedMinimum);
  const rawTail = (boundary: number) => boundary + d.logOffset <= 0 ? 1 : survival((Math.log(boundary + d.logOffset)-d.logMean)/d.logStd);
  const mass = rawTail(min - .5);
  if (!Number.isFinite(mass) || mass < 1e-12) return null; // Numerically unsupported conditioning; do not invent a forecast.
  return {min, tail: (boundary: number) => boundary <= min - .5 ? 1 : Math.max(0,Math.min(1,rawTail(boundary)/mass))};
}
/** line is in native target units. Equality is a push, not an under. */
export function totalsLine(d: TotalsDistribution, line: number): TotalsLine | null {
  const ctx = context(d);
  if (!ctx || !Number.isFinite(line) || line < 0) return null;
  const pOver = ctx.tail(Math.floor(line) + .5);
  const pUnder = 1 - ctx.tail(Math.ceil(line) - .5);
  const pPush = Math.max(0,1 - pOver - pUnder);
  return {line,pOver,pUnder,pPush};
}
function quantile(d: TotalsDistribution, probability: number): number | null {
  const ctx = context(d);
  if (!ctx) return null;
  let lo = ctx.min, hi = Math.max(lo + 1, Math.ceil(Math.exp(d.logMean+8*d.logStd)-d.logOffset));
  if (!Number.isSafeInteger(hi)) return null;
  while (ctx.tail(hi+.5) > 1-probability) {
    hi *= 2;
    if (!Number.isSafeInteger(hi)) return null;
  }
  while (lo < hi) {
    const mid = Math.floor((lo+hi)/2);
    if (ctx.tail(mid+.5) <= 1-probability) hi = mid; else lo = mid+1;
  }
  return lo;
}
/** All response display numbers share displayUnit. Convert seconds -> minutes exactly once. */
export function totalsLadder(d: TotalsDistribution, requestedCount = 7) {
  const q25 = quantile(d,.25), median = quantile(d,.5), q75 = quantile(d,.75);
  if (q25 === null || median === null || q75 === null) return null;
  const scale = d.unit === 'seconds' ? 60 : 1;
  const count = Number.isFinite(requestedCount) ? Math.max(3,Math.min(15,Math.floor(requestedCount))) : 7;
  const step = d.unit === 'kills' ? 1 : .5;
  const center = d.unit === 'kills' ? median + .5 : Math.round(median/scale*2)/2;
  const firstAllowed = d.unit === 'kills' ? Math.max(.5,(d.observedMinimum ?? 0)+.5)
    : Math.max(.5,(Math.floor((d.observedMinimum ?? 0)/30)+1)*.5);
  const first = Math.max(firstAllowed,center-Math.floor(count/2)*step);
  const lines = Array.from({length:count},(_,i)=>{
    const line = first+i*step;
    return {...totalsLine(d,line*scale)!,line};
  });
  return {displayUnit:d.unit === 'seconds' ? 'minutes' as const : 'kills' as const,
    expectedValue:median/scale,statistic:'median' as const,interval:{q25:q25/scale,q75:q75/scale},lines};
}

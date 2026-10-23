/** Free-only local policy. Actual requests reserve quota in @workspace/db/opendota. */
export function setOdDbPremium(_value: boolean | null): void {}
export function odEnvModeSet(): boolean { return true; }
export function isOpenDotaPremium(): boolean { return false; }
export function withOpenDotaKey(url: string): string { return url; }
export function odThrottleMs(requestedMs: number): number { return Math.max(requestedMs, 1100); }
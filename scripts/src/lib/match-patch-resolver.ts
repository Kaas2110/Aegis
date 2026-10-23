import { createHash } from 'node:crypto';
import { compareDotaPatchVersions } from './patch-catalog';

export const PATCH_RESOLVER_VERSION = 'official-calendar-v1';
const VERSION = /^[1-9][0-9]{0,2}\.[0-9]{2}[a-z]?$/;
export type ReleasePrecision = 'source_timestamp_seconds' | 'date_only_utc';
export interface PatchRelease {
  version: string; source: string; releaseFrom: string; releaseTo: string;
  timestampPrecision: ReleasePrecision; observedAt: string; knownAt: string;
  knowledgeBasis: 'official_publication_timestamp' | 'collector_observation';
}
export interface ProviderPatchEvidence {
  source: string; rawPatch: string | number; version: string | null;
  precision: 'exact' | 'base' | 'unmapped'; receivedAt: string;
  payloadSha256?: string; catalogHash?: string;
}
export interface MatchPatchAssignment {
  matchId: number; matchStart: string; inferredVersion: string | null;
  confirmedVersion: string | null; providerBaseVersion: string | null;
  providerEvidence: ProviderPatchEvidence | null;
  provenance: 'provider_reported_exact' | 'inferred_by_release_calendar' | 'unresolved';
  uncertainty: boolean; reasons: string[]; candidates: string[];
  calendarHash: string; releaseKnownAt: string | null; releaseObservedAt: string | null;
  releaseTimestampPrecision: ReleasePrecision | null;
  inferenceBasis: 'retrospective_as_of_catalog_observation';
  resolverVersion: string; inputFingerprint: string;
}
function timestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new Error('Expected a UTC timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value.slice(0, 10)) throw new Error('Invalid timestamp');
  return ms;
}

/** The source's release time is not proof of the version used by a tournament.
 * An observation made today is valid for retrospective inference, not a claim
 * that our collector knew this metadata before the historical prediction. */
export function makePatchRelease(input: {version: string; date: string; source: string;
  observedAt: string; publicationAt?: string}): PatchRelease {
  if (!VERSION.test(input.version)) throw new Error('Invalid patch version');
  timestamp(input.observedAt);
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(input.date);
  const from = dayOnly ? `${input.date}T00:00:00.000Z` : new Date(timestamp(input.date)).toISOString();
  const start = timestamp(from);
  if (input.publicationAt) timestamp(input.publicationAt);
  return {version: input.version, source: input.source, releaseFrom: from,
    releaseTo: new Date(start + (dayOnly ? 86_400_000 : 0)).toISOString(),
    timestampPrecision: dayOnly ? 'date_only_utc' : 'source_timestamp_seconds',
    observedAt: input.observedAt, knownAt: input.publicationAt ?? input.observedAt,
    knowledgeBasis: input.publicationAt ? 'official_publication_timestamp' : 'collector_observation'};
}

export function normalizeReleases(releases: PatchRelease[]): PatchRelease[] {
  if (!releases.length) throw new Error('An official release calendar is required');
  const names = new Set<string>();
  for (const row of releases) {
    if (!VERSION.test(row.version) || names.has(row.version)) throw new Error('Invalid or duplicate patch version');
    names.add(row.version);
    const from = timestamp(row.releaseFrom), to = timestamp(row.releaseTo);
    timestamp(row.observedAt); timestamp(row.knownAt);
    if (to < from || (row.timestampPrecision === 'date_only_utc' ? to - from !== 86_400_000 : to !== from)) throw new Error('Invalid release precision/window');
  }
  return [...releases].sort((a, b) => timestamp(a.releaseFrom) - timestamp(b.releaseFrom)
    || compareDotaPatchVersions(a.version, b.version));
}

/** Call once per catalog, then resolve many matches without sorting per map. */
export function createPatchResolver(releases: PatchRelease[], calendarHash: string) {
  if (!/^[a-f0-9]{64}$/.test(calendarHash)) throw new Error('Invalid calendar hash');
  const ordered = normalizeReleases(releases);
  const starts = ordered.map(r => timestamp(r.releaseFrom));
  return (input: {matchId: number; startTime: number; provider?: ProviderPatchEvidence | null}): MatchPatchAssignment => {
    if (!Number.isSafeInteger(input.matchId) || input.matchId <= 0 || !Number.isSafeInteger(input.startTime) || input.startTime <= 0) throw new Error('Invalid match identity/start');
    const at = input.startTime * 1000;
    const matchStart = new Date(at).toISOString();
    const provider = input.provider ?? null;
    if (provider && (!['base', 'exact', 'unmapped'].includes(provider.precision)
      || (provider.precision !== 'unmapped' && (!provider.version || !VERSION.test(provider.version)))
      || !Number.isFinite(timestamp(provider.receivedAt)))) throw new Error('Invalid provider patch evidence');
    let low = 0, high = starts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (starts[middle] <= at) low = middle + 1; else high = middle; }
    const selected = ordered[low - 1] ?? null;
    const reasons: string[] = [];
    const candidates = new Set<string>();
    if (selected) {
      candidates.add(selected.version);
      // On a release known only to the day, include the last definite release
      // and every same-day release which could have happened before this map.
      if (timestamp(selected.releaseTo) > at) {
        reasons.push('date_only_release_boundary');
        for (let i = low - 1; i >= 0; i--) {
          candidates.add(ordered[i].version);
          if (timestamp(ordered[i].releaseTo) <= at) break;
        }
        if (![...ordered.slice(0, low)].some(r => timestamp(r.releaseTo) <= at)) reasons.push('previous_release_outside_catalog');
      }
      if (low >= 2 && starts[low - 2] === starts[low - 1]) {
        reasons.push('same_timestamp_releases');
        for (let i = low - 2; i >= 0 && starts[i] === starts[low - 1]; i--) candidates.add(ordered[i].version);
      }
    } else reasons.push('no_release_before_map_start');
    const confirmedVersion = provider?.precision === 'exact' ? provider.version : null;
    const providerBaseVersion = provider?.version?.match(/^[0-9]+\.[0-9]{2}/)?.[0] ?? null;
    if (provider?.precision === 'unmapped') reasons.push('provider_patch_unmapped');
    if (selected && providerBaseVersion && providerBaseVersion !== selected.version.replace(/[a-z]$/, '')) reasons.push('provider_base_conflicts_calendar');
    if (selected && confirmedVersion && !candidates.has(confirmedVersion)) reasons.push('provider_exact_conflicts_calendar');
    const result = {matchId: input.matchId, matchStart, inferredVersion: selected?.version ?? null,
      confirmedVersion, providerBaseVersion, providerEvidence: provider,
      provenance: confirmedVersion ? 'provider_reported_exact' as const : selected ? 'inferred_by_release_calendar' as const : 'unresolved' as const,
      // Even a clean calendar estimate remains inferred; this flag identifies
      // *additional* ambiguity/conflict, not a certificate of confirmation.
      uncertainty: reasons.length > 0, reasons, candidates: [...candidates].sort(compareDotaPatchVersions),
      calendarHash, releaseKnownAt: selected?.knownAt ?? null, releaseObservedAt: selected?.observedAt ?? null,
      releaseTimestampPrecision: selected?.timestampPrecision ?? null,
      inferenceBasis: 'retrospective_as_of_catalog_observation' as const, resolverVersion: PATCH_RESOLVER_VERSION};
    return {...result, inputFingerprint: createHash('sha256').update(JSON.stringify(result)).digest('hex')};
  };
}

import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { normalizePatchCatalog, compareDotaPatchVersions, VALVE_PATCH_SOURCE, PATCH_CATALOG_SOURCE,
  VALVE_PATCH_STATE_FILE, PATCH_STATE_FILE } from './patch-catalog';
import { readMatchObservation } from './match-observation';
import { makePatchRelease, type ProviderPatchEvidence } from './match-patch-resolver';

/** Read and verify the immutable catalog saved by our existing collector.
 * Valve patch_timestamp is preserved as source seconds; it is not promoted to
 * a publication/knowledge timestamp. This path performs no provider requests. */
export function readLocalPatchCatalog(stateDir: string, provider: 'valve' | 'opendota') {
  if (!isAbsolute(stateDir)) throw new Error('An absolute state directory is required');
  const checkpoint = JSON.parse(readFileSync(join(stateDir, provider === 'valve' ? VALVE_PATCH_STATE_FILE : PATCH_STATE_FILE), 'utf8'));
  const ref = checkpoint.snapshot;
  if (!ref || typeof ref.file !== 'string' || basename(ref.file) !== ref.file
    || !new RegExp(`^${provider}-patches-[\\dTZ-]+-[a-f0-9]{64}-[a-f0-9-]{36}\\.json$`).test(ref.file)) throw new Error('Invalid calendar snapshot reference');
  const snapshot = JSON.parse(readFileSync(join(stateDir, ref.file), 'utf8'));
  const source = provider === 'valve' ? VALVE_PATCH_SOURCE : PATCH_CATALOG_SOURCE;
  const normalized = normalizePatchCatalog(snapshot.catalog, Date.parse(snapshot.receivedAt), provider === 'valve' ? compareDotaPatchVersions : undefined);
  if (snapshot.version !== 1 || snapshot.identity !== `${provider}_patch_catalog` || snapshot.source !== source
    || checkpoint.source !== source || normalized.hash !== snapshot.hash || snapshot.hash !== ref.hash
    || snapshot.receivedAt !== ref.receivedAt) throw new Error('Calendar snapshot integrity check failed');
  return {hash: normalized.hash, receivedAt: snapshot.receivedAt as string, source,
    lastCheckedAt: checkpoint.lastSuccessfulReceivedAt as string | undefined,
    // Raw dates preserve date-only precision if a future source supplies it.
    catalog: snapshot.catalog as {name: string; date: string; id?: number}[]};
}

export function loadOfficialReleases(stateDir: string) {
  const snapshot = readLocalPatchCatalog(stateDir, 'valve');
  return {...snapshot, releases: snapshot.catalog.map(row => makePatchRelease({version: row.name,
    date: row.date, source: snapshot.source, observedAt: snapshot.receivedAt}))};
}

export function providerPatchEvidence(raw: unknown, receivedAt: string, payloadSha256: string,
  idVersions: Map<number, string>, catalogHash?: string): ProviderPatchEvidence | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let version: string | null = null;
  let precision: ProviderPatchEvidence['precision'] = 'unmapped';
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && idVersions.has(raw)) {
    version = idVersions.get(raw)!;
    // OpenDota's numeric catalog is coarse; it cannot confirm a letter patch.
    precision = 'base';
  } else if (typeof raw === 'string' && /^[1-9][0-9]{0,2}\.[0-9]{2}[a-z]?$/.test(raw)) {
    version = raw; precision = /[a-z]$/.test(raw) ? 'exact' : 'base';
  }
  return {source: 'opendota_match_observation', rawPatch: raw, version, precision,
    receivedAt, payloadSha256, ...(typeof raw === 'number' && catalogHash ? {catalogHash} : {})};
}

/** Select the latest non-null patch evidence by collector receipt. No replay
 * outcome/player field is used; the original observation remains immutable. */
export function readProviderPatchEvidence(stateDir: string) {
  let secondary: ReturnType<typeof readLocalPatchCatalog> | null = null;
  try { secondary = readLocalPatchCatalog(stateDir, 'opendota'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const ids = new Map<number, string>((secondary?.catalog ?? []).filter(row => row.id !== undefined).map(row => [row.id!, row.name]));
  const root = join(stateDir, 'observations', 'opendota-match-details');
  const evidence = new Map<number, ProviderPatchEvidence>();
  let observations = 0;
  if (!existsSync(root)) return {evidence, observations, secondaryCatalogAvailable: !!secondary};
  if (lstatSync(root).isSymbolicLink()) throw new Error('Unexpected observation journal symlink');
  for (const day of readdirSync(root, {withFileTypes: true})) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
    for (const entry of readdirSync(join(root, day.name), {withFileTypes: true})) {
      const match = /^(\d+)-[a-f0-9-]+\.json\.gz$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const id = Number(match[1]);
      const observation = readMatchObservation(stateDir, join(root, day.name, entry.name), id);
      if (!observation) continue;
      observations++;
      const value = providerPatchEvidence(observation.payload.patch, observation.receivedAt, observation.payloadSha256, ids, secondary?.hash);
      if (value && (!evidence.has(id) || value.receivedAt > evidence.get(id)!.receivedAt)) evidence.set(id, value);
    }
  }
  return {evidence, observations, secondaryCatalogAvailable: !!secondary};
}

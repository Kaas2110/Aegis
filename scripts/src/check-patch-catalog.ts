import { openDotaBackgroundFetch } from '@workspace/db/opendota';
import { checkPatchCatalog, comparePatchCatalogs } from './lib/patch-catalog';

// Valve is the primary patch calendar, including letter balance updates. OD's
// coarser calendar remains a separate mapping source with its existing quota.
const official = await checkPatchCatalog({stateDir: process.env.AEGIS_STATE_DIR, provider: 'valve', fetchImpl: globalThis.fetch});
const secondary = await checkPatchCatalog({stateDir: process.env.AEGIS_STATE_DIR, fetchImpl: openDotaBackgroundFetch});
console.log(JSON.stringify({event: 'patch-catalog-check', ...comparePatchCatalogs(official, secondary), official, secondary}));
// A degraded source stays visible without stopping required match ingestion.
process.exitCode = [official, secondary].some(result => result.state === 'degraded') ? 20
  : [official, secondary].every(result => result.state === 'skipped') ? 10 : 0;

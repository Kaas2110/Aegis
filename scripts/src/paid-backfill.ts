/** Bounded archive enrichment. No training, activation or replay POST. */
import { refreshMatchDetails } from './refresh-match-details.js';
import { openDotaLedger } from '@workspace/db/opendota';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
async function main() {
  const snapshot = await openDotaLedger.snapshot();
  if (!snapshot.state.paid?.enabled)
    throw new Error('Archive mode is not enabled in the shared ledger');
  const limit = Number(process.argv[2] ?? 800);
  if (!Number.isInteger(limit) || limit < 1 || limit > 800)
    throw new Error('Archive detail limit must be1..800');
  // A small explicitly bounded validation run skips the separate history page walk.
  if (process.argv[2] === undefined) {
    if (!process.env.AEGIS_STATE_DIR) throw new Error('AEGIS_STATE_DIR is required');
    const cursor = path.join(process.env.AEGIS_STATE_DIR, 'opendota-backfill-paid-archive-v1.json');
    let cutoff = Math.floor(Date.now() / 1000) - 365 * 86400;
    try {
      const previous = JSON.parse(readFileSync(cursor, 'utf8'));
      cutoff = previous.stopAfter;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Invalid paid archive cursor');
    }
    if (!Number.isSafeInteger(cutoff) || cutoff <= 0)
      throw new Error('Invalid paid archive cutoff');
    const run = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('./ingest-matches.ts', import.meta.url)),
        '20',
        '--archive',
        '--checkpoint=paid-archive-v1',
        `--stop-after-unix=${cutoff}`
      ],
      { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 }
    );
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
  }
  await refreshMatchDetails({ archive: true, limit, concurrency: 2, maxDurationMs: 420_000 });
}
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[paid-backfill]', error instanceof Error ? error.message : 'failed');
    process.exit((error as any)?.code === 'OD_DEFERRED' ? 10 : 1);
  });

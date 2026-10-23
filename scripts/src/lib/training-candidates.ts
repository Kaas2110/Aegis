import { randomUUID } from 'node:crypto';
import { modelVersionsTable } from '@workspace/db/schema';

export type CandidateRow = typeof modelVersionsTable.$inferInsert;
export type TrainingDatabase = Pick<typeof import('@workspace/db').db, 'transaction'>;

export interface CandidateProvenance {
  trainer: string;
  seed: number;
  limitations: string[];
  runId?: string;
}

/** Legacy datasets have not passed the chronological/as-of validation contract. */
export function assertCandidateOnlyArgs(args: string[] = process.argv.slice(2)): void {
  if (args.some(arg => /^--(?:activate|promote|validated)(?:=|$)/.test(arg))) {
    throw new Error('Legacy trainers only create inactive, unvalidated candidates. Promotion requires the separate validated-manifest pipeline.');
  }
}

export function prepareLegacyCandidates(rows: CandidateRow[], provenance: CandidateProvenance): CandidateRow[] {
  if (!provenance.trainer || provenance.limitations.length === 0) {
    throw new Error('Candidate provenance must identify the trainer and unresolved validation limitations.');
  }
  const runId = provenance.runId ?? randomUUID();
  const keys = new Set<string>();
  return rows.map(row => {
    if (!row.kind || !row.engine || !Number.isInteger(row.featuresVersion) || row.featuresVersion! < 1) {
      throw new Error('A candidate requires an explicit kind, featuresVersion and engine.');
    }
    const key = JSON.stringify([row.kind, row.featuresVersion, row.engine]);
    if (keys.has(key)) throw new Error(`Duplicate candidate key: ${key}`);
    keys.add(key);
    return {
      ...row,
      version: `${row.version}-candidate-${runId}`,
      isActive: false,
      metadata: {
        ...row.metadata,
        validationStatus: 'legacy_unvalidated',
        eligibleForPromotion: false,
        trainingRun: {
          id: runId,
          trainer: provenance.trainer,
          seed: provenance.seed,
          nodeVersion: process.version,
          mode: 'candidate_only',
          validatedManifest: null,
          limitations: [...provenance.limitations],
        },
      },
    };
  });
}

/** Insert-only, atomic persistence. Existing champions and fallbacks are untouched. */
export async function saveLegacyCandidates(database: TrainingDatabase, rows: CandidateRow[], provenance: CandidateProvenance): Promise<void> {
  assertCandidateOnlyArgs();
  const candidates = prepareLegacyCandidates(rows, provenance);
  if (candidates.length === 0) return;
  await database.transaction(async tx => {
    await tx.insert(modelVersionsTable).values(candidates);
  });
}

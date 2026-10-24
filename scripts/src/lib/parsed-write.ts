/** A conservative current-row write plan, not per-field historical versioning.
 * Call only after locking this match's parent row and reading the existing row.
 * Retained older responses remain in the raw journal; they cannot rewrite a
 * newer parsed projection or attach its surviving values to an older receipt.
 */
import {mergeParsedPayload, type ParsedPayload} from './parsed-payload.js';

type PreviousParsed = Parameters<typeof mergeParsedPayload>[0] & {parsedAt?: unknown};
export type ParsedWritePlan =
  | {status: 'skip_not_newer'; values: null; parsedAt: null}
  | {status: 'write'; values: ParsedPayload; parsedAt: Date;
      availabilityBasis: 'incoming_receipt' | 'unknown_prior_materialization'};

function time(value: unknown): number | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const n = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

export function planParsedWrite(previous: PreviousParsed | null, incoming: ParsedPayload,
  {receivedAt, materializedAt}: {receivedAt: Date; materializedAt: Date}): ParsedWritePlan {
  const receipt = time(receivedAt), materialization = time(materializedAt);
  if (receipt === null || materialization === null || receipt > materialization) {
    throw new Error('parsed_write_invalid_receipt_or_materialization');
  }
  const prior = time(previous?.parsedAt);
  if (previous !== null && prior !== null && receipt <= prior) {
    return {status: 'skip_not_newer', values: null, parsedAt: null};
  }
  const unknownPrior = previous !== null && prior === null;
  const available = Math.max(receipt, prior ?? receipt, unknownPrior ? materialization : receipt);
  return {status: 'write', values: mergeParsedPayload(previous, incoming), parsedAt: new Date(available),
    availabilityBasis: unknownPrior ? 'unknown_prior_materialization' : 'incoming_receipt'};
}

/** A bounded retry for idempotent GETs, including failures while reading JSON. */
import { openDotaBackgroundFetch } from '@workspace/db/opendota';
interface RetryOptions {
  timeoutMs?: number;
  minDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, reason: string, delayMs: number) => void;
}

class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Sanitized classification for the persistent collector, without keyed URLs. */
export class OpenDotaGetError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs: number | null, readonly status: number | null) {
    super(message);
    this.name = 'OpenDotaGetError';
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH',
  'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const duration = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function failureReason(error: unknown, signal: AbortSignal): { retry: boolean; label: string } {
  if (error instanceof HttpStatusError) {
    return { retry: error.status === 429 || (error.status >= 500 && error.status <= 599), label: `HTTP ${error.status}` };
  }
  if (signal.aborted && signal.reason?.name === 'TimeoutError') {
    return { retry: true, label: 'timeout' };
  }
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const details = current as { name?: string; code?: string; cause?: unknown };
    if (details.name === 'TimeoutError') return { retry: true, label: 'timeout' };
    if (details.code && TRANSIENT_CODES.has(details.code)) return { retry: true, label: details.code };
    current = details.cause;
  }
  return { retry: false, label: error instanceof SyntaxError ? 'invalid JSON' : 'non-transient request failure' };
}

export async function fetchJsonGet<T>(url: string, options: RetryOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? openDotaBackgroundFetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const minDelayMs = options.minDelayMs ?? 1100;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    try {
      const response = await fetchImpl(url, { method: 'GET', signal });
      if (!response.ok) {
        const waitMs = retryAfterMs(response.headers.get('retry-after'));
        await response.body?.cancel().catch(() => {});
        throw new HttpStatusError(response.status, waitMs);
      }
      // Keep the deadline active until the full body has been read and parsed.
      return await response.json() as T;
    } catch (error) {
      // The shared ledger has already reserved/blocked the attempt. Defer the
      // entire job; retrying this error would not send a request and wastes time.
      if ((error as { code?: string } | null)?.code === 'OD_DEFERRED') throw error;
      const reason = failureReason(error, signal);
      const serverWaitMs = error instanceof HttpStatusError ? error.retryAfterMs : null;
      // Do not retry earlier than a long Retry-After; leave it to the next job.
      if (!reason.retry || attempt === 3 || (serverWaitMs !== null && serverWaitMs > 30_000)) {
        // Do not propagate upstream exceptions: they may contain a keyed URL.
        const deferred = serverWaitMs !== null && serverWaitMs > 30_000
          ? `; server Retry-After ${Math.ceil(serverWaitMs / 1000)}s exceeds the 30s retry-wait limit, deferred to a later job`
          : '';
        throw new OpenDotaGetError(`OpenDota GET failed after ${attempt} attempt(s): ${reason.label}${deferred}`,
          reason.retry, serverWaitMs, error instanceof HttpStatusError ? error.status : null);
      }
      const backoffMs = error instanceof HttpStatusError && error.status === 429 ? 5000 * attempt : minDelayMs * attempt;
      const delayMs = Math.max(minDelayMs, backoffMs, serverWaitMs ?? 0);
      options.onRetry?.(attempt, reason.label, delayMs);
      await sleep(delayMs);
    }
  }
  throw new Error('OpenDota GET exhausted its attempt limit.');
}

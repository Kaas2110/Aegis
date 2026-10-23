/** Only these fields may reach diagnostics; raw errors, URLs and response bodies never do. */
export type SafeProviderFeedError =
  | { category: 'http'; httpStatus: number }
  | { category: 'network'; networkCode: string }
  | { category: 'timeout' | 'aborted' | 'quota_deferred' | 'invalid_payload' | 'unknown' };
const NETWORK_CODES = new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN',
  'ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);

export class ProviderFeedHttpError extends Error {
  constructor(readonly httpStatus: number) { super('Provider HTTP failure'); this.name = 'ProviderFeedHttpError'; }
}
export class ProviderFeedPayloadError extends Error {
  constructor() { super('Provider payload invalid'); this.name = 'ProviderFeedPayloadError'; }
}
/** Wrap only a positively identified quota exception at the provider boundary. */
export class ProviderFeedQuotaError extends Error {
  constructor() { super('Provider quota deferred'); this.name = 'ProviderFeedQuotaError'; }
}
export function classifyProviderFeedError(error: unknown): SafeProviderFeedError {
  let current = error;
  const seen = new Set<unknown>();
  try {
    for (let depth=0; depth<5 && current !== null && typeof current === 'object'; depth++) {
      if (seen.has(current)) break;
      seen.add(current);
      if (current instanceof ProviderFeedHttpError && Number.isInteger(current.httpStatus)
        && current.httpStatus >= 100 && current.httpStatus <= 599)
        return { category:'http', httpStatus:current.httpStatus };
      if (current instanceof ProviderFeedQuotaError) return { category:'quota_deferred' };
      if (current instanceof ProviderFeedPayloadError || current instanceof SyntaxError)
        return { category:'invalid_payload' };
      const item = current as {name?: unknown; code?: unknown; cause?: unknown};
      if (item.name === 'TimeoutError') return { category:'timeout' };
      if (item.name === 'AbortError') return { category:'aborted' };
      if (typeof item.code === 'string' && NETWORK_CODES.has(item.code))
        return { category:'network', networkCode:item.code };
      current = item.cause;
    }
  } catch { /* Even hostile getters must not affect feed retention or expose raw input. */ }
  return { category:'unknown' };
}

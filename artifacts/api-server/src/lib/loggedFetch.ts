/**
 * fetch-обёртка с подробным structured-логированием для прода.
 *
 * Логирует на каждый запрос: URL (host+path, без query), method, status,
 * длительность, размер ответа в байтах, ошибку (если есть). Поле `tag`
 * группирует запросы по логическому источнику (opendota / pandascore /
 * stratz / bovada / ml-service / etc) — удобно фильтровать `tag=bovada` в проде.
 *
 * Использование:
 *   const r = await loggedFetch('bovada', url, { timeout: 8000 });
 *
 * Принцип: НИЧЕГО не глотает — все ошибки и не-2xx статусы попадают в логи как
 * warn/error, плюс пробрасываются вверх. Вызывающий сам решает что с этим делать.
 */
import { logger } from './logger';

export interface LoggedFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Жёсткий таймаут (мс). По умолчанию 15000. */
  timeout?: number;
  /** Опциональный AbortSignal от вызывающего (мерджится с timeout). */
  signal?: AbortSignal;
}

function safeUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: 'unknown', path: url.slice(0, 80) };
  }
}

export async function loggedFetch(
  tag: string,
  url: string,
  opts: LoggedFetchOptions = {},
): Promise<Response> {
  const { host, path } = safeUrl(url);
  const method = (opts.method ?? 'GET').toUpperCase();
  const timeoutMs = opts.timeout ?? 15_000;
  const startedAt = Date.now();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method,
      headers: opts.headers,
      body: opts.body,
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const contentLength = resp.headers.get('content-length');
    const bytes = contentLength ? Number(contentLength) : null;
    const meta = {
      tag,
      method,
      host,
      path,
      status: resp.status,
      durationMs,
      bytes,
    };
    if (resp.ok) {
      logger.info(meta, '[upstream] ok');
    } else {
      logger.warn(meta, '[upstream] non-2xx');
    }
    return resp;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const isAbort = (err as { name?: string }).name === 'AbortError';
    const reason = isAbort
      ? (opts.signal?.aborted ? 'caller_abort' : `timeout_${timeoutMs}ms`)
      : (err instanceof Error ? err.message : String(err));
    logger.warn(
      { tag, method, host, path, durationMs, err: reason },
      '[upstream] error',
    );
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
}

import { openDotaArchiveFetch, OdQuotaExhaustedError } from '@workspace/db/opendota';
/** Short, non-spending pacing waits only. Upstream blocks and free quota defer the job. */
export const archiveFetch: typeof fetch = async (input, init) => {
  for (;;) {
    try {
      return await openDotaArchiveFetch(input, init);
    } catch (error) {
      if (
        !(error instanceof OdQuotaExhaustedError) ||
        !['archive_pacing', 'minute_limit'].includes(error.reason)
      )
        throw error;
      const wait = error.retryAt - Date.now() + 10;
      if (wait < 0 || wait > 5000) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
      init?.signal?.throwIfAborted();
    }
  }
};

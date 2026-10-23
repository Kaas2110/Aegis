/** Browser origins are explicit; native clients do not send Origin. */
export function browserOriginAllowed(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (origin === undefined) return true;
  if (!validOrigin(origin)) return false;
  const local = new Set(['http://127.0.0.1:8080', 'http://localhost:8080']);
  if (local.has(origin)) return true;
  if (env.AEGIS_LOCAL_ONLY === 'true') return false;
  const configured = (env.AEGIS_AUTH_ALLOWED_ORIGINS ?? '').split(',').map(v => v.trim());
  return configured.some(value => validOrigin(value) && value === origin);
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}

/** No historical hosting fallback and no trust in request Host/forwarded headers. */
export function referralLanding(configured: unknown, env: NodeJS.ProcessEnv = process.env): string {
  for (const value of [configured, env.AEGIS_PUBLIC_APP_URL]) {
    if (typeof value !== 'string' || value.length > 4096) continue;
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch { /* Invalid optional configuration falls back to the current site. */ }
  }
  return '/';
}

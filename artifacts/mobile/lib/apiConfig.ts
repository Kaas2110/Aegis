export type ApiPlatform = 'web' | 'native';

/** Public server origin only. Never infer a localhost server on a phone. */
export function resolveApiOrigin(configuredUrl: string | undefined, platform: ApiPlatform): string {
  const value = configuredUrl?.trim() ?? '';
  if (!value) {
    if (platform === 'web') return '';
    throw new Error('api_url_required');
  }
  let url: URL;
  try {url = new URL(value);} catch {throw new Error('api_url_invalid');}
  const path = url.pathname.replace(/\/+$/, '');
  if (!['https:','http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || (path !== '' && path !== '/api')) {
    throw new Error('api_url_invalid');
  }
  return url.origin;
}

export function buildApiUrl(path: string, configuredUrl: string | undefined, platform: ApiPlatform): string {
  if (!/^\/api(?:\/|\?|$)/.test(path) || /[\\#]/.test(path) || path.split('?')[0].split('/').some(segment=>segment === '..' || segment === '.')) throw new Error('api_path_invalid');
  return resolveApiOrigin(configuredUrl, platform) + path;
}

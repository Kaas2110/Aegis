import {Agent} from 'node:https';
import nodeFetch from 'node-fetch';

// Verified on the local deployment: these public Russian feeds work directly,
// while the configured environment proxy cannot connect. Bovada needs that
// proxy, so never change global process/Windows proxy settings for one source.
const directHosts = new Set(['line-lb51.bk6bba-resources.com','line-lb51-w.pb06e2-resources.com']);
const directAgent = new Agent({keepAlive:true,proxyEnv:{}} as ConstructorParameters<typeof Agent>[0]);

export async function fetchBookmaker(url: string, init: RequestInit): Promise<Response> {
  if (!directHosts.has(new URL(url).hostname)) return fetch(url,init);
  const response = await nodeFetch(url,{
    headers:init.headers as Record<string,string>,signal:init.signal,agent:directAgent,
    // Fixed source hosts, bounded responses, no credentials or external redirects.
    redirect:'error',size:16*1024*1024,
  });
  return response as unknown as Response;
}

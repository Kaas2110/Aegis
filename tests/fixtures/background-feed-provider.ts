
export const FEED_INTERVALS={opendota_live:120000,stratz_live:120000,pandascore_running:120000,pandascore_upcoming:300000,heroes:86400000,hero_stats:3600000,odds_api_dota2:3600000,odds_api_sports:86400000};
let value:any={data:null,receivedAt:null,attemptedAt:null,error:'background_feed_not_ready'};
export function setFeedFixture(v:any){value=v;}
export async function readProviderFeed(_key:string){return structuredClone(value);}
export async function refreshProviderFeed(){throw new Error('public HTTP route attempted collector refresh');}

export function providerFeedIsEnabled(_key:string){return true;}

export const liveSnapshotsTable='snapshot',predictionsTable='predictions',teamsTable='teams',matchDraftsTable='drafts',modelVersionsTable='models';
export const fixture:any={rows:{},feed:null};
export function eq(..._args:any[]){return null;} export const desc=eq,inArray=eq;
export const db={select(){let name='';const query:any={from(n:string){name=n;return query;},where(){return query;},orderBy(){return query;},limit(){return query;},catch(reject:any){return Promise.resolve(fixture.rows[name]??[]).catch(reject);},then(resolve:any,reject:any){return Promise.resolve(fixture.rows[name]??[]).then(resolve,reject);}};return query;}};
export async function readProviderFeed(){return fixture.feed;}
export function getActiveLiveModel(){return {version:'winner-v1'};}
export async function predictMatchWinner(){return null;}
export function getPredictionModelRevision(){return 'fixture';}
export function getMarketModelRevision(){return 'fixture';}
export async function predictMarketsFor(){return null;}
export function probLogNormalOver(){throw new Error('Legacy probability callback must not run');}
export function isActiveMarketVersion(v:string,market:string){return v===market+'-validated';}

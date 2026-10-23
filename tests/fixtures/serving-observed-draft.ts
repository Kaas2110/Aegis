// Offline serving integration fixture; no database, credentials, provider or ML calls.
export const teamsTable={},predictionsTable={},liveSnapshotsTable={},matchDraftsTable={},modelVersionsTable={},
  liveObservationJournalTable={},livePredictionJournalTable={};
let tables=new Map<object,unknown[]>(),feed:unknown;
export function setupServingFixture(nextFeed:unknown,rows:Array<[object,unknown[]]>) {feed=nextFeed;tables=new Map(rows);}
export const db={select:()=>({from:(table:object)=>{
  const chain:any=new Proxy({}, {get:(_target,key)=>key==='then'
    ? (resolve:any)=>Promise.resolve(tables.get(table)??[]).then(resolve):()=>chain});
  return chain;
}})};
export async function readProviderFeed(){return feed;}
export function getActiveLiveModel(){return {version:'state-tree'};}
export function getPredictionModelRevision(){return 'fixture';}
export function getAllActiveModels(){return [{engine:'lightgbm',version:'draft-tree',artifactHash:'a'.repeat(64),featuresVersion:2}];}
export async function predictMatchWinner(){return null;}
export function getMarketModelRevision(){return 'fixture';}
export async function predictMarketsFor(){return null;}
export function isActiveMarketVersion(){return false;}

let identityRows:unknown[]=[];
export function setTeamIdentityRows(rows:unknown[]){identityRows=rows;}
export const pool={query:async()=>({rows:identityRows})};

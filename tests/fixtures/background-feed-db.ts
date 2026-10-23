
// Every database read returns an empty result. No database or provider is contacted.
const chain: any = new Proxy({}, {get:(_target,key)=>key==='then' ? (resolve:any)=>Promise.resolve([]).then(resolve) : ()=>chain});
export const db={select:()=>chain};
export const pool={query:async()=>({rows:[]})};
export const teamsTable:any={}, leaguesTable:any={}, heroStatsTable:any={}, liveSnapshotsTable:any={}, matchDraftsTable:any={}, proMatchesTable:any={};

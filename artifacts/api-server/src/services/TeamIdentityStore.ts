import type {TeamCatalogueRow,TeamHistoryIdentityRow} from './TeamIdentity';

export const TEAM_IDENTITY_ROW_LIMIT=10_000;
export const TEAM_IDENTITY_QUERY_TIMEOUT_MS=5_000;
/** Only persisted completed-map identity pairs. No ratings or outcomes derived. */
export const TEAM_IDENTITY_SQL=`WITH names AS (
 SELECT radiant_team_id AS team_id,radiant_name AS name,start_time FROM pro_matches
 WHERE radiant_team_id>0 AND radiant_name IS NOT NULL AND btrim(radiant_name)<>'' AND start_time>0 AND duration>0
   AND start_time+duration<=EXTRACT(EPOCH FROM now()) AND ingested_at<=now()
 UNION ALL
 SELECT dire_team_id AS team_id,dire_name AS name,start_time FROM pro_matches
 WHERE dire_team_id>0 AND dire_name IS NOT NULL AND btrim(dire_name)<>'' AND start_time>0 AND duration>0
   AND start_time+duration<=EXTRACT(EPOCH FROM now()) AND ingested_at<=now()
)
SELECT 'catalogue' AS source,team_id,name,tag,rating,NULL::bigint AS last_seen_at,0::int AS matches FROM teams
UNION ALL
SELECT 'history' AS source,team_id,name,NULL::text AS tag,NULL::real AS rating,
 MAX(start_time) AS last_seen_at,COUNT(*)::int AS matches FROM names GROUP BY team_id,name
LIMIT ${TEAM_IDENTITY_ROW_LIMIT+1}`;

export type TeamIdentityRows={catalogue:TeamCatalogueRow[];history:TeamHistoryIdentityRow[];available:boolean};
type DbRow={source:string;team_id:unknown;name:string|null;tag:string|null;rating:number|null;last_seen_at:unknown;matches:unknown};
type ReadRows=()=>Promise<readonly DbRow[]>;
const empty=():TeamIdentityRows=>({catalogue:[],history:[],available:false});
/** Single-flight read, 60-second success cache, 5-second failure cooldown.
 * Overflow/error clears old data: partial rows might hide a name collision.
 */
export function createTeamIdentityReader(read:ReadRows,now:()=>number=Date.now) {
  let cached:TeamIdentityRows=empty(),expires=-Infinity;
  let pending:Promise<TeamIdentityRows>|null=null;
  return async():Promise<TeamIdentityRows>=>{
    if(now()<expires)return cached;
    if(pending)return pending;
    pending=Promise.resolve().then(async()=>{
      try {
        const rows=await read();
        if(rows.length>TEAM_IDENTITY_ROW_LIMIT)throw new Error('team_identity_row_limit');
        const result:TeamIdentityRows={catalogue:[],history:[],available:true};
        for(const row of rows) {
          const id=Number(row.team_id);
          if(!Number.isSafeInteger(id)||id<=0)throw new Error('team_identity_invalid_id');
          if(row.source==='catalogue')result.catalogue.push({teamId:id,name:row.name,tag:row.tag,rating:row.rating});
          else if(row.source==='history') {
            // Missing names are real provider gaps, not identities or collisions.
            if(!row.name?.trim())continue;
            const lastSeenAt=Number(row.last_seen_at),matches=Number(row.matches);
            if(!Number.isSafeInteger(lastSeenAt)||lastSeenAt<=0||!Number.isSafeInteger(matches)||matches<=0)
              throw new Error('team_identity_invalid_history');
            result.history.push({teamId:id,name:row.name,lastSeenAt,matches});
          } else throw new Error('team_identity_invalid_source');
        }
        cached=result;expires=now()+60_000;return result;
      } catch {
        cached=empty();expires=now()+5_000;return cached;
      }
    }).finally(()=>{pending=null;});
    return pending;
  };
}

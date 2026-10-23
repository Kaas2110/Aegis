import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocalCapture,canonical,sha} from './steamLiveAdapter.mjs';
import {REVIEWED_LEGACY_SOURCE_SCHEMA_HASH} from './recordedNormalization.mjs';
import {evaluatePinnedNativeHistory} from './historicalAlignment.mjs';
const pin=data=>{const utf8=typeof data==='string'?data:JSON.stringify(data);return{utf8,pin:{path:'synthetic-compatibility.json',bytes:Buffer.byteLength(utf8),sha256:sha(utf8)}};};
function fixture(legacy){
 const players=side=>Array.from({length:5},(_,i)=>({account_id:side*5+i+1,hero_id:side*5+i+1,net_worth:5000+i,gold_per_min:300+i,xp_per_min:400+i,level:10,gold:0,item0:0,item1:0,item2:0,item3:0,item4:0,item5:-1}));
 const rawCaptureInput=pin({result:{games:[{match_id:999,game_state:5,radiant_team:{team_id:1},dire_team:{team_id:2},scoreboard:{duration:900,roshan_respawn_timer:0,radiant:{score:10,players:players(0)},dire:{score:12,players:players(1)}}}]}}),at='2026-10-23T00:15:00Z';
 const o=normalizeLocalCapture({body:Buffer.from(rawCaptureInput.utf8),endpoint:'GetLiveLeagueGames/v1',httpStatus:200,requestStartedAt:at,receivedAt:at,persistedAt:at,rawSha256:rawCaptureInput.pin.sha256,payloadRef:'journal:'+rawCaptureInput.pin.sha256,authenticatedAttempt:true}).observations[0];
 if(legacy){
  delete o.normalizationContract;o.sourceSchemaHash=REVIEWED_LEGACY_SOURCE_SCHEMA_HASH;
  const metrics=[o.providerGameClockSeconds,o.declaredBroadcastDelaySeconds];for(const side of ['radiant','dire']){const s=o.sides[side];metrics.push(s.score,s.towerMaskRaw,s.barracksMaskRaw);for(const p of s.players)metrics.push(p.level,p.netWorth,p.goldPerMinute,p.experiencePerMinute,p.gold,p.netGoldRaw,...p.observedItemFields);}
  for(const m of metrics)for(const key of ['fieldEvidenceContract','sourceFieldPath','sourceProfile','knownAt','rawSha256','units','availabilityBasis','providerEventTimeProven','substitution'])delete m[key];
  // This canonical digest was independently generated using the reviewed legacy
  // adapter, not calculated from the new verifier's own compatibility expectation.
  assert.equal(sha(canonical(o)),'fc76df1308ae86300f63941289239929fb8ebb6b10e7a973620f870019db9d61');
 }
 const roster=[...players(0),...players(1)].map((p,i)=>({accountId:String(p.account_id),heroId:p.hero_id,side:i<5?'radiant':'dire',teamId:i<5?'1':'2'}));
 const priorMapInput=pin({matchId:'999',durationSeconds:2700,endedAt:'2026-10-23T00:45:00Z',outcomeKnownAt:'2026-10-23T00:46:00Z',durationKnownAt:'2026-10-23T00:46:00Z',heroesKnownAt:'2026-10-23T00:01:00Z',playersKnownAt:'2026-10-23T00:46:00Z',radiantTeamId:'1',direTeamId:'2',radiantWon:true,players:roster,heroes:roster.map(({heroId,side})=>({heroId,side}))});
 return{observationInput:pin(o),rawCaptureInput,priorMapInput,targetMapId:'1000',historyCutoffAt:'2026-10-23T01:00:00Z',computedAt:'2026-10-23T02:00:00Z'};
}
for(const legacy of [true,false])test('pinned S3 alignment fully verifies '+(legacy?'retained recognized v1':'current v2')+' without rewriting it',()=>{const input=fixture(legacy),before=structuredClone(input),r=evaluatePinnedNativeHistory(input);assert.equal(r.accepted,true);assert.equal(r.normalizationEvidence.legacyCompatibilityApplied,legacy);assert.equal(r.normalizationEvidence.recordedObjectRewritten,false);assert.deepEqual(input,before);});
for(const mutate of [o=>o.sides.radiant.players[0].netWorth.value++,o=>o.extraneous='unreviewed',o=>o.sourceSchemaHash='f'.repeat(64)])test('legacy compatibility cannot hide repinned metric/shape/version corruption '+String(mutate),()=>{const f=fixture(true),o=JSON.parse(f.observationInput.utf8);mutate(o);f.observationInput=pin(o);assert.equal(evaluatePinnedNativeHistory(f).reason,'raw_normalized_evidence_mismatch');});

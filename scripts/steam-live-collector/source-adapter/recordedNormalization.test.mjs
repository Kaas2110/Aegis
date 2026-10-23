/** Synthetic compatibility and tamper cases, with a pinned pre-v2 golden hash. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocalCapture,canonical,sha} from './steamLiveAdapter.mjs';
import {verifyRecordedNormalizedObservation,REVIEWED_LEGACY_SOURCE_SCHEMA_HASH} from './recordedNormalization.mjs';
function input(){
 const players=side=>Array.from({length:5},(_,i)=>({account_id:side*5+i+1,hero_id:side*5+i+1,net_worth:5000+i,gold_per_min:300+i,xp_per_min:400+i,level:10,gold:0,item0:0,item1:0,item2:0,item3:0,item4:0,item5:-1}));
 const body=Buffer.from(JSON.stringify({result:{games:[{match_id:999,game_state:5,radiant_team:{team_id:1},dire_team:{team_id:2},scoreboard:{duration:900,roshan_respawn_timer:0,radiant:{score:10,players:players(0)},dire:{score:12,players:players(1)}}}]}}));
 const rawSha256=sha(body),at='2026-10-23T00:15:00Z';
 return{body,endpoint:'GetLiveLeagueGames/v1',httpStatus:200,requestStartedAt:at,receivedAt:at,persistedAt:at,rawSha256,payloadRef:'journal:'+rawSha256,authenticatedAttempt:true};
}
function current(){return normalizeLocalCapture(input()).observations[0];}
// A fixture builder only. The result is checked against an independently produced
// baseline-normalizer canonical SHA before it is used for compatibility tests.
function legacy(){
 const x=current();delete x.normalizationContract;x.sourceSchemaHash=REVIEWED_LEGACY_SOURCE_SCHEMA_HASH;
 const metrics=[x.providerGameClockSeconds,x.declaredBroadcastDelaySeconds];
 for(const side of ['radiant','dire']){
  const s=x.sides[side];metrics.push(s.score,s.towerMaskRaw,s.barracksMaskRaw);
  for(const p of s.players)metrics.push(p.level,p.netWorth,p.goldPerMinute,p.experiencePerMinute,p.gold,p.netGoldRaw,...p.observedItemFields);
 }
 for(const m of metrics)for(const key of ['fieldEvidenceContract','sourceFieldPath','sourceProfile','knownAt','rawSha256','units','availabilityBasis','providerEventTimeProven','substitution'])delete m[key];
 assert.equal(sha(canonical(x)),'fc76df1308ae86300f63941289239929fb8ebb6b10e7a973620f870019db9d61');
 return x;
}
test('recognized legacy row verifies fully and yields a separately versioned projection',()=>{
 const recorded=legacy(),before=canonical(recorded),r=verifyRecordedNormalizedObservation(input(),recorded);
 assert.equal(r.accepted,true);assert.equal(r.legacyCompatibilityApplied,true);assert.equal(r.recordedObjectRewritten,false);
 assert.equal(canonical(recorded),before);assert.equal(r.replayedObservation.normalizationContract,'steam-live-scoreboard-normalization.v2');
 assert.equal(r.replayedObservation.observationId,recorded.observationId);assert.equal(r.replayedObservation.sides.radiant.players[0].netWorth.units,'gold_value');
});
test('current version uses full equality without compatibility',()=>{
 const r=verifyRecordedNormalizedObservation(input(),current());assert.equal(r.legacyCompatibilityApplied,false);assert.equal(r.accepted,true);
});
for(const [label,mutate,pattern]of [
 ['legacy metric',x=>x.sides.radiant.players[0].netWorth.value++,/content_mismatch/],
 ['legacy raw subset',x=>x.source.rawPacket.scoreboard.radiant.players[0].net_worth++,/content_mismatch/],
 ['legacy extra field',x=>x.extraneous='unreviewed',/content_mismatch/],
 ['legacy added provenance',x=>x.sides.radiant.players[0].netWorth.knownAt=x.source.capture.receivedAt,/content_mismatch/],
 ['legacy missing required field',x=>delete x.sides.radiant.players[0].netWorth.status,/content_mismatch/],
 ['legacy unknown schema',x=>x.sourceSchemaHash='f'.repeat(64),/version_unsupported/],
 ['unknown explicit version',x=>x.normalizationContract='steam-live-scoreboard-normalization.v999',/version_unsupported/],
 ['legacy forged current version',x=>x.normalizationContract='steam-live-scoreboard-normalization.v2',/schema_unsupported/],
 ['legacy observation id',x=>x.observationId='0'.repeat(64),/raw_identity_mismatch/],
])test(label+' corruption fails closed',()=>{const x=legacy();mutate(x);assert.throws(()=>verifyRecordedNormalizedObservation(input(),x),pattern);});
test('current metadata corruption is not removed by legacy compatibility',()=>{
 const x=current();x.sides.radiant.players[0].netWorth.units='gold_per_minute';assert.throws(()=>verifyRecordedNormalizedObservation(input(),x),/content_mismatch/);
});
test('current marker removal cannot select legacy by itself',()=>{
 const x=current();delete x.normalizationContract;assert.throws(()=>verifyRecordedNormalizedObservation(input(),x),/version_unsupported/);
});
test('changed raw capture cannot validate an earlier saved observation',()=>{
 const x=legacy(),i=input(),b=JSON.parse(i.body);b.result.games[0].scoreboard.duration=901;
 i.body=Buffer.from(JSON.stringify(b));i.rawSha256=sha(i.body);i.payloadRef='journal:'+i.rawSha256;
 assert.throws(()=>verifyRecordedNormalizedObservation(i,x),/raw_identity_mismatch/);
});

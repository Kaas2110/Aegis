import test from 'node:test';
import assert from 'node:assert/strict';
import {expireMarketQuotes,nextExpiryDelay} from '../artifacts/mobile/lib/marketExpiry';
import type {BookmakerOdds} from '../artifacts/mobile/types';
const now=Date.parse('2026-10-04T00:00:00Z');
const quote=(source:string,expiry=now+5000):BookmakerOdds=>({bookmakerId:source,bookmakerName:source,expiresAt:new Date(expiry).toISOString(),oddsTeam1:2,oddsTeam2:1.9,impliedProbTeam1:.5,impliedProbTeam2:1/1.9,fairProbTeam1:.49,fairProbTeam2:.51,freshness:1,snapshotAge:190});
const fixture=()=>({bestOdds:quote('bovada'),allBookmakerOdds:[quote('bovada'),quote('pari',now+195000)],prediction:{modelProbability:.7,expiresAt:new Date(now+60000).toISOString(),edge:.21,ev:.4,marketFairProbability:.49}});

test('quote expires before model while offline: remove odds/EV, keep model probability and source identity',()=>{
  const original=fixture();
  assert.equal(expireMarketQuotes(original,now+4999),original);
  const expired=expireMarketQuotes(original,now+5000);
  assert.equal(expired.prediction.modelProbability,.7);
  assert.equal(expired.prediction.expiresAt,original.prediction.expiresAt);
  assert.equal(expired.bestOdds.bookmakerId,'bovada');
  assert.equal(expired.bestOdds.oddsTeam1,0);assert.equal(expired.bestOdds.oddsTeam2,0);
  assert.equal(expired.prediction.ev,null);assert.equal(expired.prediction.edge,null);assert.equal(expired.prediction.marketFairProbability,0);
  assert.deepEqual(expired.allBookmakerOdds.map(q=>q.bookmakerId),['pari']);
  assert.equal(original.bestOdds.oddsTeam1,2);assert.equal(original.prediction.ev,.4);
});

test('unknown/malformed expiry or incomplete prices cannot remain actionable',()=>{
  for(const patch of [{expiresAt:undefined},{expiresAt:'invalid'},{oddsTeam2:NaN},{oddsTeam1:1}]) {
    const original=fixture();original.bestOdds={...original.bestOdds,...patch};
    const safe=expireMarketQuotes(original,now);
    assert.equal(safe.bestOdds.oddsTeam1,0);assert.equal(safe.prediction.ev,null);assert.equal(safe.prediction.modelProbability,.7);
  }
});

test('quote-only payload neither fabricates a model nor retains stale prices',()=>{
  const quoteOnly={bestOdds:quote('bovada'),allBookmakerOdds:[quote('bovada')]};
  assert.equal(expireMarketQuotes(quoteOnly,now).bestOdds.oddsTeam1,2);
  const expired=expireMarketQuotes(quoteOnly,now+5000);
  assert.equal(expired.bestOdds.oddsTeam1,0);assert.equal(expired.allBookmakerOdds.length,0);assert.ok(!('prediction' in expired));
});

test('clock wakes at quote boundary independently from model and caps idle ticks',()=>{
  assert.equal(nextExpiryDelay([new Date(now+60000).toISOString(),new Date(now+5000).toISOString()],now),5000);
  assert.equal(nextExpiryDelay([new Date(now+1).toISOString()],now),1);
  assert.equal(nextExpiryDelay(['invalid',undefined,new Date(now-1).toISOString()],now),15000);
});

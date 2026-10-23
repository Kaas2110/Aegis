import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreFilters,normalizeBookmaker} from '../artifacts/mobile/lib/filterPersistence';
import type {Filters,FilterBookmaker} from '../artifacts/mobile/types';
const defaults:Filters={bookmaker:'none',minOdds:1.5,minEdge:.03,minConfidence:60,eventType:'all',mode:'all',onlyPositiveEV:false,hideStaleData:false};

test('all seven selected sources and explicit none survive serialized cold-start restoration',()=>{
  for(const bookmaker of ['none','bovada','fonbet','liga_stavok','pari','betboom','x1stavka','olimp'] as FilterBookmaker[]) {
    const saved={...defaults,bookmaker,minOdds:2,mode:'live' as const};
    const first=restoreFilters(JSON.stringify(saved),defaults);
    assert.deepEqual(first,saved);
    assert.deepEqual(restoreFilters(JSON.stringify(first),defaults),saved);
  }
});

test('old all/betfair and unknown stored IDs become real none without resetting other filters',()=>{
  for(const bookmaker of ['all','betfair','deleted_provider',null,123]) {
    const restored=restoreFilters(JSON.stringify({...defaults,bookmaker,minOdds:3,mode:'prematch'}),defaults);
    assert.equal(restored.bookmaker,'none');assert.equal(restored.minOdds,3);assert.equal(restored.mode,'prematch');
    assert.equal(normalizeBookmaker(bookmaker),'none');
    assert.equal(restoreFilters(JSON.stringify(restored),defaults).bookmaker,'none');
  }
});

test('missing or damaged stored filters restore safe defaults; legacy partial objects retain valid choices',()=>{
  for(const raw of [null,'{broken','null','[]','"pari"','42'])assert.deepEqual(restoreFilters(raw,defaults),defaults);
  assert.deepEqual(restoreFilters('{"bookmaker":"pari"}',defaults),{...defaults,bookmaker:'pari'});
  assert.deepEqual(defaults.bookmaker,'none');
});

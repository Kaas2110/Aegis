import test from 'node:test';
import assert from 'node:assert/strict';
import {teamIdentityMessages} from '../artifacts/mobile/lib/teamIdentityStatus';
test('history ID without rating is distinct from unmatched and does not claim forecast accuracy',()=>{
  const lines=teamIdentityMessages('RES','IMP',{team1:null,team2:{status:'resolved',method:'history_exact_name',reason:'resolved',ratingAvailable:false}});
  assert.deepEqual(lines,['IMP: команда найдена в истории матчей, рейтинг пока отсутствует.']);
});
test('ambiguous identities expose the reason; complete identities and absent evidence stay quiet',()=>{
  assert.deepEqual(teamIdentityMessages('A','B'),[]);
  assert.deepEqual(teamIdentityMessages('A','B',{team1:{status:'resolved',method:'provider_id',reason:'resolved',ratingAvailable:true},team2:null}),[]);
  assert.deepEqual(teamIdentityMessages('A','B',{team1:null,team2:{status:'unresolved',method:null,reason:'name_ambiguous',ratingAvailable:false}}),['B: найдено несколько команд с таким именем.']);
});

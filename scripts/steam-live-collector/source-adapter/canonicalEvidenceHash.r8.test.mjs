import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {hashCanonicalEvidence} from './canonicalEvidenceHash.mjs';
// Independent bounded fixtures retain the exact prior grammar as a parity oracle.
const legacy=x=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(legacy).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+legacy(x[k])).join(',')+'}';
const digest=x=>createHash('sha256').update(legacy(x)).digest('hex');
test('streamed canonical evidence preserves legacy hashes across scalar/key/array/Unicode/missing cases',()=>{
 const sparse=Array(3);sparse[1]='x';const shared={a:1,b:['a',-0,null]};
 for(const value of [null,0,-0,1e100,NaN,Infinity,'\ud800','x😀y',{z:2,a:1},[3,undefined,null,NaN],sparse,{missing:undefined,present:null},{quote:'"\\\n',nested:{β:'😀',a:'é'}},{first:shared,second:shared},Array.from({length:1000},(_,i)=>({i,shared}))])assert.equal(hashCanonicalEvidence(value),digest(value));
});
test('streamed canonical evidence handles repeated immutable DAGs without mutating or treating sharing as a cycle',()=>{
 const leaf=Object.freeze({description:'x'.repeat(2048),fields:Object.freeze(['NW','GPM','level'])}),value=Object.freeze(Array(4096).fill(leaf));assert.equal(hashCanonicalEvidence(value),digest(value));assert.equal(value[0],value[4095]);
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>hashCanonicalEvidence(cyclic),/cyclic_data/);assert.throws(()=>hashCanonicalEvidence(undefined),/undefined_root/);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {createDiagnosticResourceArena,measureBoundedJsonBytes} from './diagnosticResourceArena.mjs';
test('bounded measurement matches actual JSON UTF8 for controls Unicode lone surrogates and omissions',()=>{
 for(const value of [{a:'quote" slash\\ controls\u0000\b\t\n\f\r',b:'кириллица 😀 \ud800 \udc00',c:undefined,d:[null,true,false,0,-0,1e-7,1e21,undefined]},[,,{nested:['x',42]}],Object.assign(Object.create(null),{a:'utf8'})])assert.equal(measureBoundedJsonBytes(value),Buffer.byteLength(JSON.stringify(value)));
});
test('measurement rejects accessors cycles and bounds without invoking arbitrary getters',()=>{
 let entered=0;const getter=Object.defineProperty({},'a',{enumerable:true,get(){entered++;return'large';}});assert.throws(()=>measureBoundedJsonBytes(getter),/accessor/);assert.equal(entered,0);
 const cycle={};cycle.self=cycle;assert.throws(()=>measureBoundedJsonBytes(cycle),/plain_json/);
 assert.throws(()=>measureBoundedJsonBytes({s:'x'.repeat(10000)},{maxBytes:64}),/byte_bound/);
 assert.throws(()=>measureBoundedJsonBytes([1,2,3],{maxNodes:2}),/structure_bound/);
});
test('unique immutable assets are charged until every cache and in-flight owner releases',()=>{
 const arena=createDiagnosticResourceArena({maxBytes:1024}),asset=Object.freeze({schema:'same'}),cache=arena.retainAsset(asset,800),inflight=arena.retainAsset(asset,800);
 assert.equal(arena.status().chargedBytes,800);assert.equal(arena.reserve(225),null);assert.equal(arena.status().leases,2);
 assert.throws(()=>arena.retainAsset(asset,801),/asset_charge_changed/);cache.release();assert.equal(arena.status().chargedBytes,800);assert.equal(cache.release(),false);inflight.release();assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
 const write=arena.reserve(1024);assert.ok(write);write.release();assert.equal(arena.status().heldAssets,0);
});
test('explicit owner8GiB arena retains an exact finite boundary while default remains2GiB',()=>{
 // Engineering tickets exercise safe integer admission; this allocates no8GiB
 // buffer and cannot stand in for the external whole-process JobObject check.
 const maximum=8*1024**3,arena=createDiagnosticResourceArena({maxBytes:maximum});assert.equal(arena.status().maxBytes,maximum);const lease=arena.reserve(maximum);assert.ok(lease);assert.equal(arena.status().chargedBytes,maximum);assert.equal(arena.reserve(1),null);assert.equal(lease.release(),true);assert.equal(lease.release(),false);assert.equal(arena.status().chargedBytes,0);assert.equal(arena.status().leases,0);
 assert.throws(()=>createDiagnosticResourceArena({maxBytes:maximum+1}),/configuration/);assert.equal(createDiagnosticResourceArena().status().maxBytes,2*1024**3);
});

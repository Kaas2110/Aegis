import test from 'node:test';
import assert from 'node:assert/strict';
import pg from '../lib/db/node_modules/pg/lib/index.js';
import { configureApiDbPool } from '../artifacts/api-server/src/lib/configureApiDbPool';

test('API min retention changes no other public pool setting and does not eagerly connect',async()=>{
 const pool=new pg.Pool({max:1});
 try{
  const options={...pool.options};configureApiDbPool(pool);
  assert.equal(pool.options.min,1);assert.equal(pool.totalCount,0);
  assert.deepEqual({...pool.options,min:options.min},options);
 }finally{await pool.end();}
});

test('installed pg retains two API backends past the default 10s idle timeout; CLI still evicts all',async()=>{
 assert.ok(process.env.DATABASE_URL,'A local DATABASE_URL is required; this test never calls upstream providers');
 const api=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:30000});
 const cli=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:30000});
 const max=api.options.max;configureApiDbPool(api);
 let apiCreated=0;api.on('connect',()=>apiCreated++);
 try{
  assert.equal(api.options.min,2);assert.equal(api.options.max,max);
  assert.equal(cli.options.min,0);assert.equal(api.options.idleTimeoutMillis,10000);
  const leases=await Promise.all([api.connect(),api.connect(),api.connect()]);
  const cliLease=await cli.connect();
  const before=(await Promise.all(leases.map(c=>c.query('SELECT pg_backend_pid() AS pid')))).map(r=>r.rows[0].pid);
  for(const lease of leases)lease.release();cliLease.release();
  await new Promise(resolve=>setTimeout(resolve,11000));
  assert.equal(api.totalCount,2);assert.equal(api.idleCount,2);assert.equal(cli.totalCount,0);
  const retained=await Promise.all([api.connect(),api.connect()]);
  const after=(await Promise.all(retained.map(c=>c.query('SELECT pg_backend_pid() AS pid')))).map(r=>r.rows[0].pid);
  for(const lease of retained)lease.release();
  assert.equal(apiCreated,3,'No new backend may be needed after idle eviction');
  assert.ok(after.every(pid=>before.includes(pid)));assert.equal(new Set(after).size,2);
  console.log(JSON.stringify({before,after,apiTotal:api.totalCount,cliTotal:cli.totalCount,idleWaitMs:11000}));
 }finally{await Promise.all([api.end(),cli.end()]);}
});

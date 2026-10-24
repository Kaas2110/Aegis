import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {relative,resolve} from 'node:path';
import {loadLocalUnifiedProducerConfig} from './unifiedProducerConfig.mjs';

test('published source identity covers the current producer static local dependency closure',()=>{
 const app=fileURLToPath(new URL('../../../',import.meta.url));
 const inventory=loadLocalUnifiedProducerConfig().sourceInventory;
 const listed=new Set(Object.values(inventory).flatMap(g=>g.files.map(f=>f.path)));
 const seen=new Set();
 function visit(url){
  const path=fileURLToPath(url);if(seen.has(path))return;seen.add(path);assert.ok(seen.size<=64,'bounded current production module closure');
  const source=readFileSync(path,'utf8');
  for(const match of source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g))if(match[1].startsWith('.'))visit(new URL(match[1],url));
 }
 visit(new URL('./unifiedFeatureProducer.mjs',import.meta.url));
 for(const path of seen)assert.ok(listed.has(relative(resolve(app),path).replaceAll('\\','/')),path+' missing source identity');
});

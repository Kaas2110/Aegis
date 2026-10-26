import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWindowsArtifactWriterLeaseProvider} from './artifactWriterLeaseWindows.mjs';
import {acquireArtifactWriterLease,assertArtifactWriterLease,releaseArtifactWriterLease} from './artifactWriterLease.mjs';

// Explicitly opted-in REAL OS lock check, not part of ordinary synthetic runs.
// Root owns bounded native execution and chooses the approved absolute Python.
test('Windows OS-held lease excludes a second helper and releases on owner close',{
 skip:process.platform!=='win32'||!process.env.AEGIS_TEST_PYTHON,
},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-windows-artifact-lease-r5-'));
 const provider=createWindowsArtifactWriterLeaseProvider({pythonExecutable:process.env.AEGIS_TEST_PYTHON});
 let first,second;
 t.after(async()=>{await releaseArtifactWriterLease(first);await releaseArtifactWriterLease(second);const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('aegis-windows-artifact-lease-r5-'));await fs.rm(target,{recursive:true,force:true});});
 first=await acquireArtifactWriterLease(provider,directory);await assertArtifactWriterLease(first,directory);
 await assert.rejects(acquireArtifactWriterLease(provider,directory),/acquire_or_assert_failed|released_or_exited/);
 await assertArtifactWriterLease(first,directory);await releaseArtifactWriterLease(first);
 second=await acquireArtifactWriterLease(provider,directory);await assertArtifactWriterLease(second,directory);
 assert.equal((await fs.stat(path.join(directory,'.artifact-writer-lease'))).size,1);
});

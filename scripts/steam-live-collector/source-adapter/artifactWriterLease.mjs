/** Trusted host lease boundary. Ownership is never reconstructed from JSON, a
 * PID, lockfile age or a claimed boolean. The injected callable port is trusted
 * infrastructure; tests may explicitly substitute a synthetic held-lease port.
 * The Windows adapter supplies a process-lifetime OS byte-range lock. */
const providers=new WeakMap(),leases=new WeakMap();
const fail=x=>{throw Error('artifact_writer_lease:'+x);};
export function createOwnedArtifactWriterLeaseProvider({acquireExclusive}){
 if(typeof acquireExclusive!=='function')fail('acquire_port');
 const token=Object.freeze({contract:'aegis.owned-artifact-writer-lease-provider.v1'});
 providers.set(token,acquireExclusive);return token;
}
export async function acquireArtifactWriterLease(provider,directory){
 const acquire=providers.get(provider);if(!acquire)fail('unowned_provider');
 const port=await acquire({directory});
 if(!port||typeof port.assertHeld!=='function'||typeof port.release!=='function')fail('held_port');
 try{await port.assertHeld();}catch(error){try{await port.release();}catch{}throw error;}
 const token=Object.freeze({contract:'aegis.held-artifact-writer-lease.v1'});
 leases.set(token,{port,directory,closed:false});return token;
}
export async function assertArtifactWriterLease(token,directory){
 const entry=leases.get(token);if(!entry||entry.closed||entry.directory!==directory)fail('not_owned');
 await entry.port.assertHeld();
}
export async function releaseArtifactWriterLease(token){
 const entry=leases.get(token);if(!entry||entry.closed)return;
 entry.closed=true;await entry.port.release();
}

import {mkdir,readFile,readdir,open,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {CoverageOperation} from './liveCoverageContract';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const valid=/^(\d{20})_([a-f0-9-]{36})\.json$/;
/** Ordered durable operations. A failed DB write never acknowledges/deletes a file. */
export class CoverageOutbox {
  readonly directory:string;
  private sequence:bigint|null=null;
  private queue:Promise<unknown>=Promise.resolve();
  private draining:Promise<number>|null=null;
  constructor(stateDir:string){if(!isAbsolute(stateDir))throw new Error('absolute_coverage_state_dir_required');
    this.directory=join(stateDir,'live-coverage-outbox');}
  private async durable(path:string,text:string){const temp=path+'.'+randomUUID()+'.tmp';
    const f=await open(temp,'wx');try{await f.writeFile(text,'utf8');await f.sync();}finally{await f.close();}
    await rename(temp,path);}
  async enqueue(raw:Omit<CoverageOperation,'sequence'>):Promise<void>{
    const work=this.queue.then(async()=>{
      await mkdir(this.directory,{recursive:true});
      if(this.sequence===null){
        let saved='0';try{saved=(await readFile(join(this.directory,'sequence'),'utf8')).trim();}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        if(!/^\d{1,20}$/.test(saved))throw new Error('coverage_sequence_file_invalid');
        this.sequence=BigInt(saved);
        for(const name of await readdir(this.directory)){const match=valid.exec(name);if(match&&BigInt(match[1])>this.sequence)this.sequence=BigInt(match[1]);}
      }
      if(!/^[a-f0-9-]{36}$/.test(raw.id))throw new Error('coverage_operation_id_invalid');
      const wall=BigInt(Date.now())*1000n;this.sequence=this.sequence>=wall?this.sequence+1n:wall;
      const operation:CoverageOperation={...raw,sequence:this.sequence.toString()};
      const file=join(this.directory,this.sequence.toString().padStart(20,'0')+'_'+raw.id+'.json');
      await this.durable(file,JSON.stringify({operation,sha256:digest(operation)}));
      await this.durable(join(this.directory,'sequence'),this.sequence.toString());
    });
    this.queue=work.catch(()=>{});return work;
  }
  drain(consume:(operation:CoverageOperation)=>Promise<void>):Promise<number>{
    if(this.draining)return this.draining;
    this.draining=(async()=>{await mkdir(this.directory,{recursive:true});let completed=0;
      while(true){const names=(await readdir(this.directory)).filter(n=>valid.test(n)).sort().slice(0,50);
        if(!names.length)return completed;
        for(const name of names){const path=join(this.directory,name),entry=JSON.parse(await readFile(path,'utf8'));
          const match=valid.exec(name)!;
          if(!entry.operation||digest(entry.operation)!==entry.sha256||BigInt(entry.operation.sequence)!==BigInt(match[1])
            ||entry.operation.id!==match[2])throw new Error('coverage_outbox_integrity');
          await consume(entry.operation);await unlink(path);completed++;
        }
      }
    })().finally(()=>{this.draining=null;});return this.draining;
  }
}

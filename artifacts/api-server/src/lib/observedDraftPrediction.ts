import {safeOpenDotaId} from './openDotaLiveIds';
import type {SupportedEstimate} from '../services/PredictionContract';

type Row={observation:{matchId:number;receivedAt:Date;gameTimeSec:number|null;phase:string;
  input:Record<string,unknown>;availability:Record<string,unknown>};prediction:{producer:string;status:string;
  modelVersion:string|null;predictedAt:Date;evidence:Record<string,unknown>|null;output:Record<string,unknown>|null}};
function draftIdentity(players:unknown,normalized:boolean):string|null {
  if(!Array.isArray(players)||players.length!==10) return null;
  const rows=players.map(p=>({side:p?.team,hero:safeOpenDotaId(p?.[normalized?'heroId':'hero_id']),
    account:safeOpenDotaId(p?.[normalized?'accountId':'account_id'])??null}));
  if(rows.some(p=>!p.hero || (p.side!==0 && p.side!==1)) || rows.filter(p=>p.side===0).length!==5
    || new Set(rows.map(p=>p.hero)).size!==10) return null;
  return JSON.stringify(rows.sort((a,b)=>a.side-b.side || a.hero!-b.hero!));
}

/** Select an actual collector result. Never recalculate rich draft inputs in an HTTP handler. */
export function selectObservedDraftPrediction(packet:Record<string,unknown>,rows:Row[],
  activeBoosters:Array<{version:string;hash:string;featuresVersion:number}>,orientation:'same'|'flipped',now=Date.now()):SupportedEstimate|null {
  const clock=packet.game_time,identity=draftIdentity(packet.players,false),id=safeOpenDotaId(packet.match_id);
  const radiant=safeOpenDotaId(packet.team_id_radiant),dire=safeOpenDotaId(packet.team_id_dire);
  if(!id || !radiant || !dire || radiant===dire || !identity || typeof clock!=='number' || !Number.isFinite(clock) || clock< -3600 || clock>=60) return null;
  for(const {observation:o,prediction:p} of rows) {
    const model=activeBoosters.find(m=>m.featuresVersion>=2&&m.version===p.modelVersion&&m.hash===p.evidence?.modelHash);
    const age=now-o.receivedAt.getTime(),predAge=now-p.predictedAt.getTime();
    if(o.matchId!==id || o.gameTimeSec!==clock || age< -5000 || age>=180_000 || predAge< -5000 || predAge>=180_000
      || p.predictedAt<o.receivedAt || o.availability.outcomeKnownAtCapture!==false || o.availability.draftComplete!==true
      || o.input.radiantTeamId!==safeOpenDotaId(packet.team_id_radiant) || o.input.direTeamId!==safeOpenDotaId(packet.team_id_dire)
      || draftIdentity(o.input.players,true)!==identity || (clock<0?o.phase!=='post_draft':o.phase!=='live')
      || p.producer!=='prematch_context' || p.status!=='predicted'
      || !model) continue;
    const prob=p.output?.radiantWinProbability;
    if(typeof prob!=='number'||!Number.isFinite(prob)||prob<0||prob>1) continue;
    return {probability:orientation==='flipped'?1-prob:prob,modelVersion:p.modelVersion!,
      predictedAt:p.predictedAt.toISOString(),observedAt:o.receivedAt.toISOString(),
      featuresVersion:model.featuresVersion,calibrationMethod:'model_bundle',basis:clock<0?'observed_post_draft':'observed_early_live_draft_context'};
  }
  return null;
}

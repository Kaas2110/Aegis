/** Pinned SYNTHETIC inputs for the actual canonical feature producer. No network,
 * database, fitted model or real-provider/source-coverage evidence is supplied. */
import {draftArgs,draftEntry,pinned} from './observedDraftHistory.fixtures.mjs';
import {normalizeLocalCapture} from './steamLiveAdapter.mjs';
import {createDynamicHistoryProof} from './observedDraftFeatureBundle.mjs';
import {createUnifiedFeatureProducer} from './unifiedFeatureProducer.mjs';

export function syntheticRichProducerFixture({matchId='90001',seriesId='synthetic-r5-series',startAt='2026-10-23T12:30:00Z',resourceArena=null,capacityProfile}={}){
 const args=draftArgs({matchId,accounts:true,time:startAt,clock:0,phase:2});
 args.matchId=matchId;args.computedAt=startAt;
 const history=createDynamicHistoryProof(args,{includeInspectionCopies:false});
 const producer=createUnifiedFeatureProducer({resourceArena,...(capacityProfile===undefined?{}:{projectionOptions:{capacityProfile}})});
 const seriesInput=pinned({contract:'aegis.series-map-receipts.v1',seriesId,bestOf:3,team1Id:'100',team2Id:'200',availableAt:startAt,completeThroughMapNumber:0,previousMaps:[]});
 let previousLiveState=null;
 function frame(clock){
  const receivedAt=new Date(Date.parse(startAt)+clock*1000).toISOString(),entry=draftEntry({matchId,accounts:true,time:receivedAt,clock,phase:5}),metadata=JSON.parse(entry.metadataInput.utf8),raw=JSON.parse(entry.rawInput.utf8),board=raw.result.games[0].scoreboard;
  for(const[side,sign]of [['radiant',1],['dire',-1]]){
   board[side].score=Math.floor(clock/90)+(side==='radiant'?2:0);
   for(const[p,i]of board[side].players.map((p,i)=>[p,i]))Object.assign(p,{net_worth:600+clock*(6+i)+sign*100,gold_per_min:360+i*15+sign*5,xp_per_min:420+i*15+sign*8,level:Math.min(30,1+Math.floor(clock/180)),gold:clock%500,kills:Math.floor(clock/(180+i*30)),deaths:Math.floor(clock/(250+i*20)),assists:Math.floor(clock/(150+i*20)),last_hits:Math.floor(clock/(6+i)),denies:Math.floor(clock/100),item0:0,item1:0,item2:0,item3:0,item4:0,item5:0});
  }
  const rawInput=pinned(raw),observation=normalizeLocalCapture({...metadata.capture,body:Buffer.from(rawInput.utf8),rawSha256:rawInput.pin.sha256,payloadRef:'journal:'+rawInput.pin.sha256}).observations[0];
  return{rawInput,metadataInput:pinned({...metadata,observationId:observation.observationId}),receivedAt};
 }
 function generate(clock=null){
  const f=clock===null?null:frame(clock),decisionAt=f?new Date(Date.parse(f.receivedAt)+100).toISOString():startAt;
  const out=producer.generateFeatureBundle({mode:f?'LIVE':'POST',matchId,decisionAt,historyProof:history.proof,seriesInput,currentMapNumber:1,...f?{livePrefixInputs:[{rawInput:f.rawInput,metadataInput:f.metadataInput}],previousLiveState}:{}});
  if(f)previousLiveState=out.nextLiveState;
  return out;
 }
 return{producer,generate,frame,historyProof:history.proof,args,seriesInput};
}

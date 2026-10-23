/** Model and quote clocks are independent. Expired probability must never survive beside a fresh quote. */
export function expireTotalsAt<T extends {
  expiresAt?:string;probabilityExpiresAt?:string;lines:Array<{pOver:number|null;pUnder:number|null;pPush:number|null}>;
  expectedValue:number|null;interval:unknown;projection:unknown;
}>(value:T|null,now=Date.now()):T|null{
  if(!value)return value;
  if(value.expiresAt&&Date.parse(value.expiresAt)<=now)return {...value,lines:[],expectedValue:null,interval:null,projection:null,unavailable:true};
  if(value.probabilityExpiresAt&&Date.parse(value.probabilityExpiresAt)<=now)return {...value,
    lines:value.lines.map(r=>({...r,pOver:null,pUnder:null,pPush:null})),expectedValue:null,interval:null,projection:null,
    modelUnavailable:true,modelUnavailableReason:'Прогноз устарел; показаны актуальные коэффициенты БК'};
  return value;
}

export type Spec={version:1;sessionId:string;candidateManifestSha256:string;startsAtMs:number;expiresAtMs:number;
 maxDispatches:number;maxReservedBytes:number;maxResponseBytes:number;minFreeDiskBytes:number};
export type State={contract:string;spec:Spec;specSha256:string;lastObservedAtMs:number;dispatches:number;reservedBytes:number;
 reservations:Array<{attemptId:string;requestSha256:string;requestBytes:number;reservedBytes:number;atMs:number}>;
 ingress:Array<{batchId:string;bytes:number;atMs:number}>;ingressBytes:number;closure:null|{reason:string;atMs:number}};
export type Decision={allowed:boolean;reason?:string;expiresAtMs?:number;remainingMs?:number;maximumResponseBytes?:number};
export const LIMITS:Readonly<{durationMs:number;maxDispatches:number;maxReservedBytes:number;maxResponseBytes:number;
 maxRequestBytes:number;minFreeDiskBytes:number;maxIngressBytes:number;maxIngressBatches:number}>;
export function hash(value:unknown):string;
export function readState(file:string,pin:string):State;
export function createExplicitSession(file:string,spec:Spec):string;
export function checkWindow(file:string,pin:string,now?:number,freeBytes?:()=>number):Decision;
export function admitIngress(file:string,pin:string,batchId:string,bytes:number,options?:{now?:number;freeBytes?:()=>number}):Decision;
export function reserve(file:string,pin:string,request:{attemptId:string;requestSha256:string;requestBytes:number},
 options?:{now?:number;freeBytes?:()=>number}):Decision;

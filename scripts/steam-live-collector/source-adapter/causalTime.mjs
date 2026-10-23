/** Exact, timezone-aware instants for as-of gates. BigInt stays outside JSON evidence. */
export function instantNs(value){
 if(typeof value!=='string'||value.length>64)return null;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
 if(!m)return null;
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
 if(year<1||month<1||month>12||day<1||day>31||hour>23||minute>59||second>59)return null;
 const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,0);
 if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
 const offsetHours=Number(m[10]??0),offsetMinutes=Number(m[11]??0);
 if(offsetHours>23||offsetMinutes>59)return null;
 const offset=(m[9]==='-'?-1:1)*(offsetHours*60+offsetMinutes);
 return BigInt(date.getTime()-offset*60000)*1000000n+BigInt((m[7]??'').padEnd(9,'0'));
}

/** Allocation-light JSON grammar/structure admission before JSON.parse.
 * Counts and estimated parsed bytes are engineering bounds, not measured V8 heap.
 * Scanning does not build decoded strings, property maps or an object graph. */
export function inspectBoundedJsonSource(utf8,{maxBytes=64*1024**2,maxNodes=8000000,maxDepth=64}={}){
 if(typeof utf8!=='string'||!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxNodes)||maxNodes<1||maxNodes>8000000||!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>64)throw Error('bounded_json:configuration');
 const size=Buffer.byteLength(utf8);if(size<1||size>maxBytes)throw Error('bounded_json:byte_bound');
 let i=0,nodes=0,properties=0,containers=0,strings=0,stringUnits=0,peakDepth=0;
 const fail=()=>{throw Error('bounded_json:syntax_or_structure_bound');},digit=c=>c>=48&&c<=57;
 function ws(){while(i<utf8.length&&[32,9,10,13].includes(utf8.charCodeAt(i)))i++;}
 function string(){if(utf8.charCodeAt(i++)!==34)fail();strings++;const start=i;let ended=false;
  while(i<utf8.length){const c=utf8.charCodeAt(i++);if(c===34){ended=true;break;}if(c<32)fail();if(c===92){const e=utf8[i++];if(e==='u'){for(let j=0;j<4;j++)if(!/[0-9a-fA-F]/.test(utf8[i++]??''))fail();}else if(!['"','\\','/','b','f','n','r','t'].includes(e))fail();}}
  if(!ended)fail();stringUnits+=i-start-1;
 }
 function number(){if(utf8[i]==='-')i++;if(utf8[i]==='0')i++;else{if(!(utf8.charCodeAt(i)>=49&&utf8.charCodeAt(i)<=57))fail();while(digit(utf8.charCodeAt(i)))i++;}
  if(utf8[i]==='.'){i++;if(!digit(utf8.charCodeAt(i)))fail();while(digit(utf8.charCodeAt(i)))i++;}
  if(utf8[i]==='e'||utf8[i]==='E'){i++;if(utf8[i]==='+'||utf8[i]==='-')i++;if(!digit(utf8.charCodeAt(i)))fail();while(digit(utf8.charCodeAt(i)))i++;}
 }
 function value(depth){ws();if(++nodes>maxNodes||depth>maxDepth)fail();peakDepth=Math.max(peakDepth,depth);const c=utf8[i];
  if(c==='"'){string();return;}
  if(c==='{'||c==='['){containers++;i++;ws();const object=c==='{',end=object?'}':']';if(utf8[i]===end){i++;return;}
   while(true){if(object){if(utf8[i]!=='"')fail();string();if(++properties>maxNodes)fail();ws();if(utf8[i++]!==':')fail();}value(depth+1);ws();if(utf8[i]===end){i++;return;}if(utf8[i++]!==',')fail();ws();}
  }
  if(c==='t'&&utf8.slice(i,i+4)==='true'){i+=4;return;}if(c==='f'&&utf8.slice(i,i+5)==='false'){i+=5;return;}if(c==='n'&&utf8.slice(i,i+4)==='null'){i+=4;return;}
  if(c==='-'||digit(utf8.charCodeAt(i))){number();return;}fail();
 }
 value(1);ws();if(i!==utf8.length)fail();
 const estimatedParsedBytes=65536+utf8.length*4+nodes*96+properties*128+containers*128+stringUnits*4;
 if(!Number.isSafeInteger(estimatedParsedBytes))fail();
 return Object.freeze({contract:'aegis.bounded-json-structure.v1',utf8Bytes:size,nodes,properties,containers,strings,maximumDepth:peakDepth,estimatedParsedBytes,accounting:'conservative_structure_estimate_not_measured_heap'});
}

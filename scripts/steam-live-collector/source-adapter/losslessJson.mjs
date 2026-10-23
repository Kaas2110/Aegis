/** Bounded JSON reader: preserve uint64 integer tokens and reject duplicate keys.
 * Decimal/exponent numeric tokens retain their lexical distinction, so an ID
 * written as 1.0 or 1e3 cannot silently become an integer identity.
 */
export class DecimalNumber {constructor(value){this.value=value;}}
export function parseLosslessJson(text,{onDuplicate=()=>false}={}){
  let i=0;const ws=()=>{while(/[ \t\r\n]/.test(text[i]??'X'))i++;};
  const fail=()=>{throw Error('invalid_bounded_json_at_'+i);};
  function string(){
    const begin=i++;let escape=false;
    for(;i<text.length;i++){
      const c=text[i];if(!escape&&c==='"'){i++;try{return JSON.parse(text.slice(begin,i));}catch{return fail();}}
      if(!escape&&c==='\\')escape=true;else escape=false;
    }return fail();
  }
  function value(depth,path=[]){
    if(depth>128)return fail();ws();const c=text[i];
    if(c==='"')return string();
    if(c==='{'){
      i++;ws();const out=Object.create(null);if(text[i]==='}'){i++;return out;}
      while(i<text.length){
        ws();if(text[i]!=='"')return fail();const key=string();if(Object.hasOwn(out,key)&&onDuplicate(path,key,i)!==true)return fail();
        ws();if(text[i++]!==':')return fail();out[key]=value(depth+1,[...path,key]);ws();const end=text[i++];if(end==='}')return out;if(end!==',')return fail();
      }return fail();
    }
    if(c==='['){
      i++;ws();const out=[];if(text[i]===']'){i++;return out;}
      while(i<text.length){out.push(value(depth+1,[...path,out.length]));ws();const end=text[i++];if(end===']')return out;if(end!==',')return fail();}return fail();
    }
    for(const [token,literal] of [['true',true],['false',false],['null',null]])if(text.startsWith(token,i)){i+=token.length;return literal;}
    const token=text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
    if(!token||token.length>128)return fail();i+=token.length;
    const number=Number(token);if(!Number.isFinite(number))return fail();
    if(/^-?(?:0|[1-9]\d*)$/.test(token))return Number.isSafeInteger(number)?number:token;
    return new DecimalNumber(number);
  }
  const out=value(0);ws();if(i!==text.length)return fail();return out;
}

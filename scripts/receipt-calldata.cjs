const path=require('node:path'),{pathToFileURL}=require('node:url');
const {createRequire}=require('node:module');
let sdk;
async function decodeReceipt(receipt){
 if(!sdk){
  if(!process.env.GENLAYER_CLI_PATH)throw Error('GENLAYER_CLI_PATH required for pinned CLI calldata decoder');
  const base=path.dirname(createRequire(process.env.GENLAYER_CLI_PATH).resolve('genlayer-js'));
  const [{abi},{CalldataAddress}]=await Promise.all([import(pathToFileURL(path.join(base,'index.js')).href),import(pathToFileURL(path.join(base,'types/index.js')).href)]);
  sdk={abi,CalldataAddress};
 }
 function plain(x){
  if(typeof x==='bigint'){if(x>BigInt(Number.MAX_SAFE_INTEGER)||x<BigInt(Number.MIN_SAFE_INTEGER))throw Error('Unsafe calldata integer');return Number(x);}
  if(x instanceof sdk.CalldataAddress)return '0x'+Buffer.from(x.bytes).toString('hex');
  if(x instanceof Map)return Object.fromEntries([...x].map(([k,v])=>[k,plain(v)]));
  if(Array.isArray(x))return x.map(plain);
  if(x===null||['string','number','boolean'].includes(typeof x))return x;
  throw Error('Unexpected calldata value');
 }
 const result=plain(sdk.abi.calldata.decode(Buffer.from(receipt.data.calldata,'base64')));
 if(result.args===undefined)result.args=[];
 if(result.kwargs!==undefined){if(Object.keys(result.kwargs).length)throw Error('Unexpected keyword arguments');delete result.kwargs;}
 return result;
}
module.exports={decodeReceipt};

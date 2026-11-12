const {test}=require('node:test'),assert=require('node:assert/strict');
const {retryPreflight}=require('../scripts/rpc-preflight.cjs');
const endpoint='https://studio.genlayer.com/api';
const options=method=>({method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});
const config={pause:async()=>{},warn:()=>{}};
test('HTML and HTTP failures retry the read-only request, preserving the usable response',async()=>{
 let calls=0;
 const fetch=retryPreflight(async()=>{calls++;return calls===1?new Response('<!DOCTYPE html>'):calls===2?new Response('',{status:503}):Response.json({result:'0x0'});},config);
 assert.deepEqual(await(await fetch(endpoint,options('eth_gasPrice'))).json(),{result:'0x0'});
 assert.equal(calls,3);
});
test('network failures stop after three attempts',async()=>{
 let calls=0;const fetch=retryPreflight(async()=>{calls++;throw Error('offline');},config);
 await assert.rejects(fetch(endpoint,options('eth_gasPrice')),/offline/);assert.equal(calls,3);
});
for(const method of ['eth_sendRawTransaction','eth_sendTransaction','gen_sendTransaction'])test(method+' is never retried after an ambiguous transport failure',async()=>{
 let calls=0;const fetch=retryPreflight(async()=>{calls++;throw Error('ambiguous');},config);
 await assert.rejects(fetch(endpoint,options(method)),/ambiguous/);assert.equal(calls,1);
});
test('another endpoint is never retried',async()=>{
 let calls=0;const fetch=retryPreflight(async()=>{calls++;throw Error('offline');},config);
 await assert.rejects(fetch('https://example.com',options('eth_gasPrice')),/offline/);assert.equal(calls,1);
});
test('valid RPC application errors pass through without replay',async()=>{
 let calls=0;const fetch=retryPreflight(async()=>{calls++;return Response.json({error:{code:-32601,message:'disabled'}});},config);
 assert.equal((await(await fetch(endpoint,options('eth_gasPrice'))).json()).error.code,-32601);assert.equal(calls,1);
});

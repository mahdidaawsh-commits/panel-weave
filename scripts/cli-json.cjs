// Shared CLI transport adaptation from ProbeMinimax; no contract logic.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),util=require('node:util');
globalThis.fetch=require('./rpc-preflight.cjs').retryPreflight(globalThis.fetch);
const inspect=util.inspect;
util.inspect=function(value,options,...rest){
  if(options?.depth===null&&options?.colors===false)return JSON.stringify(value,(_,x)=>typeof x==='bigint'?String(x):x);
  return inspect.call(this,value,options,...rest);
};
require('node:module').syncBuiltinESMExports();
const log=console.log;
console.log=(...values)=>log(...values.map(x=>x&&typeof x==='object'?JSON.stringify(x,(_,v)=>typeof v==='bigint'?String(v):v):x));
const configPath=path.join(os.homedir(),'.genlayer','genlayer-config.json'),read=fs.readFileSync;
fs.readFileSync=function(file,...args){
  const value=read.call(this,file,...args);
  if(typeof file==='string'&&path.resolve(file)===configPath){
    const config=JSON.parse(String(value));config.network='studionet';
    if(process.env.PANEL_ACCOUNT)config.activeAccount=process.env.PANEL_ACCOUNT;
    const out=JSON.stringify(config);return typeof value==='string'?out:Buffer.from(out);
  }
  return value;
};

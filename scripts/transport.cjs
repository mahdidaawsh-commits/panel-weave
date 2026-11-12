// Generic CLI/receipt transport reused under MIT; no program-search logic.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),journal=path.join(root,'.proof-journal'),proofs=path.join(root,'proofs');
for(const dir of [journal,proofs])fs.mkdirSync(dir,{recursive:true});
const assert=(ok,message)=>{if(!ok)throw Error(message);};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const sourceHash=digest(fs.readFileSync(path.join(root,'contracts/panel_weave.py')));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const sanitize=x=>Array.isArray(x)?x.map(sanitize):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).filter(([k])=>k!=='node_config').map(([k,v])=>[k,/private.?key|api.?key|password|secret|authorization/i.test(k)?'REDACTED':sanitize(v)])):x;
const save=(name,x)=>fs.writeFileSync(path.join(proofs,name+'.json'),JSON.stringify(sanitize(x),null,2)+'\n');
function record(label,hash){
  const f=path.join(proofs,'transactions.json'),x=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{source_sha256:sourceHash,hashes:{}};
  assert(x.source_sha256===sourceHash,'Transaction journal source mismatch');x.hashes[label]=hash;save('transactions',x);
}
function invoke(label,args){
  const cli=process.env.GENLAYER_CLI_PATH;assert(cli&&fs.existsSync(cli),'Set GENLAYER_CLI_PATH');
  const file=path.join(journal,label+'.json'),prior=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};
  const mutation=['deploy','write'].includes(args[0]);
  if(mutation&&prior.hash){assert(equal(prior.args,args)&&prior.sourceHash===sourceHash&&prior.account===process.env.PANEL_ACCOUNT,'Unsafe transaction recovery');return Promise.resolve(prior.hash);}
  if(mutation&&prior.started)throw Error('Ambiguous previous send; inspect journal '+label);
  const initial={started:true,args,sourceHash,account:process.env.PANEL_ACCOUNT};
  if(mutation)fs.writeFileSync(file,JSON.stringify(initial));
  console.log('RUN',label);
  return new Promise((resolve,reject)=>{
    const child=cp.spawn(process.execPath,['--require',path.join(__dirname,'cli-json.cjs'),cli,...args],{cwd:root,windowsHide:true,env:{...process.env,NO_COLOR:'1'},stdio:['pipe','pipe','pipe']});
    child.stdin.end((process.env.PANEL_PASSWORD||'')+'\n');let stdout='',stderr='',hash;
    const timer=setTimeout(()=>{console.log('TIMEOUT',label,hash||'no hash; inspect journal before retry');child.kill();},180000);
    child.stdout.on('data',chunk=>{
      stdout+=String(chunk);const found=stdout.match(/(?:Deployment|Write) Transaction Hash:\s*(0x[0-9a-f]{64})/i)?.[1];
      if(found&&!hash){hash=found;fs.writeFileSync(file,JSON.stringify({...initial,hash}));record(label,hash);console.log('SUBMITTED',label,hash);}
    });
    child.stderr.on('data',chunk=>stderr+=String(chunk));child.on('error',reject);
    child.on('close',code=>{
      clearTimeout(timer);fs.writeFileSync(file,JSON.stringify({...initial,hash,stdout,stderr,code}));
      if(mutation&&hash)resolve(hash);else if(code!==0)reject(Error(label+': '+stderr.slice(-800)));else resolve(stdout);
    });
  });
}
async function read(label,args){
  for(let i=0;i<3;i++){try{const out=await invoke(label,args),at=out.indexOf('Result:');assert(at>=0,'Missing CLI result');return JSON.parse(out.slice(at+7).trim());}catch(e){if(i===2)throw e;await delay(7000);}}
}
async function rpc(method,params){
  assert(['eth_chainId','eth_getTransactionByHash','gen_getContractCode'].includes(method),'Read-only RPC helper');
  for(let i=0;i<3;i++){
    try{const r=await fetch('https://studio.genlayer.com/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000)});const x=await r.json();assert(r.ok&&!x.error,JSON.stringify(x.error||r.status));return x.result;}
    catch(e){if(i===2)throw e;await delay(7000);}
  }
}
function receiptSummary(r){
  const votes=Object.values(r.consensus_data.votes);
  return {hash:r.hash||r.tx_id,status:r.status_name||r.status,execution:r.consensus_data.leader_receipt[0].execution_result,result:r.result_name||r.result,agree:votes.filter(v=>v==='agree').length,disagree:votes.filter(v=>v==='disagree').length,idle:votes.filter(v=>v==='idle').length};
}
async function receipt(label,hash,success){
  let r;for(let i=0;i<100;i++){r=await rpc('eth_getTransactionByHash',[hash]);if((r?.status_name||r?.status)==='FINALIZED')break;await delay(6000);}
  assert(r,'Missing receipt');save(label+'-receipt',r);
  const s=receiptSummary(r);console.log('RECEIPT',label,JSON.stringify(s));
  assert(s.status==='FINALIZED'&&s.hash===hash,'Receipt finality/identity');
  assert(s.result==='MAJORITY_AGREE'&&s.agree>(s.agree+s.disagree+s.idle)/2,'No strict consensus majority');
  assert(success?['SUCCESS','FINISHED_WITH_RETURN'].includes(s.execution):s.execution==='ERROR','Wrong execution outcome');
  return r;
}
module.exports={root,assert,equal,digest,sourceHash,delay,save,invoke,read,rpc,receipt,receiptSummary};

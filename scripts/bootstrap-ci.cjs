// Encrypted disposable CLI accounts; no private key export.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),os=require('node:os');
if(!process.env.GITHUB_ACTIONS||!process.env.GITHUB_ENV)throw Error('Disposable CI runner only');
const cli=path.resolve(__dirname,'../node_modules/genlayer/dist/index.js');
if(!fs.existsSync(cli))throw Error('Run npm ci before preparing proof accounts');
const password=crypto.randomBytes(24).toString('hex');console.log('::add-mask::'+password);
const accounts=[];
for(let i=0;i<5;i++){
 const name='panel-proof-'+i;
 cp.execFileSync(process.execPath,[cli,'account','create','--name',name,'--password',password],{stdio:['ignore','ignore','pipe']});
 const metadata=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.genlayer','keystores',name+'.json'),'utf8'));
 const address='0x'+metadata.address.replace(/^0x/,'');
 if(!/^0x[a-fA-F0-9]{40}$/.test(address))throw Error('Invalid public account metadata');
 accounts.push({name,address:address.toLowerCase()});
}
cp.execFileSync(process.execPath,[cli,'network','set','studionet'],{stdio:['ignore','ignore','pipe']});
fs.appendFileSync(process.env.GITHUB_ENV,`GENLAYER_CLI_PATH=${cli}\nPANEL_PASSWORD=${password}\nPANEL_ACCOUNTS=${JSON.stringify(accounts)}\n`);
console.log('Prepared encrypted disposable caller: '+accounts.map(a=>a.address).join(', '));

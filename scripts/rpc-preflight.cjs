// Retry only this read-only RPC. Never replay a signed send or an entire CLI command.
function retryPreflight(fetchImpl,{pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),attempts=3,warn=console.warn}={}){
 return async function(input,options){
  let request;
  try{request=JSON.parse(options?.body);}catch{}
  const allowed=String(input)==='https://studio.genlayer.com/api'&&options?.method==='POST'&&request?.method==='eth_gasPrice'&&!Array.isArray(request);
  if(!allowed)return fetchImpl(input,options);
  for(let attempt=1;attempt<=attempts;attempt++){
   try{
    const response=await fetchImpl(input,options);
    if(!response.ok)throw Error('Gas-price preflight HTTP '+response.status);
    await response.clone().json();
    return response;
   }catch(error){
    if(attempt===attempts)throw error;
    warn('Retry read-only eth_gasPrice preflight '+attempt+'/'+attempts);
    await pause(7000*attempt);
   }
  }
 };
}
module.exports={retryPreflight};

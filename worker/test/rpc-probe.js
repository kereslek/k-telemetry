// Which public Solana RPCs answer a Worker's fetch? GET / returns one line per endpoint.
const C=['https://solana-rpc.publicnode.com','https://api.mainnet-beta.solana.com','https://solana.drpc.org',
  'https://solana.api.onfinality.io/public','https://endpoints.omniatech.io/v1/sol/mainnet/public',
  'https://solana.leorpc.com/?api_key=FREE','https://rpc.solanatracker.io/public','https://solana-mainnet.gateway.tatum.io',
  'https://solana.public-rpc.com','https://mainnet.helius-rpc.com','https://rpc.ankr.com/solana','https://solana-mainnet.rpc.extrnode.com',
  'https://api.mainnet.solana.com','https://solana.rpc.grove.city/v1/public','https://go.getblock.io/solana'];
const E=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth','https://rpc.mevblocker.io',
  'https://eth-mainnet.public.blastapi.io','https://rpc.flashbots.net','https://eth.llamarpc.com','https://eth.merkle.io','https://rpc.payload.de'];
const ethOne=async u=>{ const t=Date.now(); try{
  const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:'0x552371ab438c8f35810d2d4206fd72dc23bb544a',data:'0x3850c7bd'},'latest']}),signal:AbortSignal.timeout(10000)});
  const x=await r.text(); return (r.ok&&x.includes('"result":"0x')?'OK  ':'NO  ')+r.status+' '+(Date.now()-t)+'ms '+u+' '+x.slice(0,70).replace(/\s+/g,' ');
}catch(e){ return 'ERR '+u+' '+e.message; } };
export default { async fetch(req){
  if(new URL(req.url).pathname!=='/') return new Response('up');
  const out=await Promise.all(C.map(async u=>{ const t=Date.now(); try{
    const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getMultipleAccounts',params:[['AZRhFo3w29qaea8f2BhaNtAAxhXujRG16cJn4KcbYijE'],{encoding:'base64'}]}),signal:AbortSignal.timeout(10000)});
    const x=await r.text(); return (r.ok&&x.includes('"data"')?'OK  ':'NO  ')+r.status+' '+(Date.now()-t)+'ms '+u+' '+x.slice(0,90).replace(/\s+/g,' ');
  }catch(e){ return 'ERR '+u+' '+e.message; } }));
  const eo=await Promise.all(E.map(ethOne));
  return new Response(out.join('\n')+'\n--- ethereum eth_call\n'+eo.join('\n'));
}};

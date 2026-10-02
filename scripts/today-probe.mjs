/* One-off, read-only: every transaction today from the deck's wallets. For the Ethereum side it
   lists the method, counterparties, ETH and token movements, the gas paid and, for swaps, which
   pools the swap went through. For Solana it lists SOL and token balance changes per transaction
   and where they went. */
import fs from 'node:fs';
const cfg=JSON.parse(fs.readFileSync('deck-r7k4x9/config.json','utf8'));
const W=cfg.profiles[0].wallets;
const since=Date.parse(process.env.SINCE||new Date().toISOString().slice(0,10)+'T00:00:00Z');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt){ for(let k=0;k<4;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(30000)}); if(r.ok) return await r.json(); console.log('  http',r.status,u); }catch(e){ console.log('  err',e.message); } await sleep(1500*(k+1)); } return null; }
const BS='https://eth.blockscout.com/api/v2';
const nm=a=>a?(a.name||a.ens_domain_name?((a.name||a.ens_domain_name)+' '):'')+a.hash.slice(0,8):'?';
const seen=new Set();
for(const w of W.filter(x=>x.chain==='ethereum')){
  console.log('\n=== ETH wallet',w.address);
  const tx=await j(BS+'/addresses/'+w.address+'/transactions');
  for(const t of (tx&&tx.items)||[]){
    const ts=Date.parse(t.timestamp); if(ts<since) continue;
    console.log(t.timestamp, t.hash, 'status',t.status, 'method',t.method, nm(t.from),'->',nm(t.to), 'value',Number(t.value)/1e18,'ETH', 'fee',Number(t.fee&&t.fee.value)/1e18,'ETH');
    if(seen.has(t.hash)) continue; seen.add(t.hash);
    const tt=await j(BS+'/transactions/'+t.hash+'/token-transfers');
    for(const x of (tt&&tt.items)||[]) console.log('    tok',x.token&&x.token.symbol, Number(x.total&&x.total.value)/10**Number(x.total&&x.total.decimals||18), nm(x.from),'->',nm(x.to), '| to', x.to&&x.to.hash, x.to&&x.to.is_contract?'(contract)':'(wallet)');
    const it=await j(BS+'/transactions/'+t.hash+'/internal-transactions');
    for(const x of (it&&it.items)||[]) if(Number(x.value)>0) console.log('    int',Number(x.value)/1e18,'ETH', nm(x.from),'->',nm(x.to));
    const lg=await j(BS+'/transactions/'+t.hash+'/logs');
    for(const x of (lg&&lg.items)||[]){ const n=x.decoded&&x.decoded.method_call||''; if(/Swap|IncreaseLiquidity|DecreaseLiquidity|Collect/.test(n))
      console.log('    log',n.split('(')[0], 'at',nm(x.address), JSON.stringify((x.decoded.parameters||[]).map(p=>[p.name,p.value])).slice(0,400)); }
    await sleep(300);
  }
  const tt=await j(BS+'/addresses/'+w.address+'/token-transfers');
  for(const x of (tt&&tt.items)||[]){ if(Date.parse(x.timestamp)<since||seen.has(x.transaction_hash)) continue;
    console.log('  in-only tok',x.timestamp,x.transaction_hash,x.token&&x.token.symbol,Number(x.total&&x.total.value)/10**Number(x.total&&x.total.decimals||18),nm(x.from),'->',nm(x.to)); }
}
// ---------------- Solana ----------------
const SR=[process.env.SOL_RPC_URL,'https://solana-rpc.publicnode.com','https://api.mainnet-beta.solana.com'].filter(Boolean);
async function srpc(method,params){ for(let k=0;k<4;k++) for(const u of SR){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); if(r&&r.result!==undefined) return r.result; await sleep(800);} return null; }
for(const w of W.filter(x=>x.chain==='solana')){
  console.log('\n=== SOL wallet',w.address);
  const sigs=await srpc('getSignaturesForAddress',[w.address,{limit:60}])||[];
  for(const s of sigs){ if(!s.blockTime||s.blockTime*1000<since) continue;
    const t=await srpc('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]); if(!t) { console.log(s.signature,'(no tx)'); continue; }
    const keys=t.transaction.message.accountKeys.map(k=>k.pubkey);
    const i=keys.indexOf(w.address);
    const dSol=i>=0?(t.meta.postBalances[i]-t.meta.preBalances[i])/1e9:null;
    console.log(new Date(s.blockTime*1000).toISOString(), s.signature.slice(0,20), s.err?'ERR':'', 'dSOL',dSol, 'fee',t.meta.fee/1e9);
    const ins=[...t.transaction.message.instructions,...(t.meta.innerInstructions||[]).flatMap(x=>x.instructions)];
    for(const x of ins) if(x.parsed&&/transfer/i.test(x.parsed.type||'')) console.log('    ',x.program,x.parsed.type,JSON.stringify(x.parsed.info).slice(0,300));
    const pre=new Map((t.meta.preTokenBalances||[]).map(b=>[b.accountIndex+b.mint,b])), post=t.meta.postTokenBalances||[];
    for(const b of post){ if(b.owner!==w.address) continue; const p=pre.get(b.accountIndex+b.mint); const dv=(b.uiTokenAmount.uiAmount||0)-((p&&p.uiTokenAmount.uiAmount)||0); if(Math.abs(dv)>0) console.log('     token',b.mint.slice(0,8),dv); }
    await sleep(400);
  }
}

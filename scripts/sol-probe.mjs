/* One-off probe, run from GitHub Actions where the RPCs are reachable. Answers, with measured
   numbers rather than assumptions:
     1. which free Solana endpoints answer at all, which keep year-old transactions, and how
        hard each throttles a runner;
     2. whether the CLMM event decode in sol-history.mjs agrees with the money that actually
        moved, transaction by transaction, on the real positions;
     3. whether a price feed covers the Solana CPOOL mint historically, or whether the pool's
        own implied price is the only source.
   Read-only. Writes nothing but its log. */
import fs from 'node:fs';
import {makeRpc, syncSignatures, positionEffect, decodeClmmEvents} from './sol-history.mjs';

const data=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const KEYED=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean);
const PUBLIC=['https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com','https://solana.drpc.org',
  'https://solana.api.onfinality.io/public','https://solana.lava.build','https://endpoints.omniatech.io/v1/sol/mainnet/public',
  'https://rpc.ankr.com/solana','https://solana-mainnet.rpc.extrnode.com'];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pos=(data.sol||[]).filter(p=>p.pda&&p.nftMint);
console.log('positions from payload:',pos.length, ' keyed endpoint configured:',KEYED.length>0);

// ---------- 1. endpoint capability ----------
const ref=pos.slice().sort((a,b)=>(b.ageDays||0)-(a.ageDays||0))[0];   // the oldest position
console.log('\n=== ENDPOINTS (reference: oldest position '+ref.id.slice(4,14)+', '+(ref.ageDays||0).toFixed(0)+'d) ===');
const cap={};
for(const url of [...KEYED,...PUBLIC]){
  const one=makeRpc([url],{timeout:15000});
  const L=one.label(url); const c=cap[url]={label:L};
  const t0=Date.now();
  try{ c.slot=await one('getSlot',[]); c.ms=Date.now()-t0; }catch(e){ c.dead=String(e.message).slice(0,70); console.log(' ',L.padEnd(40),'DEAD',c.dead); continue; }
  try{ c.minLedger=await one('minimumLedgerSlot',[]); }catch(e){ c.minLedger='n/a'; }
  try{
    const sg=await one('getSignaturesForAddress',[ref.pda,{limit:1000}]);
    c.sigs=sg.length; c.oldestT=sg.length?sg[sg.length-1].blockTime:null; c.oldestSig=sg.length?sg[sg.length-1].signature:null;
  }catch(e){ c.sigErr=String(e.message).slice(0,60); }
  if(c.oldestSig){
    try{ const tx=await one('getTransaction',[c.oldestSig,{maxSupportedTransactionVersion:0,encoding:'jsonParsed'}]);
         c.archival=!!(tx&&tx.meta); }catch(e){ c.archival=false; c.txErr=String(e.message).slice(0,60); }
  }
  // burst: how quickly does this endpoint push back
  if(c.oldestSig){
    let ok=0,thr=0; const b0=Date.now();
    for(let i=0;i<12;i++){
      try{ await one('getTransaction',[c.oldestSig,{maxSupportedTransactionVersion:0,encoding:'jsonParsed'}]); ok++; }catch(e){}
    }
    thr=one.stats.throttled; c.burst=ok+'/12 ok, '+thr+' throttled, '+((Date.now()-b0)/1000).toFixed(1)+'s';
  }
  console.log(' ',L.padEnd(40),'slot',c.slot,(c.ms+'ms').padStart(7),' minLedger',c.minLedger,
    ' sigs',c.sigs??c.sigErr, ' oldest',c.oldestT?new Date(c.oldestT*1000).toISOString().slice(0,10):'-',
    ' archival',c.archival??c.txErr??'-',' burst',c.burst||'-');
  await sleep(400);
}
const good=[...KEYED,...PUBLIC].filter(u=>cap[u]&&!cap[u].dead&&cap[u].archival);
const usable=good.length?good:[...KEYED,...PUBLIC].filter(u=>cap[u]&&!cap[u].dead);
console.log('\narchival-capable:',good.map(u=>cap[u].label).join(', ')||'NONE');

// ---------- 2. per-position history, decoded and cross-checked ----------
const rpc=makeRpc(usable,{timeout:25000});
const acc=await rpc('getMultipleAccounts',[pos.map(p=>p.pda),{encoding:'base64'}]);
acc.value.forEach((a,i)=>{ if(!a) return; const b=Buffer.from(a.data[0],'base64'); pos[i].tl=b.readInt32LE(73); pos[i].tu=b.readInt32LE(77); pos[i].owner=pos[i].wallet; });
const pdas=new Set(pos.map(p=>p.pda));
const human=(raw,d)=>Number(raw)/10**d;
const f=(x,d)=>x===0?'0':Math.abs(x)>=100?x.toFixed(0):x.toFixed(d);
let agree=0, disagree=0, noEvent=0;
for(const p of pos){
  const st={};
  let pages=0; while(!st.complete && pages<6){ await syncSignatures(rpc,p.pda,st,1); pages++; }
  const sigs=st.sigs.filter(x=>!x.e);
  console.log('\n=== '+p.pairLabel+' '+p.id.slice(4,14)+' ticks '+p.tl+'..'+p.tu+'  history '+st.sigs.length+' sigs ('+(st.complete?'complete':'TRUNCATED')+'), '+sigs.length+' ok, oldest '+
    (sigs.length?new Date(sigs[sigs.length-1].t*1000).toISOString().slice(0,16):'-'));
  const sum={dep:[0,0],wd:[0,0],fee:[0,0]};
  const cap_=Math.min(sigs.length,160);
  for(const s of sigs.slice(0,cap_).reverse()){
    let tx=null;
    try{ tx=await rpc('getTransaction',[s.s,{maxSupportedTransactionVersion:0,encoding:'jsonParsed'}]); }catch(e){ console.log('   ',s.s.slice(0,8),'FETCH FAIL',e.message.slice(0,50)); continue; }
    if(!tx||!tx.meta){ console.log('   ',s.s.slice(0,8),'no tx'); continue; }
    const keys=(tx.transaction.message.accountKeys||[]).map(k=>typeof k==='string'?k:k.pubkey);
    p.soleInTx=keys.filter(k=>pdas.has(k)).length<=1;
    const r=positionEffect(tx,p);
    const d0=p.d0,d1=p.d1;
    const dep=[human(r.dep[0],d0),human(r.dep[1],d1)], wd=[human(r.wd[0],d0),human(r.wd[1],d1)], fee=[human(r.fee[0],d0),human(r.fee[1],d1)];
    for(const k of [0,1]){ sum.dep[k]+=dep[k]; sum.wd[k]+=wd[k]; sum.fee[k]+=fee[k]; }
    let chk='';
    if(r.src==='event'&&r.xfer){
      const xo=[human(r.xfer.out[0],d0),human(r.xfer.out[1],d1)], xi=[human(r.xfer.inn[0],d0),human(r.xfer.inn[1],d1)];
      const near=(a,b)=>Math.abs(a-b)<=Math.max(1e-6,Math.abs(b)*0.002);
      /* Deposits must equal what left the wallet; principal plus fees must equal what arrived.
         Only checked where this position is the only one of ours in the transaction. */
      if(p.soleInTx){
        const ok=near(dep[0],xo[0])&&near(dep[1],xo[1])&&near(wd[0]+fee[0],xi[0])&&near(wd[1]+fee[1],xi[1]);
        if(ok) agree++; else disagree++;
        chk=ok?'✓':'✗ xfer out '+f(xo[0],4)+'/'+f(xo[1],2)+' in '+f(xi[0],4)+'/'+f(xi[1],2);
      }else chk='(shared tx)';
    }else if(!r.src){ noEvent++; chk='no event'; }
    const px=r.sqrt?(r.sqrt*r.sqrt*10**(d0-d1)):null;
    const any=dep[0]||dep[1]||wd[0]||wd[1]||fee[0]||fee[1];
    if(!any && r.src!==null) continue;
    console.log('   '+new Date(r.t*1000).toISOString().slice(0,16)+' '+s.s.slice(0,8)+' '+(r.kinds.join('+')||'-').padEnd(12)+' '+(r.src||'-').padEnd(8)+
      ' dep '+f(dep[0],4)+'/'+f(dep[1],2)+'  wd '+f(wd[0],4)+'/'+f(wd[1],2)+'  fee '+f(fee[0],4)+'/'+f(fee[1],2)+
      (px?'  px '+px.toPrecision(6):'')+'  '+chk);
  }
  if(cap_<sigs.length) console.log('   … '+(sigs.length-cap_)+' newer signatures not fetched in the probe');
  console.log('   TOTAL dep '+f(sum.dep[0],4)+' '+p.m0.symbol+' + '+f(sum.dep[1],2)+' '+p.m1.symbol+
    ' | principal back '+f(sum.wd[0],4)+' + '+f(sum.wd[1],2)+' | fees '+f(sum.fee[0],4)+' + '+f(sum.fee[1],2)+
    ' | now '+f(p.amt0,4)+' + '+f(p.amt1,2));
}
console.log('\ncross-check: '+agree+' agree, '+disagree+' disagree, '+noEvent+' with no decodable event');

// ---------- 3. historical price coverage ----------
console.log('\n=== PRICE FEEDS (DefiLlama historical) ===');
const cpool=pos.map(p=>[p.mint0,p.mint1]).flat().find(m=>m&&m.startsWith('AeXr'));
const now=Math.floor(Date.now()/1000);
for(const ts of [now-3*86400, now-30*86400, now-120*86400, now-320*86400]){
  try{
    const r=await fetch('https://coins.llama.fi/prices/historical/'+ts+'/coingecko:solana,solana:'+cpool+',ethereum:0x66761fa41377003622aee3c7675fc7b5c1c2fac5');
    const js=await r.json();
    const g=k=>js.coins&&js.coins[k]?js.coins[k].price:null;
    console.log('  '+new Date(ts*1000).toISOString().slice(0,10)+'  SOL '+g('coingecko:solana')+'  CPOOL(sol) '+g('solana:'+cpool)+'  CPOOL(eth) '+g('ethereum:0x66761fa41377003622aee3c7675fc7b5c1c2fac5'));
  }catch(e){ console.log('  llama error',e.message); }
}

// ---------- cost of the probe itself ----------
console.log('\n=== RPC USAGE (history walk) ===');
console.log(JSON.stringify(rpc.stats,null,1));

// rerun 1
/* One-off, read-only: every swap made from this deck's own wallets this month, and how much of
   the fee it paid came straight back to its own LP positions. Per swap: the pool, the fee paid,
   the protocol's cut (read from the pool's on-chain config), and this deck's share of the pool's
   active liquidity at that moment (from the swap event's own liquidity and tick). */
import fs from 'node:fs';
import crypto from 'node:crypto';
const d=JSON.parse(fs.readFileSync('/tmp/data.json','utf8'));
const costs=JSON.parse(fs.readFileSync('/tmp/costs.json','utf8'));
const cfg=JSON.parse(fs.readFileSync('deck-r7k4x9/config.json','utf8'));
const wallets=cfg.profiles[0].wallets;
const monthStart=Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),1);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const out=[];
const day=t=>new Date(t).toISOString().slice(0,10);
// ---------------- Ethereum ----------------
const ERPC=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://eth.llamarpc.com','https://1rpc.io/eth'];
let rid=0;
async function erpc(method,params){ let last;
  for(let k=0;k<3;k++) for(const u of ERPC){ try{ const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(20000),body:JSON.stringify({jsonrpc:'2.0',id:++rid,method,params})});
    const j=await r.json(); if(j.error) throw new Error(j.error.message); return j.result; }catch(e){ last=e; } }
  throw last; }
const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88';
const ours={}; // pool -> [ids]
for(const p of d.eth||[]) (ours[p.pool.toLowerCase()]=ours[p.pool.toLowerCase()]||[]).push(String(p.id));
(ours['0x5aaa28ca43c6646fd1403e508f0fca1d92357dde']=ours['0x5aaa28ca43c6646fd1403e508f0fca1d92357dde']||[]).includes('1355331')||ours['0x5aaa28ca43c6646fd1403e508f0fca1d92357dde'].push('1355331');
const px={};
for(const p of d.eth||[]){ px[p.token0.toLowerCase()]=p.usd0; px[p.token1.toLowerCase()]=p.usd1; }
px['0x037a54aab062628c9bbae1fdb1583c195585fe41']=(d.quotes||[]).find(q=>q.label==='LCX / USD (old)')?.usd;
px['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']=d.ethUsd; px['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']=1; px['0xdac17f958d2ee523a2206206994597c13d831ec7']=1;
px['0x66761fa41377003622aee3c7675fc7b5c1c2fac5']=(d.quotes||[]).find(q=>q.label==='CPOOL / USD (ETH)')?.usd;
const w=(data,i)=>BigInt('0x'+data.slice(2+64*i,2+64*(i+1)));
const s256=v=>v>=1n<<255n?v-(1n<<256n):v;
const SW3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const meta={};
async function poolMeta(a){ if(meta[a]) return meta[a];
  const t0='0x'+(await erpc('eth_call',[{to:a,data:'0x0dfe1681'},'latest'])).slice(-40);
  const t1='0x'+(await erpc('eth_call',[{to:a,data:'0xd21220a7'},'latest'])).slice(-40);
  const fee=Number(BigInt(await erpc('eth_call',[{to:a,data:'0xddca3f43'},'latest'])));
  const dec=async t=>Number(BigInt(await erpc('eth_call',[{to:t,data:'0x313ce567'},'latest'])));
  return meta[a]={t0,t1,fee,d0:await dec(t0),d1:await dec(t1)}; }
const evmTx=Object.entries(costs.txs||{}).filter(([,v])=>v===1).map(([k])=>k);
console.log('Ethereum txs in the cost ledger this month:',evmTx.length);
for(const h of evmTx){
  let rc; try{ rc=await erpc('eth_getTransactionReceipt',[h]); }catch(e){ console.log('receipt fail',h); continue; }
  const swaps=(rc.logs||[]).filter(l=>l.topics[0]===SW3); if(!swaps.length) continue;
  const blk=parseInt(rc.blockNumber,16);
  const b=await erpc('eth_getBlockByNumber',[rc.blockNumber,false]); const t=parseInt(b.timestamp,16)*1000;
  for(const lg of swaps){
    const a=lg.address.toLowerCase(), m=await poolMeta(a);
    const a0=s256(w(lg.data,0)), a1=s256(w(lg.data,1)), L=w(lg.data,3), tick=Number(s256(w(lg.data,4)));
    const inTok=a0>0n?m.t0:m.t1, inAmt=Number(a0>0n?a0:a1)/10**(a0>0n?m.d0:m.d1);
    const feeUsd=inAmt*(px[inTok]||0)*m.fee/1e6;
    let share=0, proto=0;
    if(ours[a]){
      const tag='0x'+(blk-1).toString(16);
      let our=0n;
      for(const id of ours[a]){
        try{ const r=await erpc('eth_call',[{to:NPM,data:'0x99fbab88'+BigInt(id).toString(16).padStart(64,'0')},tag]);
          const tl=Number(s256(w(r,5))), tu=Number(s256(w(r,6))), l=w(r,7); if(tl<=tick&&tick<tu) our+=l; }catch(e){}
      }
      share=L>0n?Math.min(1,Number(our*1000000n/L)/1e6):0;
      try{ const s0=await erpc('eth_call',[{to:a,data:'0x3850c7bd'},tag]); const fp=Number(w(s0,5));
        const fpIn=a0>0n?(fp%16):(fp>>4); proto=fpIn?1/fpIn:0; }catch(e){}
    }
    const back=feeUsd*(1-proto)*share;
    out.push({chain:'eth',t,day:day(t),tx:h.slice(0,12),pool:a.slice(0,10),own:!!ours[a],fee:m.fee/1e4+'%',feeUsd,proto,share,back});
  }
  await sleep(100);
}
// ---------------- Solana ----------------
const KEY=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean);
const SRPC=[...KEY,'https://api.mainnet-beta.solana.com'];
async function srpc(method,params){ let last;
  for(let k=0;k<4;k++) for(const u of SRPC){ try{ const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(25000),body:JSON.stringify({jsonrpc:'2.0',id:++rid,method,params})});
    const j=await r.json(); if(j.error) throw new Error(j.error.message); return j.result; }catch(e){ last=e; await sleep(400); } }
  throw last; }
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let x=BigInt('0x'+Buffer.from(buf).toString('hex')||'0'), s=''; while(x>0n){ s=B58[Number(x%58n)]+s; x/=58n; } for(const c of buf){ if(c===0) s='1'+s; else break; } return s; };
const solPos=(d.sol||[]).map(p=>({pool:p.poolId,tl:p.tl,tu:p.tu,L:BigInt(p.liq),m0:p.mint0,m1:p.mint1,u0:p.usd0,u1:p.usd1}));
const myPools=[...new Set(solPos.map(p=>p.pool))];
const pinfo={};
for(const pool of myPools){
  const a=await srpc('getAccountInfo',[pool,{encoding:'base64'}]); const bf=Buffer.from(a.value.data[0],'base64');
  const cfgKey=b58(bf.subarray(9,41));
  const c=await srpc('getAccountInfo',[cfgKey,{encoding:'base64'}]); const cb=Buffer.from(c.value.data[0],'base64');
  pinfo[pool]={protocol:cb.readUInt32LE(43)/1e6, trade:cb.readUInt32LE(47)/1e6, fund:cb.readUInt32LE(53)/1e6, liqNow:bf.readBigUInt64LE(237)+(bf.readBigUInt64LE(245)<<64n)};
  const ourNow=solPos.filter(p=>p.pool===pool).reduce((s,p)=>s+p.L,0n);
  console.log('pool',pool.slice(0,8),'trade fee',pinfo[pool].trade,'protocol cut',pinfo[pool].protocol,'fund cut',pinfo[pool].fund,'active liq now',pinfo[pool].liqNow.toString(),'ours (all ranges)',ourNow.toString());
}
const DISC=crypto.createHash('sha256').update('event:SwapEvent').digest().subarray(0,8);
const px0={}; for(const p of solPos){ px0[p.m0]=p.u0; px0[p.m1]=p.u1; }
for(const wal of wallets.filter(x=>x.chain==='solana').map(x=>x.address)){
  let before=null, n=0, stop=false;
  while(!stop){
    const sigs=await srpc('getSignaturesForAddress',[wal,{limit:1000,...(before?{before}:{})}]);
    if(!sigs.length) break;
    for(const s of sigs){
      if(s.blockTime && s.blockTime*1000<monthStart){ stop=true; break; }
      before=s.signature; if(s.err) continue;
      let tx; try{ tx=await srpc('getTransaction',[s.signature,{maxSupportedTransactionVersion:0,encoding:'json'}]); }catch(e){ continue; }
      n++;
      for(const line of (tx?.meta?.logMessages||[])){
        if(!line.startsWith('Program data: ')) continue;
        const bf=Buffer.from(line.slice(14),'base64'); if(bf.length<8||!bf.subarray(0,8).equals(DISC)) continue;
        const pool=b58(bf.subarray(8,40)); if(!pinfo[pool]) continue;
        // pool, sender, token_account_0, token_account_1, amount_0 u64, transfer_fee_0 u64, amount_1 u64, transfer_fee_1 u64, zero_for_one bool, sqrt_price_x64 u128, liquidity u128, tick i32
        let o=8+32*4; const amt0=bf.readBigUInt64LE(o); o+=16; const amt1=bf.readBigUInt64LE(o); o+=16; const z=bf[o]===1; o+=1; o+=16;
        const L=bf.readBigUInt64LE(o)+(bf.readBigUInt64LE(o+8)<<64n); o+=16; const tick=bf.readInt32LE(o);
        const ps=solPos.filter(p=>p.pool===pool), P=ps[0];
        const inMint=z?P.m0:P.m1;
        const dec=inMint==='So11111111111111111111111111111111111111112'?9:6;
        const inAmt=Number(z?amt0:amt1)/10**dec;
        const info=pinfo[pool];
        const feeUsd=inAmt*(px0[inMint]||0)*info.trade;
        const our=ps.filter(p=>p.tl<=tick&&tick<p.tu).reduce((a,p)=>a+p.L,0n);
        const share=L>0n?Math.min(1,Number(our*1000000n/L)/1e6):0;
        const back=feeUsd*(1-info.protocol-info.fund)*share;
        const t=(tx.blockTime||s.blockTime)*1000;
        out.push({chain:'sol',t,day:day(t),tx:s.signature.slice(0,12),pool:pool.slice(0,8),own:true,fee:info.trade*100+'%',feeUsd,proto:info.protocol+info.fund,share,back});
      }
      await sleep(40);
    }
    if(sigs.length<1000) break;
  }
  console.log('wallet',wal.slice(0,6),'transactions read',n);
}
// ---------------- report ----------------
out.sort((a,b)=>a.t-b.t);
for(const r of out) console.log(new Date(r.t).toISOString().slice(0,16),r.chain,r.tx,r.pool,r.fee,'own',r.own,'fee $'+r.feeUsd.toFixed(2),'cut',(r.proto*100).toFixed(1)+'%','share',(r.share*100).toFixed(1)+'%','back $'+r.back.toFixed(2));
const agg={}; for(const r of out){ const k=r.chain+' '+r.pool; agg[k]=agg[k]||{fee:0,back:0,n:0}; agg[k].fee+=r.feeUsd; agg[k].back+=r.back; agg[k].n++; }
console.log('BY POOL',JSON.stringify(Object.fromEntries(Object.entries(agg).map(([k,v])=>[k,{n:v.n,fee:+v.fee.toFixed(2),back:+v.back.toFixed(2)}]))));
const byDay={}; for(const r of out) byDay[r.day]=+(((byDay[r.day]||0)+r.back).toFixed(4));
console.log('BACK BY DAY',JSON.stringify(byDay));
console.log('TOTAL fee paid $'+out.reduce((a,r)=>a+r.feeUsd,0).toFixed(2)+'  back to own LPs $'+out.reduce((a,r)=>a+r.back,0).toFixed(2));
fs.writeFileSync('/tmp/selfswap.json',JSON.stringify(out));
console.log('JSON '+JSON.stringify(out.map(r=>[r.t,r.chain,r.pool,+r.feeUsd.toFixed(4),+r.back.toFixed(4),r.tx])));

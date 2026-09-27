// rerun 1
/* One-off, read-only: where does LCX actually trade, and what share of LCX swap fees do this
   deck's LPs really collect? Every LCX pool found on-chain (Uniswap v3 all fee tiers, Uniswap v2,
   Sushi v2) against WETH / USDC / USDT for both LCX contracts, with the last 7 days of swaps
   decoded; plus DEX-aggregator and CEX listings for what is off Uniswap. Runs in Actions because
   none of these hosts are reachable from the dev container. */
import fs from 'node:fs';
const d=JSON.parse(fs.readFileSync('/tmp/data.json','utf8'));
const ETH=d.ethUsd;
const RPCS=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://eth.llamarpc.com','https://1rpc.io/eth'];
let rid=0;
async function rpc(method,params){
  let last;
  for(let pass=0;pass<3;pass++) for(const u of RPCS){
    try{ const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rid,method,params}),signal:AbortSignal.timeout(20000)});
      const j=await r.json(); if(j.error) throw new Error(j.error.message); return j.result; }catch(e){ last=e; }
  }
  throw last;
}
const call=(to,data,tag='latest')=>rpc('eth_call',[{to,data},tag]);
const pad=a=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const LCX={new:'0x8cd41041505885ef0ad3858181d66f17be8aae7e', old:'0x037a54aab062628c9bbae1fdb1583c195585fe41'};
const Q={WETH:['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',ETH,18],USDC:['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',1,6],USDT:['0xdac17f958d2ee523a2206206994597c13d831ec7',1,6]};
const V3F='0x1f98431c8ad98523631ae4a59f267346ea31f984', V2F='0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', SUSHI='0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac';
const ZERO='0x'+'0'.repeat(40);
const addrOf=h=>'0x'+h.slice(-40);
const pools=[];
for(const [era,lcx] of Object.entries(LCX)) for(const [qs,[qa,qusd,qd]] of Object.entries(Q)){
  const [t0,t1]=lcx<qa?[lcx,qa]:[qa,lcx]; const lcxIs0=t0===lcx;
  for(const fee of [100,500,3000,10000]){
    const r=await call(V3F,'0x1698ee82'+pad(t0)+pad(t1)+fee.toString(16).padStart(64,'0'));
    const a=addrOf(r); if(a!==ZERO) pools.push({kind:'uniV3',fee,era,q:qs,addr:a,lcxIs0,qusd,qd});
  }
  for(const [kind,f] of [['uniV2',V2F],['sushiV2',SUSHI]]){
    const r=await call(f,'0xe6a43905'+pad(t0)+pad(t1)); const a=addrOf(r);
    if(a!==ZERO) pools.push({kind,fee:3000,era,q:qs,addr:a,lcxIs0,qusd,qd});
  }
}
const toNum=(h,dec)=>{ let v=BigInt(h); if(v>=1n<<255n) v-=1n<<256n; return Number(v)/10**dec; };
const LCXUSD={new:(d.quotes||[]).find(q=>q.label==='LCX / USD (new)')?.usd, old:(d.quotes||[]).find(q=>q.label==='LCX / USD (old)')?.usd};
// TVL and active liquidity
for(const p of pools){
  const bal=async tok=>toNum(await call(tok,'0x70a08231'+pad(p.addr)),18);
  const lcxBal=Number(BigInt(await call(LCX[p.era],'0x70a08231'+pad(p.addr))))/1e18;
  const qBal=Number(BigInt(await call(Q[p.q][0],'0x70a08231'+pad(p.addr))))/10**p.qd;
  p.tvl=lcxBal*LCXUSD[p.era]+qBal*p.qusd;
  if(p.kind==='uniV3'){ p.L=BigInt(await call(p.addr,'0x1a686502')); const s0=await call(p.addr,'0x3850c7bd'); let t=BigInt('0x'+s0.slice(2+64,2+128)); if(t>=1n<<255n) t-=1n<<256n; p.tick=Number(t); }
}
// our positions: tick ranges from the payload (both tokens 18 decimals on the WETH pools)
const ours=(d.eth||[]).map(x=>({pool:(x.pool||'').toLowerCase(), L:BigInt(x.liq), tl:Math.log(x.priceLower)/Math.log(1.0001), tu:Math.log(x.priceUpper)/Math.log(1.0001), id:x.id}));
// 7 days of swaps
const head=parseInt(await rpc('eth_blockNumber',[]),16), from=head-7*7200;
const V3SW='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', V2SW='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const byAddr=Object.fromEntries(pools.map(p=>[p.addr,Object.assign(p,{vol:0,fees:0,ourFees:0,n:0})]));
const addrs=pools.map(p=>p.addr);
for(let b=from;b<=head;b+=2000){
  const logs=await rpc('eth_getLogs',[{fromBlock:'0x'+b.toString(16),toBlock:'0x'+Math.min(head,b+1999).toString(16),address:addrs,topics:[[V3SW,V2SW]]}]);
  for(const lg of logs){
    const p=byAddr[lg.address.toLowerCase()]; if(!p) continue;
    const w=i=>'0x'+lg.data.slice(2+64*i,2+64*(i+1));
    let qAmt;
    if(lg.topics[0]===V3SW){
      const a0=toNum(w(0),p.lcxIs0?18:p.qd), a1=toNum(w(1),p.lcxIs0?p.qd:18);
      qAmt=Math.abs(p.lcxIs0?a1:a0);
      const L=BigInt(w(3)); let t=BigInt(w(4)); if(t>=1n<<255n) t-=1n<<256n; const tick=Number(t);
      const ourL=ours.filter(o=>o.pool===p.addr && o.tl<=tick && tick<o.tu).reduce((s,o)=>s+o.L,0n);
      const usd=qAmt*p.qusd, fee=usd*p.fee/1e6;
      p.vol+=usd; p.fees+=fee; p.ourFees+=L>0n?fee*Number(ourL*10000n/L)/10000:0; p.n++;
    } else {
      const a=[0,1,2,3].map(i=>toNum(w(i),(i%2===0)===p.lcxIs0?18:p.qd));
      qAmt=p.lcxIs0?Math.max(a[1],a[3]):Math.max(a[0],a[2]);
      const usd=qAmt*p.qusd; p.vol+=usd; p.fees+=usd*0.003; p.n++;
    }
  }
}
console.log('ETH $'+ETH.toFixed(0)+'  LCX new $'+LCXUSD.new+'  old $'+LCXUSD.old+'  window blocks '+from+'..'+head+' (7 days)');
console.log('kind      fee    era q     pool                                        tvl$    swaps  vol7d$    fees7d$  ourFees7d$  ourShareActive');
const tot={new:{vol:0,fees:0,our:0},old:{vol:0,fees:0,our:0}};
for(const p of pools.sort((a,b)=>b.vol-a.vol)){
  const ourNow=ours.filter(o=>o.pool===p.addr && p.tick!=null && o.tl<=p.tick && p.tick<o.tu).reduce((s,o)=>s+o.L,0n);
  const share=(p.L&&p.L>0n)?Number(ourNow*10000n/p.L)/100:null;
  tot[p.era].vol+=p.vol; tot[p.era].fees+=p.fees; tot[p.era].our+=p.ourFees;
  console.log([p.kind.padEnd(8),String(p.fee/10000+'%').padEnd(6),p.era.padEnd(4),p.q.padEnd(5),p.addr,p.tvl.toFixed(0).padStart(8),String(p.n).padStart(6),p.vol.toFixed(0).padStart(9),p.fees.toFixed(2).padStart(9),p.ourFees.toFixed(2).padStart(10),share==null?'':share.toFixed(1)+'%'].join('  '));
}
console.log('TOTAL on-chain (Uniswap v2/v3 + Sushi):',JSON.stringify(tot));
// aggregators and exchanges
for(const [era,a] of Object.entries(LCX)){
  try{ const j=await (await fetch('https://api.dexscreener.com/latest/dex/tokens/'+a)).json();
    console.log('\n--- DexScreener pairs, LCX '+era+' ---');
    for(const x of (j.pairs||[]).sort((a,b)=>(b.volume?.h24||0)-(a.volume?.h24||0)))
      console.log(' ',x.chainId,x.dexId,(x.labels||[]).join('/'),x.baseToken.symbol+'/'+x.quoteToken.symbol,x.pairAddress,'liq$',Math.round(x.liquidity?.usd||0),'vol24$',Math.round(x.volume?.h24||0),'vol6h$',Math.round(x.volume?.h6||0),'tx24',(x.txns?.h24?.buys||0)+(x.txns?.h24?.sells||0));
  }catch(e){ console.log('dexscreener',era,e.message); }
}
try{ const j=await (await fetch('https://api.coingecko.com/api/v3/coins/lcx/tickers?include_exchange_logo=false&depth=false')).json();
  console.log('\n--- CoinGecko tickers (LCX) ---');
  for(const t of (j.tickers||[]).sort((a,b)=>(b.converted_volume?.usd||0)-(a.converted_volume?.usd||0)).slice(0,25))
    console.log(' ',t.market?.name,t.base+'/'+t.target,'vol24$',Math.round(t.converted_volume?.usd||0),'trust',t.trust_score,t.is_stale?'STALE':'');
}catch(e){ console.log('coingecko',e.message); }

/* The whole market for two tokens, from public data: every pool that lists LCX (new contract) on
   Ethereum and every pool that lists CPOOL on Solana — against ETH, SOL and the stablecoins alike.
   For each pool: size, trading day by day, fee rate, whether its price agrees with the rest of the
   market, and its LP book (positions, how many sit at the price, how many wallets, who arrived and
   who left). For each token: how its trading and its liquidity divide between the pools, and three
   cross-checks of the public sources against each other and against the chain itself.

   It does not open the deck's data and does not know which pools are the deck's: the log is public
   and says nothing about whose liquidity is whose. Pool totals and counts only. */
const LCXN='0x8cd41041505885ef0ad3858181d66f17be8aae7e', CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg';
const DAYS=+(process.env.DAYS||30);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt,tries=3,ms=25000){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(ms)}); if(r.ok) return await r.json(); if(r.status===429) await sleep(5000); }catch(e){} await sleep(1200*(k+1)); } return null; }
const budget=ms=>{ const end=Date.now()+ms; return ()=>Date.now()>end; };
const usd=x=>x==null||!isFinite(x)?'—':'$'+(Math.abs(x)>=1e6?(x/1e6).toFixed(2)+'M':Math.abs(x)>=1e4?(x/1e3).toFixed(1)+'k':Math.abs(x)>=100?x.toFixed(0):x.toFixed(2));
const pct=x=>x==null||!isFinite(x)?'—':(x*100).toFixed(1)+'%';
const day=ms=>new Date(ms).toISOString().slice(0,10);
const pad=(s,n)=>String(s).slice(0,n).padEnd(n), lpad=(s,n)=>String(s).padStart(n);
const DAYLIST=[]; for(let i=DAYS-1;i>=0;i--) DAYLIST.push(day(Date.now()-i*86400e3));
const med=a=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[s.length>>1]; };

/* ---------- GeckoTerminal (30 calls a minute) ---------- */
const GT='https://api.geckoterminal.com/api/v2'; let gtLast=0;
const gt=async path=>{ const w=2300-(Date.now()-gtLast); if(w>0) await sleep(w); gtLast=Date.now(); return j(GT+path,{headers:{accept:'application/json;version=20230302'}}); };
async function tokenPools(net, token){
  const out=[]; for(let page=1; page<=5; page++){ const r=await gt('/networks/'+net+'/tokens/'+token+'/pools?page='+page+'&sort=h24_volume_usd_desc&include=dex');
    const a=r?.data||[]; out.push(...a); if(a.length<20) break; }
  return out.map(x=>{ const a=x.attributes||{}; const fm=String(a.name||'').match(/([\d.]+)%/);
    return {addr:a.address, name:String(a.name||'?').replace(/\s+[\d.]+%$/,''), dex:x.relationships?.dex?.data?.id||'?', tvl:+a.reserve_in_usd||0, vol24:+a.volume_usd?.h24||0,
      tx24:(a.transactions?.h24?.buys||0)+(a.transactions?.h24?.sells||0), created:a.pool_created_at?Date.parse(a.pool_created_at):null,
      fee:fm?+fm[1]/100:null, baseAddr:x.relationships?.base_token?.data?.id?.split('_').pop(), basePx:+a.base_token_price_usd||null, quotePx:+a.quote_token_price_usd||null}; }); }
async function daily(net, addr){ const r=await gt('/networks/'+net+'/pools/'+addr+'/ohlcv/day?limit='+(DAYS+1)+'&currency=usd'); const m=new Map();
  for(const c of r?.data?.attributes?.ohlcv_list||[]) m.set(day(c[0]*1000), +c[5]); return m; }

/* ---------- Ethereum: Blockscout serves whole histories; one node call for state ---------- */
const BS='https://eth.blockscout.com';
async function bsLogs(params, over){
  const out=[], seen=new Set(); let from=params.fromBlock||0;
  for(let n=0;n<60;n++){ if(over&&over()) return {logs:out, partial:true};
    const q=new URLSearchParams({module:'logs',action:'getLogs',...params,fromBlock:String(from),toBlock:'latest'});
    const r=await j(BS+'/api?'+q,{},3,60000); const a=Array.isArray(r?.result)?r.result:null; if(!a) return {logs:out, partial:true, failed:true};
    let added=0; for(const l of a){ const k=l.transactionHash+':'+l.logIndex; if(seen.has(k)) continue; seen.add(k); out.push(l); added++; }
    if(a.length<1000||!added) break; from=parseInt(a[a.length-1].blockNumber,16); }
  return {logs:out, partial:false}; }
const ERPC=[BS+'/api/eth-rpc','https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth'];
async function erpc(method,params){ for(const u of ERPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,15000); if(r&&r.result!==undefined&&r.result!==null&&!r.error) return r.result; } return null; }
let keccak=null; try{ keccak=(await import('js-sha3')).keccak256; }catch(e){}
const sig=(s,known)=>keccak?'0x'+keccak(s):known;
const EV={
  v3mint:sig('Mint(address,address,int24,int24,uint128,uint256,uint256)','0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'),
  v3burn:sig('Burn(address,int24,int24,uint128,uint256,uint256)','0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'),
  v3swap:sig('Swap(address,address,int256,int256,uint160,uint128,int24)','0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'),
  v4mod:sig('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)','0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'),
  v4swap:sig('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)','0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f')};
const PM4='0x000000000004444c5dc75cb358380d2e3de08a90', SV4='0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const sInt=(h,bits=256)=>{ let v=BigInt('0x'+h); const top=1n<<BigInt(bits-1); if(bits<256){ v&=(1n<<BigInt(bits))-1n; } if(v>=top) v-=1n<<BigInt(bits); return v; };
const i24=h=>Number(sInt(h.slice(-6),24));
const w=(data,i)=>data.slice(2+64*i,2+64*(i+1));

async function uniBook(P){
  const v4=P.addr.length===66, over=budget(8*60e3);
  const startBlk=await erpc('eth_blockNumber',[]); const tip=startBlk?parseInt(startBlk,16):null;
  const born=tip&&P.created?Math.max(0,tip-Math.ceil((Date.now()-P.created)/12000*1.05)-2000):0;
  const lp=v4 ? await bsLogs({address:PM4, topic0:EV.v4mod, topic1:P.addr, topic0_1_opr:'and', fromBlock:born}, over)
              : await bsLogs({address:P.addr, topic0:EV.v3mint, fromBlock:born}, over);
  const burns=v4?{logs:[],partial:false}:await bsLogs({address:P.addr, topic0:EV.v3burn, fromBlock:born}, over);
  const swapFrom=tip?tip-Math.ceil(DAYS*86400/12.05):0;
  const sw=v4? await bsLogs({address:PM4, topic0:EV.v4swap, topic1:P.addr, topic0_1_opr:'and', fromBlock:swapFrom}, budget(5*60e3))
             : await bsLogs({address:P.addr, topic0:EV.v3swap, fromBlock:swapFrom}, budget(5*60e3));
  // positions: v4 by (owner, range, salt); v3 by (owner, range) — the position manager pools NFTs of one range into one key
  const pos=new Map(); const add=(k,lo,hi,dL,t,tx)=>{ const e=pos.get(k)||{lo,hi,L:0n,first:t,last:t,tx:new Set()}; e.L+=dL; e.last=t; if(dL>0n) e.tx.add(tx); pos.set(k,e); };
  for(const l of lp.logs){ const t=parseInt(l.timeStamp,16)*1000;
    if(v4){ const lo=i24(w(l.data,0)), hi=i24(w(l.data,1)), dL=sInt(w(l.data,2)), salt=w(l.data,3); add(l.topics[2]+':'+lo+':'+hi+':'+salt, lo,hi,dL,t,l.transactionHash); }
    else{ const lo=i24(l.topics[2]), hi=i24(l.topics[3]), amt=BigInt('0x'+w(l.data,1)); add(l.topics[1]+':'+lo+':'+hi, lo,hi,amt,t,l.transactionHash); } }
  for(const l of burns.logs){ const t=parseInt(l.timeStamp,16)*1000, lo=i24(l.topics[2]), hi=i24(l.topics[3]), amt=BigInt('0x'+w(l.data,0)); add(l.topics[1]+':'+lo+':'+hi, lo,hi,-amt,t,l.transactionHash); }
  // the pool's tick and active liquidity now
  let tick=null, liqNow=null;
  if(v4){ const r=await erpc('eth_call',[{to:SV4,data:'0xc815641c'+P.addr.slice(2)},'latest']); if(r) tick=i24(w(r,1));
          const q=await erpc('eth_call',[{to:SV4,data:'0xfa6793d5'+P.addr.slice(2)},'latest']); if(q) liqNow=BigInt('0x'+w(q,0)); }
  else{ const r=await erpc('eth_call',[{to:P.addr,data:'0x3850c7bd'},'latest']); if(r) tick=i24(w(r,1));
        const q=await erpc('eth_call',[{to:P.addr,data:'0x1a686502'},'latest']); if(q) liqNow=BigInt('0x'+w(q,0)); }
  if(tick==null&&sw.logs.length){ const l=sw.logs[sw.logs.length-1]; tick=i24(w(l.data,v4?4:4)); }
  const live=[...pos.values()].filter(e=>e.L>0n), inR=tick==null?[]:live.filter(e=>e.lo<=tick&&tick<e.hi);
  const sumIn=inR.reduce((s,e)=>s+e.L,0n);
  // who opened them: the wallet that sent each opening transaction (sampled within a budget)
  const overW=budget(3*60e3), wallets=new Set(); let walletsRead=0;
  for(const e of live){ if(overW()) break; const h=[...e.tx][0]; if(!h) continue; const r=await j(BS+'/api/v2/transactions/'+h,{},2,12000); const f=r?.from?.hash; if(f){ wallets.add(f.toLowerCase()); walletsRead++; } }
  // arrivals and departures in the window, by week
  const since=Date.now()-DAYS*86400e3;
  const arrived=[...pos.values()].filter(e=>e.first>=since), left=[...pos.values()].filter(e=>e.L<=0n&&e.last>=since&&e.first<since);
  // swaps by day: count and the active liquidity each swap met
  const sd=new Map(); for(const l of sw.logs){ const d=day(parseInt(l.timeStamp,16)*1000); const e=sd.get(d)||{n:0,L:[]}; e.n++; e.L.push(Number(BigInt('0x'+w(l.data,3)))); sd.set(d,e); }
  return {kind:v4?'v4':'v3', open:live.length, inRange:inR.length, ever:pos.size, wallets:walletsRead===live.length?wallets.size:null, walletsSeen:wallets.size,
    arrived:arrived.length, left:left.length, arrivedWeeks:weeks(arrived.map(e=>e.first)), sd, swaps:sw.logs.length,
    check:liqNow!=null&&inR.length?{pool:liqNow, sum:sumIn}:null, partial:lp.partial||burns.partial||sw.partial, failed:lp.failed||sw.failed}; }
function weeks(ts){ const w=[0,0,0,0,0]; for(const t of ts){ const k=Math.floor((Date.now()-t)/(7*86400e3)); if(k>=0&&k<5) w[k]++; } return w.slice(0,Math.ceil(DAYS/7)).reverse(); }

/* ---------- Solana ---------- */
const SRPC=[process.env.SOL_RPC_URL,'https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com','https://solana.leorpc.com/?api_key=FREE','https://rpc.solanatracker.io/public'].filter(Boolean);
async function srpc(method,params){ for(const u of SRPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,20000); if(r&&r.result!==undefined&&!r.error) return r.result; await sleep(250); } return null; }
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let n=BigInt('0x'+(Buffer.from(buf).toString('hex')||'0')), s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of buf){ if(x===0) s='1'+s; else break; } return s; };
const u128=(b,o)=>{ let v=0n; for(let i=15;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const u64=(b,o)=>{ let v=0n; for(let i=7;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const CLMM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', ORCA='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PE6UZBRyrrtbaPu';
async function holderOf(mint){ for(const prog of [TOKEN,T22]){ const r=await srpc('getProgramAccounts',[prog,{encoding:'base64',filters:[...(prog===TOKEN?[{dataSize:165}]:[]),{memcmp:{offset:0,bytes:mint}}]}]);
    if(Array.isArray(r)) for(const a of r){ const b=Buffer.from(a.account.data[0],'base64'); if(b.length>=72&&u64(b,64)>0n) return b58(b.subarray(32,64)); } } return null; }
async function clmmBook(P, orca){
  const acct=await srpc('getAccountInfo',[P.addr,{encoding:'base64'}]); if(!acct?.value) return null;
  const pb=Buffer.from(acct.value.data[0],'base64'); const poolL=orca?u128(pb,49):u128(pb,237), tick=orca?pb.readInt32LE(81):pb.readInt32LE(269);
  const gpa=await srpc('getProgramAccounts',[orca?ORCA:CLMM,{encoding:'base64',filters:orca?[{dataSize:216},{memcmp:{offset:8,bytes:P.addr}}]:[{dataSize:281},{memcmp:{offset:41,bytes:P.addr}}]}]);
  if(!Array.isArray(gpa)) return {failed:true};
  const live=[]; for(const a of gpa){ const b=Buffer.from(a.account.data[0],'base64');
    const mint=orca?b58(b.subarray(40,72)):b58(b.subarray(9,41)), L=orca?u128(b,72):u128(b,81), lo=orca?b.readInt32LE(88):b.readInt32LE(73), hi=orca?b.readInt32LE(92):b.readInt32LE(77);
    if(L>0n) live.push({mint,L,lo,hi}); }
  const inR=live.filter(e=>e.lo<=tick&&tick<e.hi), sumIn=inR.reduce((s,e)=>s+e.L,0n);
  const over=budget(4*60e3), wallets=new Set(); let walletsRead=0, dated=0; const opened=[];
  for(const p of live){ if(over()) break;
    let before=null, oldest=null; for(let pg=0;pg<4;pg++){ const s=await srpc('getSignaturesForAddress',[p.mint,{limit:1000,...(before?{before}:{})}]); if(!Array.isArray(s)||!s.length) break; oldest=s[s.length-1]; before=oldest.signature; if(s.length<1000) break; }
    if(oldest?.blockTime){ opened.push(oldest.blockTime*1000); dated++; }
    const h=await holderOf(p.mint); if(h){ wallets.add(h); walletsRead++; } }
  const since=Date.now()-DAYS*86400e3;
  return {kind:orca?'orca':'clmm', open:live.length, inRange:inR.length, wallets:walletsRead===live.length?wallets.size:null, walletsSeen:wallets.size, dated,
    arrived:opened.filter(t=>t>=since).length, arrivedWeeks:weeks(opened), check:inR.length?{pool:poolL, sum:sumIn}:null}; }
async function ammHolders(lpMint){ const r=await srpc('getProgramAccounts',[TOKEN,{encoding:'base64',filters:[{dataSize:165},{memcmp:{offset:0,bytes:lpMint}}]}]);
  if(!Array.isArray(r)) return null; let n=0; for(const a of r){ const b=Buffer.from(a.account.data[0],'base64'); if(u64(b,64)>0n) n++; } return n; }

/* ---------- one token's market ---------- */
async function market(net, token, sym, chainName){
  const pools=(await tokenPools(net, token)).filter(p=>p.addr);
  let ray=new Map();
  if(net==='solana'){ const r=await j('https://api-v3.raydium.io/pools/info/mint?mint1='+token+'&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=100&page=1');
    const arr=Array.isArray(r?.data?.data)?r.data.data:(Array.isArray(r?.data)?r.data:[]);
    for(const d of arr) ray.set(d.id,d);
    // a Raydium pool the price index has not listed yet still belongs in the market
    for(const [id,d] of ray) if(!pools.some(p=>p.addr===id)) pools.push({addr:id, name:(d.mintA?.symbol||'?')+' / '+(d.mintB?.symbol||'?'), dex:'raydium ('+String(d.type||'').toLowerCase()+', unlisted)', tvl:+d.tvl||0, vol24:+d.day?.volume||0, tx24:null, created:d.openTime?+d.openTime*1000:null, fee:d.feeRate!=null?+d.feeRate:null, basePx:null}); }
  for(const p of pools){ const d=ray.get(p.addr); if(d?.feeRate!=null&&p.fee==null) p.fee=+d.feeRate; }
  // the token's price in each pool against the market's (volume-weighted) price: a pool far off it is not trading
  const tokPx=p=>p.baseAddr&&String(p.baseAddr).toLowerCase()===String(token).toLowerCase()?p.basePx:(p.quotePx||p.basePx);
  const act=pools.filter(p=>p.vol24>0&&tokPx(p)>0); const mpx=act.length?act.reduce((s,p)=>s+tokPx(p)*p.vol24,0)/act.reduce((s,p)=>s+p.vol24,0):null;
  const tot={tvl:pools.reduce((s,p)=>s+p.tvl,0), vol24:pools.reduce((s,p)=>s+p.vol24,0)};
  const active=pools.filter(p=>p.tvl>=100||p.vol24>0);
  console.log('\n######## '+sym+' on '+chainName+' · '+pools.length+' pools list it ('+active.length+' with $100+ or any trading) · TVL '+usd(tot.tvl)+' · 24h volume '+usd(tot.vol24)+' · price '+(mpx?'$'+mpx.toPrecision(4):'—'));
  // daily volume, every active pool
  for(const p of active){ p.days=await daily(net,p.addr); p.vol30=[...p.days.values()].reduce((s,v)=>s+(v||0),0); }
  const tot30=active.reduce((s,p)=>s+p.vol30,0);
  console.log('  pool                              venue                         fee     TVL    vol 24h    vol '+DAYS+'d  share of '+DAYS+'d vol  opened      price vs market');
  for(const p of active.sort((a,b)=>b.vol30-a.vol30||b.tvl-a.tvl)){
    const off=mpx&&tokPx(p)>0?tokPx(p)/mpx-1:null;
    console.log('  '+pad(p.name,33)+' '+pad(p.dex,28)+' '+lpad(p.fee!=null?(p.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':'—',6)+' '+lpad(usd(p.tvl),7)+' '+lpad(usd(p.vol24),9)+' '+lpad(usd(p.vol30),9)+' '+lpad(pct(tot30>0?p.vol30/tot30:null),17)+'  '+(p.created?day(p.created):'—    ')+'  '+(off==null?'—':(off>=0?'+':'')+(off*100).toFixed(1)+'%'+(Math.abs(off)>0.1?'  ← off the market':''))); }
  const dead=pools.length-active.length; if(dead) console.log('  + '+dead+' more pool(s) under $100 with no trading');
  // the market's day: total and how it split
  const top=active.filter(p=>p.vol30>0).slice(0,4);
  console.log('\n  day (UTC)   all pools  '+top.map(p=>lpad(p.name.slice(0,14)+(p.fee!=null?' '+(p.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':''),20)).join(' ')+'   rest');
  for(const d of DAYLIST){ const all=active.reduce((s,p)=>s+(p.days.get(d)||0),0), t=top.map(p=>p.days.get(d)||0), rest=all-t.reduce((s,v)=>s+v,0);
    console.log('  '+d+'  '+lpad(usd(all),9)+'  '+t.map(v=>lpad(usd(v)+' '+lpad(all>0?Math.round(v/all*100)+'%':'',4),20)).join(' ')+'   '+lpad(usd(rest),7)); }
  // LP books
  console.log('\n  LP books (positions open · at the price now · wallets · opened in the window, by week oldest→newest · closed in the window)');
  const checks=[];
  const offOf=p=>mpx&&tokPx(p)>0?tokPx(p)/mpx-1:null;
  const skipped=active.filter(x=>x.tvl>=100&&(x.tvl<1000||Math.abs(offOf(x)??0)>0.1));
  if(skipped.length) console.log('  ('+skipped.length+' pool(s) not read: under $1k, or priced more than 10% off the market, so not trading)');
  for(const p of active.filter(x=>x.tvl>=1000&&Math.abs(offOf(x)??0)<=0.1)){
    let b=null; const d=ray.get(p.addr), type=String(d?.type||'').toLowerCase(), dex=String(p.dex);
    try{
      if(net==='eth'&&/uniswap/.test(dex)) b=await uniBook(p);
      else if(net==='solana'&&(type==='concentrated'||/clmm/.test(dex))) b=await clmmBook(p,false);
      else if(net==='solana'&&/orca/.test(dex)) b=await clmmBook(p,true);
      else if(net==='solana'&&d?.lpMint?.address){ const n=await ammHolders(d.lpMint.address); b={kind:'amm', holders:n}; }
    }catch(e){ b={failed:true}; }
    const lab='  '+pad(p.name+(p.fee!=null?' '+(p.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':''),24)+' '+pad(p.dex,22)+' ';
    if(!b) console.log(lab+'not read (no reader for this pool type)');
    else if(b.failed) console.log(lab+'the position list was refused by every public node');
    else if(b.kind==='amm') console.log(lab+'classic pool: '+(b.holders!=null?b.holders+' wallets hold its LP token':'LP-token holders not readable'));
    else { console.log(lab+b.open+' open · '+b.inRange+' at the price · '+(b.wallets!=null?b.wallets+' wallets':b.walletsSeen?'≥'+b.walletsSeen+' wallets':'wallets —')+' · opened '+b.arrived+' ['+b.arrivedWeeks.join(' ')+']'+(b.left!=null?' · closed '+b.left:'')+(b.swaps!=null?' · swaps read '+b.swaps:'')+(b.partial?' (partial)':''));
      if(b.check) checks.push([p, b.check]);
      if(b.sd&&b.sd.size){ const idx=[]; let L0=null; for(const dd of DAYLIST){ const e=b.sd.get(dd); const m=e?med(e.L):null; if(m!=null&&L0==null) L0=m; idx.push(m!=null&&L0?Math.round(m/L0*100):'·'); }
        console.log('    liquidity at the price, day by day (first day = 100): '+idx.join(' '));
        console.log('    swaps per day: '+DAYLIST.map(dd=>b.sd.get(dd)?.n||0).join(' ')); } }
  }
  // cross-checks
  console.log('\n  cross-checks');
  for(const p of active){ const d=ray.get(p.addr); if(!d) continue;
    const dt=p.tvl&&d.tvl?Math.abs(p.tvl/d.tvl-1):null, dv=p.vol24&&d.day?.volume?Math.abs(p.vol24/d.day.volume-1):null;
    console.log('    '+pad(p.name+(p.fee!=null?' '+(p.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':''),24)+' price index vs Raydium: TVL '+usd(p.tvl)+' / '+usd(d.tvl)+' ('+pct(dt)+' apart) · 24h volume '+usd(p.vol24)+' / '+usd(d.day?.volume)+' ('+pct(dv)+' apart)'+((dt>0.1||dv>0.25)?'  ← check':''));
    const f30=d.month?.volumeFee, v30=d.month?.volume; if(f30!=null&&v30>0&&p.fee) console.log('      Raydium’s 30-day fees ÷ volume = '+(f30/v30*100).toFixed(3)+'% against the '+(p.fee*100).toFixed(2)+'% fee rate'); }
  for(const [p,c] of checks){ const r=c.pool>0n?Number(c.sum*10000n/c.pool)/10000:null;
    console.log('    '+pad(p.name+(p.fee!=null?' '+(p.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':''),24)+' positions at the price add up to '+pct(r)+' of the pool’s own liquidity figure'+(r!=null&&Math.abs(r-1)>0.01?'  ← check':'  ✓')); }
  return {pools, active};
}

console.log('window: '+DAYS+' days · '+(keccak?'event signatures computed':'event signatures from the built-in list'));
const ONLY=String(process.env.ONLY||'');
if(ONLY!=='sol') await market('eth', LCXN, 'LCX (new contract)', 'Ethereum');
if(ONLY!=='eth') await market('solana', CPOOL, 'CPOOL', 'Solana');

/* The pools themselves, examined: the deck's LCX (new contract) pool on Ethereum and its CPOOL / SOL
   pools on Solana. For each one — traffic (volume, fees, swaps, traders, day by day), depth (TVL,
   active liquidity), the LP book (how many positions and wallets, how many in range, who arrived
   and when), and where the token's trading actually happens (this pool's slice of the token's DEX
   volume across every pool that lists it).

   Public data only reaches this log, and only at pool level: every figure here is one anyone can
   read off the chain for these pools. Nothing about the deck's own positions is printed — no
   share, no size, no "theirs versus ours" split, no address or ID. */
import crypto from 'node:crypto';
const SITE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/', PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const DAYS=+(process.env.DAYS||30);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt,tries=4,ms=30000){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(ms)}); if(r.ok) return await r.json(); if(r.status===429&&tries>1) await sleep(6000); }catch(e){} if(tries>1) await sleep(1500*(k+1)); } return null; }
/* every pool gets a time budget: what was read by then is reported, marked partial */
const budget=ms=>{ const end=Date.now()+ms; return ()=>Date.now()>end; };
const L=await j(SITE+'lock.json?t='+Date.now());
const KEY=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').subarray(0,32);
const open=e=>{ if(!(e&&e.lock===1)) return e; const all=Buffer.from(e.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(e.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); };
const data=open(await j(SITE+'data-main.json?t='+Date.now()));
const LCXN='0x8cd41041505885ef0ad3858181d66f17be8aae7e', CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg';
const usd=x=>x==null||!isFinite(x)?'—':'$'+(Math.abs(x)>=1e6?(x/1e6).toFixed(2)+'M':Math.abs(x)>=1e4?(x/1e3).toFixed(1)+'k':Math.abs(x)>=100?x.toFixed(0):x.toFixed(2));
const day=ms=>new Date(ms).toISOString().slice(0,10);
const pct=x=>x==null||!isFinite(x)?'—':(x*100).toFixed(1)+'%';

/* ---- which pools: the deck's own, by token, identified from its sealed data (never printed) ---- */
const pools=[];
for(const p of data.eth||[]){ const t=[p.token0,p.token1].map(x=>String(x).toLowerCase()); if(!t.includes(LCXN)) continue;
  const a=String(p.pool).toLowerCase(); if(pools.some(x=>x.addr===a)) continue;
  pools.push({net:'eth', addr:a, venue:'Uniswap v3', fee:(p.feeTier||0)/1e6, label:(p.m0?.symbol||'?')+' / '+(p.m1?.symbol||'?'), token:LCXN, tokenSym:'LCX (new)'}); }
for(const p of data.sol||[]){ if(![p.mint0,p.mint1].includes(CPOOL)) continue; if(pools.some(x=>x.addr===p.poolId)) continue;
  pools.push({net:'solana', addr:p.poolId, venue:p.venue==='orca'?'Orca':'Raydium CLMM', fee:null, label:(p.m0?.symbol||'?')+' / '+(p.m1?.symbol||'?'), token:CPOOL, tokenSym:'CPOOL'}); }
console.log('pools examined: '+pools.length+' ('+pools.filter(p=>p.net==='eth').length+' Ethereum, '+pools.filter(p=>p.net==='solana').length+' Solana) · window: '+DAYS+' days');

/* ---- GeckoTerminal: pool record, daily candles, the token's other pools (30 calls a minute) ---- */
const GT='https://api.geckoterminal.com/api/v2';
let gtLast=0; const gt=async path=>{ const w=2300-(Date.now()-gtLast); if(w>0) await sleep(w); gtLast=Date.now(); return j(GT+path,{headers:{accept:'application/json;version=20230302'}}); };

/* ---- Ethereum ---- */
const ERPC=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth','https://eth.llamarpc.com'];
/* one quick try per node, then the next node; a node that refuses is not waited on */
async function erpc(method,params){ for(let k=0;k<2;k++) for(const u of ERPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,12000); if(r&&r.result!==undefined&&!r.error) return r.result; } return null; }
const T={mint:'0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde', burn:'0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c',
  swap:'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', inc:'0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f', dec:'0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4'};
const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88';
const i24=h=>{ let v=BigInt('0x'+h.slice(-6)); if(v>=0x800000n) v-=0x1000000n; return Number(v); };
const s256=h=>{ let v=BigInt('0x'+h); if(v>=2n**255n) v-=2n**256n; return v; };
let gaps=0;
async function ethLogs(addr, topics, from, to, over){
  const out=[]; let step=9000;
  for(let a=from; a<=to; ){ if(over&&over()){ gaps++; break; } const b=Math.min(to,a+step-1);
    const r=await erpc('eth_getLogs',[{address:addr,fromBlock:'0x'+a.toString(16),toBlock:'0x'+b.toString(16),topics}]);
    if(Array.isArray(r)){ out.push(...r); a=b+1; if(step<9000) step=Math.min(9000,step*2); } else if(step>2000) step=Math.floor(step/2); else { gaps++; a=b+1; } }
  return out; }

async function ethPool(P, rec){
  const tip=parseInt(await erpc('eth_blockNumber',[]),16), now=Date.now();
  const created=rec?.pool_created_at?Date.parse(rec.pool_created_at):now-120*86400e3;
  const from=Math.max(0, tip-Math.ceil((now-created)/12000*1.06)-3000);
  const blkTime=async n=>{ const b=await erpc('eth_getBlockByNumber',['0x'+n.toString(16),false]); return b?parseInt(b.timestamp,16)*1000:null; };
  const t0=await blkTime(tip); const spb=12.05; const tOf=n=>t0-(tip-n)*spb*1000;   // block → time, close enough for day buckets
  const over=budget(14*60e3); gaps=0;
  // Mint and Burn in one pass (either topic), the pool's whole life; swaps for the window
  const mb=await ethLogs(P.addr,[[T.mint,T.burn]],from,tip,over);
  const mints=mb.filter(l=>l.topics[0]===T.mint), burns=mb.filter(l=>l.topics[0]===T.burn);
  console.log('  (LP events read: '+mb.length+' over '+Math.round((tip-from)/7200)+' days'+(gaps?', '+gaps+' block range(s) unread':'')+')');
  const swapFrom=Math.max(from, tip-Math.ceil(DAYS*86400/spb)-50);
  const swaps=await ethLogs(P.addr,[T.swap],swapFrom,tip,budget(5*60e3));
  // tie each pool Mint/Burn to the position NFT it belongs to (the manager's event in the same transaction)
  const rc=new Map(); const txs=[...new Set([...mints,...burns].map(l=>l.transactionHash))];
  const overR=budget(6*60e3); for(const h of txs){ if(overR()) break; rc.set(h, await erpc('eth_getTransactionReceipt',[h])); }
  const pos=new Map(); let direct=0;
  const apply=(l,sign)=>{ const r=rc.get(l.transactionHash); const li=parseInt(l.logIndex,16);
    const ev=(r?.logs||[]).filter(x=>String(x.address).toLowerCase()===NPM && x.topics[0]===(sign>0?T.inc:T.dec) && parseInt(x.logIndex,16)>li)
      .sort((a,b)=>parseInt(a.logIndex,16)-parseInt(b.logIndex,16))[0];
    const amt=BigInt('0x'+l.data.slice(2+(sign>0?64:0),2+(sign>0?128:64)));
    const id=ev?BigInt(ev.topics[1]).toString():('direct:'+l.topics[1]+l.topics[2]+l.topics[3]); if(!ev) direct++;
    const e=pos.get(id)||{id, lo:i24(l.topics[2]), hi:i24(l.topics[3]), L:0n, first:parseInt(l.blockNumber,16), from:sign>0?String(r?.from||'').toLowerCase():'', hist:[]};
    e.L+=sign>0?amt:-amt; e.hist.push([parseInt(l.blockNumber,16), sign>0?amt:-amt]); pos.set(id,e); };
  const all=[...mints.map(l=>[l,1]),...burns.map(l=>[l,-1])].sort((a,b)=>parseInt(a[0].blockNumber,16)-parseInt(b[0].blockNumber,16)||parseInt(a[0].logIndex,16)-parseInt(b[0].logIndex,16));
  for(const [l,s] of all) apply(l,s);
  const s0=await erpc('eth_call',[{to:P.addr,data:'0x3850c7bd'},'latest']); const tickNow=s0?i24(s0.slice(2+64,2+128)):null;
  const live=[...pos.values()].filter(e=>e.L>0n);
  const owners=new Set(); for(const e of live){ if(e.id.startsWith('direct:')){ owners.add(e.id); continue; }
    const o=await erpc('eth_call',[{to:NPM,data:'0x6352211e'+BigInt(e.id).toString(16).padStart(64,'0')},'latest']); if(o) owners.add('0x'+o.slice(-40)); }
  const inRange=live.filter(e=>tickNow!=null&&e.lo<=tickNow&&tickNow<e.hi).length;
  // day by day: swaps, the pool's active liquidity at each swap (from the swap itself), positions in range and opened
  const days=new Map();
  for(const s of swaps){ const d=day(tOf(parseInt(s.blockNumber,16))); const w=s.data.slice(2);
    const liq=BigInt('0x'+w.slice(64*3,64*4)), tick=i24(w.slice(64*4,64*5));
    const e=days.get(d)||{swaps:0, liq:[], lastTick:null, lastBlk:0}; e.swaps++; e.liq.push(liq); const bn=parseInt(s.blockNumber,16); if(bn>=e.lastBlk){ e.lastBlk=bn; e.lastTick=tick; } days.set(d,e); }
  const opened=new Map(), newW=new Map(), seenW=new Set();
  for(const e of [...pos.values()].sort((a,b)=>a.first-b.first)){ const d=day(tOf(e.first)); opened.set(d,(opened.get(d)||0)+1); if(e.from&&!seenW.has(e.from)){ seenW.add(e.from); newW.set(d,(newW.get(d)||0)+1); } }
  const Lat=(e,blk)=>e.hist.filter(h=>h[0]<=blk).reduce((s,h)=>s+h[1],0n);
  const inRangeAt=(blk,tick)=>[...pos.values()].filter(e=>e.lo<=tick&&tick<e.hi&&Lat(e,blk)>0n).length;
  return {created, positions:pos.size, live:live.length, inRange, wallets:owners.size, everWallets:seenW.size, direct, days, opened, newW, inRangeAt, swapsN:swaps.length};
}

/* ---- Solana ---- */
const SRPC=[process.env.SOL_RPC_URL,'https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com','https://solana.leorpc.com/?api_key=FREE','https://rpc.solanatracker.io/public'].filter(Boolean);
async function srpc(method,params){ for(let k=0;k<2;k++) for(const u of SRPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,15000); if(r&&r.result!==undefined&&!r.error) return r.result; await sleep(300); } return null; }
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let n=BigInt('0x'+Buffer.from(buf).toString('hex')||'0'), s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of buf){ if(x===0) s='1'+s; else break; } return s; };
const u128=(b,o)=>{ let v=0n; for(let i=15;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const i32=(b,o)=>b.readInt32LE(o);
async function solPool(P){
  const acct=await srpc('getAccountInfo',[P.addr,{encoding:'base64'}]); if(!acct?.value) return null;
  const pb=Buffer.from(acct.value.data[0],'base64'), orca=P.venue==='Orca';
  const poolL=orca?u128(pb,49):u128(pb,237), tick=orca?i32(pb,81):i32(pb,269);
  const prog=orca?'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
  const filters=orca?[{dataSize:216},{memcmp:{offset:8,bytes:P.addr}}]:[{dataSize:281},{memcmp:{offset:41,bytes:P.addr}}];
  const gpa=await srpc('getProgramAccounts',[prog,{encoding:'base64',filters}]);
  let positions=null, live=[], inRange=0, opened=new Map(), wallets=null;
  if(Array.isArray(gpa)){
    positions=gpa.length;
    for(const a of gpa){ const b=Buffer.from(a.account.data[0],'base64');
      const mint=orca?b58(b.subarray(40,72)):b58(b.subarray(9,41)), Lq=orca?u128(b,72):u128(b,81), lo=orca?i32(b,88):i32(b,73), hi=orca?i32(b,92):i32(b,77);
      if(Lq>0n){ live.push({mint,L:Lq,lo,hi}); if(lo<=tick&&tick<hi) inRange++; } }
    // when each live position was opened: the oldest transaction of its NFT; and who holds it
    const ws=new Set();
    const overP=budget(4*60e3);
    for(const p of live.slice(0,80)){ if(overP()) break;
      let before=null, oldest=null; for(let pg=0;pg<5;pg++){ const s=await srpc('getSignaturesForAddress',[p.mint,{limit:1000,...(before?{before}:{})}]); if(!Array.isArray(s)||!s.length) break; oldest=s[s.length-1]; before=oldest.signature; if(s.length<1000) break; }
      if(oldest?.blockTime){ p.t=oldest.blockTime*1000; const d=day(p.t); opened.set(d,(opened.get(d)||0)+1); }
      const la=await srpc('getTokenLargestAccounts',[p.mint]); const ta=la?.value?.find(x=>x.uiAmount>0)?.address;
      if(ta){ const ai=await srpc('getAccountInfo',[ta,{encoding:'jsonParsed'}]); const ow=ai?.value?.data?.parsed?.info?.owner; if(ow) ws.add(ow); }
    }
    wallets=ws.size;
  }
  // transactions touching the pool, day by day (swaps and LP moves alike)
  const txDays=new Map(); let before=null, stop=Date.now()-DAYS*86400e3, n=0;
  const overT=budget(3*60e3);
  for(let pg=0;pg<60;pg++){ if(overT()) break; const s=await srpc('getSignaturesForAddress',[P.addr,{limit:1000,...(before?{before}:{})}]); if(!Array.isArray(s)||!s.length) break;
    let done=false; for(const x of s){ before=x.signature; if(!x.blockTime) continue; if(x.blockTime*1000<stop){ done=true; break; } if(x.err) continue; n++; const d=day(x.blockTime*1000); txDays.set(d,(txDays.get(d)||0)+1); }
    if(done||s.length<1000) break; }
  return {poolL, tick, positions, live:live.length, inRange, wallets, opened, txDays, txN:n, gpa:Array.isArray(gpa), liveList:live};
}

/* ---- run ---- */
const tokenPools=new Map();
for(const P of pools){
  const net=P.net;
  const rec=(await gt('/networks/'+net+'/pools/'+P.addr))?.data?.attributes||null;
  const ohlcv=(await gt('/networks/'+net+'/pools/'+P.addr+'/ohlcv/day?limit='+(DAYS+1)+'&currency=usd'))?.data?.attributes?.ohlcv_list||[];
  let ray=null; if(net==='solana'&&P.venue!=='Orca'){ const r=await j('https://api-v3.raydium.io/pools/info/ids?ids='+P.addr); ray=Array.isArray(r?.data)?r.data[0]:null; if(ray?.feeRate!=null) P.fee=Number(ray.feeRate); }
  if(P.fee==null && rec?.name){ const m=String(rec.name).match(/([\d.]+)%/); if(m) P.fee=+m[1]/100; }
  console.log('\n== '+P.label+' '+(P.fee!=null?(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':'')+' · '+P.venue+' ('+(net==='eth'?'Ethereum':'Solana')+')'+(rec?.pool_created_at?' · pool opened '+day(Date.parse(rec.pool_created_at)):''));
  if(rec){ const v=+rec.volume_usd?.h24, tx=rec.transactions?.h24||{};
    console.log('  now: TVL '+usd(+rec.reserve_in_usd)+' · 24h volume '+usd(v)+' · 24h fees '+usd(P.fee!=null?v*P.fee:null)+' · 24h swaps '+((tx.buys||0)+(tx.sells||0))+' ('+(tx.buyers||0)+' buyers, '+(tx.sellers||0)+' sellers)'
      +' · volume/TVL '+(+rec.reserve_in_usd>0?(v/+rec.reserve_in_usd).toFixed(2)+'x a day':'—')); }
  else console.log('  now: the pool record did not answer');
  if(ray) console.log('  Raydium’s own figures: TVL '+usd(ray.tvl)+' · volume 24h '+usd(ray.day?.volume)+', 7d '+usd(ray.week?.volume)+', 30d '+usd(ray.month?.volume)+' · fees 24h '+usd(ray.day?.volumeFee)+', 7d '+usd(ray.week?.volumeFee)+', 30d '+usd(ray.month?.volumeFee)+' · fee APR 7d '+(ray.week?.feeApr!=null?ray.week.feeApr.toFixed(0)+'%':'—'));
  let lp=null; try{ lp=net==='eth'?await ethPool(P,rec):await solPool(P); }catch(e){ console.log('  LP book: could not be read ('+String(e.message||e).slice(0,50)+')'); }
  if(lp){
    if(net==='eth') console.log('  LP book: '+lp.live+' positions open ('+lp.inRange+' in range now) held by '+lp.wallets+' wallet(s) · '+lp.positions+' positions ever, opened by '+lp.everWallets+' wallet(s)'+(lp.direct?' · '+lp.direct+' events not through the position manager':'')+' · swaps in the window: '+lp.swapsN);
    else console.log('  LP book: '+(lp.gpa?lp.live+' positions open ('+lp.inRange+' in range now)'+(lp.wallets!=null?' held by '+lp.wallets+' wallet(s)':''):'the position list was refused by every public node')+' · pool transactions in the window: '+lp.txN);
  }
  // day by day
  const vol=new Map(ohlcv.map(c=>[day(c[0]*1000), {v:+c[5], c:+c[4]}]));
  const ds=[]; for(let i=DAYS-1;i>=0;i--) ds.push(day(Date.now()-i*86400e3));
  console.log('  day (UTC)    volume     fees      '+(net==='eth'?'swaps  active-L idx  in range':'pool txs')+'  opened'+(net==='eth'?'  new wallets':''));
  let L0=null;
  for(const d of ds){ const o=vol.get(d), v=o?o.v:null;
    let extra='';
    if(lp&&net==='eth'){ const e=lp.days.get(d); const med=e&&e.liq.length?e.liq.sort((a,b)=>a<b?-1:a>b?1:0)[e.liq.length>>1]:null; if(med!=null&&L0==null) L0=med;
      const idx=med!=null&&L0>0n?Number(med*1000n/L0)/10:null;
      const inr=e&&e.lastTick!=null?lp.inRangeAt(e.lastBlk,e.lastTick):null;
      extra=String(e?e.swaps:0).padStart(5)+'  '+String(idx!=null?idx.toFixed(0):'—').padStart(11)+'  '+String(inr??'—').padStart(8)+'  '+String(lp.opened.get(d)||0).padStart(6)+'  '+String(lp.newW.get(d)||0).padStart(11); }
    else if(lp){ extra=String(lp.txDays.get(d)||0).padStart(8)+'  '+String(lp.opened.get(d)||0).padStart(6); }
    console.log('  '+d+'  '+usd(v).padStart(8)+'  '+usd(v!=null&&P.fee!=null?v*P.fee:null).padStart(8)+'  '+extra); }
  // this pool's slice of the token's trading
  if(!tokenPools.has(P.net+':'+P.token)){ const tp=await gt('/networks/'+net+'/tokens/'+P.token+'/pools?page=1&sort=h24_volume_usd_desc'); tokenPools.set(P.net+':'+P.token, tp?.data||[]); }
  const tp=tokenPools.get(P.net+':'+P.token)||[];
  const tot=tp.reduce((s,x)=>s+(+x.attributes?.volume_usd?.h24||0),0), tvlTot=tp.reduce((s,x)=>s+(+x.attributes?.reserve_in_usd||0),0);
  const me=tp.find(x=>String(x.attributes?.address).toLowerCase()===String(P.addr).toLowerCase());
  console.log('  market: '+tp.length+' pools list '+P.tokenSym+' on '+(net==='eth'?'Ethereum':'Solana')+' · 24h volume '+usd(tot)+', TVL '+usd(tvlTot)
    +(me?' · this pool: '+pct((+me.attributes.volume_usd.h24)/tot)+' of the volume, '+pct((+me.attributes.reserve_in_usd)/tvlTot)+' of the TVL':''));
  for(const x of tp.slice(0,6)){ const a=x.attributes; console.log('    '+String(a.name).slice(0,34).padEnd(34)+' '+String(x.relationships?.dex?.data?.id||'').slice(0,16).padEnd(16)+' vol 24h '+usd(+a.volume_usd?.h24).padStart(8)+' · TVL '+usd(+a.reserve_in_usd).padStart(8)+' · opened '+(a.pool_created_at?day(Date.parse(a.pool_created_at)):'—')); }
}

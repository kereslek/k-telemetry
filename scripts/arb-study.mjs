/* ARBITRAGE STUDY — 28 days of your CPOOL pools, read back from the chain, and what an arbitrage bot of
   ours would have done with them. Step 1 of the plan: measure only, nothing trades.

   Read: every transaction in the deck's Raydium CLMM CPOOL pools (and pools it has left within the
   window), from Solana itself; the market's price minute by minute (SOL from Coinbase, CPOOL as the
   median of MEXC, KuCoin and Bitget). Each trade is valued at the market: what the trader made, and what
   the pool's LPs made, and your share of that. Traders are sorted into you, atomic arbitrage bots,
   market-making bots, bridge traders and people. Every gap between two of your pools, and between each
   pool and the market, is an episode: what opened it, who closed it, what that bot kept, what it cost you.

   Then the what-ifs, booked with the same valuation (arb-core.mjs): copying the bots' trades; closing
   gaps between your pools ourselves at a threshold; selling across sibling pools instead of one; and the
   three together, each over a grid of win rates and transaction costs.

   Kept incrementally in a sealed cache (restored between runs by the workflow); the report is sealed
   (deck-r7k4x9/arb-<slug>.json) and drawn by the deck's ARBITRAGE STUDY panel. The log is public:
   counts, dates, ratios and pass/fail only — never a pool, a wallet, an amount or a share. */
import { initLock, readJ, writeJ } from './lock.mjs';
import { hashOf } from './bridge-links.mjs';
import fs from 'node:fs';
import { D, MIN, SOL_MINT, STABLES, JITO_TIPS, PROGRAMS, PLUMBING, med, q, sum, r2, r4, day, legValue, cpoolPx, txFlags, classify, CLASS_NAME,
  episodes, bestArb, bookArb, splitSell, sellCpool, qDec, cDec } from './arb-core.mjs';

const OUT='deck-r7k4x9', SLUG=process.env.PROFILE||'main', DAYS=+process.env.DAYS||28, START=Date.now(), BUDGET=(+process.env.BUDGET_MIN||50)*60e3;
const CACHE_DIR=process.env.CACHE_DIR||'.arbcache', CACHE=CACHE_DIR+'/arb-cache-'+SLUG+'.json', FILE='arb-'+SLUG+'.json';
const CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg', CLMMP='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const over=(slack=0)=>Date.now()-START>BUDGET-slack;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt,tries=3,ms=25000){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{...opt,headers:{'user-agent':'k-telemetry',...(opt?.headers||{})},signal:AbortSignal.timeout(ms)}); if(r.ok) return await r.json(); if(r.status===429) await sleep(3000*(k+1)); }catch(e){} await sleep(700*(k+1)); } return null; }
async function mapLimit(arr,k,fn){ let i=0; await Promise.all(Array.from({length:Math.min(k,arr.length)},async()=>{ while(i<arr.length&&!over(4*60e3)){ const n=i++; await fn(arr[n],n); } })); }

if(!String(process.env.DECK_PASSPHRASE||'').trim()){ console.log('DECK_PASSPHRASE is not set: nothing done'); process.exit(1); }
initLock(OUT);
const rd=f=>{ try{ return readJ(f); }catch(e){ return null; } };
const data=rd(OUT+'/data-'+SLUG+'.json'), census=rd(OUT+'/pools-'+SLUG+'.json'), replay=rd(OUT+'/pools-replay-'+SLUG+'.json'), cfg=rd(OUT+'/config.json')||{}, bc=rd(OUT+'/blockcache.json')||{};
if(!data||!census){ console.log('the relay’s data or the census could not be read: nothing done'); process.exit(1); }
const prof=(cfg.profiles||[]).find(p=>p.slug===SLUG)||(cfg.profiles||[])[0]||{};
const WAL=new Set((prof.wallets||[]).filter(w=>w.chain==='solana').map(w=>String(w.address)));
const NOW=Date.now(), FROM=Math.floor((NOW-DAYS*D)/D)*D;   // whole UTC days
const stats={pools:0, sigsNew:0, txRead:0, txFail:0, txKept:0, swaps:0, mkt:{sol:0,cpool:0}, notes:[]};

/* ---------- Solana ---------- */
const KEYED=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean);
const SRPC=[...KEYED,'https://api.mainnet-beta.solana.com'];
async function srpc(method,params){
  for(const u of SRPC){ for(let k=0;k<5;k++){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,30000);
      if(r&&r.result!==undefined&&!r.error) return r.result;
      const msg=String(r?.error?.message||''); if(r&&!/too many|rate|429|busy/i.test(msg)) break;
      await sleep(800*2**k); } }
  return undefined; }
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let n=BigInt('0x'+(Buffer.from(buf).toString('hex')||'0')), s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of buf){ if(x===0) s='1'+s; else break; } return s; };
const u128=(b,o)=>{ let v=0n; for(let i=15;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const u64=(b,o)=>{ let v=0n; for(let i=7;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const EV_SWAP='40c6cde8260871e2';
/* a Raydium CLMM pool's own account: its two mints and their decimals */
async function poolMeta(id){
  const r=await srpc('getAccountInfo',[id,{encoding:'base64'}]); const b=r&&r.value&&Array.isArray(r.value.data)?Buffer.from(r.value.data[0],'base64'):null;
  if(!b||b.length<273||String(r.value.owner)!==CLMMP) return null;
  const m0=b58(b.subarray(73,105)), m1=b58(b.subarray(105,137)), d0=b[233], d1=b[234];
  if(d0>18||d1>18||(m0!==CPOOL&&m1!==CPOOL)) return null;
  return {m0, m1, d0, d1, c0:m0===CPOOL, quote:m0===CPOOL?m1:m0}; }
/* one transaction, kept small: its swap legs (any CLMM pool), who paid and signed, the programs it called,
   the tip it paid block builders, and what its trading parties' balances did */
function recOf(tx){
  const msg=tx?.transaction?.message, meta=tx?.meta; if(!msg||!meta) return null;
  const keys=[...(msg.accountKeys||[]).map(String), ...(meta.loadedAddresses?.writable||[]), ...(meta.loadedAddresses?.readonly||[])];
  const hdr=msg.header||{}, signers=keys.slice(0,Math.max(1,hdr.numRequiredSignatures||1)), payer=keys[0];
  const legs=[];
  for(const l of meta.logMessages||[]){ if(!l.startsWith('Program data: ')) continue; let b; try{ b=Buffer.from(l.slice(14),'base64'); }catch(e){ continue; }
    if(b.length>=205&&b.subarray(0,8).toString('hex')===EV_SWAP)
      legs.push({pl:b58(b.subarray(8,40)), sd:b58(b.subarray(40,72)), a0:String(u64(b,136)), a1:String(u64(b,152)), z:b[168]===1?1:0, sp:String(u128(b,169)), L:String(u128(b,185))}); }
  const pg=[...new Set((msg.instructions||[]).map(ix=>keys[ix.programIdIndex]).filter(p=>p&&!PLUMBING.has(p)))];
  let tip=0; keys.forEach((k,i)=>{ if(JITO_TIPS.has(k)&&meta.postBalances[i]!=null&&meta.preBalances[i]!=null) tip+=meta.postBalances[i]-meta.preBalances[i]; });
  const pools=new Set(legs.map(x=>x.pl)), O=new Set([...signers, ...legs.map(x=>x.sd)].filter(a=>a&&!pools.has(a)));
  const d={}; const add=(arr,sg)=>{ for(const t of arr||[]){ if(!O.has(String(t.owner))) continue; const a=Number(t.uiTokenAmount?.amount||0)/10**(t.uiTokenAmount?.decimals||0); d[t.mint]=(d[t.mint]||0)+sg*a; } };
  add(meta.preTokenBalances,-1); add(meta.postTokenBalances,1);
  for(const k of Object.keys(d)) if(Math.abs(d[k])<1e-12) delete d[k];
  let sol=0; signers.forEach((k,i)=>{ if(meta.postBalances[i]!=null) sol+=(meta.postBalances[i]-meta.preBalances[i])/1e9; });
  return {t:(tx.blockTime||0)*1000, sl:tx.slot||0, p:payer, pg, fee:meta.fee||0, tip, legs, d, sol, err:meta.err?1:0}; }
async function sigsOf(addr, untilSig, beforeSig, sinceMs){
  const out=[]; let before=beforeSig||null;
  for(let n=0;n<300;n++){ if(over(6*60e3)) return {sigs:out, partial:true};
    const s=await srpc('getSignaturesForAddress',[addr,{limit:1000,...(before?{before}:{}),...(untilSig?{until:untilSig}:{})}]);
    if(!Array.isArray(s)) return {sigs:out, partial:true};
    for(const x of s){ if(sinceMs&&x.blockTime&&x.blockTime*1000<sinceMs) return {sigs:out, partial:false, reached:true}; out.push(x); }
    if(s.length<1000) return {sigs:out, partial:false, reached:true}; before=s[s.length-1].signature; }
  return {sigs:out, partial:true}; }

/* ---------- the market, minute by minute ---------- */
async function marketMinutes(cache){
  /* each source is read once over the window: a watermark at each end (lo, hi) says how far it has been read,
     so a minute an exchange has no trade in is not asked for again */
  const M=cache.mkt=cache.mkt||{}; M.sol=M.sol||{}; M.src=M.src||{mexc:{}, kucoin:{}, bitget:{}}; M.w=M.w||{};
  const spans=k=>{ const w=M.w[k]||{}, out=[]; if(!(w.lo<=FROM)) out.push([FROM, w.lo||NOW-2*MIN]); if(w.hi) out.push([w.hi, NOW-2*MIN]); return out.filter(([a,b])=>b>a); };
  const mark=(k,a,b)=>{ const w=M.w[k]||(M.w[k]={}); w.lo=Math.min(w.lo??a,a); w.hi=Math.max(w.hi??b,b); };
  const walk=async(k,size,ask)=>{ for(const [a0,b0] of spans(k)){ for(let a=a0;a<b0;a+=size*MIN){ if(over(8*60e3)) return; const b=Math.min(b0,a+size*MIN); if(await ask(a,b)) mark(k,a,b); else return; } } };
  await walk('sol',300,async(a,b)=>{ const r=await j('https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60&start='+new Date(a).toISOString()+'&end='+new Date(b-MIN).toISOString(),{},3,20000);
    if(!Array.isArray(r)) return false; for(const c of r){ M.sol[c[0]*1000]=+c[4]; stats.mkt.sol++; } await sleep(140); return true; });
  await walk('mexc',1000,async(a,b)=>{ const r=await j('https://api.mexc.com/api/v3/klines?symbol=CPOOLUSDT&interval=1m&startTime='+a+'&endTime='+(b-1)+'&limit=1000',{},3,20000);
    if(!Array.isArray(r)) return false; for(const c of r){ M.src.mexc[c[0]]=+c[4]; stats.mkt.cpool++; } await sleep(120); return true; });
  await walk('kucoin',1500,async(a,b)=>{ const r=await j('https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=CPOOL-USDT&startAt='+Math.floor(a/1000)+'&endAt='+Math.floor((b-1)/1000),{},3,20000);
    if(!(r&&Array.isArray(r.data))) return false; for(const c of r.data){ M.src.kucoin[c[0]*1000]=+c[2]; stats.mkt.cpool++; } await sleep(150); return true; });
  await walk('bitget',200,async(a,b)=>{ const r=await j('https://api.bitget.com/api/v2/spot/market/history-candles?symbol=CPOOLUSDT&granularity=1min&endTime='+b+'&limit=200',{},3,20000);
    if(!(r&&Array.isArray(r.data))) return false; for(const c of r.data){ const t=+c[0]; if(t>=a&&t<b){ M.src.bitget[t]=+c[4]; stats.mkt.cpool++; } } await sleep(90); return true; });
  for(const o of [M.sol, M.src.mexc, M.src.kucoin, M.src.bitget]) for(const k of Object.keys(o)) if(+k<FROM-D) delete o[k];
  for(const w of Object.values(M.w)) if(w.lo<FROM-D) w.lo=FROM-D;
}
/* a price at a moment: the minute's close, or the last one within ten minutes before it */
function pxAt(o,t){ const m=Math.floor(t/MIN)*MIN; for(let k=0;k<=10;k++){ const v=o[m-k*MIN]; if(v>0) return v; } return null; }
function cpoolAt(M,t){ const v=['mexc','kucoin','bitget'].map(s=>pxAt(M.src[s],t)).filter(x=>x>0); return v.length?med(v):null; }

/* ---------- run: read ---------- */
let cache=rd(CACHE); if(!cache||cache.v!==1||cache.slug!==SLUG) cache={v:1, slug:SLUG, pools:{}, tx:{}, mkt:null};
const censusT=(census.tokens||[]).find(t=>t.key==='cpool')||{pools:[]};
const ids=new Map();
for(const P of censusT.pools) if(P.mine&&P.venue==='Raydium CLMM') ids.set(P.id,{name:P.name, fee:P.fee, lpCut:P.lpCut??0.84, past:false});
for(const R of replay?.pools||[]) if(R.mine&&!/^0x/i.test(String(R.id))&&!ids.has(R.id)&&R.venue==='Raydium CLMM'){
  const last=Object.keys(R.days||{}).sort().pop(); if(last&&Date.parse(last)>=FROM) ids.set(R.id,{name:R.name, fee:R.fee, lpCut:R.lpCut??0.84, past:true}); }
const POOLS=new Map();
for(const [id,x] of ids){ const m=cache.pools[id]?.meta||await poolMeta(id); if(!m||x.fee==null){ stats.notes.push('a pool could not be read'); continue; }
  const qk=m.quote===SOL_MINT?'SOL':STABLES.has(m.quote)?'USD':null; if(!qk){ stats.notes.push('a pool quoted in a token the study cannot price is left out'); continue; }
  POOLS.set(id,{id, ...x, ...m, qk}); cache.pools[id]={...(cache.pools[id]||{}), meta:m}; }
stats.pools=POOLS.size;
/* signatures: newer than the last run's newest, then older ones back to the first day */
const need=new Set((cache.retry||[]).filter(s=>!cache.tx[s]));   // what the last run listed but could not read
for(const [id] of POOLS){ const c=cache.pools[id];
  const nw=await sigsOf(id, c.newest||null, null, FROM); stats.sigsNew+=nw.sigs.length;
  for(const x of nw.sigs) if(!cache.tx[x.signature]&&!x.err) need.add(x.signature);
  /* A listing is contiguous from the newest down. A first listing that ran out of time still leaves both ends
     known (the rest is read back from its oldest next run); a later one that did not reach the last run's newest
     leaves a hole, so the newest is not moved and the next run lists that stretch again. */
  if(nw.sigs.length&&(!nw.partial||!c.newest)){ const first=!c.newest; c.newest=nw.sigs[0].signature;
    if(first){ c.oldest=nw.sigs[nw.sigs.length-1].signature; c.oldestT=(nw.sigs[nw.sigs.length-1].blockTime||0)*1000; if(nw.reached) c.complete=true; } }
  if(!nw.sigs.length&&!c.newest&&nw.reached) c.complete=true;
  if(!c.complete&&c.oldest&&!over(10*60e3)){ const ol=await sigsOf(id, null, c.oldest, FROM); stats.sigsNew+=ol.sigs.length;
    for(const x of ol.sigs) if(!cache.tx[x.signature]&&!x.err) need.add(x.signature);
    if(ol.sigs.length){ c.oldest=ol.sigs[ol.sigs.length-1].signature; c.oldestT=(ol.sigs[ol.sigs.length-1].blockTime||0)*1000; } if(ol.reached) c.complete=true; } }
const needL=[...need];
await mapLimit(needL, KEYED.length?6:2, async sig=>{ const tx=await srpc('getTransaction',[sig,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
  if(!tx){ stats.txFail++; return; } const r=recOf(tx); if(!r){ stats.txFail++; return; } stats.txRead++; cache.tx[sig]=r; });
// a transaction that could not be read is asked for again next run: the pools' cursors stay where the reads reached
for(const s of Object.keys(cache.tx)) if(cache.tx[s].t<FROM-D) delete cache.tx[s];
cache.retry=needL.filter(s=>!cache.tx[s]).slice(0,20000);
await marketMinutes(cache);
fs.mkdirSync(CACHE_DIR,{recursive:true}); writeJ(CACHE, cache);
const missing=needL.filter(s=>!cache.tx[s]).length;

/* ---------- analysis ---------- */
const M=cache.mkt, solAt=t=>pxAt(M.sol,t), cpAt=t=>cpoolAt(M,t);
const quoteUsd=(P,t)=>P.qk==='USD'?1:solAt(t);
const mOf=(P,t)=>({cpool:cpAt(t), quote:quoteUsd(P,t)});
/* your share of a pool's LP fees on a day: the swap replay's (weighted by trade), else the relay's share at
   the price that day, else the pool's own median of the days known */
const repBy=new Map((replay?.pools||[]).map(R=>[R.id,R])), cenBy=new Map((census.mine||[]).map(Mn=>[Mn.id,Mn]));
const shareMemo=new Map();
function shareOf(id,d){ const k=id+'|'+d; if(shareMemo.has(k)) return shareMemo.get(k);
  let s=repBy.get(id)?.days?.[d]?.s; if(s==null){ const x=cenBy.get(id)?.share?.[d]; if(x&&x.s!=null) s=x.s; }
  if(s==null){ const all=[...Object.values(repBy.get(id)?.days||{}).map(x=>x.s), ...Object.values(cenBy.get(id)?.share||{}).map(x=>x.s)]; s=med(all)??0; }
  s=Math.max(0,Math.min(1,s)); shareMemo.set(k,s); return s; }
const bridgeParties=new Set(); for(const c of Object.values(bc?.bridgeLinks?.[SLUG]?.cx||{})) for(const h of c?.ps||[]) bridgeParties.add(h);
const usdOf=(mint,amt,t)=>mint===SOL_MINT?amt*solAt(t):mint===CPOOL?amt*cpAt(t):STABLES.has(mint)?amt:null;

const recs=Object.entries(cache.tx).map(([sig,r])=>({sig,...r})).filter(r=>!r.err&&r.t>=FROM&&r.legs.some(l=>POOLS.has(l.pl))).sort((a,b)=>a.t-b.t||a.sl-b.sl);
const st=new Map();   // each pool's state after its last swap: {sp, L, t}
const trades=[], ownSnaps=new Map();
for(const r of recs){
  const t=r.t, d=day(t), sU=solAt(t), cU=cpAt(t);
  if(!(sU>0&&cU>0)) continue;
  // the state of every pool of yours just before this transaction, for your own trades (selling smarter)
  if(WAL.has(r.p)||r.legs.some(l=>WAL.has(l.sd))) ownSnaps.set(r.sig, new Map([...st].map(([k,v])=>[k,{...v}])));
  const legs=[];
  for(const l of r.legs){ const P=POOLS.get(l.pl); if(!P) continue;
    const pre=st.get(P.id), sp=Number(BigInt(l.sp))/2**64, L=Number(BigInt(l.L));
    const v=legValue(P,{zfo:!!l.z, a0:Number(l.a0), a1:Number(l.a1)},mOf(P,t)); st.set(P.id,{sp, L, t});
    if(!v) continue;
    const cpIn=!!l.z===P.c0, cpAmt=(cpIn?-1:1)*Number(cpIn?(l.z?l.a0:l.a1):(l.z?l.a1:l.a0))/10**cDec(P);
    const s=shareOf(P.id,d), pxPre=pre?cpoolPx(P,pre.sp)*quoteUsd(P,t):null, pxPost=cpoolPx(P,sp)*quoteUsd(P,t);
    legs.push({pool:P.id, side:cpIn?'sell':'buy', cpoolAmt:cpAmt, usd:v.vin, fees:v.fees, lps:v.lps, prot:v.prot, trader:v.trader, s, uFee:s*v.fees, uLp:s*v.lps,
      gapPre:pxPre?Math.log(pxPre/cU):null, gapPost:Math.log(pxPost/cU), dtPrev:pre?(t-pre.t)/1000:null}); stats.swaps++; }
  if(!legs.length) continue;
  // the trader's result: its balances, valued at the minute (a token the study cannot price leaves it unknown)
  let pnl=r.sol*sU, ok=true; for(const [mint,a] of Object.entries(r.d)){ if(mint===SOL_MINT){ pnl+=a*sU; continue; } const u=usdOf(mint,a,t); if(u==null){ if(Math.abs(a)>0) ok=false; continue; } pnl+=u; }
  const fl=txFlags({legs, d:r.d}, CPOOL);
  trades.push({id:r.sig, t, sl:r.sl, a:r.p, you:WAL.has(r.p)||r.legs.some(l=>WAL.has(l.sd)), legs, pnl:ok?pnl:null, cost:(r.fee+Math.max(0,r.tip))/1e9*sU, tip:Math.max(0,r.tip)/1e9,
    atomic:fl.atomic, jito:fl.jito, pg:r.pg.map(p=>PROGRAMS[p]||'own program'),
    // a round trip between two of your own pools: both sides of it are you as LP
    ownPair:fl.atomic&&legs.length>=2&&new Set(legs.map(l=>l.pool)).size>=2&&legs.some(l=>l.side==='buy')&&legs.some(l=>l.side==='sell')});
}
const tradeBy=new Map(trades.map(x=>[x.id,x]));
/* traders and their classes */
const TR=new Map();
for(const x of trades){ const a=TR.get(x.a)||{a:x.a, n:0, legsN:0, toward:0, atomic:0, jito:0, buy:0, sell:0, you:false, bridge:false, usd:0, pnl:0, pnlN:0, uFee:0, uLp:0, t0:x.t, t1:x.t, pg:{}, tips:[], sizes:[], gaps:[], dts:[], wins:0};
  a.n++; if(x.atomic) a.atomic++; if(x.jito) a.jito++; a.you=a.you||x.you; a.t1=x.t;
  for(const l of x.legs){ l.side==='buy'?a.buy++:a.sell++; a.usd+=l.usd; a.uFee+=l.uFee; a.uLp+=l.uLp; if(l.dtPrev!=null) a.dts.push(l.dtPrev);
    if(l.gapPre!=null){ a.gaps.push(Math.abs(l.gapPre)); a.legsN++; if(Math.abs(l.gapPost)<Math.abs(l.gapPre)-0.002) a.toward++; } }
  if(x.pnl!=null){ a.pnl+=x.pnl; a.pnlN++; if(x.pnl>0) a.wins++; } a.sizes.push(sum(x.legs.map(l=>l.usd))); if(x.tip) a.tips.push(x.tip);
  for(const p of x.pg) a.pg[p]=(a.pg[p]||0)+1; TR.set(x.a,a); }
for(const a of TR.values()){ a.bridge=bridgeParties.has(hashOf(a.a)); a.gapMed=med(a.gaps); a.cls=classify(a); }
for(const x of trades) x.cls=TR.get(x.a).cls;
const BOT=new Set(['atomic','market']);

/* ---------- pools, classes, days ---------- */
const mine=[...POOLS.values()];
const poolOut=mine.map(P=>{ const ls=trades.flatMap(x=>x.legs.filter(l=>l.pool===P.id).map(l=>({...l, cls:x.cls})));
  const by={}; for(const l of ls){ const b=by[l.cls]||(by[l.cls]={n:0, usd:0, fees:0, uFee:0, uLp:0}); b.n++; b.usd+=l.usd; b.fees+=l.fees; b.uFee+=l.uFee; b.uLp+=l.uLp; }
  for(const b of Object.values(by)) for(const k of ['usd','fees','uFee','uLp']) b[k]=r2(b[k]);
  return {id:P.id, name:P.name, fee:P.fee, quote:P.qk, past:P.past, swaps:ls.length, usd:r2(sum(ls.map(l=>l.usd))), fees:r2(sum(ls.map(l=>l.fees))), uFee:r2(sum(ls.map(l=>l.uFee))), uLp:r2(sum(ls.map(l=>l.uLp))), by,
    read:{complete:!!cache.pools[P.id]?.complete, oldest:cache.pools[P.id]?.oldestT||null}}; });
const classes={}; for(const x of trades) for(const l of x.legs){ const c=classes[x.cls]||(classes[x.cls]={n:0, traders:new Set(), usd:0, fees:0, uFee:0, uLp:0, pnl:0}); c.n++; c.traders.add(x.a); c.usd+=l.usd; c.fees+=l.fees; c.uFee+=l.uFee; c.uLp+=l.uLp; }
for(const x of trades) if(x.pnl!=null) classes[x.cls].pnl+=x.pnl;
for(const [k,c] of Object.entries(classes)) classes[k]={name:CLASS_NAME[k], n:c.n, traders:c.traders.size, usd:r2(c.usd), fees:r2(c.fees), uFee:r2(c.uFee), uLp:r2(c.uLp), pnl:r2(c.pnl)};

/* ---------- gap episodes ---------- */
const TH=[0.01,0.02,0.03,0.05,0.08];
const pairs=[]; for(let i=0;i<mine.length;i++) for(let k=i+1;k<mine.length;k++) pairs.push([mine[i],mine[k]]);
/* the timeline of a pair's gap (dollars, so pools quoted in SOL and in USDC compare), event by event; a pair
   quoted in different tokens also moves with SOL, so every minute is a point too ('market') */
function pairPoints(A,B){
  const pts=[], sA=new Map(), cross=A.qk!==B.qk;
  const evs=trades.filter(x=>x.legs.some(l=>l.pool===A.id||l.pool===B.id));
  const ev=[]; for(const x of evs) ev.push({t:x.t, x}); if(cross) for(let t=FROM;t<NOW;t+=5*MIN) ev.push({t, x:null});
  ev.sort((a,b)=>a.t-b.t);
  const cur={};
  // the pool states after each event come from the swap records themselves: price and liquidity
  for(const e of ev){ if(e.x){ const r=cache.tx[e.x.id]; for(const l of r.legs) if(l.pl===A.id||l.pl===B.id) cur[l.pl]={sp:Number(BigInt(l.sp))/2**64, L:Number(BigInt(l.L))}; }
    if(!cur[A.id]||!cur[B.id]) continue; const s=solAt(e.t); if(!(s>0)) continue;
    const pa=cpoolPx(A,cur[A.id].sp)*(A.qk==='SOL'?s:1), pb=cpoolPx(B,cur[B.id].sp)*(B.qk==='SOL'?s:1); if(!(pa>0&&pb>0)) continue;
    pts.push({t:e.t, g:Math.log(pa/pb), by:e.x?e.x.id:'market', stA:{...cur[A.id]}, stB:{...cur[B.id]}}); }
  return pts; }
function marketPoints(P){
  const pts=[], ev=trades.filter(x=>x.legs.some(l=>l.pool===P.id)).map(x=>({t:x.t,x})); for(let t=FROM;t<NOW;t+=5*MIN) ev.push({t,x:null}); ev.sort((a,b)=>a.t-b.t);
  let sp=null; for(const e of ev){ if(e.x){ const r=cache.tx[e.x.id]; for(const l of r.legs) if(l.pl===P.id) sp=Number(BigInt(l.sp))/2**64; }
    if(sp==null) continue; const c=cpAt(e.t), q_=quoteUsd(P,e.t); if(!(c>0&&q_>0)) continue;
    pts.push({t:e.t, g:Math.log(cpoolPx(P,sp)*q_/c), by:e.x?e.x.id:'market'}); }
  return pts; }
const who=id=>{ if(id==='market') return {cls:'market move'}; const x=tradeBy.get(id); return x?{cls:x.cls, a:x.a}:{cls:'?'}; };
function epiOut(eps, inPools){
  return eps.map(e=>{ const bots=[...new Set(e.ids)].map(i=>tradeBy.get(i)).filter(x=>x&&BOT.has(x.cls));
    const take=sum(bots.map(x=>x.pnl??0)), cost=sum(bots.flatMap(x=>x.legs.filter(l=>inPools.has(l.pool)).map(l=>l.uLp)));
    return {t0:e.t0, t1:e.t1, peak:r4(e.peak), open:who(e.open), close:e.close?who(e.close):null, dur:e.t1?Math.round((e.t1-e.t0)/1000):null, bots:bots.length, take:r2(take), cost:r2(cost), ids:e.ids}; }); }
function epiSummary(all){
  const op={}, cl={}; for(const e of all){ op[e.open.cls]=(op[e.open.cls]||0)+1; if(e.close) cl[e.close.cls]=(cl[e.close.cls]||0)+1; }
  return {n:all.length, dur:med(all.map(e=>e.dur)), peak:r4(med(all.map(e=>e.peak))), open:op, close:cl, take:r2(sum(all.map(e=>e.take))), cost:r2(sum(all.map(e=>e.cost))), open_by_you:all.filter(e=>e.open.cls==='you').length}; }
const pairEp=pairs.map(([A,B])=>{ const pts=pairPoints(A,B), ps=new Set([A.id,B.id]);
  const by={}; for(const th of TH) by[th]=epiOut(episodes(pts,th), ps);
  return {A, B, pts, by}; });
const mktEp=mine.map(P=>{ const pts=marketPoints(P), ps=new Set([P.id]); const by={}; for(const th of TH) by[th]=epiOut(episodes(pts,th), ps); return {P, by}; });
const keepEp=(list,n)=>list.slice().sort((a,b)=>(a.cost)-(b.cost)||b.peak-a.peak).slice(0,n).map(({ids,...e})=>e);

/* ---------- the bots, profiled: what sets them off and what they make ---------- */
const bots=[...TR.values()].filter(a=>BOT.has(a.cls)&&a.n>=2).sort((a,b)=>b.pnl-a.pnl).slice(0,8).map(a=>{
  const hrs={}; for(const x of trades.filter(x=>x.a===a.a)){ const h=+new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Budapest',hour:'2-digit',hour12:false}).format(x.t)%24; hrs[h]=(hrs[h]||0)+1; }
  const topH=Object.entries(hrs).sort((x,y)=>y[1]-x[1]).slice(0,3).map(([h,n])=>({h:+h,n}));
  const pgs=Object.entries(a.pg).sort((x,y)=>y[1]-x[1]).slice(0,3).map(([p,n])=>({p, n}));
  return {a:a.a, cls:a.cls, n:a.n, days:Math.max(1,Math.round((a.t1-a.t0)/D)), pnl:r2(a.pnl), pnlN:a.pnlN, per:r2(a.pnlN?a.pnl/a.pnlN:null), win:r4(a.pnlN?a.wins/a.pnlN:null),
    size:r2(med(a.sizes)), gap:r4(med(a.gaps)), gap90:r4(q(a.gaps,0.9)), dt:r2(med(a.dts)), tip:a.tips.length?+med(a.tips).toPrecision(3):0, jito:r4(a.jito/a.n), atomic:r4(a.atomic/a.n),
    uFee:r2(a.uFee), uLp:r2(a.uLp), toward:r4(a.legsN?a.toward/a.legsN:null), hours:topH, pg:pgs}; });

/* ---------- the what-ifs ---------- */
const W=[1,0.7,0.4], TXC=[0.00005,0.0003,0.001], CX=[0.0025,0.005,0.01];
const solMed=med(Object.values(M.sol))||150;
/* 1 · do what the bots did: their trades in your pools, made by us. What a replaced trade gains is what
   its bot made, give or take the difference in costs (arb-core's identity); a trade that was not atomic
   leaves us holding CPOOL or SOL to be turned back at some cost (cx, on its size). */
function mimic(sel, w, txSol, cx){ let g=0, n=0, notional=0;
  for(const x of trades){ if(!sel(x)||x.pnl==null) continue; n++; const our=txSol*solMed, size=sum(x.legs.map(l=>l.usd));
    g+=x.pnl+x.cost-our-(x.atomic?0:cx*size); notional+=size; }
  return {n:Math.round(n*w), gain:r2(g*w), notional:r2(notional*w)}; }
const mimicSets=[
  ['own-pair','bots trading one of your pools against another', x=>x.cls==='atomic'&&x.ownPair],
  ['atomic-other','atomic bots trading your pools against other venues', x=>x.cls==='atomic'&&!x.ownPair],
  ['market','market-making bots in your pools', x=>x.cls==='market']];
if(bots[0]) mimicSets.push(['best','the most profitable bot alone ('+bots[0].a.slice(0,4)+'…)', x=>x.a===bots[0].a]);
const sMimic=mimicSets.map(([k,name,sel])=>({k, name, grid:W.map(w=>({w, rows:TXC.map(tx=>({tx, ...mimic(sel,w,tx,CX[1])}))})), cx:CX.map(cx=>({cx, ...mimic(sel,0.7,TXC[1],cx)}))}));
/* 2 · close the gaps between your pools ourselves, as soon as one passes θ. Booked as a counterfactual, event by
   event: the gap is carried forward as it would have stood with our corrections in place (each trade moves it by
   as much as it moved it in history), and whenever it passes θ we correct it there — sized for what it costs us
   (the fee less our share of it) at the pools' real depth, booked at the market — and it falls back to what is
   left. A bot that traded one of these pools against the other is taken as prevented when the gap, so carried,
   stood well short of where that bot actually fired; what its trade cost you is then saved. */
const THS=[0.01,0.015,0.02,0.03,0.05,0.08,0.1];
const spFor=(P,usd,t)=>{ const qp=usd/quoteUsd(P,t), k=10**(P.d0-P.d1); const raw=P.c0?qp/k:1/(qp*k); return raw>0?Math.sqrt(raw):null; };
function selfCorrect(th, w, txSol, only=null){ let n=0, ours=0, saved=0, vol=0, prevented=0; const per={};
  for(const pe of pairEp){ if(only&&pe!==only) continue; const {A,B}=pe, ps=new Set([A.id,B.id]); let gc=null, prevG=null;
    for(const p of pe.pts){ const dg=prevG==null?0:p.g-prevG, gBefore=prevG; prevG=p.g;
      if(gc==null){ gc=p.g; continue; }
      const x=p.by==='market'?null:tradeBy.get(p.by), d=day(p.t);
      if(x&&x.cls==='atomic'&&x.ownPair&&x.legs.every(l=>ps.has(l.pool))&&gBefore!=null&&Math.abs(gc)<Math.abs(gBefore)-0.02){
        const c=sum(x.legs.filter(l=>ps.has(l.pool)).map(l=>l.uLp)); saved+=w*(-c); prevented++; per[d]=(per[d]||0)+w*(-c); continue; }
      gc+=dg; if(Math.abs(gc)<th) continue;
      // the pools as they would stand: A as it was, B priced so the gap is the carried one
      const t=p.t, su=solAt(t), cu=cpAt(t); if(!(su>0&&cu>0)) continue;
      const pa=cpoolPx(A,p.stA.sp)*quoteUsd(A,t), spB=spFor(B,pa*Math.exp(-gc),t); if(!spB||!(p.stA.L>0&&p.stB.L>0)) continue;
      const stA={sp:p.stA.sp, L:p.stA.L}, stB={sp:spB, L:p.stB.L}, sA=shareOf(A.id,d), sB=shareOf(B.id,d);
      const cheapA=gc<0, [X,Y,sX,sY,stX,stY]=cheapA?[A,B,sA,sB,stA,stB]:[B,A,sB,sA,stB,stA];
      const conv=X.qk===Y.qk?null:{rate:quoteUsd(Y,t)/quoteUsd(X,t), cx:0.0005};
      const r=bestArb(X,stX,Y,stY,X.fee*(1-X.lpCut*sX),Y.fee*(1-Y.lpCut*sY),conv); if(!r) continue;
      const b=bookArb(X,Y,r,mOf(X,t),sX,sY,txSol*su,mOf(Y,t)); if(!b) continue;
      ours+=w*b.total; vol+=w*b.notional; n++; per[d]=(per[d]||0)+w*b.total;
      const px=cpoolPx(X,r.spA)*quoteUsd(X,t), py=cpoolPx(Y,r.spB)*quoteUsd(Y,t); gc=cheapA?Math.log(px/py):Math.log(py/px); } }
  return {th, w, tx:txSol, n:Math.round(n*w), prevented:Math.round(prevented*w), gain:r2(ours+saved), ours:r2(ours), saved:r2(saved), vol:r2(vol), per}; }
/* pair by pair: corrections pay only where bots were taking money between those two pools; each pair gets its
   own best threshold, or none */
const sSelf=pairEp.map(pe=>({a:pe.A.id, b:pe.B.id, an:pe.A.name, bn:pe.B.name, af:pe.A.fee, bf:pe.B.fee, cross:pe.A.qk!==pe.B.qk,
  ths:THS.map(th=>({th, grid:W.map(w=>({w, rows:TXC.map(tx=>{ const r=selfCorrect(th,w,tx,pe); delete r.per; return r; })}))}))}));
for(const p of sSelf){ const b=p.ths.map(x=>({th:x.th, g:x.grid[1].rows[1].gain})).sort((x,y)=>y.g-x.g)[0]; p.best=b&&b.g>0?b.th:null; }
/* 3 · sell smarter: each sale of yours put through its pool and any sibling of the same quote, split so both
   end at about the same price; booked at the market both ways (your proceeds and your share of each pool's
   LPs' side). Gaps your own sales opened and what the bots then took are counted beside it. */
function smarterSales(){ let gain=0, n=0, skipped=0, opened=0, opTake=0; const per={};
  for(const pe of pairEp) for(const e of pe.by[0.02]) if(e.open.cls==='you'){ opened++; opTake+=-e.cost; }
  for(const x of trades.filter(x=>x.cls==='you')){ const snap=ownSnaps.get(x.id); const sells=x.legs.filter(l=>l.side==='sell'); if(!snap||!sells.length){ skipped++; continue; }
    const P0=POOLS.get(sells[0].pool), sib=mine.filter(P=>P.qk===P0.qk&&snap.get(P.id)); if(sib.length<2){ skipped++; continue; }
    const t=x.t, d=day(t), m=mOf(P0,t), cpIn=-sum(sells.map(l=>l.cpoolAmt));
    const val=(alloc)=>{ let v=0; for(const [P,amt] of alloc){ if(!(amt>0)) continue; const s0=snap.get(P.id); const raw=amt*10**cDec(P); const r=sellCpool(P,s0,raw,P.fee);
        const leg=legValue(P,{zfo:P.c0, a0:P.c0?raw:r.out, a1:P.c0?r.out:raw},m); if(!leg) return null; v+=leg.trader+shareOf(P.id,d)*leg.lps; } return v; };
    const actual=val(sells.map(l=>[POOLS.get(l.pool),-l.cpoolAmt]));
    const sp=splitSell(sib.map(P=>({...P, qUsd:quoteUsd(P,t)})), sib.map(P=>snap.get(P.id)), cpIn*10**cDec(P0));
    const alt=val(sib.map((P,i)=>[P,sp.used[i]/10**cDec(P)]));
    if(actual==null||alt==null){ skipped++; continue; } const g=alt-actual; gain+=g; n++; per[d]=(per[d]||0)+g; }
  return {n, skipped, gain:r2(gain), opened, opTake:r2(opTake), per}; }
const sSales=smarterSales();
/* 4 · the three together, at a middle setting: corrections at the best threshold (70% won, middle cost),
   smarter sales, and copying the bots the corrections do not already cover (40% won, middle cost) */
const scs=sSelf.map((p,i)=>p.best!=null?selfCorrect(p.best,0.7,TXC[1],pairEp[i]):null).filter(Boolean);
const sc={gain:r2(sum(scs.map(x=>x.gain))), per:{}}; for(const x of scs) for(const [d,v] of Object.entries(x.per)) sc.per[d]=(sc.per[d]||0)+v;
const mOther=mimic(x=>x.cls==='atomic'&&!x.ownPair,0.4,TXC[1],CX[1]), mMkt=mimic(x=>x.cls==='market',0.4,TXC[1],CX[1]);
const combined={pairs:sSelf.map(p=>({an:p.an, bn:p.bn, af:p.af, bf:p.bf, th:p.best})), parts:[{k:'self', name:'closing gaps between your pools, where it pays', gain:sc.gain}, {k:'sales', name:'selling across sibling pools', gain:sSales.gain},
  {k:'other', name:'copying atomic bots elsewhere', gain:mOther.gain}, {k:'market', name:'copying market-making bots', gain:mMkt.gain}]};
combined.total=r2(sum(combined.parts.map(p=>p.gain))); combined.perDay=r2(combined.total/DAYS); combined.perMonth=r2(combined.total/DAYS*30);

/* ---------- day by day: the shadow bot's log ---------- */
const days=[]; for(let t=FROM;t<NOW;t+=D){ const d=day(t), xs=trades.filter(x=>day(x.t)===d), ls=xs.flatMap(x=>x.legs.map(l=>({...l,cls:x.cls})));
  const own2=sum(pairEp.map(pe=>pe.by[0.02].filter(e=>day(e.t0)===d).length)), mk3=sum(mktEp.map(me=>me.by[0.03].filter(e=>day(e.t0)===d).length));
  days.push({d, swaps:ls.length, usd:r2(sum(ls.map(l=>l.usd))), uFee:r2(sum(ls.map(l=>l.uFee))), uLp:r2(sum(ls.map(l=>l.uLp))), botLp:r2(sum(ls.filter(l=>BOT.has(l.cls)).map(l=>l.uLp))),
    take:r2(sum(xs.filter(x=>BOT.has(x.cls)&&x.pnl!=null).map(x=>x.pnl))), gapsOwn:own2, gapsMkt:mk3, save:r2((sc.per[d]||0)+(sSales.per[d]||0)),
    read:[...POOLS.keys()].every(id=>cache.pools[id]?.complete||(cache.pools[id]?.oldestT||Infinity)<=t)?1:0}); }

/* ---------- checks ---------- */
const checks=[];
const C=(st_,t,x)=>checks.push({st:st_, t, x});
const swapsAll=Object.values(cache.tx).filter(r=>r.t>=FROM&&!r.err).length;
C(missing===0?'ok':'look','Transactions read', needL.length+' new this run, '+(needL.length-missing)+' read, '+missing+' left for the next run · '+swapsAll+' kept for the window');
for(const P of mine){ const c=cache.pools[P.id]; C(c?.complete?'ok':'look','Window covered · '+P.name+' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%', c?.complete?'every transaction since '+day(FROM):'read back to '+(c?.oldestT?day(c.oldestT):'—')+' so far'); }
const mk=[]; for(let t=FROM;t<NOW-5*MIN;t+=MIN) mk.push(solAt(t)>0&&cpAt(t)>0);
const cover=mk.filter(Boolean).length/Math.max(1,mk.length); C(cover>=0.97?'ok':'look','Market prices, minute by minute', Math.round(cover*1000)/10+'% of minutes priced (SOL: Coinbase · CPOOL: median of MEXC, KuCoin, Bitget)');
const spreads=[]; for(let t=FROM;t<NOW;t+=60*MIN){ const v=['mexc','kucoin','bitget'].map(s=>pxAt(M.src[s],t)).filter(x=>x>0); if(v.length>=2) spreads.push(Math.max(...v)/Math.min(...v)-1); }
C(med(spreads)!=null&&med(spreads)<0.02?'ok':'look','The three exchanges agree on CPOOL', 'typical spread between them '+(med(spreads)!=null?(med(spreads)*100).toFixed(2)+'%':'—')+' (hourly)');
const pnlOk=trades.filter(x=>x.pnl!=null).length/Math.max(1,trades.length); C(pnlOk>=0.8?'ok':'look','Traders’ results readable', Math.round(pnlOk*100)+'% of trades: the rest hold tokens the study cannot price');
for(const P of mine){ const Pc=censusT.pools.find(p=>p.id===P.id); if(!Pc?.vol) continue; const rs=[];
  for(const dd of days){ const v=Pc.vol[dd.d]; const ours=sum(trades.filter(x=>day(x.t)===dd.d).flatMap(x=>x.legs.filter(l=>l.pool===P.id).map(l=>l.usd))); if(v>50&&ours>0) rs.push(ours/v); }
  const r=med(rs); C(r!=null&&Math.abs(r-1)<=0.25?'ok':r==null?'na':'look','Trading vs the price index · '+P.name+' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%', r==null?'too few days to compare':'chain '+Math.round(r*100)+'% of the index, median of '+rs.length+' day(s)'); }
for(const P of mine){ const Mn=cenBy.get(P.id); if(!Mn?.fees) continue; const rs=[];
  for(const dd of days){ const c=Mn.fees[dd.d]; const ours=sum(trades.filter(x=>day(x.t)===dd.d&&x.cls!=='you').flatMap(x=>x.legs.filter(l=>l.pool===P.id).map(l=>l.uFee))); if(c>0.5&&ours>0) rs.push(ours/c); }
  const r=med(rs); C(r!=null&&Math.abs(r-1)<=0.3?'ok':r==null?'na':'look','Your fees vs your fee counters · '+P.name+' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%', r==null?'too few days to compare':'rebuilt '+Math.round(r*100)+'% of the counters, median of '+rs.length+' day(s)'); }

/* ---------- the report ---------- */
const traders=[...TR.values()].sort((a,b)=>Math.abs(b.uLp)-Math.abs(a.uLp)).slice(0,25).map(a=>({a:a.a, cls:a.cls, n:a.n, buy:a.buy, sell:a.sell, usd:r2(a.usd), pnl:r2(a.pnlN?a.pnl:null), uFee:r2(a.uFee), uLp:r2(a.uLp), atomic:r4(a.atomic/a.n), jito:r4(a.jito/a.n), toward:r4(a.legsN?a.toward/a.legsN:null), t0:a.t0, t1:a.t1}));
const recent=trades.filter(x=>x.t>NOW-2*D).slice(-300).map(x=>({id:x.id, t:x.t, a:x.a, cls:x.cls, pnl:r2(x.pnl), atomic:x.atomic, own:x.ownPair, legs:x.legs.map(l=>({pool:l.pool, side:l.side, usd:r2(l.usd), uFee:r2(l.uFee), uLp:r2(l.uLp), gap:r4(l.gapPre)}))}));
const report={v:1, t:NOW, slug:SLUG, from:FROM, to:NOW, days:DAYS,
  pools:poolOut, classes, traders, bots,
  totals:{swaps:trades.reduce((s,x)=>s+x.legs.length,0), trades:trades.length, traders:TR.size, usd:r2(sum(poolOut.map(p=>p.usd))), uFee:r2(sum(poolOut.map(p=>p.uFee))), uLp:r2(sum(poolOut.map(p=>p.uLp))),
    botLp:r2(sum(trades.filter(x=>BOT.has(x.cls)).flatMap(x=>x.legs.map(l=>l.uLp)))), botFee:r2(sum(trades.filter(x=>BOT.has(x.cls)).flatMap(x=>x.legs.map(l=>l.uFee)))),
    botTake:r2(sum(trades.filter(x=>BOT.has(x.cls)&&x.pnl!=null).map(x=>x.pnl))), youLp:r2(sum(trades.filter(x=>x.cls==='you').flatMap(x=>x.legs.map(l=>l.uLp)))),
    youPnl:r2(sum(trades.filter(x=>x.cls==='you'&&x.pnl!=null).map(x=>x.pnl)))},
  gaps:{th:TH, pairs:pairEp.map(pe=>({a:pe.A.id, b:pe.B.id, an:pe.A.name, bn:pe.B.name, af:pe.A.fee, bf:pe.B.fee, cross:pe.A.qk!==pe.B.qk,
      sum:Object.fromEntries(TH.map(th=>[th,epiSummary(pe.by[th])])), top:keepEp(pe.by[0.02],25)})),
    market:mktEp.map(me=>({p:me.P.id, n:me.P.name, f:me.P.fee, sum:Object.fromEntries(TH.map(th=>[th,epiSummary(me.by[th])])), top:keepEp(me.by[0.03],15)}))},
  scenarios:{mimic:sMimic, self:sSelf, sales:{...sSales, per:undefined}, combined, grid:{w:W, tx:TXC, cx:CX}, solUsd:r2(solMed)},
  daysOut:days, recent, checks, notes:[...new Set(stats.notes)],
  read:{pools:POOLS.size, txWindow:swapsAll, complete:mine.every(P=>cache.pools[P.id]?.complete), missing}};
writeJ(OUT+'/'+FILE, report);

/* ---------- the public log: counts, ratios and pass/fail only ---------- */
const cnt=s=>checks.filter(c=>c.st===s).length;
console.log('arbitrage study over '+DAYS+' days from '+day(FROM)+': '+POOLS.size+' pool(s) · '+stats.sigsNew+' new signature(s) · '+stats.txRead+' transaction(s) read this run, '+missing+' left for the next · '+swapsAll+' kept for the window');
console.log('  window covered: '+(report.read.complete?'yes':'not yet')+' · market minutes priced: '+Math.round(cover*100)+'% · traders\' results readable: '+Math.round(pnlOk*100)+'%');
console.log('  trades in the deck’s pools: '+trades.length+' by '+TR.size+' trader(s) · by class: '+Object.entries(classes).map(([k,c])=>k+' '+c.n).join(', '));
console.log('  gap episodes at 2%: between pools '+sum(pairEp.map(pe=>pe.by[0.02].length))+', against the market (3%) '+sum(mktEp.map(me=>me.by[0.03].length))+' · bots profiled: '+bots.length);
console.log('  what-ifs computed: copy '+sMimic.length+' set(s), correct '+sSelf.length+' pair(s) at '+THS.length+' threshold(s) ('+sSelf.filter(p=>p.best!=null).length+' pair(s) where it pays), sales '+sSales.n+' sale(s) modelled ('+sSales.skipped+' not), combined');
console.log('  checks: '+cnt('ok')+' agree, '+cnt('look')+' to look at, '+cnt('na')+' not comparable');
checks.forEach((c,i)=>console.log('    '+String(i+1).padStart(2)+'. '+(c.st==='ok'?'ok  ':c.st==='look'?'LOOK':'n/a ')+' '+c.t.replace(/ · .*$/,'')));
for(const n of report.notes) console.log('  note: '+n);

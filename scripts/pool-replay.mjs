/* The swap replay: WHY YOUR FEES MOVED back to the first day (FROM, 1 August), rebuilt from the
   chains' own records. Every swap in a pool the deck has been in — Uniswap v3 for LCX, Raydium CLMM
   for CPOOL — carries what went in, the price it left and the liquidity it met. With the deck's own
   positions over time (their ranges and liquidity, from their own deposit and withdrawal records),
   each swap says whether the deck was in range and what share of the liquidity at the price was its
   own, so what part of the fee was its. Summed by day (UTC, like the census): the deck's share of
   what the pool's LPs earned (weighted by fee), its share of the liquidity at the price through the
   day, its time in range, its liquidity, and the other LPs' liquidity at the price.

   Kept incrementally: each run reads only what happened since the last and carries the state (the
   pool's price and liquidity, the deck's positions) forward, from the first day the last run kept.
   FROM given starts there instead (a different day starts over); REBUILD=1 starts over from it.

   Checked against every record the deck already keeps: the positions' own fee counters (per pool,
   per day, since mid-October), the relay's share readings, the fee ledger's month totals per token,
   and the minute recorder's last 24 hours. Written sealed (deck-r7k4x9/pools-replay-<slug>.json).
   The log is public: counts, dates and pass/fail only — never a pool, a position, an amount or a
   share. */
import { initLock, readJ, writeJ, lockToken } from './lock.mjs';

const OUT='deck-r7k4x9', SLUG=process.env.PROFILE||'main';
const FROM_IN=String(process.env.FROM||'').trim();
const REBUILD=process.env.REBUILD==='1', START=Date.now(), BUDGET=(+process.env.BUDGET_MIN||70)*60e3;
const over=()=>Date.now()-START>BUDGET;
const LCXN='0x8cd41041505885ef0ad3858181d66f17be8aae7e', CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg';
const D=864e5;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt,tries=3,ms=25000){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(ms)}); if(r.ok) return await r.json(); if(r.status===429) await sleep(4000); }catch(e){} await sleep(800*(k+1)); } return null; }
const day=ms=>new Date(ms).toISOString().slice(0,10);
const r4=x=>x==null||!isFinite(x)?null:Math.round(x*1e4)/1e4, r2=x=>x==null||!isFinite(x)?null:Math.round(x*100)/100;
const g6=x=>x==null||!isFinite(x)?null:Number(x.toPrecision(6));
async function mapLimit(arr,k,fn){ const out=new Array(arr.length); let i=0; await Promise.all(Array.from({length:Math.min(k,arr.length)},async()=>{ while(i<arr.length&&!over()){ const n=i++; out[n]=await fn(arr[n],n); } })); return out; }

if(!String(process.env.DECK_PASSPHRASE||'').trim()){ console.log('DECK_PASSPHRASE is not set: nothing done'); process.exit(1); }
initLock(OUT);
const rd=f=>{ try{ return readJ(OUT+'/'+f); }catch(e){ return null; } };
const data=rd('data-'+SLUG+'.json'), census=rd('pools-'+SLUG+'.json'), bc=rd('blockcache.json')||{}, daily=rd('daily-'+SLUG+'.json'), fees=rd('fees-'+SLUG+'.json')||{}, cfg=rd('config.json')||{};
if(!data||!census){ console.log('the relay’s data or the census could not be read: nothing done'); process.exit(1); }
let prev=REBUILD?null:rd('pools-replay-'+SLUG+'.json'); if(prev&&prev.v!==1) prev=null;
const FROM=FROM_IN||prev?.from||'2026-08-01', T0=Date.parse(FROM+'T00:00:00Z');
if(!/^\d{4}-\d\d-\d\d$/.test(FROM)||!isFinite(T0)){ console.log('the first day is not a date (YYYY-MM-DD): nothing done'); process.exit(1); }
if(prev&&prev.from!==FROM) prev=null;
const prof=(cfg.profiles||[]).find(p=>p.slug===SLUG)||(cfg.profiles||[])[0]||{};
const WAL={eth:new Set((prof.wallets||[]).filter(w=>w.chain==='ethereum').map(w=>String(w.address).toLowerCase())),
           sol:new Set((prof.wallets||[]).filter(w=>w.chain==='solana').map(w=>String(w.address)))};
const DAILY=Array.isArray(daily)?daily:[];
const stats={eth:{pools:0,swaps:0,lp:0,mine:0,own:0,chunks:0,refused:0,receipts:0}, sol:{pools:0,txs:0,swaps:0,lp:0,mine:0,own:0,refused:0}, unread:0};

/* ---------- the day books ----------
   Between two records the pool stands still: its tick, its liquidity and the deck's positions. That
   standing is booked by the second, day by day: seconds covered, seconds the deck had liquidity,
   seconds it had liquidity in range, its liquidity, its share of the liquidity at the price (over the
   seconds anyone's liquidity stood there, as the relay reads it: an empty price is no share at all), the
   others' liquidity at the price. A swap books its size (in the pool's first token) and the deck's
   share of it: the mean of its share before and after the swap, each counted only where in range. */
const ACC=()=>({n:0,w:0,y:0,o:0,T:0,tA:0,tI:0,Lt:0,St:0,OLt:0,TL:0});
const accOf=(st,d)=>st.raw[d]||(st.raw[d]=ACC());
const sumL=pos=>Object.values(pos).reduce((s,p)=>s+(p.L>0?p.L:0),0);
const inL=(pos,tick)=>tick==null?0:Object.values(pos).reduce((s,p)=>s+(p.L>0&&p.lo!=null&&p.lo<=tick&&tick<p.hi?p.L:0),0);
function standing(st,t1){
  if(st.t==null||!(t1>st.t)){ if(st.t==null) st.t=t1; return; }
  let t=st.t; const Lu=sumL(st.pos), Li=inL(st.pos,st.tick), La=st.L||0;
  while(t<t1){ const e=Math.min(t1,(Math.floor(t/D)+1)*D), dt=(e-t)/1000, a=accOf(st,day(t));
    a.T+=dt; if(Lu>0) a.tA+=dt; if(Li>0) a.tI+=dt; a.Lt+=Lu*dt;
    if(La>0){ a.TL+=dt; a.St+=Math.min(1,Li/La)*dt; a.OLt+=Math.max(0,La-Li)*dt; }
    t=e; }
  st.t=t1; }
function onSwap(st,{t,tick,L,w,own}){
  standing(st,t);
  const pre=st.L>0&&st.tick!=null?Math.min(1,inL(st.pos,st.tick)/st.L):null, post=L>0?Math.min(1,inL(st.pos,tick)/L):0;
  const s=pre==null?post:(pre+post)/2, a=accOf(st,day(t));
  a.n++; a.w+=w; if(own) a.o+=w*s; else a.y+=w*s;
  if(!own&&s>0&&t>Date.now()-26*3600e3) (st.recent=st.recent||[]).push([t,w*s]);
  st.tick=tick; st.L=L; }
function onPool(st,{t,lo,hi,dL,tick,Lafter}){ standing(st,t);
  if(Lafter!=null){ st.L=Lafter; if(tick!=null) st.tick=tick; }
  else if(st.tick!=null&&lo<=st.tick&&st.tick<hi) st.L=Math.max(0,(st.L||0)+dL); }
function onMine(st,{t,k,lo,hi,dL}){ standing(st,t); const p=st.pos[k]||(st.pos[k]={lo:null,hi:null,L:0});
  if(lo!=null&&hi!=null){ p.lo=lo; p.hi=hi; } p.L=Math.max(0,p.L+dL); }
const dayOut=a=>({n:a.n, s:a.w>0?r4(a.y/a.w):null, own:a.w>0&&a.o>0?r4(a.o/a.w):0, st:a.TL>0?r4(a.St/a.TL):null,
  tin:a.tA>0?r4(a.tI/a.tA):null, L:a.T>0?g6(a.Lt/a.T):null, oL:a.T>0?g6(a.OLt/a.T):null, cov:r4(Math.min(1,a.T/86400))});
const newState=()=>({cur:null, t:null, tick:null, L:0, pos:{}, raw:{}, recent:[]});

/* ---------- Ethereum: Uniswap v3 ---------- */
/* Blockscout's own node first: the free public nodes now refuse history (a personal token, a 10,000-block cap,
   or nothing at all), and Blockscout answers both old logs and calls at old blocks. */
const NODES=['https://eth.blockscout.com/api/eth-rpc','https://eth.drpc.org','https://ethereum-rpc.publicnode.com','https://1rpc.io/eth','https://eth.llamarpc.com'];
const BS='https://eth.blockscout.com';
async function rpcRaw(u,method,params,ms=25000){ return j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,ms); }
async function rpcAt(u,method,params,ms=25000){ const r=await rpcRaw(u,method,params,ms); return r&&r.result!==undefined&&!r.error?r.result:undefined; }
/* each node in turn; a revert is the chain's own answer (a position not minted yet, or burned), not a node's failing */
async function erpc(method,params){ for(const u of NODES){ const r=await rpcRaw(u,method,params);
    if(r&&r.result!==undefined&&r.result!==null&&!r.error) return r.result; if(r&&r.error&&/revert/i.test(String(r.error.message||''))) return null; } return undefined; }
const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88', FACT='0x1f98431c8ad98523631ae4a59f267346ea31f984';
const TOP={swap:'0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', mint:'0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde',
  burn:'0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c', inc:'0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f',
  dec:'0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4'};
const word=(d,i)=>d.slice(2+64*i,2+64*(i+1)), pad32=h=>String(h).replace(/^0x/,'').padStart(64,'0'), bn=h=>parseInt(h,16);
const sInt=(h,bits=256)=>{ let v=BigInt('0x'+h); if(bits<256) v&=(1n<<BigInt(bits))-1n; if(v>=(1n<<BigInt(bits-1))) v-=1n<<BigInt(bits); return v; };
const i24=h=>Number(sInt(h.slice(-6),24));
const tsCache=new Map();
async function blockTs(b){ if(tsCache.has(b)) return tsCache.get(b); const x=await erpc('eth_getBlockByNumber',['0x'+b.toString(16),false]); const t=x?bn(x.timestamp)*1000:null; if(t) tsCache.set(b,t); return t; }
async function blockAt(ms){
  const r=await j(BS+'/api?module=block&action=getblocknobytime&timestamp='+Math.floor(ms/1000)+'&closest=after',{},3,30000);
  if(r?.result?.blockNumber) return +r.result.blockNumber;
  const tip=await erpc('eth_getBlockByNumber',['latest',false]); if(!tip) return null; let b=bn(tip.number), t=bn(tip.timestamp)*1000;
  for(let k=0;k<8&&Math.abs(t-ms)>30e3;k++){ b=Math.max(1,b-Math.round((t-ms)/12000)); const x=await blockTs(b); if(!x) break; t=x; }
  return b; }
/* eth_getLogs, 9,000 blocks at a time, each node asked in turn; whole only if every chunk answered.
   Each chunk's last block is read for its time, so a record without its own time is placed between two. */
async function nodeLogs(filter, from, to){
  const CH=9000, out=[], anchors=[]; let failed=0;
  const t0=await blockTs(from); if(t0) anchors.push([from,t0]);
  for(let a=from; a<=to; a+=CH){ if(over()) return {logs:out, anchors, partial:true};
    const b=Math.min(to,a+CH-1); stats.eth.chunks++; let got;
    for(const u of NODES){ got=await rpcAt(u,'eth_getLogs',[{...filter,fromBlock:'0x'+a.toString(16),toBlock:'0x'+b.toString(16)}],30000); if(Array.isArray(got)) break; }
    if(!Array.isArray(got)){ failed++; stats.eth.refused++; if(failed>=3&&out.length===0&&anchors.length<=1) return {logs:out, anchors, partial:true}; continue; }
    out.push(...got); const tb=await blockTs(b); if(tb) anchors.push([b,tb]); await sleep(60); }
  return {logs:out, anchors, partial:failed>0}; }
/* Blockscout's log query, window by window (25,000 blocks), one kind of record per query; its records carry their time.
   Whole or nothing. */
async function bsLogs(address, topic0, from, to){
  const out=[], seen=new Set();
  for(let w=from; w<=to; w+=25000){ const end=Math.min(to,w+24999); let a=w;
    for(let n=0;n<40;n++){ if(over()) return null;
      const q=new URLSearchParams({module:'logs',action:'getLogs',address,topic0,fromBlock:String(a),toBlock:String(end)});
      const r=await j(BS+'/api?'+q,{},3,60000); const xs=Array.isArray(r?.result)?r.result:null; if(!xs) return null;
      let added=0; for(const l of xs){ const k=l.transactionHash+':'+l.logIndex; if(seen.has(k)) continue; seen.add(k); out.push(l); added++; }
      if(xs.length<1000||!added) break; a=bn(xs[xs.length-1].blockNumber); } }
  return out; }
/* Blockscout's own paged address logs, newest first, every kind of record at once, until the first block is passed */
async function bsPaged(address, kinds, from){
  const out=[]; let next=null;
  for(let n=0;n<2000;n++){ if(over()) return null;
    const r=await j(BS+'/api/v2/addresses/'+address+'/logs'+(next?'?'+new URLSearchParams(next):''),{},3,45000); if(!r||!Array.isArray(r.items)) return null;
    for(const it of r.items){ if((it.block_number||0)<from) return out;
      const t0=(it.topics||[])[0]; if(kinds.includes(t0)) out.push({blockNumber:'0x'+Number(it.block_number).toString(16), logIndex:'0x'+Number(it.index||0).toString(16), transactionHash:it.transaction_hash, topics:(it.topics||[]).filter(x=>x!=null), data:it.data||'0x'}); }
    if(!r.next_page_params) return out; next=r.next_page_params; }
  return null; }
function timeOf(l, anchors){
  if(l.blockTimestamp) return bn(l.blockTimestamp)*1000;
  if(l.timeStamp) return bn(l.timeStamp)*1000;
  const b=bn(l.blockNumber); let lo=null, hi=null; for(const a of anchors){ if(a[0]<=b) lo=a; if(a[0]>=b){ hi=a; break; } }
  if(lo&&hi&&hi[0]>lo[0]) return Math.round(lo[1]+(b-lo[0])*(hi[1]-lo[1])/(hi[0]-lo[0]));
  const a=lo||hi; return a?a[1]+(b-a[0])*12000:null; }
/* the deck's own Ethereum transactions since a block: its swaps through its own pools are not income */
async function ownTxs(fromB){
  const s=new Set(); let ok=0;
  for(const w of WAL.eth){ const r=await j(BS+'/api?module=account&action=txlist&address='+w+'&startblock='+fromB+'&endblock=99999999&sort=asc',{},3,45000);
    if(Array.isArray(r?.result)){ ok++; for(const x of r.result) if(x.hash) s.add(String(x.hash).toLowerCase()); } await sleep(150); }
  return {set:s, ok, of:WAL.eth.size}; }

async function ethSide(out, prevPools){
  const tipHex=await erpc('eth_blockNumber',[]); if(!tipHex){ out.notes.push('eth: no node answered'); return; }
  const tip=bn(tipHex)-3, tipT=await blockTs(tip);
  const T=census.tokens.find(t=>t.key==='lcx'); if(!T) return;
  const v3=T.pools.filter(p=>p.venue==='Uniswap v3').map(p=>String(p.id).toLowerCase());
  // the deck's Ethereum position ids, from every record that names one
  const ids=new Set();
  for(const p of data.eth||[]) if((p.chain||'ethereum')==='ethereum'&&/^\d+$/.test(String(p.id))) ids.add(String(p.id));
  for(const r of DAILY) for(const p of r.ps||[]) if(p.c==='evm'&&(p.k0==='evm:'+LCXN||p.k1==='evm:'+LCXN)&&/^\d+$/.test(String(p.i))) ids.add(String(p.i));
  for(const [k,v] of Object.entries(bc.tscan||{})) if(k.startsWith('ethereum:')) for(const id of v.ids||[]) ids.add(String(id));
  for(const src of [fees.pos||{}, fees.closedPos||{}]) for(const [id,e] of Object.entries(src)) if(/^\d+$/.test(id)&&String(e?.tk||'').toLowerCase()==='ethereum:'+LCXN) ids.add(id);
  const pools=new Map();   // pool → state
  for(const id of v3){ const pv=prevPools.get(id); if(pv&&pv.state) pools.set(id,pv.state); }
  const fresh=v3.filter(id=>!pools.has(id));
  if(fresh.length){
    const fromB=await blockAt(T0); if(!fromB){ out.notes.push('eth: the first block could not be found'); return; }
    // reading a position where it stood on the first day needs a node that keeps state that far back
    const arch=await erpc('eth_call',[{to:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',data:'0x18160ddd'},'0x'+fromB.toString(16)]);
    if(arch===undefined){ out.notes.push('eth: no node answered for the first day’s state; nothing rebuilt'); stats.unread+=fresh.length; return; }
    // the pools' standing at the first block, and every position of the deck's that stood in one
    const t0=await blockTs(fromB);
    const poolOf=new Map(); const gp=async(t0a,t1a,fee)=>{ const k=t0a+t1a+fee; if(poolOf.has(k)) return poolOf.get(k);
      const r=await erpc('eth_call',[{to:FACT,data:'0x1698ee82'+pad32(t0a)+pad32(t1a)+pad32(fee.toString(16))},'latest']); const p=r?('0x'+r.slice(-40)).toLowerCase():null; poolOf.set(k,p); return p; };
    for(const id of fresh){ const s0=await erpc('eth_call',[{to:id,data:'0x3850c7bd'},'0x'+fromB.toString(16)]), lq=await erpc('eth_call',[{to:id,data:'0x1a686502'},'0x'+fromB.toString(16)]);
      // a pool not deployed yet starts empty: its first records set its price and liquidity
      const st=newState(); st.cur=fromB; st.t=t0||T0; st.tick=s0&&s0.length>=130?i24(word(s0,1)):null; st.L=lq&&lq.length>=66?Number(BigInt('0x'+word(lq,0))):0; pools.set(id,st); }
    let probed=0;
    let unanswered=0;
    for(const id of ids){ const r=await erpc('eth_call',[{to:NPM,data:'0x99fbab88'+pad32(BigInt(id).toString(16))},'0x'+fromB.toString(16)]); probed++;
      if(r===undefined){ unanswered++; continue; } if(!r||r.length<2+64*8) continue;
      const a0=('0x'+word(r,2).slice(-40)).toLowerCase(), a1=('0x'+word(r,3).slice(-40)).toLowerCase(); if(a0!==LCXN&&a1!==LCXN) continue;
      const L=BigInt('0x'+word(r,7)); if(L<=0n) continue;
      const pool=await gp(a0,a1,Number(BigInt('0x'+word(r,4)))); const st=pool&&fresh.includes(pool)&&pools.get(pool); if(!st) continue;
      st.pos[id]={lo:i24(word(r,5)), hi:i24(word(r,6)), L:Number(L)}; }
    out.notes.push('eth: '+probed+' position record(s) read at the first block'+(unanswered?', '+unanswered+' not answered':''));
    if(unanswered){ out.notes.push('eth: some positions could not be read where they stood on the first day; nothing rebuilt for Ethereum this run'); for(const id of fresh) pools.delete(id); stats.unread+=fresh.length; }
  }
  if(!pools.size) return;
  const minCur=Math.min(...[...pools.values()].map(s=>s.cur));
  const own=await ownTxs(minCur+1);
  if(own.ok<own.of) out.notes.push('eth: own swaps checked for '+own.ok+' of '+own.of+' wallet(s)');
  for(const [id,st0] of pools){
    if(over()){ stats.unread++; continue; }
    const st=structuredClone(st0); if(!(tip>st.cur)) continue;
    // the public nodes first; where they refuse, Blockscout's windowed query, then its paged address logs — each whole or not at all
    let L=await nodeLogs({address:id, topics:[[TOP.swap,TOP.mint,TOP.burn]]}, st.cur+1, tip);
    if(L.partial&&!over()){ const parts=[]; let whole=true;
      for(const t0 of [TOP.swap,TOP.mint,TOP.burn]){ const x=await bsLogs(id,t0,st.cur+1,tip); if(x===null){ whole=false; break; } parts.push(...x); }
      if(whole){ L={logs:parts, anchors:L.anchors, partial:false}; out.notes.push('eth: a pool read from Blockscout’s windows'); } }
    if(L.partial&&!over()){ const x=await bsPaged(id,[TOP.swap,TOP.mint,TOP.burn],st.cur+1);
      if(x){ const anchors=[...L.anchors]; for(let b=st.cur+1; b<=tip; b+=20000){ const t=await blockTs(b); if(t) anchors.push([b,t]); } const tt=await blockTs(tip); if(tt) anchors.push([tip,tt]);
        anchors.sort((a,b)=>a[0]-b[0]); L={logs:x.filter(l=>bn(l.blockNumber)<=tip), anchors, partial:false}; out.notes.push('eth: a pool read from Blockscout’s pages'); } }
    if(L.partial){ stats.unread++; out.notes.push('eth: a pool’s records were not all served this run; kept as it was'); continue; }
    const logs=L.logs.sort((a,b)=>bn(a.blockNumber)-bn(b.blockNumber)||bn(a.logIndex)-bn(b.logIndex));
    // which of the position manager's deposits and withdrawals were the deck's: the receipt names the position
    const lpTx=[...new Set(logs.filter(l=>l.topics[0]!==TOP.swap&&('0x'+l.topics[1].slice(-40)).toLowerCase()===NPM).map(l=>l.transactionHash))];
    const mineIn=new Map();   // tx → [{id, dL}]
    await mapLimit(lpTx,4,async h=>{ const rc=await erpc('eth_getTransactionReceipt',[h]); stats.eth.receipts++; if(!rc) return;
      const xs=[]; for(const g of rc.logs||[]) if(String(g.address).toLowerCase()===NPM&&(g.topics[0]===TOP.inc||g.topics[0]===TOP.dec)){ const tid=BigInt(g.topics[1]).toString();
        if(ids.has(tid)) xs.push({id:tid, dL:(g.topics[0]===TOP.inc?1:-1)*Number(BigInt('0x'+word(g.data,0)))}); }
      if(xs.length) mineIn.set(h,xs); });
    for(const l of logs){ const t=timeOf(l,L.anchors); if(t==null) continue;
      if(l.topics[0]===TOP.swap){ const d=l.data, a0=sInt(word(d,0)), a1=sInt(word(d,1)), sp=Number(BigInt('0x'+word(d,2)))/2**96, Lq=Number(BigInt('0x'+word(d,3))), tick=i24(word(d,4));
        const P=sp*sp, w=a0>0n?Number(a0):(P>0?Number(a1)/P:0); const ownS=own.set.has(String(l.transactionHash).toLowerCase());
        onSwap(st,{t,tick,L:Lq,w,own:ownS}); stats.eth.swaps++; if(ownS) stats.eth.own++; }
      else { const lo=i24(l.topics[2]), hi=i24(l.topics[3]), amt=Number(BigInt('0x'+word(l.data,l.topics[0]===TOP.mint?1:0))); if(!(amt>0)) continue;
        const sign=l.topics[0]===TOP.mint?1:-1; onPool(st,{t,lo,hi,dL:sign*amt}); stats.eth.lp++;
        const xs=mineIn.get(l.transactionHash); if(xs){ const k=xs.findIndex(x=>Math.sign(x.dL)===sign&&Math.abs(Math.abs(x.dL)-amt)<=amt*1e-9+1);
          if(k>=0){ const x=xs.splice(k,1)[0]; onMine(st,{t,k:x.id,lo,hi,dL:x.dL}); stats.eth.mine++; } } } }
    if(tipT) standing(st,tipT);
    st.cur=tip; st.recent=(st.recent||[]).filter(x=>x[0]>Date.now()-26*3600e3);
    pools.set(id,st); stats.eth.pools++;
  }
  for(const [id,st] of pools){ const P=T.pools.find(p=>String(p.id).toLowerCase()===id); const had=Object.keys(st.pos).length>0;
    out.pools.push({id, tok:'lcx', chain:'eth', venue:'Uniswap v3', name:P?.name||null, fee:P?.fee??null, lpCut:1, mine:had, state:st}); }
}

/* ---------- Solana: Raydium CLMM ---------- */
const KEYED=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean);
const SRPC=[...KEYED,'https://api.mainnet-beta.solana.com'];
/* Solana: the keyed node if there is one, then the public one. The public node turns a busy caller away
   ("too many requests"); that is a pause, not a refusal, so it is asked again after one, two, four,
   eight seconds. */
async function srpc(method,params){
  for(const u of SRPC){ for(let k=0;k<5;k++){ const r=await rpcRaw(u,method,params,30000);
      if(r&&r.result!==undefined&&!r.error) return r.result;
      const msg=String(r?.error?.message||''); if(r&&!/too many|rate|429|busy/i.test(msg)) break;   // a real refusal: the next node
      await sleep(1000*2**k); } }
  return undefined; }
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let n=BigInt('0x'+(Buffer.from(buf).toString('hex')||'0')), s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of buf){ if(x===0) s='1'+s; else break; } return s; };
const u128=(b,o)=>{ let v=0n; for(let i=15;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const u64=(b,o)=>{ let v=0n; for(let i=7;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const EVT={swap:'40c6cde8260871e2', liq:'7ef0afce9e58996b', inc:'314f69d420221e54', dec:'3ade563a44325538', open:'641e57f9c4df9ace'};
function decodeTx(tx){
  const out=[]; const keys=(tx?.transaction?.message?.accountKeys||[]).map(String), hdr=tx?.transaction?.message?.header||{};
  for(const l of tx?.meta?.logMessages||[]){ if(!l.startsWith('Program data: ')) continue; let b; try{ b=Buffer.from(l.slice(14),'base64'); }catch(e){ continue; }
    if(b.length<16) continue; const h=b.subarray(0,8).toString('hex');
    if(h===EVT.swap&&b.length>=205) out.push({k:'swap', pool:b58(b.subarray(8,40)), a0:u64(b,136), a1:u64(b,152), zfo:b[168]===1, sp:u128(b,169), L:u128(b,185), tick:b.readInt32LE(201)});
    else if(h===EVT.liq&&b.length>=84) out.push({k:'liq', pool:b58(b.subarray(8,40)), tick:b.readInt32LE(40), lo:b.readInt32LE(44), hi:b.readInt32LE(48), Lb:u128(b,52), La:u128(b,68)});
    else if(h===EVT.inc&&b.length>=56) out.push({k:'inc', mint:b58(b.subarray(8,40)), dL:u128(b,40)});
    else if(h===EVT.dec&&b.length>=56) out.push({k:'dec', mint:b58(b.subarray(8,40)), dL:u128(b,40)});
    else if(h===EVT.open&&b.length>=128) out.push({k:'open', pool:b58(b.subarray(8,40)), owner:b58(b.subarray(72,104)), lo:b.readInt32LE(104), hi:b.readInt32LE(108), dL:u128(b,112)}); }
  const signers=keys.slice(1,Math.max(1,hdr.numRequiredSignatures||1));
  return {t:(tx?.blockTime||0)*1000, slot:tx?.slot||0, payer:keys[0]||null, signers, ev:out}; }
async function sigsOf(addr, untilSig, sinceMs){
  const out=[]; let before=null;
  for(let n=0;n<400;n++){ if(over()) return {sigs:out, partial:true};
    const s=await srpc('getSignaturesForAddress',[addr,{limit:1000,...(before?{before}:{}),...(untilSig?{until:untilSig}:{})}]);
    if(!Array.isArray(s)) return {sigs:out, partial:true};
    for(const x of s){ if(sinceMs&&x.blockTime&&x.blockTime*1000<sinceMs) return {sigs:out, partial:false}; out.push(x); }
    if(s.length<1000) return {sigs:out, partial:false}; before=s[s.length-1].signature; }
  return {sigs:out, partial:true}; }
/* a position the deck closed before the first day reached it: its range from its own opening record */
async function openRange(mint){
  const s=await sigsOf(mint,null,null); if(!s.sigs.length) return null; const o=s.sigs[s.sigs.length-1];
  const tx=await srpc('getTransaction',[o.signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]); if(!tx) return null;
  const e=decodeTx(tx).ev.find(x=>x.k==='open'); return e?{lo:e.lo,hi:e.hi}:null; }

async function solSide(out, prevPools){
  const T=census.tokens.find(t=>t.key==='cpool'); if(!T) return;
  const clmm=T.pools.filter(p=>p.venue==='Raydium CLMM'&&(p.real||p.mine));
  // the deck's position NFTs, from every record that names one
  const mints=new Set(), alive=new Map();
  for(const p of data.sol||[]) if(p.nftMint&&p.poolId){ mints.add(p.nftMint); alive.set(p.nftMint,{pool:p.poolId, lo:p.tl, hi:p.tu, L:p.liq!=null?Number(BigInt(p.liq)):0}); }
  for(const r of DAILY) for(const p of r.ps||[]) if(p.c==='sol'&&(p.k0==='sol:'+CPOOL||p.k1==='sol:'+CPOOL)&&String(p.i).startsWith('sol:')) mints.add(String(p.i).slice(4));
  for(const k of Object.keys(bc.solHist||{})) if(k.startsWith('sol:')) mints.add(k.slice(4));
  for(const src of [fees.pos||{}, fees.closedPos||{}]) for(const [id,e] of Object.entries(src)) if(id.startsWith('sol:')&&String(e?.tk||'')==='sol:'+CPOOL) mints.add(id.slice(4));
  const dataT=data.t||Date.now();
  for(const P of clmm){
    if(over()){ stats.unread++; continue; }
    const pv=prevPools.get(K(P.id)), st=pv&&pv.state?structuredClone(pv.state):newState(), first=!pv||!pv.state;
    const S=await sigsOf(P.id, first?null:st.cur?.sig, first?T0:null);
    if(S.partial){ stats.unread++; out.notes.push('sol: a pool’s transaction list was not served whole this run; kept as it was'); out.pools.push(pv||{id:P.id}); continue; }
    const sigs=S.sigs.filter(x=>!x.err).reverse();   // oldest first
    const getTx=async x=>{ const tx=await srpc('getTransaction',[x.signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]); return tx?decodeTx(tx):null; };
    // a keyed node takes four at a time; the public one two, with a breath between
    const txs=await mapLimit(sigs,KEYED.length?4:2,async x=>{ const r=await getTx(x); if(!KEYED.length) await sleep(180); return r; });
    // whatever a busy node turned away gets a second, slower pass
    for(let i=0;i<txs.length&&!over();i++) if(!txs[i]){ await sleep(250); txs[i]=await getTx(sigs[i]); }
    const missing=txs.filter(x=>!x).length;
    if(missing){ stats.unread++; stats.sol.refused+=missing; out.notes.push('sol: '+missing+' transaction(s) of a pool not served this run; kept as it was'); out.pools.push(pv||{id:P.id}); continue; }
    stats.sol.txs+=txs.length;
    for(const m of Object.keys(st.pos)) mints.add(m);
    // the deck's own position records in this pool, and any it opened that no record named yet
    for(const x of txs) for(const e of x.ev){ if(e.k==='open'&&e.pool===P.id&&WAL.sol.has(e.owner)){ const m=x.signers.find(s=>mints.has(s))||x.signers.find(s=>s!==x.payer); if(m){ mints.add(m); e.mint=m; } } }
    for(const x of txs){ const opened=new Set(x.ev.filter(e=>e.k==='open'&&e.mint).map(e=>e.mint)); if(opened.size) x.ev=x.ev.filter(e=>!(e.k==='inc'&&opened.has(e.mint))); }
    if(first){
      // where each of the deck's positions stood on the first day: today's liquidity less everything since
      const delta=new Map(); for(const x of txs){ if(x.t>dataT) continue; for(const e of x.ev){ const m=e.mint; if((e.k==='inc'||e.k==='dec')&&mints.has(e.mint)) delta.set(e.mint,(delta.get(e.mint)||0)+(e.k==='inc'?1:-1)*Number(e.dL)); if(e.k==='open'&&m) delta.set(m,(delta.get(m)||0)+Number(e.dL)); } }
      for(const [m,a] of alive) if(a.pool===P.id&&!delta.has(m)) delta.set(m,0);
      for(const [m,dl] of delta){ const a=alive.get(m); if(a&&a.pool!==P.id) continue;
        const L0=Math.max(0,(a?a.L:0)-dl); if(!(L0>0)) continue;
        const rg=a&&a.lo!=null?{lo:a.lo,hi:a.hi}:await openRange(m); if(!rg) continue; st.pos[m]={lo:rg.lo, hi:rg.hi, L:L0}; }
      st.t=T0;
      // the pool stands where its first record finds it, from the first day until then
      for(const x of txs){ const e=x.ev.find(e=>(e.k==='swap'||e.k==='liq')&&e.pool===P.id); if(e){ st.tick=e.tick; st.L=Number(e.k==='swap'?e.L:e.Lb); break; } }
    }
    // the ranges of positions opened inside the window, for when their deposits come
    const ranges=new Map(); for(const x of txs) for(const e of x.ev) if(e.k==='open'&&e.mint) ranges.set(e.mint,{lo:e.lo,hi:e.hi});
    for(const [m,a] of alive) if(a.pool===P.id&&a.lo!=null) ranges.set(m,{lo:a.lo,hi:a.hi});
    // a deposit or withdrawal of a position whose range nothing here gives: from its own opening record
    const need=new Set(); for(const x of txs) for(const e of x.ev) if((e.k==='inc'||e.k==='dec')&&mints.has(e.mint)&&!(st.pos[e.mint]&&st.pos[e.mint].lo!=null)&&!ranges.has(e.mint)) need.add(e.mint);
    for(const m of need){ if(over()) break; const rg=await openRange(m); if(rg) ranges.set(m,rg); }
    let liqSeen=0, liqAgree=0;
    for(const x of txs){ if(!x.t) continue;
      for(const e of x.ev){
        if(e.k==='swap'&&e.pool===P.id){ const sp=Number(e.sp)/2**64, Pz=sp*sp, w=e.zfo?Number(e.a0):(Pz>0?Number(e.a1)/Pz:0), own=WAL.sol.has(x.payer)||x.signers.some(k=>WAL.sol.has(k));
          if(st.tick==null){ st.tick=e.tick; st.L=Number(e.L); }
          onSwap(st,{t:x.t, tick:e.tick, L:Number(e.L), w, own}); stats.sol.swaps++; if(own) stats.sol.own++; }
        else if(e.k==='liq'&&e.pool===P.id){ liqSeen++; if(st.L>0&&Math.abs(Number(e.Lb)-st.L)<=st.L*1e-6+1) liqAgree++; onPool(st,{t:x.t, tick:e.tick, Lafter:Number(e.La)}); stats.sol.lp++; }
        else if((e.k==='inc'||e.k==='dec')&&mints.has(e.mint)){ const rg=st.pos[e.mint]||ranges.get(e.mint)||{};
          onMine(st,{t:x.t, k:e.mint, lo:rg.lo??null, hi:rg.hi??null, dL:(e.k==='inc'?1:-1)*Number(e.dL)}); stats.sol.mine++; }
        else if(e.k==='open'&&e.mint&&e.pool===P.id){ onMine(st,{t:x.t, k:e.mint, lo:e.lo, hi:e.hi, dL:Number(e.dL)}); stats.sol.mine++; } } }
    standing(st, Date.now()-60e3);
    const newest=S.sigs[0]; if(newest) st.cur={sig:newest.signature, slot:newest.slot};
    st.recent=(st.recent||[]).filter(x=>x[0]>Date.now()-26*3600e3);
    st.liqCheck={seen:(st.liqCheck?.seen||0)+liqSeen, agree:(st.liqCheck?.agree||0)+liqAgree};
    stats.sol.pools++;
    out.pools.push({id:P.id, tok:'cpool', chain:'sol', venue:'Raydium CLMM', name:P.name, fee:P.fee??null, lpCut:P.lpCut??0.84, mine:Object.keys(st.pos).length>0, state:st});
  }
}

/* ---------- the checks: the rebuilt figures against every record the deck already keeps ---------- */
function checks(out){
  const C=(tok,st,t,x,k,g,up)=>out.checks.push({tok,grp:'rep',st,t,x,k,g:g!=null?r4(g):null,...(up!=null?{up}:{})});
  const pct=x=>(x*100).toFixed(1)+'%', usd=x=>x==null?'—':'$'+(x>=1e4?(x/1e3).toFixed(1)+'k':x>=100?Math.round(x).toLocaleString('en-US'):x.toFixed(2));
  const lab=R=>(R.name||'pool')+(R.fee!=null?' '+(R.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':'')+' · '+R.venue;
  const usdDay=(R,P,d)=>{ const s=R.days[d]?.s; const v=P?.vol?.[d]; return s!=null&&v!=null&&R.fee!=null?v*R.fee*(R.lpCut??1)*s:null; };
  for(const R of out.pools.filter(p=>p.days&&p.mine)){
    const T=census.tokens.find(t=>t.key===R.tok), P=T?.pools.find(p=>String(p.id).toLowerCase()===String(R.id).toLowerCase()), M=(census.mine||[]).find(m=>String(m.id).toLowerCase()===String(R.id).toLowerCase());
    const ds=Object.keys(R.days).sort(), full=ds.filter(d=>R.days[d].cov>=0.99);
    C(R.tok, full.length?'ok':'na', 'Rebuilt from the chain · '+lab(R), full.length?full.length+' whole day(s) from '+full[0]+' to '+full[full.length-1]+' · '+ds.reduce((s,d)=>s+R.days[d].n,0)+' swaps':'nothing rebuilt yet','cover');
    if(M){ const fd=Object.keys(M.fees||{}).filter(d=>R.days[d]&&R.days[d].cov>=0.99).sort().slice(-7);
      const a=fd.reduce((s,d)=>s+(M.fees[d]||0),0), b=fd.reduce((s,d)=>s+(usdDay(R,P,d)||0),0);
      if(fd.length&&a>0.5){ const g=Math.abs(b/a-1); C(R.tok, g<=0.15?'ok':'look', 'Rebuilt vs your fee counters · '+lab(R), 'rebuilt '+usd(b)+' vs counted '+usd(a)+' over '+fd.length+' day(s) · '+pct(g)+' apart','counters',g,b>a); }
      else C(R.tok,'na','Rebuilt vs your fee counters · '+lab(R),'needs a whole day of both records','counters');
      const sd=Object.keys(M.share||{}).filter(d=>R.days[d]&&R.days[d].cov>=0.99&&R.days[d].st!=null).sort().slice(-7);
      if(sd.length){ const a2=sd.reduce((s,d)=>s+M.share[d].s,0)/sd.length, b2=sd.reduce((s,d)=>s+R.days[d].st,0)/sd.length, g=a2>0?Math.abs(b2/a2-1):null;
        C(R.tok, g!=null&&g<=0.15?'ok':'look', 'Rebuilt vs the relay’s share readings · '+lab(R), 'rebuilt '+pct(b2)+' vs read '+pct(a2)+' of the liquidity at the price over '+sd.length+' day(s)'+(g!=null?' · '+pct(g)+' apart':''),'share',g,g!=null?b2>a2:null); } }
    if(R.chain==='sol'&&R.state?.liqCheck?.seen) { const q=R.state.liqCheck; C(R.tok, q.agree>=q.seen*0.8?'ok':'look', 'Pool liquidity, two records · '+lab(R), q.agree+' of '+q.seen+' liquidity changes start where the last swap left the pool','liq',q.seen?1-q.agree/q.seen:null); }
  }
  // the fee ledger's month totals per token
  const KEY={lcx:'ethereum:'+LCXN, cpool:'sol:'+CPOOL};
  for(const m of (fees.months||[])){ if(!m?.tok||m.m<FROM.slice(0,7)) continue;
    for(const tk of ['lcx','cpool']){ const want=m.tok[KEY[tk]]; if(want==null) continue;
      const Rs=out.pools.filter(p=>p.tok===tk&&p.days), T=census.tokens.find(t=>t.key===tk);
      const ds=[...new Set(Rs.flatMap(R=>Object.keys(R.days)))].filter(d=>d.slice(0,7)===m.m);
      const whole=ds.length&&ds.every(d=>Rs.every(R=>!R.days[d]||R.days[d].cov>=0.99));
      let got=0, gap=false; for(const R of Rs){ const P=T?.pools.find(p=>String(p.id).toLowerCase()===String(R.id).toLowerCase()); for(const d of ds){ if(!R.days[d]) continue; const u=usdDay(R,P,d); if(u==null){ if(R.days[d].s>0) gap=true; continue; } got+=u; } }
      const startsLate=m.m===FROM.slice(0,7)&&FROM.slice(8)!=='01';
      if(!ds.length) continue;
      const g=want>0?Math.abs(got/want-1):null;
      C(tk, gap||!whole||startsLate?'na':(g!=null&&g<=0.15?'ok':'look'), 'Month total · '+(tk==='lcx'?'LCX':'CPOOL')+' · '+m.m, 'rebuilt '+usd(got)+' vs the fee ledger’s '+usd(want)+(g!=null?' · '+pct(g)+' apart':'')+(gap?' · a day without the pool’s trading':'')+(!whole?' · not every day rebuilt whole':''),'month',g,g!=null?got>want:null); } }
}
/* the minute recorder's last 24 hours, pool by pool, against the swaps of the same hours */
async function minuteCheck(out){
  const tok=lockToken(); if(!tok) return;
  const m=await j('https://kt-pulse.kereslek.workers.dev/m?n=1440&k='+tok+'&t='+Date.now(),{},2,30000); if(!m||!Array.isArray(m.mins)) { out.notes.push('the minute recorder did not answer'); return; }
  const now=Date.now(), a=now-24*3600e3, lblPool=new Map(), px=new Map();
  for(const p of data.eth||[]) if(p.pool){ lblPool.set(((p.pairLabel||'')+' '+(p.feeLabel||'')).trim(), String(p.pool).toLowerCase()); px.set(String(p.pool).toLowerCase(),{d0:p.d0, u0:p.usd0}); }
  for(const p of data.sol||[]) if(p.poolId&&p.venue!=='orca'){ lblPool.set(((p.pairLabel||'')+' '+(p.feeLabel||'')).trim(), p.poolId); px.set(p.poolId,{d0:p.d0, u0:p.usd0}); }
  const rec=new Map(); for(const r of m.mins){ if(r[0]<a||!r[3]) continue; for(const [k,v] of Object.entries(r[3])){ const pl=lblPool.get(String(k).trim()); if(pl) rec.set(pl,(rec.get(pl)||0)+v); } }
  for(const R of out.pools.filter(p=>p.mine&&p.state)){ const q=px.get(String(R.id).toLowerCase()); if(!q||q.u0==null||q.d0==null||R.fee==null) continue;
    const reb=(R.state.recent||[]).filter(x=>x[0]>=a).reduce((s,x)=>s+x[1],0)/10**q.d0*q.u0*R.fee*(R.lpCut??1), got=rec.get(String(R.id).toLowerCase())||0;
    const lab=(R.name||'pool')+' '+(R.fee*100).toFixed(2).replace(/\.?0+$/,'')+'% · '+R.venue;
    if(got<0.5&&reb<0.5){ out.checks.push({tok:R.tok, grp:'rep', st:'na', t:'Last 24 hours · '+lab, x:'too little earned on either record to compare', k:'minute', g:null}); continue; }
    const g=got>0?Math.abs(reb/got-1):null;
    out.checks.push({tok:R.tok, grp:'rep', st:g!=null&&g<=0.2?'ok':'look', t:'Last 24 hours · '+lab, x:'rebuilt $'+reb.toFixed(2)+' vs the minute recorder’s $'+got.toFixed(2)+(g!=null?' · '+(g*100).toFixed(1)+'% apart':''), k:'minute', g:g!=null?r4(g):null, ...(g!=null?{up:reb>got}:{})}); }
}

/* ---------- run ---------- */
const K=id=>/^0x/i.test(String(id))?String(id).toLowerCase():String(id);
const prevPools=new Map((prev?.pools||[]).map(p=>[K(p.id),p]));
const out={v:1, t:Date.now(), slug:SLUG, from:FROM, pools:[], checks:[], notes:[]};
if(process.env.ONLY!=='sol') await ethSide(out, prevPools);
if(process.env.ONLY!=='eth') await solSide(out, prevPools);
// a pool not read this run keeps what it had
for(const p of prev?.pools||[]) if(!out.pools.some(q=>K(q.id)===K(p.id))) out.pools.push(p);
for(const R of out.pools) if(R.state){ R.days={}; for(const [d,a] of Object.entries(R.state.raw||{})) R.days[d]=dayOut(a); }
checks(out); await minuteCheck(out);
/* A pool's rebuilt days are used by the page only once they have earned it: at least one of your own
   records (the fee counters, the minute recorder, the relay's share readings) agrees with them, and
   neither the counters nor the minute recorder disagrees. Until then they wait here, checked each run. */
const labOf=R=>(R.name||'pool')+(R.fee!=null?' '+(R.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':'')+' · '+R.venue;
for(const R of out.pools){ if(!R.days||!R.mine){ R.trust=false; continue; }
  const cs=out.checks.filter(c=>c.t&&c.t.endsWith(' · '+labOf(R))&&['counters','minute','share'].includes(c.k));
  R.trust=cs.some(c=>c.st==='ok')&&!cs.some(c=>c.st==='look'&&(c.k==='counters'||c.k==='minute')); }
writeJ(OUT+'/pools-replay-'+SLUG+'.json', out);
const cnt=s=>out.checks.filter(c=>c.st===s).length;
console.log('swap replay since '+FROM+(REBUILD?' (rebuilt from the start)':prev?' (carried on from the last run)':' (first run)')+' · '+Math.round((Date.now()-START)/60000)+' min');
console.log('  Ethereum: '+stats.eth.pools+' pool(s) read · '+stats.eth.swaps+' swap records, '+stats.eth.lp+' liquidity changes ('+stats.eth.mine+' of the deck’s), '+stats.eth.own+' own swap(s) set aside · '+stats.eth.chunks+' chunk(s), '+stats.eth.refused+' refused · '+stats.eth.receipts+' receipt(s)');
console.log('  Solana: '+stats.sol.pools+' pool(s) read · '+stats.sol.txs+' transactions, '+stats.sol.swaps+' swap records, '+stats.sol.lp+' liquidity changes ('+stats.sol.mine+' of the deck’s), '+stats.sol.own+' own swap(s) set aside · '+stats.sol.refused+' not served');
console.log('  pools not read this run: '+stats.unread+' · notes: '+out.notes.length);
console.log('  checks: '+cnt('ok')+' agree, '+cnt('look')+' to look at, '+cnt('na')+' not comparable yet · pools of the deck’s trusted for the page: '+out.pools.filter(p=>p.trust).length+' of '+out.pools.filter(p=>p.mine&&p.days).length);
// each check by kind, status and gap only: which pool, token or amount it concerns stays in the sealed file
const KIND={cover:'rebuilt days',counters:'vs fee counters',share:'vs share readings',liq:'pool liquidity, two records',month:'vs month total',minute:'vs minute record'};
const HI={counters:['rebuilt','counters'],share:['rebuilt','readings'],month:['rebuilt','ledger'],minute:['rebuilt','minute record']};
out.checks.forEach((c,i)=>console.log('    '+String(i+1).padStart(2)+'. '+(KIND[c.k]||c.k||'?')+' · '+(c.st==='ok'?'agrees':c.st==='look'?'TO LOOK AT':'not comparable')+(c.g!=null?' · '+(c.g*100).toFixed(1)+'% apart'+(c.up!=null&&HI[c.k]?', '+HI[c.k][c.up?0:1]+' higher':''):'')));
for(const n of out.notes) console.log('  note: '+n);

/* Can the chain's own swap records rebuild WHY YOUR FEES MOVED back to August? A read-only probe
   of the whole market for two tokens — every LCX (new contract) pool on Ethereum and every CPOOL
   pool on Raydium that trades — asking, pool by pool: how many swaps since FROM; does each source
   serve them whole (Blockscout's log history, the public nodes' eth_getLogs in chunks, Solana's
   signature lists and transactions); does every swap record carry the price and the liquidity it
   met, and decode consistently; how far back the price index's daily candles reach; and what a
   full replay would cost in calls and minutes.

   It does not open the deck's data and does not know which pools are the deck's: the log is public
   and says nothing about whose liquidity is whose. Counts, dates, ratios and market data only. */
const LCXN='0x8cd41041505885ef0ad3858181d66f17be8aae7e', CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg';
const FROM=String(process.env.FROM||'2026-08-01'), FROMMS=Date.parse(FROM+'T00:00:00+02:00');   // Budapest midnight
const ONLY=String(process.env.ONLY||'');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt,tries=3,ms=25000){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(ms)}); if(r.ok) return await r.json(); if(r.status===429) await sleep(4000); }catch(e){} await sleep(1000*(k+1)); } return null; }
const budget=ms=>{ const end=Date.now()+ms; return ()=>Date.now()>end; };
const day=ms=>new Date(ms).toISOString().slice(0,10);
const pad=(s,n)=>String(s).slice(0,n).padEnd(n), lpad=(s,n)=>String(s).padStart(n);
const usd=x=>x==null||!isFinite(x)?'—':'$'+(Math.abs(x)>=1e6?(x/1e6).toFixed(2)+'M':Math.abs(x)>=1e4?(x/1e3).toFixed(1)+'k':Math.abs(x)>=100?x.toFixed(0):x.toFixed(2));
const nf=n=>Number(n).toLocaleString('en-US');
const secs=t0=>((Date.now()-t0)/1000).toFixed(0)+' s';
const WEEKS=Math.ceil((Date.now()-FROMMS)/(7*864e5));
const byWeek=ts=>{ const w=Array(WEEKS).fill(0); for(const t of ts){ const k=Math.floor((t-FROMMS)/(7*864e5)); if(k>=0&&k<WEEKS) w[k]++; } return w.join(' '); };
const feeLbl=f=>f!=null?(f*100).toFixed(2).replace(/\.?0+$/,'')+'%':'—';

/* ---------- GeckoTerminal (30 calls a minute) ---------- */
const GT='https://api.geckoterminal.com/api/v2'; let gtLast=0;
const gt=async path=>{ const w=2300-(Date.now()-gtLast); if(w>0) await sleep(w); gtLast=Date.now(); return j(GT+path,{headers:{accept:'application/json;version=20230302'}}); };
async function tokenPools(net, token){
  const out=[]; for(let page=1; page<=5; page++){ const r=await gt('/networks/'+net+'/tokens/'+token+'/pools?page='+page+'&sort=h24_volume_usd_desc&include=dex'); const a=r?.data||[]; out.push(...a); if(a.length<20) break; }
  return out.map(x=>{ const a=x.attributes||{}, fm=String(a.name||'').match(/([\d.]+)%/);
    return {addr:a.address, name:String(a.name||'?').replace(/\s+[\d.]+%$/,''), dex:x.relationships?.dex?.data?.id||'?', tvl:+a.reserve_in_usd||0, created:a.pool_created_at?Date.parse(a.pool_created_at):null, fee:fm?+fm[1]/100:null}; }); }
/* how far back the daily candles go, and whether a page before the oldest serves more */
async function candles(net, addr){
  const r=await gt('/networks/'+net+'/pools/'+addr+'/ohlcv/day?limit=1000&currency=usd'); const L=r?.data?.attributes?.ohlcv_list||[];
  if(!L.length) return {n:0, vol:new Map()};
  const oldest=Math.min(...L.map(c=>c[0]));
  const r2=await gt('/networks/'+net+'/pools/'+addr+'/ohlcv/day?limit=1000&currency=usd&before_timestamp='+oldest); const L2=r2?.data?.attributes?.ohlcv_list||[];
  return {n:L.length, oldest:day(oldest*1000), more:L2.length, vol:new Map(L.map(c=>[day(c[0]*1000), +c[5]]))}; }

/* ---------- Ethereum ---------- */
const BS='https://eth.blockscout.com';
const NODES=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://eth.llamarpc.com','https://1rpc.io/eth',BS+'/api/eth-rpc'];
async function rpcAt(u,method,params,ms=20000){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,ms); return r&&r.result!==undefined&&!r.error?r.result:undefined; }
async function erpc(method,params){ for(const u of NODES){ const r=await rpcAt(u,method,params); if(r!==undefined) return r; } return undefined; }
let keccak=null; try{ keccak=(await import('js-sha3')).keccak256; }catch(e){}
const TOP={
  v3swap:['Swap(address,address,int256,int256,uint160,uint128,int24)','0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'],
  v4swap:['Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)','0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'],
  v4mod:['ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)','0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'],
  inc:['IncreaseLiquidity(uint256,uint128,uint256,uint256)','0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f'],
  dec:['DecreaseLiquidity(uint256,uint128,uint256,uint256)','0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4']};
const T={}; let topicsOk=0; for(const [k,[s,h]] of Object.entries(TOP)){ const c=keccak?'0x'+keccak(s):h; if(c===h) topicsOk++; T[k]=c; }
const PM4='0x000000000004444c5dc75cb358380d2e3de08a90', NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88';
const word=(d,i)=>d.slice(2+64*i,2+64*(i+1));
const sInt=(h,bits=256)=>{ let v=BigInt('0x'+h); if(bits<256) v&=(1n<<BigInt(bits))-1n; if(v>=(1n<<BigInt(bits-1))) v-=1n<<BigInt(bits); return v; };
const i24=h=>Number(sInt(h.slice(-6),24));
const tickOfSqrt=(sq,Q)=>{ const s=Number(sq)/2**Q; return Math.floor(Math.log(s*s)/Math.log(1.0001)); };
/* a swap record: amounts of opposite signs, a positive liquidity, and a tick that agrees with its price */
function evmSwapOk(l, v4){ const d=l.data; if(!d||d.length<2+64*(v4?6:5)) return false;
  const a0=sInt(word(d,0)), a1=sInt(word(d,1)), sp=BigInt('0x'+word(d,2)), L=BigInt('0x'+word(d,3)), t=i24(word(d,4));
  return L>0n && sp>0n && (a0>0n)!==(a1>0n) && Math.abs(tickOfSqrt(sp,96)-t)<=1; }
async function blockAt(ms){
  const r=await j(BS+'/api?module=block&action=getblocknobytime&timestamp='+Math.floor(ms/1000)+'&closest=after',{},3,30000);
  const b=r?.result?.blockNumber!=null?+r.result.blockNumber:null; if(b) return {b, how:'Blockscout'};
  const tip=parseInt(await erpc('eth_blockNumber',[])||'0',16); return tip?{b:Math.max(0,tip-Math.ceil((Date.now()-ms)/12050)), how:'estimate'}:null; }
/* Blockscout's history, a thousand records a page */
async function bsLogs(params, over){
  const out=[], seen=new Set(); let from=params.fromBlock||0, pages=0;
  for(let n=0;n<200;n++){ if(over()) return {logs:out, partial:true, pages};
    const q=new URLSearchParams({module:'logs',action:'getLogs',...params,fromBlock:String(from),toBlock:'latest'});
    const r=await j(BS+'/api?'+q,{},3,60000); pages++; const a=Array.isArray(r?.result)?r.result:null; if(!a) return {logs:out, partial:true, failed:true, pages};
    let added=0; for(const l of a){ const k=l.transactionHash+':'+l.logIndex; if(seen.has(k)) continue; seen.add(k); out.push(l); added++; }
    if(a.length<1000||!added) break; from=parseInt(a[a.length-1].blockNumber,16); }
  return {logs:out, partial:false, pages}; }
/* the public nodes' eth_getLogs, 9,000 blocks at a time, each node asked in turn; whole only if every chunk answered */
async function nodeLogs(filter, from, to, over){
  const CH=9000, out=[], served={}; let chunks=0, failed=0;
  for(let a=from; a<=to; a+=CH){ if(over()) return {logs:out, chunks, failed, served, partial:true};
    const b=Math.min(to,a+CH-1); chunks++; let got;
    for(const u of NODES){ got=await rpcAt(u,'eth_getLogs',[{...filter,fromBlock:'0x'+a.toString(16),toBlock:'0x'+b.toString(16)}],30000); if(Array.isArray(got)){ served[u.replace(/^https:\/\//,'').split('/')[0]]=(served[u.replace(/^https:\/\//,'').split('/')[0]]||0)+1; break; } }
    if(!Array.isArray(got)){ failed++; continue; } out.push(...got); await sleep(80); }
  return {logs:out, chunks, failed, served, partial:failed>0}; }

async function ethPool(P, fromB, tip){
  const v4=P.addr.length===66;
  console.log('\n  '+P.name+' '+feeLbl(P.fee)+' · '+(v4?'Uniswap v4':'Uniswap v3')+' · size '+usd(P.tvl)+' · daily candles '+P.c.n+(P.c.oldest?' from '+P.c.oldest:'')+(P.c.more?' (and '+P.c.more+' more before)':''));
  // Blockscout
  let t0=Date.now();
  const bs=v4?await bsLogs({address:PM4, topic0:T.v4swap, topic1:P.addr, topic0_1_opr:'and', fromBlock:fromB}, budget(10*60e3))
             :await bsLogs({address:P.addr, topic0:T.v3swap, fromBlock:fromB}, budget(10*60e3));
  const okB=bs.logs.filter(l=>evmSwapOk(l,v4)).length, tsB=bs.logs.map(l=>parseInt(l.timeStamp,16)*1000).filter(x=>x>0);
  console.log('    Blockscout: '+nf(bs.logs.length)+' swaps since '+FROM+' in '+bs.pages+' page(s), '+secs(t0)+' · '+(bs.failed?'REFUSED part way':bs.partial?'stopped at the time limit':'whole')
    +' · decode consistently '+nf(okB)+' of '+nf(bs.logs.length)+(tsB.length?' · first '+day(Math.min(...tsB))+', last '+day(Math.max(...tsB)):''));
  if(bs.logs.length) console.log('      per week since '+FROM+': '+byWeek(tsB));
  // the public nodes, the same window
  t0=Date.now();
  const nd=await nodeLogs(v4?{address:PM4, topics:[T.v4swap, P.addr]}:{address:P.addr, topics:[T.v3swap]}, fromB, tip, budget(10*60e3));
  const okN=nd.logs.filter(l=>evmSwapOk(l,v4)).length, withTs=nd.logs.filter(l=>l.blockTimestamp!=null).length;
  console.log('    public nodes: '+nf(nd.logs.length)+' swaps, '+nd.chunks+' chunk(s) of 9,000 blocks, '+nd.failed+' refused by every node, '+secs(t0)
    +' · decode consistently '+nf(okN)+' of '+nf(nd.logs.length)+' · records carrying their time '+nf(withTs)+' · served by '+Object.entries(nd.served).map(([k,v])=>k+' '+v).join(', '));
  const agree=!bs.partial&&!nd.partial?(bs.logs.length===nd.logs.length?'the two sources agree exactly':'the two sources differ by '+Math.abs(bs.logs.length-nd.logs.length)):'not compared (one source incomplete)';
  console.log('    '+agree);
  if(v4){ t0=Date.now(); const m=await bsLogs({address:PM4, topic0:T.v4mod, topic1:P.addr, topic0_1_opr:'and', fromBlock:0}, budget(4*60e3));
    console.log('    liquidity changes (ModifyLiquidity), whole history: '+nf(m.logs.length)+' in '+m.pages+' page(s), '+secs(t0)+' · '+(m.failed?'REFUSED':m.partial?'stopped at the time limit':'whole')); }
  return {swaps:Math.max(bs.logs.length,nd.logs.length), whole:(!bs.partial&&okB===bs.logs.length)||(!nd.partial&&okN===nd.logs.length)}; }

/* a position's own record on the v3 position manager: a recent id, its whole history by its topic */
async function npmCheck(fromB, tip){
  const t0=Date.now(); const recent=await erpc('eth_getLogs',[{address:NPM, topics:[T.inc], fromBlock:'0x'+(tip-1500).toString(16), toBlock:'0x'+tip.toString(16)}]);
  if(!Array.isArray(recent)||!recent.length){ console.log('\n  v3 position records: no recent record to test with'); return; }
  const id=recent[recent.length-1].topics[1];
  const h=await nodeLogs({address:NPM, topics:[[T.inc,T.dec],id]}, fromB, tip, budget(5*60e3));
  console.log('\n  v3 position records (one position, picked at random, its whole window by its id): '+h.chunks+' chunk(s), '+h.failed+' refused, '+h.logs.length+' record(s), '+secs(t0)); }

/* ---------- Solana ---------- */
const KEYED=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean);
const SRPC=[...KEYED,'https://api.mainnet-beta.solana.com'];
const served={keyed:0, pub:0, miss:0};
async function srpc(method,params){ for(const u of SRPC){ const r=await rpcAt(u,method,params,25000); if(r!==undefined){ if(KEYED.includes(u)) served.keyed++; else served.pub++; return r; } } served.miss++; return undefined; }
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let n=BigInt('0x'+(Buffer.from(buf).toString('hex')||'0')), s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of buf){ if(x===0) s='1'+s; else break; } return s; };
const u128=(b,o)=>{ let v=0n; for(let i=15;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const u64=(b,o)=>{ let v=0n; for(let i=7;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const CLMM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
// Anchor event tags: the first 8 bytes of sha256("event:<Name>")
const EVT={swap:'40c6cde8260871e2', liq:'7ef0afce9e58996b', inc:'314f69d420221e54', dec:'3ade563a44325538', open:'641e57f9c4df9ace', collect:'a6ae69c051a15369'};
const evtsOf=tx=>{ const out=[]; for(const l of tx?.meta?.logMessages||[]){ if(!l.startsWith('Program data: ')) continue; let b; try{ b=Buffer.from(l.slice(14),'base64'); }catch(e){ continue; }
  if(b.length<8) continue; const k=Object.entries(EVT).find(([,h])=>b.subarray(0,8).toString('hex')===h); if(k) out.push({k:k[0], b}); } return out; };
/* SwapEvent: pool, sender, two token accounts, amount_0, fee_0, amount_1, fee_1, zero_for_one, sqrt_price_x64, liquidity, tick */
const swapEv=b=>b.length>=205?{pool:b58(b.subarray(8,40)), a0:u64(b,136), a1:u64(b,152), zfo:b[168]===1, sp:u128(b,169), L:u128(b,185), tick:b.readInt32LE(201)}:null;
/* LiquidityChangeEvent: pool, tick, tick_lower, tick_upper, liquidity_before, liquidity_after */
const liqEv=b=>b.length>=84?{pool:b58(b.subarray(8,40)), tick:b.readInt32LE(40), lo:b.readInt32LE(44), hi:b.readInt32LE(48), Lb:u128(b,52), La:u128(b,68)}:null;
async function sigsSince(addr, sinceMs, over){
  const out=[]; let before=null, pages=0;
  for(;;){ if(over()) return {sigs:out, partial:true, pages};
    const s=await srpc('getSignaturesForAddress',[addr,{limit:1000,...(before?{before}:{})}]); pages++;
    if(!Array.isArray(s)) return {sigs:out, partial:true, failed:true, pages};
    for(const x of s){ if(x.blockTime&&x.blockTime*1000<sinceMs) return {sigs:out, partial:false, pages}; out.push(x); }
    if(s.length<1000) return {sigs:out, partial:false, pages}; before=s[s.length-1].signature; } }

async function solPool(P){
  console.log('\n  '+P.name+' '+feeLbl(P.fee)+' · '+P.venue+' · size '+usd(P.tvl)+' · daily candles '+P.c.n+(P.c.oldest?' from '+P.c.oldest:'')+(P.c.more?' (and '+P.c.more+' more before)':''));
  let t0=Date.now(); const S=await sigsSince(P.addr, FROMMS, budget(6*60e3));
  const ok=S.sigs.filter(x=>!x.err), ts=ok.map(x=>x.blockTime*1000);
  console.log('    transactions touching the pool since '+FROM+': '+nf(S.sigs.length)+' ('+nf(S.sigs.length-ok.length)+' failed) in '+S.pages+' page(s), '+secs(t0)+' · '+(S.failed?'REFUSED part way':S.partial?'stopped at the time limit':'whole'));
  if(ts.length) console.log('      per week since '+FROM+': '+byWeek(ts));
  if(!/clmm/i.test(P.venue)){ console.log('    (not a concentrated pool: its swaps are not replayed, its daily trading comes from the candles)'); return {txs:ok.length, ms:null}; }
  // a sample spread over the window: does each swap record decode, and agree with its own price?
  const K=Math.min(40, ok.length), pick=[...new Set(Array.from({length:K},(_,i)=>Math.floor(i*(ok.length-1)/Math.max(1,K-1))))].map(i=>ok[i]);
  let got=0, sw=0, swOk=0, swMine=0, lq=0, lqOk=0, pos=0, ms=0, n=0; const lens=new Set(), show=[];
  for(const x of pick){ const a=Date.now(); const tx=await srpc('getTransaction',[x.signature,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}]); ms+=Date.now()-a; n++;
    if(!tx) continue; got++;
    for(const e of evtsOf(tx)){
      if(e.k==='swap'){ sw++; lens.add(e.b.length); const s=swapEv(e.b); if(!s) continue; if(s.pool!==P.addr) continue; swMine++;
        const good=s.L>0n&&s.sp>0n&&Math.abs(tickOfSqrt(s.sp,64)-s.tick)<=1; if(good) swOk++; else if(show.length<3) show.push('tick '+s.tick+' vs price tick '+tickOfSqrt(s.sp,64)+', liquidity '+(s.L>0n?'>0':'0')+', length '+e.b.length); }
      else if(e.k==='liq'){ lq++; const v=liqEv(e.b); if(v&&v.pool===P.addr&&v.lo<v.hi) lqOk++; }
      else if(e.k==='inc'||e.k==='dec'||e.k==='open') pos++; } }
  const avg=n?ms/n:null;
  console.log('    sample of '+pick.length+' transaction(s): '+got+' read · swap records '+sw+' ('+swMine+' of this pool, '+swOk+' of those decode consistently; record length '+[...lens].join('/')+') · liquidity-change records '+lq+' ('+lqOk+' decode) · position records '+pos);
  for(const s of show) console.log('      inconsistent: '+s);
  if(avg!=null) console.log('    one transaction read ≈ '+Math.round(avg)+' ms → every transaction since '+FROM+' ≈ '+Math.round(ok.length*avg/60000)+' min one at a time, ≈ '+Math.round(ok.length*avg/4/60000)+' min four at a time');
  return {txs:ok.length, ms:avg, ok:swMine>0&&swOk===swMine}; }

/* a Raydium position's own record: a few positions picked at random, their transactions, their open/increase/decrease records */
async function clmmPositions(P){
  const gpa=await srpc('getProgramAccounts',[CLMM,{encoding:'base64',filters:[{dataSize:281},{memcmp:{offset:41,bytes:P.addr}}]}]);
  if(!Array.isArray(gpa)){ console.log('    positions: the list was refused'); return; }
  const mints=gpa.map(a=>b58(Buffer.from(a.account.data[0],'base64').subarray(9,41)));
  let read=0, recs=0, txs=0; for(const m of mints.slice(0,3)){ const s=await srpc('getSignaturesForAddress',[m,{limit:50}]); if(!Array.isArray(s)) continue; read++;
    for(const x of s.slice(0,6)){ const tx=await srpc('getTransaction',[x.signature,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}]); if(!tx) continue; txs++; recs+=evtsOf(tx).filter(e=>['open','inc','dec'].includes(e.k)).length; } }
  console.log('    positions in the pool now: '+mints.length+' · sampled '+read+' of them: '+txs+' transaction(s) read, '+recs+' open/increase/decrease record(s) found'); }

/* ---------- run ---------- */
console.log('replay probe · since '+FROM+' (Budapest) · '+WEEKS+' week(s) · event topics '+(keccak?'computed and '+(topicsOk===Object.keys(TOP).length?'all match':'MISMATCH ('+topicsOk+' of '+Object.keys(TOP).length+')'):'from the built-in list'));
const verdict=[];
if(ONLY!=='sol'){
  const tipHex=await erpc('eth_blockNumber',[]), tip=parseInt(tipHex||'0',16), fb=await blockAt(FROMMS);
  console.log('\n######## LCX (new contract) on Ethereum · from block '+(fb?nf(fb.b)+' ('+fb.how+')':'—')+' to '+nf(tip));
  const pools=(await tokenPools('eth', LCXN)).filter(p=>p.addr&&/uniswap/.test(p.dex));
  for(const P of pools) P.c=await candles('eth', P.addr);
  const live=pools.filter(P=>[...P.c.vol.entries()].some(([d,v])=>d>=FROM&&v>0)).sort((a,b)=>b.tvl-a.tvl);
  console.log('  '+pools.length+' Uniswap pools list it; '+live.length+' traded since '+FROM);
  let all=0, whole=true; for(const P of live){ const r=await ethPool(P, fb?fb.b:tip-600000, tip); all+=r.swaps; whole=whole&&r.whole; }
  await npmCheck(fb?fb.b:tip-600000, tip);
  verdict.push('LCX: '+nf(all)+' swaps since '+FROM+' across '+live.length+' pool(s) · '+(whole?'every pool readable whole':'NOT every pool readable whole'));
}
if(ONLY!=='eth'){
  console.log('\n######## CPOOL on Solana · '+(KEYED.length?'keyed node first':'public node only'));
  const gtp=(await tokenPools('solana', CPOOL)).filter(p=>p.addr);
  const r=await j('https://api-v3.raydium.io/pools/info/mint?mint1='+CPOOL+'&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=100&page=1');
  const ray=new Map(); for(const d of (Array.isArray(r?.data?.data)?r.data.data:[])) ray.set(d.id,d);
  const pools=[...new Set([...gtp.map(p=>p.addr),...ray.keys()])].map(a=>{ const g=gtp.find(p=>p.addr===a)||{}, d=ray.get(a);
    const type=String(d?.type||'').toLowerCase();
    return {addr:a, name:g.name||((d?.mintA?.symbol||'?')+' / '+(d?.mintB?.symbol||'?')), tvl:d?+d.tvl:g.tvl||0, fee:d?.feeRate!=null?+d.feeRate:g.fee??null,
      venue:d?('Raydium '+(type==='concentrated'?'CLMM':type||'?')):(g.dex||'?'), ray:!!d||/raydium/i.test(g.dex||'')}; }).filter(P=>P.ray);
  for(const P of pools) P.c=await candles('solana', P.addr);
  const live=pools.filter(P=>[...P.c.vol.entries()].some(([d,v])=>d>=FROM&&v>0)).sort((a,b)=>b.tvl-a.tvl);
  console.log('  '+pools.length+' Raydium pools list it; '+live.length+' traded since '+FROM);
  let txs=0, mins=0, ok=true; for(const P of live){ const x=await solPool(P); txs+=x.txs; if(x.ms) mins+=x.txs*x.ms/60000; if(x.ok===false) ok=false; if(/clmm/i.test(P.venue)) await clmmPositions(P); }
  console.log('\n  Solana calls: '+served.keyed+' answered by the keyed node, '+served.pub+' by the public one, '+served.miss+' by neither');
  verdict.push('CPOOL: '+nf(txs)+' transactions since '+FROM+' across '+live.length+' Raydium pool(s) · swap records '+(ok?'decode consistently':'do NOT all decode')+' · a full read ≈ '+Math.round(mins)+' min one at a time');
}
console.log('\n######## verdict'); for(const v of verdict) console.log('  '+v);

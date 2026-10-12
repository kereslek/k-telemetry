/* The pool census: once or twice a day, every pool that lists LCX (new contract) on Ethereum and
   every pool that lists CPOOL on Solana, and the deck's own place in them. It feeds the dashboard's
   WHY FEES MOVED panel.

   For every pool: size (from two public sources where there are two), price against the market,
   fee rate and the LPs' part of it, trading day by day (60 days, then accumulated), and — where the
   chain answers — the LP book: positions, how many at the price, when they arrived.
   For each of the deck's own pools: its share of the liquidity at the price through the day (the
   relay records it every pass), time in range, its fees per day (from the relay's per-position fee
   totals), and the fees that share should have earned. Then the checks: public sources against each
   other and the chain, and the deck's own figures against the pool's.

   Everything is written sealed (deck-r7k4x9/pools-<slug>.json). The log is public: counts only. */
import { initLock, readJ, writeJ } from './lock.mjs';
const OUT='deck-r7k4x9', SLUG=process.env.PROFILE||'main';
const LCXN='0x8cd41041505885ef0ad3858181d66f17be8aae7e', CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg';
const TOKENS=[{key:'lcx', sym:'LCX', chain:'Ethereum', net:'eth', addr:LCXN}, {key:'cpool', sym:'CPOOL', chain:'Solana', net:'solana', addr:CPOOL}];
const KEEP=120, H=3600e3, D=24*H;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt,tries=3,ms=25000){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(ms)}); if(r.ok) return await r.json(); if(r.status===429) await sleep(5000); }catch(e){} await sleep(1200*(k+1)); } return null; }
const budget=ms=>{ const end=Date.now()+ms; return ()=>Date.now()>end; };
const day=ms=>new Date(ms).toISOString().slice(0,10);
const r2=x=>x==null||!isFinite(x)?null:Math.round(x*100)/100, r4=x=>x==null||!isFinite(x)?null:Math.round(x*1e4)/1e4;

if(!String(process.env.DECK_PASSPHRASE||'').trim()){ console.log('DECK_PASSPHRASE is not set: nothing done'); process.exit(1); }
initLock(OUT);
const rd=f=>{ try{ return readJ(OUT+'/'+f); }catch(e){ return null; } };
const data=rd('data-'+SLUG+'.json'), fees=rd('fees-'+SLUG+'.json'), bc=rd('blockcache.json'), prev=rd('pools-'+SLUG+'.json');
if(!data){ console.log('the relay’s data could not be read: nothing done'); process.exit(1); }

/* ---------- GeckoTerminal (30 calls a minute) ---------- */
const GT='https://api.geckoterminal.com/api/v2'; let gtLast=0;
const gt=async path=>{ const w=2300-(Date.now()-gtLast); if(w>0) await sleep(w); gtLast=Date.now(); return j(GT+path,{headers:{accept:'application/json;version=20230302'}}); };
async function tokenPools(T){
  const out=[]; for(let page=1; page<=5; page++){ const r=await gt('/networks/'+T.net+'/tokens/'+T.addr+'/pools?page='+page+'&sort=h24_volume_usd_desc&include=dex'); const a=r?.data||[]; out.push(...a); if(a.length<20) break; }
  return out.map(x=>{ const a=x.attributes||{}; const fm=String(a.name||'').match(/([\d.]+)%/), base=x.relationships?.base_token?.data?.id?.split('_').pop();
    const mineIsBase=String(base||'').toLowerCase()===T.addr.toLowerCase();
    return {id:a.address, name:String(a.name||'?').replace(/\s+[\d.]+%$/,''), dex:x.relationships?.dex?.data?.id||'?', tvlIdx:+a.reserve_in_usd||0, vol24:+a.volume_usd?.h24||0,
      created:a.pool_created_at?Date.parse(a.pool_created_at):null, fee:fm?+fm[1]/100:null, px:mineIsBase?(+a.base_token_price_usd||null):(+a.quote_token_price_usd||null)}; }); }
async function candles(T, id){ const r=await gt('/networks/'+T.net+'/pools/'+id+'/ohlcv/day?limit=61&currency=usd'); const m={};
  for(const c of r?.data?.attributes?.ohlcv_list||[]) m[day(c[0]*1000)]=r2(+c[5]); return r?m:null; }

/* ---------- chains ---------- */
const BS='https://eth.blockscout.com';
const ERPC=[BS+'/api/eth-rpc','https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth'];
async function erpc(method,params){ for(const u of ERPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,15000); if(r&&r.result!=null&&!r.error) return r.result; } return null; }
const SRPC=[process.env.SOL_RPC_URL,'https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com','https://solana.leorpc.com/?api_key=FREE','https://rpc.solanatracker.io/public'].filter(Boolean);
async function srpc(method,params){ for(const u of SRPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1,20000); if(r&&r.result!==undefined&&!r.error) return r.result; await sleep(250); } return null; }
const w32=(data,i)=>data.slice(2+64*i,2+64*(i+1));
const sInt=(h,bits=256)=>{ let v=BigInt('0x'+h); if(bits<256) v&=(1n<<BigInt(bits))-1n; if(v>=(1n<<BigInt(bits-1))) v-=1n<<BigInt(bits); return v; };
const i24=h=>Number(sInt(h.slice(-6),24));
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let n=BigInt('0x'+(Buffer.from(buf).toString('hex')||'0')), s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of buf){ if(x===0) s='1'+s; else break; } return s; };
const u128=(b,o)=>{ let v=0n; for(let i=15;i>=0;i--) v=(v<<8n)+BigInt(b[o+i]); return v; };
const PM4='0x000000000004444c5dc75cb358380d2e3de08a90', SV4='0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
const V4MOD='0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const CLMM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

/* the LP book of a Uniswap v4 pool, from its ModifyLiquidity events (Blockscout serves the history) */
async function bookV4(P){
  const over=budget(3*60e3), seen=new Set(), logs=[]; let from=0;
  const tip=parseInt(await erpc('eth_blockNumber',[])||'0',16); if(tip&&P.created) from=Math.max(0,tip-Math.ceil((Date.now()-P.created)/12000*1.05)-2000);
  for(let n=0;n<40;n++){ if(over()) return null;
    const q=new URLSearchParams({module:'logs',action:'getLogs',fromBlock:String(from),toBlock:'latest',address:PM4,topic0:V4MOD,topic1:P.id,topic0_1_opr:'and'});
    const r=await j(BS+'/api?'+q,{},3,60000); const a=Array.isArray(r?.result)?r.result:null; if(!a) return null;
    let added=0; for(const l of a){ const k=l.transactionHash+':'+l.logIndex; if(seen.has(k)) continue; seen.add(k); logs.push(l); added++; }
    if(a.length<1000||!added) break; from=parseInt(a[a.length-1].blockNumber,16); }
  const pos=new Map();
  for(const l of logs){ const t=parseInt(l.timeStamp,16)*1000, lo=i24(w32(l.data,0)), hi=i24(w32(l.data,1)), dL=sInt(w32(l.data,2)), k=l.topics[2]+':'+lo+':'+hi+':'+w32(l.data,3);
    const e=pos.get(k)||{lo,hi,L:0n,first:t,tx:l.transactionHash}; e.L+=dL; pos.set(k,e); }
  const s0=await erpc('eth_call',[{to:SV4,data:'0xc815641c'+P.id.slice(2)},'latest']), lq=await erpc('eth_call',[{to:SV4,data:'0xfa6793d5'+P.id.slice(2)},'latest']);
  const tick=s0?i24(w32(s0,1)):null, L=lq?BigInt('0x'+w32(lq,0)):null;
  const live=[...pos.values()].filter(e=>e.L>0n), at=tick==null?[]:live.filter(e=>e.lo<=tick&&tick<e.hi);
  const wallets=new Set(); const overW=budget(90e3);
  for(const e of live){ if(overW()) break; const t=await j(BS+'/api/v2/transactions/'+e.tx,{},2,12000); if(t?.from?.hash) wallets.add(t.from.hash.toLowerCase()); }
  return {open:live.length, atPrice:at.length, wallets:wallets.size||null, opened:live.map(e=>day(e.first)),
    sum:L!=null&&at.length?r4(Number(at.reduce((s,e)=>s+e.L,0n)*10000n/(L||1n))/10000):null}; }
/* the LP book of a Raydium CLMM pool, straight from its position accounts */
async function bookClmm(P, mineMints){
  const acct=await srpc('getAccountInfo',[P.id,{encoding:'base64'}]); if(!acct?.value) return null;
  const pb=Buffer.from(acct.value.data[0],'base64'), L=u128(pb,237), tick=pb.readInt32LE(269);
  let lpCut=null; try{ const cfg=b58(pb.subarray(9,41)); const c=await srpc('getAccountInfo',[cfg,{encoding:'base64'}]); const cb=Buffer.from(c.value.data[0],'base64'); lpCut=1-(cb.readUInt32LE(43)+cb.readUInt32LE(53))/1e6; }catch(e){}
  const gpa=await srpc('getProgramAccounts',[CLMM,{encoding:'base64',filters:[{dataSize:281},{memcmp:{offset:41,bytes:P.id}}]}]);
  if(!Array.isArray(gpa)) return {lpCut};
  const live=[]; for(const a of gpa){ const b=Buffer.from(a.account.data[0],'base64'); const Lq=u128(b,81); if(Lq>0n) live.push({mint:b58(b.subarray(9,41)),L:Lq,lo:b.readInt32LE(73),hi:b.readInt32LE(77)}); }
  const at=live.filter(e=>e.lo<=tick&&tick<e.hi);
  const opened=[]; const over=budget(2*60e3);
  for(const p of live){ if(over()) break; let before=null, oldest=null;
    for(let pg=0;pg<3;pg++){ const s=await srpc('getSignaturesForAddress',[p.mint,{limit:1000,...(before?{before}:{})}]); if(!Array.isArray(s)||!s.length) break; oldest=s[s.length-1]; before=oldest.signature; if(s.length<1000) break; }
    if(oldest?.blockTime) opened.push(day(oldest.blockTime*1000)); }
  const mine=live.filter(e=>mineMints.has(e.mint));
  return {open:live.length, atPrice:at.length, opened, lpCut, sum:L>0n&&at.length?r4(Number(at.reduce((s,e)=>s+e.L,0n)*10000n/L)/10000):null,
    mineFound:mine.length, mineL:mine.reduce((s,e)=>s+e.L,0n).toString()}; }

/* ---------- the deck's own positions, grouped by pool ---------- */
const mine=new Map();
for(const p of data.eth||[]){ if(![p.token0,p.token1].map(x=>String(x).toLowerCase()).includes(LCXN)) continue;
  const id=String(p.pool).toLowerCase(); const e=mine.get(id)||{tok:'lcx', id, ids:[], value:0, inL:0n, poolL:null, mints:new Set(), ck:p.chain||'ethereum'};
  e.ids.push(String(p.id)); e.value+=p.valueUsd||0; if(p.inRange&&p.liq) e.inL+=BigInt(p.liq); if(p.poolLiq!=null) e.poolL=BigInt(p.poolLiq); mine.set(id,e); }
for(const p of data.sol||[]){ if(![p.mint0,p.mint1].includes(CPOOL)) continue;
  const e=mine.get(p.poolId)||{tok:'cpool', id:p.poolId, ids:[], value:0, inL:0n, poolL:null, mints:new Set(), ck:'sol'};
  e.ids.push(String(p.id)); e.value+=p.valueUsd||0; if(p.inRange&&p.liq) e.inL+=BigInt(p.liq); if(p.poolLiq!=null) e.poolL=BigInt(p.poolLiq); if(p.nftMint) e.mints.add(p.nftMint); mine.set(p.poolId,e); }

/* the relay's share record, a point every pass: by UTC day, the mean share and the time in range */
const shareHist=(bc&&bc.shareHist)||{};
const shareOf=(ck,id)=>{ const k=Object.keys(shareHist).find(k=>k.toLowerCase()===(ck==='sol'?'sol:'+id:ck+':'+id).toLowerCase()); return k?shareHist[k]:[]; };
const byDay=pts=>{ const m={}; for(const p of pts){ const d=day(p.t); (m[d]=m[d]||[]).push(p.s/100); } const o={};
  for(const [d,a] of Object.entries(m)) o[d]={s:r4(a.reduce((x,y)=>x+y,0)/a.length), tin:r4(a.filter(x=>x>0).length/a.length), n:a.length}; return o; };
/* the relay's per-position fee totals (every pass, 50 hours): fees per UTC day, for days the record covers whole */
const posHist=Array.isArray(fees?.posHist)?fees.posHist:[];
function feesByDay(ids){ const o={}; if(posHist.length<2) return o;
  const first=posHist[0][0], last=posHist[posHist.length-1][0];
  const seenAt=id=>{ for(const [ts,snap] of posHist) if(snap[id]!=null) return [ts,snap[id]]; return null; };
  // the running total at a moment: the last reading at or before it; a position that did not exist yet counts from its first reading
  const runAt=(id,t)=>{ let v=null; for(const [ts,snap] of posHist){ if(ts>t) break; if(snap[id]!=null) v=snap[id]; }
    if(v==null){ const f=seenAt(id); if(f&&(f[0]>t||f[0]<=t+H)) v=f[1]; } return v; };
  for(let t=Math.floor(first/D)*D; t+D<=last; t+=D){ if(first>t+H) continue;
    let sum=0, ok=true; for(const id of ids){ const a=runAt(id,t), b=runAt(id,t+D); if(a==null&&b==null) continue; if(a==null||b==null){ ok=false; break; } sum+=Math.max(0,b-a); }
    if(ok) o[day(t)]=r2(sum); }
  return o; }

/* ---------- run ---------- */
const P0=prev&&prev.v===1?prev:null;
const out={v:1, t:Date.now(), slug:SLUG, tokens:[], mine:[], checks:[]};
let poolsN=0, realN=0;
for(const T of TOKENS){
  const list=await tokenPools(T);
  let ray={}; if(T.net==='solana'){ const r=await j('https://api-v3.raydium.io/pools/info/mint?mint1='+T.addr+'&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=100&page=1');
    for(const d of (Array.isArray(r?.data?.data)?r.data.data:(Array.isArray(r?.data)?r.data:[]))) ray[d.id]=d;
    for(const [id,d] of Object.entries(ray)) if(!list.some(p=>p.id===id)) list.push({id, name:(d.mintA?.symbol||'?')+' / '+(d.mintB?.symbol||'?'), dex:'raydium', tvlIdx:null, vol24:+d.day?.volume||0, created:d.openTime?+d.openTime*1000:null, fee:d.feeRate!=null?+d.feeRate:null, px:null}); }
  const act=list.filter(p=>p.vol24>0&&p.px>0), mpx=act.length?act.reduce((s,p)=>s+p.px*p.vol24,0)/act.reduce((s,p)=>s+p.vol24,0):null;
  const pools=[];
  for(const p of list){ const R=ray[p.id], own=mine.has(String(p.id).toLowerCase())||mine.has(p.id);
    const tvlRay=R?+R.tvl:null, tvl=tvlRay!=null?tvlRay:p.tvlIdx, off=mpx&&p.px>0?r4(p.px/mpx-1):null;
    const venue=/uniswap-v4/.test(p.dex)?'Uniswap v4':/uniswap/.test(p.dex)?'Uniswap v3':R?('Raydium '+(String(R.type).toLowerCase()==='concentrated'?'CLMM':String(R.type||'').toLowerCase()==='standard'?'classic':R.type)):p.dex;
    const fee=R?.feeRate!=null?+R.feeRate:p.fee;
    pools.push({id:p.id, name:p.name, venue, fee, tvl:r2(tvl), tvlIdx:r2(p.tvlIdx), tvlRay:r2(tvlRay), off, created:p.created, mine:own,
      real:own||(tvl>=100&&(off==null||Math.abs(off)<=0.1)), lpCut:/Raydium CLMM/.test(venue)?0.84:1,
      ray:R?{w:r2(R.week?.volume), wf:r2(R.week?.volumeFee), m:r2(R.month?.volume), mf:r2(R.month?.volumeFee), apr7:R.week?.feeApr!=null?r2(R.week.feeApr):null, d:r2(R.day?.volume)}:null, vol24:r2(p.vol24)}); }
  // trading day by day, kept beyond the 60 days the index serves
  for(const P of pools.filter(x=>x.real)){ const c=await candles(T,P.id); const old=P0?.tokens?.find(t=>t.key===T.key)?.pools?.find(q=>q.id===P.id)?.vol||{};
    P.vol={...old,...(c||{})}; const ks=Object.keys(P.vol).sort(); if(ks.length>KEEP) for(const k of ks.slice(0,ks.length-KEEP)) delete P.vol[k]; P.volOk=!!c; }
  // LP books: the deck's pools and any real pool of $1k or more
  for(const P of pools.filter(x=>x.real&&(x.mine||x.tvl>=1000))){
    try{ if(P.venue==='Uniswap v4') P.book=await bookV4(P);
         else if(P.venue==='Raydium CLMM'){ const m=mine.get(P.id); P.book=await bookClmm(P, m?m.mints:new Set()); if(P.book?.lpCut!=null) P.lpCut=r4(P.book.lpCut); }
         else P.book=null; }catch(e){ P.book=null; } }
  const days=[...new Set(pools.filter(x=>x.real).flatMap(x=>Object.keys(x.vol||{})))].sort();
  const market={}; for(const d of days) market[d]=r2(pools.filter(x=>x.real&&x.vol).reduce((s,x)=>s+(x.vol[d]||0),0));
  out.tokens.push({key:T.key, sym:T.sym, chain:T.chain, price:mpx, count:list.length, pools, market});
  poolsN+=list.length; realN+=pools.filter(x=>x.real).length;
}

/* ---------- the deck's own pools: share, time in range, fees ---------- */
for(const [id,m] of mine){
  const T=out.tokens.find(t=>t.key===m.tok), P=T?.pools.find(p=>String(p.id).toLowerCase()===String(id).toLowerCase());
  const old=P0?.mine?.find(x=>x.id===id)||{};
  const sh={...(old.share||{}), ...byDay(shareOf(m.ck,id))};
  const fe={...(old.fees||{}), ...feesByDay(m.ids)};
  const today=day(Date.now()), shareNow=m.poolL&&m.poolL>0n?r4(Number(m.inL*1000000n/m.poolL)/1e6):null;
  const ourL={...(old.ourL||{}), [today]:m.inL.toString()};
  const value={...(old.value||{}), [today]:r2(m.value)};
  const exp={}; if(P?.vol) for(const [d,s] of Object.entries(sh)) if(P.vol[d]!=null&&P.fee!=null) exp[d]=r2(P.vol[d]*P.fee*(P.lpCut??1)*s.s);
  const trim=o=>{ const ks=Object.keys(o).sort(); for(const k of ks.slice(0,Math.max(0,ks.length-KEEP))) delete o[k]; return o; };
  out.mine.push({id, tok:m.tok, n:m.ids.length, valueNow:r2(m.value), shareNow, tvlShareNow:P?.tvl>0?r4(m.value/P.tvl):null,
    share:trim(sh), fees:trim(fe), exp:trim(exp), ourL:trim(ourL), value:trim(value), since:Object.keys(sh).sort()[0]||null});
}

/* ---------- the checks ---------- */
const C=(tok,grp,st,t,x)=>out.checks.push({tok,grp,st,t,x});
const pct=x=>(x*100).toFixed(1)+'%', usd=x=>x==null?'—':'$'+(x>=1e4?(x/1e3).toFixed(1)+'k':x>=100?Math.round(x).toLocaleString('en-US'):x.toFixed(2));
for(const T of out.tokens){
  const off=T.pools.filter(p=>!p.real&&p.off!=null&&Math.abs(p.off)>0.1);
  if(off.length) C(T.key,'pub','ok','Prices agree · '+(T.pools.filter(p=>p.real).length)+' of '+T.pools.length+' pools', off.length+' pools are priced '+Math.round(Math.min(...off.map(p=>Math.abs(p.off)))*100)+'–'+Math.round(Math.max(...off.map(p=>Math.abs(p.off)))*100)+'% off the market and hold '+usd(off.reduce((s,p)=>s+(p.tvl||0),0))+'; they are left out of the market');
  for(const P of T.pools.filter(p=>p.real&&p.tvlRay!=null&&p.tvlIdx!=null)){
    const a=Math.abs(P.tvlIdx/Math.max(P.tvlRay,0.01)-1);
    C(T.key,'pub',a<=0.1?'ok':'look','Size, two sources · '+P.name+(P.fee!=null?' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':''),'price index '+usd(P.tvlIdx)+' · Raydium '+usd(P.tvlRay)+' · '+pct(a)+' apart'+(a>0.1?' · Raydium’s figure is used':'')); }
  const big=T.pools.filter(p=>!p.real&&p.tvlRay!=null&&p.tvlIdx>1000&&p.tvlRay<p.tvlIdx/10);
  if(big.length) C(T.key,'pub','look','Size, two sources · '+big.length+' pool(s) the price index overstates', big.map(p=>p.name+': index '+usd(p.tvlIdx)+', Raydium '+usd(p.tvlRay)).join(' · ')+' · left out of the market');
  for(const P of T.pools.filter(p=>p.real&&p.ray&&p.ray.m>0&&p.fee)){ const r=P.ray.mf/P.ray.m;
    C(T.key,'pub',Math.abs(r-P.fee)<=Math.max(0.0015,P.fee*0.05)?'ok':'look','Fee rate · '+P.name+' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%','Raydium’s 30-day fees ÷ volume = '+(r*100).toFixed(3)+'%'); }
  for(const P of T.pools.filter(p=>p.book&&p.book.sum!=null)) C(T.key,'pub',Math.abs(P.book.sum-1)<=0.01?'ok':'look','LP book adds up · '+P.name+' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'% ('+P.venue+')','positions at the price = '+pct(P.book.sum)+' of the pool’s own liquidity figure');
  for(const P of T.pools.filter(p=>p.mine&&p.book===null)) C(T.key,'pub','na','LP book · '+P.name+' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'% ('+P.venue+')','not readable from the free sources yet');
  for(const P of T.pools.filter(p=>p.real&&!p.volOk)) C(T.key,'pub','na','Trading · '+P.name,'the price index did not answer this run; the days already recorded are kept');
  // the deck's own figures against the pool's
  for(const M of out.mine.filter(m=>m.tok===T.key)){ const P=T.pools.find(p=>String(p.id).toLowerCase()===String(M.id).toLowerCase()); if(!P) continue;
    const lab=P.name+(P.fee!=null?' '+(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':'')+' · '+P.venue;
    const ds=Object.keys(M.fees).filter(d=>M.exp[d]!=null).sort().slice(-7), fa=ds.reduce((s,d)=>s+M.fees[d],0), fx=ds.reduce((s,d)=>s+M.exp[d],0);
    if(ds.length&&fx>0.5){ const a=Math.abs(fa/fx-1); C(T.key,'mine',a<=0.25?'ok':'look','Fees · '+lab,'your positions’ own fee counters '+usd(fa)+' vs your share × the pool’s fees '+usd(fx)+' over '+ds.length+' day(s) · '+pct(a)+' apart'); }
    else C(T.key,'mine','na','Fees · '+lab,'needs a day of both records; the first comes with the next run');
    if(P.book&&P.book.mineFound!=null){ const n=M.n; C(T.key,'mine',P.book.mineFound===n?'ok':'look','Positions · '+lab,P.book.mineFound+' of your '+n+' position(s) found in the pool’s LP book'); }
    if(M.tvlShareNow!=null) C(T.key,'mine',M.tvlShareNow<=1.005?'ok':'look','Value · '+lab,'your positions are '+pct(M.tvlShareNow)+' of the pool’s size'+(M.tvlShareNow>1.005?' · more than the pool holds, so one of the two figures is wrong':''));
    const sd=Object.keys(M.share).sort().slice(-7), tin=sd.length?sd.reduce((s,d)=>s+M.share[d].tin,0)/sd.length:null;
    if(tin!=null) C(T.key,'mine',tin>=0.9?'ok':'look','Time in range · '+lab,'in range '+pct(tin)+' of the last '+sd.length+' day(s)');
    const fd=Object.keys(M.fees).sort().slice(-7), f7=fd.reduce((s,d)=>s+M.fees[d],0);
    if(fd.length>=3&&M.valueNow>0&&P.tvl>0&&P.vol&&P.fee){ const myApr=f7/fd.length*365/M.valueNow, pv=fd.reduce((s,d)=>s+(P.vol[d]||0),0)/fd.length, poolApr=pv*P.fee*(P.lpCut??1)*365/P.tvl;
      C(T.key,'perf','ok','Fee yield · '+lab,'yours '+Math.round(myApr*100)+'% a year vs '+Math.round(poolApr*100)+'% for the pool’s average dollar'); } }
}
writeJ(OUT+'/pools-'+SLUG+'.json', out);
const cnt=s=>out.checks.filter(c=>c.st===s).length;
console.log('pools listed: '+poolsN+' · trading: '+realN+' · own pools: '+out.mine.length+' · days of trading kept: '+Math.max(0,...out.tokens.map(t=>Object.keys(t.market).length))
  +' · days of share: '+Math.max(0,...out.mine.map(m=>Object.keys(m.share).length))+' · days of fees: '+Math.max(0,...out.mine.map(m=>Object.keys(m.fees).length)));
console.log('checks: '+cnt('ok')+' agree · '+cnt('look')+' to look at · '+cnt('na')+' not readable');

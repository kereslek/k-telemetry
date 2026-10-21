/* LCX's market on Ethereum, day by day, rebuilt from the chain and set against what WHY FEES MOVED
   uses. For each main pool (the Uniswap v4 LCX/ETH pool and the Uniswap v3 LCX/WETH pool): its
   trading and its LPs' fees from its own Swap events (each v4 swap carries its own fee rate; the v3
   pool's LPs keep what the protocol leaves them), ETH priced by the day; beside GeckoTerminal's
   daily figures and the sealed census's records of the same pools; then the census's all-LPs'-fees
   total for the day against the one the chain gives. Pools listed off the market today are shown
   with their trading and how far their price stood from the market's on each day they traded.

   Public log: market data only. It says nothing about whose liquidity is whose and prints nothing
   from the census but its pool records and totals. */
import crypto from 'node:crypto';
const SITE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/', PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const LCX='0x8cd41041505885ef0ad3858181d66f17be8aae7e', WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const DAYS=+(process.env.DAYS||62), DAY=864e5;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt,tries=3,ms=30000){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(ms)}); if(r.ok) return await r.json(); if(r.status===429) await sleep(6000); }catch(e){} await sleep(1500*(k+1)); } return null; }
const day=ms=>new Date(ms).toISOString().slice(0,10);
const usd=x=>x==null||!isFinite(x)?'—':'$'+(Math.abs(x)>=1e6?(x/1e6).toFixed(2)+'M':Math.abs(x)>=1e4?(x/1e3).toFixed(1)+'k':Math.abs(x)>=100?x.toFixed(0):x.toFixed(2));
const pct=x=>x==null||!isFinite(x)?'—':(x*100).toFixed(1)+'%';
const lp=(s,n)=>String(s).padStart(n);
const DAYLIST=[]; for(let i=DAYS-1;i>=0;i--) DAYLIST.push(day(Date.now()-i*DAY));

/* ---------- GeckoTerminal ---------- */
const GT='https://api.geckoterminal.com/api/v2'; let gtLast=0;
const gt=async path=>{ const w=2300-(Date.now()-gtLast); if(w>0) await sleep(w); gtLast=Date.now(); return j(GT+path,{headers:{accept:'application/json;version=20230302'}}); };
const list=[]; for(let page=1;page<=5;page++){ const r=await gt('/networks/eth/tokens/'+LCX+'/pools?page='+page+'&sort=h24_volume_usd_desc&include=dex'); const a=r?.data||[]; list.push(...a); if(a.length<20) break; }
const pools=list.map(x=>{ const a=x.attributes||{}, fm=String(a.name||'').match(/([\d.]+)%/);
  return {id:String(a.address).toLowerCase(), name:String(a.name||'?').replace(/\s+[\d.]+%$/,''), dex:x.relationships?.dex?.data?.id||'?', fee:fm?+fm[1]/100:null, tvl:+a.reserve_in_usd||0}; });
const v4=pools.filter(p=>p.id.length===66&&/LCX \/ ETH/.test(p.name)).sort((a,b)=>b.tvl-a.tvl)[0];
const v3=pools.filter(p=>p.id.length===42&&/uniswap/.test(p.dex)&&/LCX \/ WETH/.test(p.name)).sort((a,b)=>b.tvl-a.tvl)[0];
if(!v4||!v3){ console.log('the two main LCX pools were not both listed by GeckoTerminal: nothing done'); process.exit(1); }
async function candles(id, tok){ const r=await gt('/networks/eth/pools/'+id+'/ohlcv/day?limit='+(DAYS+2)+'&currency=usd'+(tok?'&token='+tok:'')); if(!r) return null;
  const m=new Map(); for(const c of r?.data?.attributes?.ohlcv_list||[]) m.set(day(c[0]*1000),{close:+c[4], vol:+c[5]}); return m; }

/* ETH in dollars, a close a day (Coinbase; GeckoTerminal's WETH/USDC pool if Coinbase does not answer) */
const ethUsd=new Map();
{ const r=await j('https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=86400&start='+new Date(Date.now()-(DAYS+2)*DAY).toISOString()+'&end='+new Date().toISOString());
  if(Array.isArray(r)) for(const c of r) ethUsd.set(day(c[0]*1000), +c[4]);
  if(ethUsd.size<DAYS-2){ const g=await candles('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', WETH); if(g) for(const [d,c] of g) if(!ethUsd.has(d)&&c.close>0) ethUsd.set(d,c.close); } }

/* ---------- the chain: Blockscout serves whole histories ---------- */
const BS='https://eth.blockscout.com';
async function bsLogs(params){
  const out=[], seen=new Set(); let from=params.fromBlock||0, failed=false;
  for(let n=0;n<200;n++){ const q=new URLSearchParams({module:'logs',action:'getLogs',...params,fromBlock:String(from),toBlock:'latest'});
    const r=await j(BS+'/api?'+q,{},4,60000); const a=Array.isArray(r?.result)?r.result:null; if(!a){ failed=true; break; }
    let added=0; for(const l of a){ const k=l.transactionHash+':'+l.logIndex; if(seen.has(k)) continue; seen.add(k); out.push(l); added++; }
    if(a.length<1000||!added) break; from=parseInt(a[a.length-1].blockNumber,16); }
  return {logs:out, failed}; }
const tipR=await j('https://eth.blockscout.com/api/eth-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]})});
const tip=tipR?.result?parseInt(tipR.result,16):null; if(!tip){ console.log('no block number: nothing done'); process.exit(1); }
const fromBlk=tip-Math.ceil((DAYS+1)*86400/12.05);
const sInt=(h,bits)=>{ let v=BigInt('0x'+h); if(bits<256) v&=(1n<<BigInt(bits))-1n; if(v>=(1n<<BigInt(bits-1))) v-=1n<<BigInt(bits); return v; };
const wd=(data,i)=>data.slice(2+64*i,2+64*(i+1));
const PM4='0x000000000004444c5dc75cb358380d2e3de08a90';
const SW3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', SW4='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
/* v3: amounts are what entered the pool (token0 LCX, token1 WETH): the ETH side is the size, the fee
   is taken from what went in. v4: amounts are the swapper's (native ETH first): the same, with the
   swap's own fee rate in millionths. */
const chain={};
for(const [k,P] of [['v3',v3],['v4',v4]]){
  const r=k==='v4'?await bsLogs({address:PM4, topic0:SW4, topic1:P.id, topic0_1_opr:'and', fromBlock:fromBlk}):await bsLogs({address:P.id, topic0:SW3, fromBlock:fromBlk});
  const by=new Map(), rates=new Map();
  for(const l of r.logs){ const d=day(parseInt(l.timeStamp,16)*1000), e=by.get(d)||{n:0, eth:0, feeEth:0};
    const a0=sInt(wd(l.data,0),k==='v4'?128:256), a1=sInt(wd(l.data,1),k==='v4'?128:256);
    const ethAmt=Math.abs(Number(k==='v4'?a0:a1))/1e18, f=k==='v4'?Number(BigInt('0x'+wd(l.data,5)))/1e6:P.fee;
    if(k==='v4') rates.set(f,(rates.get(f)||0)+1);
    e.n++; e.eth+=ethAmt; e.feeEth+=ethAmt*f; e.lcx=(e.lcx||0)+Math.abs(Number(k==='v4'?a1:a0))/1e18; by.set(d,e); }
  chain[k]={by, rates, n:r.logs.length, failed:r.failed}; }

/* the v3 pool's protocol cut (Uniswap's fee switch): the LPs keep 1 - 1/n of each fee */
let lpCut3=1; { const r=await j('https://eth.blockscout.com/api/eth-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:v3.id,data:'0x3850c7bd'},'latest']})});
  if(r?.result){ const fp=parseInt(wd(r.result,5),16), cut=n=>n>0?1-1/n:1; lpCut3=(cut(fp%16)+cut(fp>>4))/2; } }

const gtv={v3:await candles(v3.id), v4:await candles(v4.id)};

/* ---------- the sealed census: its records of these pools, and its all-LPs'-fees total ---------- */
let C=null;
if(PASS){ const L=await j(SITE+'lock.json?t='+Date.now());
  if(L){ const KEY=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').subarray(0,32);
    const open=e=>{ if(!(e&&e.lock===1)) return e; const all=Buffer.from(e.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(e.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
      return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); };
    const x=await j(SITE+'pools-main.json?t='+Date.now()); try{ C=x?open(x):null; }catch(e){ C=null; } } }
const T=C?.tokens?.find(t=>t.key==='lcx'), cP=id=>T?.pools?.find(p=>String(p.id).toLowerCase()===id);
const c3=cP(v3.id), c4=cP(v4.id), real=(T?.pools||[]).filter(p=>p.real);
const pie=d=>real.reduce((s,P)=>s+((P.vol&&P.vol[d])||0)*(P.fee||0)*(P.lpCut??1),0);

/* ---------- report ---------- */
console.log('LCX on Ethereum, '+DAYS+' days to '+DAYLIST[DAYLIST.length-1]+' (UTC) · ETH priced on '+[...ethUsd.keys()].filter(d=>DAYLIST.includes(d)).length+' of '+DAYS+' days');
console.log('Uniswap v4 LCX/ETH: '+chain.v4.n+' swaps read'+(chain.v4.failed?' (the history was cut short)':'')+' · fee rates seen: '+[...chain.v4.rates].sort((a,b)=>b[1]-a[1]).map(([f,n])=>(f*100).toFixed(4).replace(/\.?0+$/,'')+'% ×'+n).join(', '));
console.log('Uniswap v3 LCX/WETH '+(v3.fee*100)+'%: '+chain.v3.n+' swaps read'+(chain.v3.failed?' (the history was cut short)':'')+' · its LPs keep '+(lpCut3*100).toFixed(1)+'% of each fee'+(c3?' (the census uses '+((c3.lpCut??1)*100).toFixed(1)+'%)':''));
// which side is ETH: LCX priced from the swaps must come out at LCX's market price
for(const k of ['v4','v3']){ const ds=[...chain[k].by.keys()].sort().reverse().filter(d=>ethUsd.get(d)&&chain[k].by.get(d).lcx>0).slice(0,7);
  const e=ds.reduce((s,d)=>s+chain[k].by.get(d).eth*ethUsd.get(d),0), l=ds.reduce((s,d)=>s+chain[k].by.get(d).lcx,0);
  console.log('  '+k+': LCX priced from its swaps over its last '+ds.length+' trading day(s): '+(l>0?'$'+(e/l).toPrecision(4):'—')+' (the side read as ETH is '+(l>0&&e/l<1?'ETH, as it should be':'NOT ETH: the sizes below are wrong')+')'); }
console.log('census: '+(C?'opened, read '+((Date.now()-C.t)/3600e3).toFixed(1)+' h ago · '+real.length+' LCX pools counted in its total · its fee rate for v4 '+(c4?.fee!=null?(c4.fee*100)+'%':'—')+', for v3 '+(c3?.fee!=null?(c3.fee*100)+'%':'—'):'not opened'));
console.log('\n            ------------- v4 LCX/ETH -------------   ------------- v3 LCX/WETH ------------   ---- all LPs’ fees ----');
console.log('day (UTC)    swaps   chain $   Gecko $  census $    swaps   chain $   Gecko $  census $    census   chain   ratio');
const tot={c:0,k:0}; let gap3=0, gap4=0, zero3=0;
for(const d of DAYLIST){ const px=ethUsd.get(d), s4=chain.v4.by.get(d)||{n:0,eth:0,feeEth:0}, s3=chain.v3.by.get(d)||{n:0,eth:0,feeEth:0};
  const ch4=px?s4.eth*px:null, ch3=px?s3.eth*px:null, f4=px?s4.feeEth*px:null, f3=px?s3.feeEth*px*lpCut3:null;
  const g4=gtv.v4?.get(d)?.vol, g3=gtv.v3?.get(d)?.vol, k4=c4?.vol?.[d], k3=c3?.vol?.[d];
  const pc=C?pie(d):null, pk=f4!=null&&f3!=null?f4+f3:null;
  if(pc!=null&&pk!=null){ tot.c+=pc; tot.k+=pk; }
  if(ch3>50&&!(k3>0)) zero3++; if(ch3!=null&&k3!=null&&ch3>50&&Math.abs(k3/ch3-1)>0.25) gap3++; if(ch4!=null&&k4!=null&&ch4>50&&Math.abs(k4/ch4-1)>0.25) gap4++;
  console.log(d+'  '+lp(s4.n,6)+' '+lp(usd(ch4),9)+' '+lp(usd(g4),9)+' '+lp(usd(k4),9)+'   '+lp(s3.n,6)+' '+lp(usd(ch3),9)+' '+lp(usd(g3),9)+' '+lp(usd(k3),9)
    +'   '+lp(usd(pc),7)+' '+lp(usd(pk),7)+' '+lp(pc>0&&pk>0?(pc/pk).toFixed(2):'—',7)); }
console.log('\nover the '+DAYS+' days: census total '+usd(tot.c)+' · from the chain '+usd(tot.k)+(tot.k>0?' · ratio '+(tot.c/tot.k).toFixed(2):''));
console.log('days the v3 pool traded over $50 with no census volume: '+zero3+' · days its census volume is more than 25% off the chain’s: '+gap3+' · v4: '+gap4);

/* pools GeckoTerminal lists that the census leaves out today: did they trade at the market's price before? */
const others=pools.filter(p=>p.id!==v3.id&&p.id!==v4.id&&p.tvl>=100);
console.log('\nother LCX pools of $100 or more ('+others.length+'): trading and price against the market on the days they traded');
const mk=await candles(v4.id, LCX);
for(const P of others.slice(0,12)){ const c=await candles(P.id, LCX); if(!c){ console.log('  '+P.name+' '+(P.fee!=null?(P.fee*100)+'%':'')+': no daily record'); continue; }
  const act=[...c].filter(([d,x])=>DAYLIST.includes(d)&&x.vol>0); const vol=act.reduce((s,[,x])=>s+x.vol,0);
  const offs=act.map(([d,x])=>{ const m=mk?.get(d)?.close; return m>0&&x.close>0?x.close/m-1:null; }).filter(x=>x!=null);
  const near=offs.filter(o=>Math.abs(o)<=0.1).length;
  console.log('  '+(P.name+' '+(P.fee!=null?(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':'')).padEnd(26)+' '+P.dex.padEnd(20)+' traded on '+act.length+' day(s), '+usd(vol)+(act.length?' · its LPs’ fees then '+usd(vol*(P.fee||0)):'')+' · priced within 10% of the market on '+near+' of '+offs.length+' day(s)'+(offs.length?' (median '+pct(offs.sort((a,b)=>a-b)[offs.length>>1])+')':'')); }

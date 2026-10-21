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
/* Uniswap's fee switch. v3: the pool's feeProtocol (each side 1/n of the fee to the protocol), now and
   every time it was set (SetFeeProtocol). v4: the pool's protocol fee and LP fee now (StateView), and
   every ProtocolFeeUpdated for it. */
let keccak=null; try{ const m=await import('js-sha3'); keccak=m.keccak256||m.default?.keccak256||null; }catch(e){}
const topic=s=>keccak?'0x'+keccak(s):null;
const NODES=['https://eth.blockscout.com/api/eth-rpc','https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth'];
async function call(to,data){ for(const u of NODES){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']})},2,20000); if(r?.result&&r.result.length>2) return r.result; } return null; }
const cut=n=>n>0?1-1/n:1, cutOf=fp=>(cut(fp%16)+cut(fp>>4))/2;
let lpCut3=null, fp3=null; { const r=await call(v3.id,'0x3850c7bd'); if(r){ fp3=Number(BigInt('0x'+wd(r,5))&0xffn); lpCut3=cutOf(fp3); } }
const sw3=[]; { const t=topic('SetFeeProtocol(uint8,uint8,uint8,uint8)'); if(t){ const r=await bsLogs({address:v3.id, topic0:t, fromBlock:0});
  for(const l of r.logs) sw3.push({d:day(parseInt(l.timeStamp,16)*1000), old:[Number(BigInt('0x'+wd(l.data,0))),Number(BigInt('0x'+wd(l.data,1)))], now:[Number(BigInt('0x'+wd(l.data,2))),Number(BigInt('0x'+wd(l.data,3)))]}); } }
const SV4='0x7ffe42c4a5deea5b0fec41c94c136cf115597227';
let pf4=null, lf4=null; { const r=await call(SV4,'0xc815641c'+v4.id.slice(2)); if(r){ pf4=Number(BigInt('0x'+wd(r,2))); lf4=Number(BigInt('0x'+wd(r,3))); } }
const sw4=[]; { const t=topic('ProtocolFeeUpdated(bytes32,uint24)'); if(t){ const r=await bsLogs({address:PM4, topic0:t, topic1:v4.id, topic0_1_opr:'and', fromBlock:0});
  for(const l of r.logs) sw4.push({d:day(parseInt(l.timeStamp,16)*1000), pf:Number(BigInt('0x'+wd(l.data,0)))}); } }
/* the v3 LPs' part of the fee on a day, from the switch's history (before its first setting: all of it) */
const cut3On=d=>{ let c=sw3.length?cutOf(sw3[0].old[0]+16*sw3[0].old[1]):(lpCut3??1); for(const e of sw3) if(e.d<=d) c=cutOf(e.now[0]+16*e.now[1]); return c; };
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
    const lpRate=k==='v4'&&pf4!=null?Math.max(0,f-((pf4&0xfff)+(pf4>>12))/2/1e6):f;
    e.n++; e.eth+=ethAmt; e.feeEth+=ethAmt*lpRate; e.lcx=(e.lcx||0)+Math.abs(Number(k==='v4'?a1:a0))/1e18; by.set(d,e); }
  chain[k]={by, rates, n:r.logs.length, failed:r.failed}; }


const gtv={v3:await candles(v3.id), v4:await candles(v4.id)};

/* ---------- the sealed census: its records of these pools, and its all-LPs'-fees total ---------- */
let C=null;
if(PASS){ const L=await j(SITE+'lock.json?t='+Date.now());
  if(L){ const KEY=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').subarray(0,32);
    const open=e=>{ if(!(e&&e.lock===1)) return e; const all=Buffer.from(e.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(e.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
      return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); };
    const x=await j(SITE+'pools-main.json?t='+Date.now()); try{ C=x?open(x):null; }catch(e){ C=null; } } }
const T=C?.tokens?.find(t=>t.key==='lcx'), cP=id=>T?.pools?.find(p=>String(p.id).toLowerCase()===id);
/* the census's all-LPs'-fees total as the page counts it: a pool on the days it stood at the market (its
   day-by-day record), or, in a census from before that record, the pools at the market today */
const c3=cP(v3.id), c4=cP(v4.id), real=(T?.pools||[]).filter(p=>p.real||(p.on&&Object.values(p.on).some(Boolean)));
const onD=(P,d)=>P.on&&P.on[d]!=null?P.on[d]===1:!!P.real;
const pie=d=>real.reduce((s,P)=>s+(onD(P,d)?((P.vol&&P.vol[d])||0)*(P.fee||0)*(P.lpCut??1):0),0);

/* ---------- report ---------- */
console.log('LCX on Ethereum, '+DAYS+' days to '+DAYLIST[DAYLIST.length-1]+' (UTC) · ETH priced on '+[...ethUsd.keys()].filter(d=>DAYLIST.includes(d)).length+' of '+DAYS+' days');
console.log('Uniswap v4 LCX/ETH: '+chain.v4.n+' swaps read'+(chain.v4.failed?' (the history was cut short)':'')+' · fee rates seen: '+[...chain.v4.rates].sort((a,b)=>b[1]-a[1]).map(([f,n])=>(f*100).toFixed(4).replace(/\.?0+$/,'')+'% ×'+n).join(', '));
console.log('Uniswap v3 LCX/WETH '+(v3.fee*100)+'%: '+chain.v3.n+' swaps read'+(chain.v3.failed?' (the history was cut short)':'')+' · its LPs keep '+(lpCut3!=null?(lpCut3*100).toFixed(1)+'% of each fee now (feeProtocol '+fp3+')':'— (the pool did not answer)')+(c3?' · the census uses '+((c3.lpCut??1)*100).toFixed(1)+'% for every day':''));
console.log('  its fee switch set '+sw3.length+' time(s)'+(keccak?'':' (event signature not computed: not read)')+(sw3.length?': '+sw3.map(e=>e.d+' '+e.old.join('/')+' → '+e.now.join('/')+' (LPs keep '+(cutOf(e.now[0]+16*e.now[1])*100).toFixed(1)+'%)').join(' · '):''));
console.log('Uniswap v4 LCX/ETH now: LP fee '+(lf4!=null?(lf4/1e4).toFixed(4).replace(/\.?0+$/,'')+'%':'—')+' · protocol fee '+(pf4!=null?((pf4&0xfff)/1e4)+'% / '+((pf4>>12)/1e4)+'% (each direction)':'—')+' · protocol fee changes for the pool: '+sw4.length+(sw4.length?' ('+sw4.map(e=>e.d+' → '+((e.pf&0xfff)/1e4)+'%').join(', ')+')':''));
// which side is ETH: LCX priced from the swaps must come out at LCX's market price
for(const k of ['v4','v3']){ const ds=[...chain[k].by.keys()].sort().reverse().filter(d=>ethUsd.get(d)&&chain[k].by.get(d).lcx>0).slice(0,7);
  const e=ds.reduce((s,d)=>s+chain[k].by.get(d).eth*ethUsd.get(d),0), l=ds.reduce((s,d)=>s+chain[k].by.get(d).lcx,0);
  console.log('  '+k+': LCX priced from its swaps over its last '+ds.length+' trading day(s): '+(l>0?'$'+(e/l).toPrecision(4):'—')+' (the side read as ETH is '+(l>0&&e/l<1?'ETH, as it should be':'NOT ETH: the sizes below are wrong')+')'); }
console.log('census: '+(C?'opened, read '+((Date.now()-C.t)/3600e3).toFixed(1)+' h ago · '+real.length+' LCX pools counted in its total ('+real.filter(p=>!p.real).length+' of them only on the days they stood at the market) · its fee rate for v4 '+(c4?.fee!=null?(c4.fee*100)+'%':'—')+', for v3 '+(c3?.fee!=null?(c3.fee*100)+'%':'—'):'not opened'));
console.log('\n            ------------- v4 LCX/ETH -------------   ------------- v3 LCX/WETH ------------   ---- all LPs’ fees ----');
console.log('day (UTC)    swaps   chain $   Gecko $  census $    swaps   chain $   Gecko $  census $    census   chain   ratio');
const tot={c:0,k:0}; let gap3=0, gap4=0, zero3=0;
for(const d of DAYLIST){ const px=ethUsd.get(d), s4=chain.v4.by.get(d)||{n:0,eth:0,feeEth:0}, s3=chain.v3.by.get(d)||{n:0,eth:0,feeEth:0};
  const ch4=px?s4.eth*px:null, ch3=px?s3.eth*px:null, f4=px?s4.feeEth*px:null, f3=px?s3.feeEth*px*cut3On(d):null;
  const g4=gtv.v4?.get(d)?.vol, g3=gtv.v3?.get(d)?.vol, k4=c4?.vol?.[d], k3=c3?.vol?.[d];
  const pc=C?pie(d):null, pk=f4!=null&&f3!=null?f4+f3:null;
  if(pc!=null&&pk!=null){ tot.c+=pc; tot.k+=pk; }
  if(ch3>50&&!(k3>0)) zero3++; if(ch3!=null&&k3!=null&&ch3>50&&Math.abs(k3/ch3-1)>0.25) gap3++; if(ch4!=null&&k4!=null&&ch4>50&&Math.abs(k4/ch4-1)>0.25) gap4++;
  console.log(d+'  '+lp(s4.n,6)+' '+lp(usd(ch4),9)+' '+lp(usd(g4),9)+' '+lp(usd(k4),9)+'   '+lp(s3.n,6)+' '+lp(usd(ch3),9)+' '+lp(usd(g3),9)+' '+lp(usd(k3),9)
    +'   '+lp(usd(pc),7)+' '+lp(usd(pk),7)+' '+lp(pc>0&&pk>0?(pc/pk).toFixed(2):'—',7)); }
console.log('\nover the '+DAYS+' days: census total '+usd(tot.c)+' · from the chain '+usd(tot.k)+(tot.k>0?' · ratio '+(tot.c/tot.k).toFixed(2):''));
console.log('days the v3 pool traded over $50 with no census volume: '+zero3+' · days its census volume is more than 25% off the chain’s: '+gap3+' · v4: '+gap4);

/* pools GeckoTerminal lists that the census leaves out today: did they trade at the market's price
   before? The market's price on a day: LCX in the two main pools, weighted by their trading. */
const others=pools.filter(p=>p.id!==v3.id&&p.id!==v4.id&&p.tvl>=100);
console.log('\nother LCX pools of $100 or more ('+others.length+'): trading and price against the market on the days they traded');
const k3=await candles(v3.id, LCX), k4=await candles(v4.id, LCX), mkt=new Map();
for(const d of DAYLIST){ const a=k3?.get(d), b=k4?.get(d), va=a?.vol||0, vb=b?.vol||0;
  const px=va+vb>0?((a?.close||0)*va+(b?.close||0)*vb)/(va+vb):(a?.close||b?.close||null); if(px>0) mkt.set(d,px); }
const extra=new Map();   // day → the LPs' fees of pools that stood within 10% of the market that day
for(const P of others.slice(0,14)){ const c=await candles(P.id, LCX); if(!c){ console.log('  '+P.name+' '+(P.fee!=null?(P.fee*100)+'%':'')+': no daily record'); continue; }
  const act=[...c].filter(([d,x])=>DAYLIST.includes(d)&&x.vol>0); const vol=act.reduce((s,[,x])=>s+x.vol,0);
  const offs=act.map(([d,x])=>{ const m=mkt.get(d); return m>0&&x.close>0?{d, o:x.close/m-1, v:x.vol}:null; }).filter(Boolean);
  const near=offs.filter(o=>Math.abs(o.o)<=0.1); for(const o of near) extra.set(o.d,(extra.get(o.d)||0)+o.v*(P.fee||0));
  const med=offs.length?offs.map(o=>o.o).sort((a,b)=>a-b)[offs.length>>1]:null;
  console.log('  '+(P.name+' '+(P.fee!=null?(P.fee*100).toFixed(2).replace(/\.?0+$/,'')+'%':'')).padEnd(26)+' '+P.dex.padEnd(20)+' traded on '+act.length+' day(s), '+usd(vol)
    +' · within 10% of the market on '+near.length+' of '+offs.length+' (median '+pct(med)+')'+(near.length?' · its LPs’ fees on those days '+usd(near.reduce((s,o)=>s+o.v*(P.fee||0),0))+' ('+near.map(o=>o.d.slice(5)).join(' ')+')':'')); }

/* the all-LPs'-fees total three ways: the census's; the chain's two main pools (v3 cut by the day's
   switch setting, v4 net of the protocol's part); and that with every other pool on the days it stood
   within 10% of the market */
console.log('\nall LCX LPs’ fees a day: census · main pools from the chain · and with other pools at the market that day');
let sc=0, sk=0, sx=0;
for(const d of DAYLIST){ const px=ethUsd.get(d); if(!px) continue; const s4=chain.v4.by.get(d), s3=chain.v3.by.get(d);
  const k=(s4?s4.feeEth*px:0)+(s3?s3.feeEth*px*cut3On(d):0), x=k+(extra.get(d)||0), c=C?pie(d):null;
  sc+=c||0; sk+=k; sx+=x;
  if(extra.get(d)||Math.abs((c||0)-k)>Math.max(1,0.03*k)) console.log('  '+d+'  '+lp(usd(c),8)+'  '+lp(usd(k),8)+'  '+lp(usd(x),8)+(extra.get(d)?'   +'+usd(extra.get(d))+' from other pools':'')); }
console.log('  over the '+DAYS+' days: census '+usd(sc)+' · main pools '+usd(sk)+' · with other pools at the market '+usd(sx)+' (days not listed agree within 3%)');

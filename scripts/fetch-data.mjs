/* Server-side data refresh for ARC // LP COMMAND.
   Runs in GitHub Actions (Node 20, no deps). Fetches Uniswap V3 + Raydium CLMM
   position data and writes data.json for the static dashboard to consume. */

const ETH_IDS = [1338795, 1342410, 1340170, 1340238, 1339457];
const SOL_WALLETS = [
  '3MwYtBaC5eM3JAaZX4XB4SrXhDempfXZsvX3rcZ1Syn2',
  '5RbHAKi1Yrj9amYo5cgN7fpLx13CJXb7RyVi5bYTicca',
];
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://eth.llamarpc.com','https://1rpc.io/eth','https://rpc.mevblocker.io'];
const SOL_RPCS = ['https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com','https://solana.drpc.org'];

const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88';
const FACTORY='0x1f98431c8ad98523631ae4a59f267346ea31f984';
const CHAINLINK_ETH='0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
const CHAINLINK_BTC='0xf4030086522a5beea4988f8ca5b36dba0d0f58a6';
const SEL={positions:'0x99fbab88',ownerOf:'0x6352211e',getPool:'0x1698ee82',slot0:'0x3850c7bd',symbol:'0x95d89b41',decimals:'0x313ce567',latestAnswer:'0x50d25bcd',collect:'0xfc6f7865'};
const TOPIC_INC='0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DEC='0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COL='0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const STABLES=new Set(['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0xdac17f958d2ee523a2206206994597c13d831ec7','0x6b175474e89094c44da98b954eedeac495271d0f']);
const WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBTC='0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';

const errors=[];
const logErr=(tag,e)=>{ errors.push(tag+': '+String(e&&e.message||e).slice(0,140)); console.error(tag, e&&e.message||e); };
const pad32=h=>h.replace(/^0x/,'').padStart(64,'0');
const word=(d,i)=>'0x'+d.replace(/^0x/,'').slice(i*64,(i+1)*64);
const toSigned=(bi,bits)=>{const mask=(1n<<BigInt(bits))-1n;const m=bi&mask;const max=1n<<BigInt(bits-1);return m>=max?m-(1n<<BigInt(bits)):m;};
const bigToFloat=(bi,dec)=>Number(bi)/Math.pow(10,dec);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function post(url,payload,timeout=15000){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),timeout);
  try{ const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:ctrl.signal});
    if(!r.ok) throw new Error('HTTP '+r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}
async function getJson(url,timeout=15000){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),timeout);
  try{ const r=await fetch(url,{signal:ctrl.signal}); if(!r.ok) throw new Error('HTTP '+r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}
let rpcId=1;
async function eth(method,params,{block}={}){
  let last;
  for(const url of ETH_RPCS){
    try{
      const js=await post(url,{jsonrpc:'2.0',id:rpcId++,method,params});
      if(js.error) throw new Error(js.error.message||JSON.stringify(js.error));
      return js.result;
    }catch(e){ last=e; }
  }
  throw last;
}
const ethCall=(to,data,block='latest',from)=>eth('eth_call',[{to,data,...(from?{from}:{})},block]);
async function sol(method,params){
  let last;
  for(const url of SOL_RPCS){
    try{
      const js=await post(url,{jsonrpc:'2.0',id:rpcId++,method,params});
      if(js.error) throw new Error(js.error.message||JSON.stringify(js.error));
      return js.result;
    }catch(e){ last=e; }
  }
  throw last;
}

/* ---------- v3 math ---------- */
const Q96=2**96, Q64=2**64;
const tickToPrice=t=>Math.pow(1.0001,t);
const tickToSqrt=t=>Math.pow(1.0001,t/2);
function amounts(L,sp,sa,sb){ if(sa>sb)[sa,sb]=[sb,sa]; let a0=0,a1=0;
  if(sp<=sa) a0=L*(sb-sa)/(sa*sb); else if(sp>=sb) a1=L*(sb-sa);
  else { a0=L*(sb-sp)/(sp*sb); a1=L*(sp-sa); } return [a0,a1]; }
function decodeString(res){ try{ const off=Number(BigInt(word(res,0)))/32; const len=Number(BigInt(word(res,off)));
  const hex=res.replace(/^0x/,'').slice((off+1)*64,(off+1)*64+len*2);
  return decodeURIComponent(hex.replace(/(..)/g,'%$1')); }catch(e){ return '???'; } }

/* ---------- ETH pipeline ---------- */
const tokenMeta=new Map();
async function meta(addr){
  addr=addr.toLowerCase();
  if(tokenMeta.has(addr)) return tokenMeta.get(addr);
  let symbol='???',decimals=18;
  try{ symbol=decodeString(await ethCall(addr,SEL.symbol)); }catch(e){}
  try{ decimals=Number(BigInt(await ethCall(addr,SEL.decimals))); }catch(e){}
  const m={symbol:symbol==='WETH'?'ETH':symbol,decimals};
  tokenMeta.set(addr,m); return m;
}
function tokenUsd(addr,counter,price,isT0,ethUsd,btcUsd){
  const a=addr.toLowerCase(),c=counter.toLowerCase();
  if(STABLES.has(a)) return 1; if(a===WETH) return ethUsd; if(a===WBTC) return btcUsd;
  let cu=null; if(STABLES.has(c)) cu=1; else if(c===WETH) cu=ethUsd; else if(c===WBTC) cu=btcUsd;
  if(cu==null||price==null) return null;
  return isT0?price*cu:cu/price;
}
async function ethHistory(id){
  const topicId='0x'+pad32(id.toString(16));
  const logs=await eth('eth_getLogs',[{address:NPM,topics:[[TOPIC_INC,TOPIC_DEC,TOPIC_COL],topicId],fromBlock:'0x'+(12369651).toString(16),toBlock:'latest'}]);
  const parse=lg=>({block:Number(BigInt(lg.blockNumber)),a0:BigInt(word(lg.data,1)),a1:BigInt(word(lg.data,2))});
  return { inc:logs.filter(l=>l.topics[0]===TOPIC_INC).map(parse),
           dec:logs.filter(l=>l.topics[0]===TOPIC_DEC).map(parse),
           col:logs.filter(l=>l.topics[0]===TOPIC_COL).map(parse) };
}
async function fetchEthPosition(id, blockNum, ethUsd, btcUsd){
  const idHex=pad32(id.toString(16));
  const pos=await ethCall(NPM,SEL.positions+idHex);
  const token0='0x'+word(pos,2).slice(-40), token1='0x'+word(pos,3).slice(-40);
  const fee=Number(BigInt(word(pos,4)));
  const tickLower=Number(toSigned(BigInt(word(pos,5)),24)), tickUpper=Number(toSigned(BigInt(word(pos,6)),24));
  const liquidity=BigInt(word(pos,7));
  let owner=null; try{ owner='0x'+(await ethCall(NPM,SEL.ownerOf+idHex)).slice(-40); }catch(e){}
  const [m0,m1]=[await meta(token0),await meta(token1)];
  const pool='0x'+(await ethCall(FACTORY,SEL.getPool+pad32(token0)+pad32(token1)+pad32(fee.toString(16)))).slice(-40);
  const slot0=await ethCall(pool,SEL.slot0);
  const sqrtPriceX96=BigInt(word(slot0,0));
  const tick=Number(toSigned(BigInt(word(slot0,1)),24));
  const MAX='f'.repeat(32).padStart(64,'0');
  const collectData=SEL.collect+idHex+pad32(owner||NPM)+MAX+MAX;
  let f0=bigToFloat(BigInt(word(pos,10)),m0.decimals), f1=bigToFloat(BigInt(word(pos,11)),m1.decimals);
  const feesOwedAt=async blk=>{
    const r=await ethCall(NPM,collectData,blk,owner||undefined);
    return { f0:bigToFloat(BigInt(word(r,0)),m0.decimals), f1:bigToFloat(BigInt(word(r,1)),m1.decimals) };
  };
  try{ const now=await feesOwedAt('latest'); f0=now.f0; f1=now.f1; }catch(e){}
  const d0=m0.decimals,d1=m1.decimals, scale=10**(d0-d1);
  const sp=Number(sqrtPriceX96)/Q96, sa=tickToSqrt(tickLower), sb=tickToSqrt(tickUpper);
  const [ra0,ra1]=amounts(Number(liquidity),sp,sa,sb);
  const amt0=ra0/10**d0, amt1=ra1/10**d1;
  const price=sp*sp*scale, priceLower=tickToPrice(tickLower)*scale, priceUpper=tickToPrice(tickUpper)*scale;
  const usd0=tokenUsd(token0,token1,price,true,ethUsd,btcUsd), usd1=tokenUsd(token1,token0,price,false,ethUsd,btcUsd);
  const valueUsd=(usd0!=null&&usd1!=null)?amt0*usd0+amt1*usd1:null;
  const feesUsd=(usd0!=null&&usd1!=null)?f0*usd0+f1*usd1:null;
  // history + economics
  let hist={inc:[],dec:[],col:[]}, mintTs=null, entryEthUsd=null;
  try{ hist=await ethHistory(id); }catch(e){ logErr('hist#'+id,e); }
  if(hist.inc.length){
    const mintBlock=Math.min(...hist.inc.map(x=>x.block));
    try{ const blk=await eth('eth_getBlockByNumber',['0x'+mintBlock.toString(16),false]); mintTs=Number(BigInt(blk.timestamp))*1000; }catch(e){}
    try{ const r=await ethCall(CHAINLINK_ETH,SEL.latestAnswer,'0x'+mintBlock.toString(16)); entryEthUsd=bigToFloat(BigInt(r),8); }catch(e){}
  }
  const sum=(arr,k,dec)=>arr.reduce((s,x)=>s+bigToFloat(x[k],dec),0);
  const dep0=sum(hist.inc,'a0',d0), dep1=sum(hist.inc,'a1',d1);
  const wdr0=sum(hist.dec,'a0',d0), wdr1=sum(hist.dec,'a1',d1);
  const col0=sum(hist.col,'a0',d0), col1=sum(hist.col,'a1',d1);
  const feeCol0=Math.max(0,col0-wdr0), feeCol1=Math.max(0,col1-wdr1);
  const ageDays=mintTs?(Date.now()-mintTs)/86400000:null;
  let costUsd=null,roiPct=null,roiMode='hodl',feeAprPct=null,feesEverUsd=null;
  if(usd0!=null&&usd1!=null&&(dep0>0||dep1>0)){
    let e0=usd0,e1=usd1;
    if(entryEthUsd&&ethUsd){
      const sc=(addr,cur)=>{const a=addr.toLowerCase(); if(STABLES.has(a))return 1; if(a===WETH)return entryEthUsd; return cur!=null?cur*(entryEthUsd/ethUsd):null;};
      const s0=sc(token0,usd0),s1=sc(token1,usd1);
      if(s0!=null&&s1!=null){e0=s0;e1=s1;roiMode='entry';}
    }
    costUsd=dep0*e0+dep1*e1;
    feesEverUsd=(feeCol0*usd0+feeCol1*usd1)+(feesUsd??0);
    const totalNow=(valueUsd??0)+(wdr0*usd0+wdr1*usd1)+feesEverUsd;
    if(costUsd>0){ roiPct=(totalNow-costUsd)/costUsd*100; if(ageDays>0.05) feeAprPct=(feesEverUsd/costUsd)*(365/ageDays)*100; }
  }
  // windowed APRs
  const aprW={t:Date.now()};
  for(const [key,days] of [['d1',1],['d7',7],['d30',30],['d365',365]]){
    aprW[key]=null;
    if(ageDays!=null&&ageDays<days) continue;
    try{
      const blk=blockNum-Math.round(days*86400/12);
      const old=await feesOwedAt('0x'+blk.toString(16));
      const cw0=hist.col.filter(x=>x.block>=blk).reduce((s,x)=>s+bigToFloat(x.a0,d0),0);
      const cw1=hist.col.filter(x=>x.block>=blk).reduce((s,x)=>s+bigToFloat(x.a1,d1),0);
      const dw0=hist.dec.filter(x=>x.block>=blk).reduce((s,x)=>s+bigToFloat(x.a0,d0),0);
      const dw1=hist.dec.filter(x=>x.block>=blk).reduce((s,x)=>s+bigToFloat(x.a1,d1),0);
      const e0=Math.max(0,f0-old.f0+cw0-dw0), e1=Math.max(0,f1-old.f1+cw1-dw1);
      const base=valueUsd||costUsd;
      if(base>0) aprW[key]=(e0*(usd0??0)+e1*(usd1??0))/base*(365/days)*100;
    }catch(e){}
  }
  const inRange=tick>=tickLower&&tick<tickUpper;
  const rangePos=(tick-tickLower)/(tickUpper-tickLower);
  const dLow=(price-priceLower)/price*100, dUp=(priceUpper-price)/price*100;
  return { id, chain:'eth', owner, relay:true, pool, token0, token1,
    m0:{symbol:m0.symbol}, m1:{symbol:m1.symbol}, d0, d1, tick, price, priceLower, priceUpper,
    amt0, amt1, f0, f1, usd0, usd1, valueUsd, feesUsd, feesEverUsd, costUsd, roiPct, roiMode, feeAprPct, aprW,
    mintTs, ageDays, inRange, rangePos, dLow, dUp,
    nearestEdge: dLow<dUp?'lower':'upper',
    edgeDist: inRange?Math.min(dLow,dUp):-(price<priceLower?(priceLower-price)/price*100:(price-priceUpper)/price*100),
    pairLabel:m0.symbol+' / '+m1.symbol, feeLabel:(fee/10000)+'%' };
}

/* ---------- 30d volatility per pool (archive slot0 samples) ---------- */
async function poolVolatility(pool, scale, blockNum){
  const samples=[];
  for(let i=14;i>=0;i--){
    const blk=blockNum-Math.round(i*2*7200);           // 2-day steps over 28 days
    try{
      const r=await ethCall(pool,SEL.slot0,'0x'+blk.toString(16));
      const sp=Number(BigInt(word(r,0)))/Q96;
      samples.push(sp*sp*scale);
    }catch(e){ samples.push(null); }
  }
  const rets=[];
  for(let i=1;i<samples.length;i++){
    if(samples[i]!=null&&samples[i-1]!=null&&samples[i]>0&&samples[i-1]>0) rets.push(Math.log(samples[i]/samples[i-1]));
  }
  if(rets.length<5) return null;
  const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
  const varr=rets.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(rets.length-1);
  return Math.sqrt(varr)/Math.sqrt(2);                 // daily sigma (2-day gaps)
}
const erf=x=>{const t=1/(1+0.3275911*Math.abs(x));const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return x>=0?y:-y;};
const Phi=z=>0.5*(1+erf(z/Math.SQRT2));
function rangeAnalytics(price, lo, up, sigma){
  if(!sigma||!(price>0&&lo>0&&up>0)) return null;
  const s7=sigma*Math.sqrt(7);
  const zLo=Math.log(price/lo)/s7, zUp=Math.log(up/price)/s7;
  const stay7=Math.max(0,Math.min(1,Phi(zUp)-Phi(-zLo)));
  const widthLog=Math.log(up/lo);
  const sug=k=>({lo:price*Math.exp(-k*s7), up:price*Math.exp(k*s7)});
  return { sigmaDaily:sigma, stay7dPct:stay7*100, widthPct:(Math.exp(widthLog)-1)*100,
    suggested:{ tight:sug(0.68), balanced:sug(1.282), wide:sug(2.0) },
    concVsBalanced: (2*1.282*s7)/widthLog };
}

/* ---------- Solana (validated against official SDKs) ---------- */
const CLMM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const TOKEN_PROG='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOL_MINT='So11111111111111111111111111111111111111112';
const SOL_KNOWN={[SOL_MINT]:'SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT'};
const B58A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58M=Object.fromEntries([...B58A].map((c,i)=>[c,i]));
function b58d(s){let n=0n;for(const c of s){n=n*58n+BigInt(B58M[c]);}const b=[];while(n>0n){b.unshift(Number(n&255n));n>>=8n;}for(const c of s){if(c==='1')b.unshift(0);else break;}return new Uint8Array(b);}
function b58e(bytes){let n=0n;for(const b of bytes)n=(n<<8n)|BigInt(b);let o='';while(n>0n){o=B58A[Number(n%58n)]+o;n/=58n;}for(const b of bytes){if(b===0)o='1'+o;else break;}return o;}
const P=(1n<<255n)-19n, D=37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function mpow(b,e,m){let r=1n;b%=m;while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n;}return r;}
function onCurve(by){let y=0n;for(let i=31;i>=0;i--)y=(y<<8n)|BigInt(i===31?(by[i]&0x7f):by[i]);if(y>=P)return false;
  const sg=(by[31]&0x80)>>7,y2=y*y%P,u=(y2-1n+P)%P,v=(D*y2+1n)%P,v3=v*v%P*v%P,uv7=u*(v3*v3%P*v%P)%P;
  let x=u*v3%P*mpow(uv7,(P-5n)/8n,P)%P; const vxx=v*x%P*x%P;
  if(vxx!==u){ if((vxx+u)%P!==0n)return false; x=x*mpow(2n,(P-1n)/4n,P)%P; }
  if(x===0n&&sg===1)return false; return true;}
async function pda(seeds,prog){
  const pg=b58d(prog), mk=new TextEncoder().encode('ProgramDerivedAddress');
  for(let bump=255;bump>=0;bump--){
    const parts=[...seeds,new Uint8Array([bump]),pg,mk];
    const buf=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));
    let o=0;for(const p of parts){buf.set(p,o);o+=p.length;}
    const h=new Uint8Array(await crypto.subtle.digest('SHA-256',buf));
    if(!onCurve(h)) return b58e(h);
  }
  throw new Error('no pda');
}
const leU16=(b,o)=>b[o]|(b[o+1]<<8);
const leU64=(b,o)=>{let n=0n;for(let i=7;i>=0;i--)n=(n<<8n)|BigInt(b[o+i]);return n;};
const leU128=(b,o)=>{let n=0n;for(let i=15;i>=0;i--)n=(n<<8n)|BigInt(b[o+i]);return n;};
const leI32=(b,o)=>{const u=(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;return u>0x7fffffff?u-0x100000000:u;};
const pk=(b,o)=>b58e(b.slice(o,o+32));
const b64=s=>Uint8Array.from(Buffer.from(s,'base64'));

async function fetchSolana(){
  const out=[];
  const cat=[];
  for(const w of SOL_WALLETS){
    for(const prog of [TOKEN_PROG,TOKEN22]){
      try{
        const res=await sol('getTokenAccountsByOwner',[w,{programId:prog},{encoding:'jsonParsed'}]);
        for(const a of res.value){
          const info=a.account?.data?.parsed?.info;
          if(info?.tokenAmount?.amount==='1'&&info?.tokenAmount?.decimals===0) cat.push({wallet:w,mint:info.mint});
        }
      }catch(e){ logErr('solWallet '+w.slice(0,6),e); }
    }
  }
  const pdas=[];
  for(const c of cat) pdas.push(await pda([new TextEncoder().encode('position'),b58d(c.mint)],CLMM));
  const found=[];
  for(let i=0;i<pdas.length;i+=100){
    const res=await sol('getMultipleAccounts',[pdas.slice(i,i+100),{encoding:'base64'}]);
    res.value.forEach((a,j)=>{
      if(!a||a.owner!==CLMM) return;
      const b=b64(a.data[0]);
      const pp={nftMint:pk(b,9),poolId:pk(b,41),tickLower:leI32(b,73),tickUpper:leI32(b,77),liquidity:leU128(b,81),fgInsideLast0:leU128(b,97),fgInsideLast1:leU128(b,113),feesOwed0:leU64(b,129),feesOwed1:leU64(b,137)};
      if(pp.liquidity>0n) found.push({cat:cat[i+j],pda:pdas[i+j],pp});
    });
  }
  if(!found.length) return out;
  const poolIds=[...new Set(found.map(x=>x.pp.poolId))];
  const pools=new Map();
  const pr=await sol('getMultipleAccounts',[poolIds,{encoding:'base64'}]);
  pr.value.forEach((a,i)=>{ if(!a) return; const b=b64(a.data[0]);
    pools.set(poolIds[i],{mint0:pk(b,73),mint1:pk(b,105),dec0:b[233],dec1:b[234],tickSpacing:leU16(b,235),sqrtPriceX64:leU128(b,253),tickCurrent:leI32(b,269),fgGlobal0:leU128(b,277),fgGlobal1:leU128(b,293)}); });
  // ---- precise pending fees: tick-array fee growth (offsets validated vs Raydium SDK) ----
  const MASK128=(1n<<128n)-1n;
  const i32be=v=>{const bb=new Uint8Array(4);new DataView(bb.buffer).setInt32(0,v,false);return bb;};
  const taStart=(tick,spacing)=>{const per=spacing*60;return Math.floor(tick/per)*per;};
  const taCache=new Map();
  async function tickFeeGrowth(poolId, spacing, tick){
    const start=taStart(tick,spacing);
    const key=poolId+':'+start;
    if(!taCache.has(key)){
      const addr=await pda([new TextEncoder().encode('tick_array'), b58d(poolId), i32be(start)], CLMM);
      const res=await sol('getMultipleAccounts',[[addr],{encoding:'base64'}]);
      taCache.set(key, res.value[0]?b64(res.value[0].data[0]):null);
    }
    const b=taCache.get(key);
    if(!b) return null;
    const idx=Math.round((tick-start)/spacing);
    if(idx<0||idx>=60) return null;
    const base=44+idx*168;
    return { fg0:leU128(b,base+36), fg1:leU128(b,base+52), gross:leU128(b,base+20) };
  }
  function fgInside(global, lowerOut, upperOut, cur, lo, up){
    const below = cur>=lo ? lowerOut : (global-lowerOut)&MASK128;
    const above = cur<up ? upperOut : (global-upperOut)&MASK128;
    return (global-below-above)&MASK128;
  }
  for(const x of found){
    const pool=pools.get(x.pp.poolId); if(!pool) continue;
    try{
      const loT=await tickFeeGrowth(x.pp.poolId,pool.tickSpacing,x.pp.tickLower);
      const upT=await tickFeeGrowth(x.pp.poolId,pool.tickSpacing,x.pp.tickUpper);
      if(loT&&upT){
        const in0=fgInside(pool.fgGlobal0,loT.fg0,upT.fg0,pool.tickCurrent,x.pp.tickLower,x.pp.tickUpper);
        const in1=fgInside(pool.fgGlobal1,loT.fg1,upT.fg1,pool.tickCurrent,x.pp.tickLower,x.pp.tickUpper);
        let d0=(in0-x.pp.fgInsideLast0)&MASK128, d1=(in1-x.pp.fgInsideLast1)&MASK128;
        if(d0>(1n<<127n)) d0=0n;               // wrap guard
        if(d1>(1n<<127n)) d1=0n;
        x.pending0=x.pp.feesOwed0+((d0*x.pp.liquidity)>>64n);
        x.pending1=x.pp.feesOwed1+((d1*x.pp.liquidity)>>64n);
      }
    }catch(e){ logErr('solFees '+x.pp.nftMint.slice(0,6),e); }
  }
  const mints=[...new Set([...pools.values()].flatMap(p=>[p.mint0,p.mint1]))];
  let prices={}; try{
    const js=await getJson('https://lite-api.jup.ag/price/v3?ids='+mints.join(','));
    for(const m of mints){ if(js[m]?.usdPrice!=null) prices[m]=Number(js[m].usdPrice); }
  }catch(e){ logErr('jup',e); }
  const symbols={};
  for(const m of mints){
    if(SOL_KNOWN[m]){ symbols[m]=SOL_KNOWN[m]; continue; }
    try{ const js=await getJson('https://lite-api.jup.ag/tokens/v2/search?query='+m);
      symbols[m]=(Array.isArray(js)?js.find(t=>t.id===m):null)?.symbol||m.slice(0,4)+'…'; }
    catch(e){ symbols[m]=m.slice(0,4)+'…'; }
  }
  let ray={}; try{
    const js=await getJson('https://api-v3.raydium.io/pools/info/ids?ids='+poolIds.join(','));
    for(const d of (js.data||[])) if(d&&d.id) ray[d.id]={aprDay:d.day?.apr??null,aprWeek:d.week?.apr??null,aprMonth:d.month?.apr??null,feeRate:d.feeRate??null};
  }catch(e){ logErr('raydium',e); }
  for(const {cat:c,pda:pd,pp} of found){
    const pool=pools.get(pp.poolId); if(!pool) continue;
    const d0=pool.dec0,d1=pool.dec1,scale=10**(d0-d1);
    const sp=Number(pool.sqrtPriceX64)/Q64;
    const [ra0,ra1]=amounts(Number(pp.liquidity),sp,tickToSqrt(pp.tickLower),tickToSqrt(pp.tickUpper));
    const amt0=ra0/10**d0, amt1=ra1/10**d1;
    const price=sp*sp*scale, priceLower=tickToPrice(pp.tickLower)*scale, priceUpper=tickToPrice(pp.tickUpper)*scale;
    let usd0=prices[pool.mint0]??null, usd1=prices[pool.mint1]??null;
    if(usd0==null&&usd1!=null) usd0=price*usd1;
    if(usd1==null&&usd0!=null) usd1=usd0/price;
    const fRaw0=(found.find(z=>z.pp===pp)?.pending0) ?? pp.feesOwed0;
    const fRaw1=(found.find(z=>z.pp===pp)?.pending1) ?? pp.feesOwed1;
    const f0=Number(fRaw0)/10**d0, f1=Number(fRaw1)/10**d1;
    const tick=pool.tickCurrent;
    const inRange=tick>=pp.tickLower&&tick<pp.tickUpper;
    const rangePos=(tick-pp.tickLower)/(pp.tickUpper-pp.tickLower);
    const dLow=(price-priceLower)/price*100, dUp=(priceUpper-price)/price*100;
    let mintTs=null;
    try{
      let before,oldest=null,pages=0;
      while(pages<3){
        const sigs=await sol('getSignaturesForAddress',[pd,{limit:1000,...(before?{before}:{})}]);
        if(!sigs||!sigs.length) break;
        oldest=sigs[sigs.length-1];
        if(sigs.length<1000) break;
        before=oldest.signature; pages++;
      }
      if(oldest?.blockTime) mintTs=oldest.blockTime*1000;
    }catch(e){}
    const rinfo=ray[pp.poolId]||{};
    out.push({ id:'sol:'+pp.nftMint, chain:'sol', relay:true, wallet:c.wallet, nftMint:pp.nftMint, poolId:pp.poolId, pda:pd,
      m0:{symbol:symbols[pool.mint0]}, m1:{symbol:symbols[pool.mint1]}, d0, d1, tick, price, priceLower, priceUpper,
      amt0, amt1, f0, f1, usd0, usd1,
      valueUsd:(usd0!=null&&usd1!=null)?amt0*usd0+amt1*usd1:null,
      feesUsd:(usd0!=null&&usd1!=null)?f0*usd0+f1*usd1:null,
      feesEverUsd:null, costUsd:null, roiPct:null, roiMode:'sol', feeAprPct:null,
      poolAprPct:rinfo.aprDay??null, poolAprDay:rinfo.aprDay??null, poolAprWeek:rinfo.aprWeek??null, poolAprMonth:rinfo.aprMonth??null,
      mintTs, ageDays:mintTs?(Date.now()-mintTs)/86400000:null,
      inRange, rangePos, dLow, dUp, nearestEdge:dLow<dUp?'lower':'upper',
      edgeDist:inRange?Math.min(dLow,dUp):-(price<priceLower?(priceLower-price)/price*100:(price-priceUpper)/price*100),
      pairLabel:symbols[pool.mint0]+' / '+symbols[pool.mint1],
      feeLabel:rinfo.feeRate!=null?(rinfo.feeRate*100).toFixed(rinfo.feeRate*100<1?2:0).replace(/\.00$/,'')+'%':'CLMM' });
  }
  return out;
}

/* ---------- main ---------- */
const main=async()=>{
  const blockNum=Number(BigInt(await eth('eth_blockNumber',[])));
  let gasGwei=null; try{ gasGwei=Number(BigInt(await eth('eth_gasPrice',[])))/1e9; }catch(e){}
  let ethUsd=null,btcUsd=null;
  try{ ethUsd=bigToFloat(BigInt(await ethCall(CHAINLINK_ETH,SEL.latestAnswer)),8); }catch(e){ logErr('chainlinkEth',e); }
  try{ btcUsd=bigToFloat(BigInt(await ethCall(CHAINLINK_BTC,SEL.latestAnswer)),8); }catch(e){}
  const ethPositions=[];
  for(const id of ETH_IDS){
    try{ ethPositions.push(await fetchEthPosition(id,blockNum,ethUsd,btcUsd)); console.log('eth #'+id+' OK'); }
    catch(e){ logErr('eth#'+id,e); }
    await sleep(300);
  }
  // token deployment dating for pairs that exist with multiple token contracts (e.g. old vs new LCX)
  async function tokenDeployTs(addr){
    try{
      if((await eth('eth_getCode',[addr,'latest']))==='0x') return null;
      let lo=100000, hi=blockNum;
      for(let i=0;i<19;i++){
        const mid=Math.floor((lo+hi)/2);
        try{
          const code=await eth('eth_getCode',[addr,'0x'+mid.toString(16)]);
          if(code && code!=='0x') hi=mid; else lo=mid+1;
        }catch(e){ lo=mid+1; }
      }
      const blk=await eth('eth_getBlockByNumber',['0x'+hi.toString(16),false]);
      return Number(BigInt(blk.timestamp))*1000;
    }catch(e){ return null; }
  }
  {
    const byPair={};
    for(const p of ethPositions){ (byPair[p.pairLabel]=byPair[p.pairLabel]||new Set()).add(p.token0); }
    const dupTokens=new Set();
    for(const k in byPair) if(byPair[k].size>1) byPair[k].forEach(t=>dupTokens.add(t));
    const deployTs={};
    for(const t of dupTokens){ deployTs[t]=await tokenDeployTs(t); console.log('deploy',t.slice(0,10),deployTs[t]?new Date(deployTs[t]).toISOString().slice(0,10):'?'); }
    for(const p of ethPositions) if(p.token0 in deployTs) p.token0DeployTs=deployTs[p.token0];
  }
  // range analytics per unique pool
  const volCache={};
  for(const p of ethPositions){
    try{
      if(!(p.pool in volCache)) volCache[p.pool]=await poolVolatility(p.pool, 10**(p.d0-p.d1), blockNum);
      p.range = rangeAnalytics(p.price, p.priceLower, p.priceUpper, volCache[p.pool]);
    }catch(e){ p.range=null; }
  }
  let solPositions=[];
  try{ solPositions=await fetchSolana(); console.log('sol positions:',solPositions.length); }
  catch(e){ logErr('sol',e); }
  let topPools=[];
  try{
    const js=await getJson('https://yields.llama.fi/pools',45000);
    topPools=(js.data||[])
      .filter(x=>['Ethereum','Solana'].includes(x.chain)
        && ['uniswap-v3','raydium-clmm','orca-dex','uniswap-v4'].includes(x.project)
        && x.tvlUsd>=3e6 && x.apy>0 && x.apy<=400)
      .sort((a,b)=>b.apy-a.apy).slice(0,12)
      .map(x=>({chain:x.chain,project:x.project,symbol:x.symbol,tvl:x.tvlUsd,apy:x.apy,base:x.apyBase??null,reward:x.apyReward??null,il:x.ilRisk??null,id:x.pool}));
    console.log('topPools:',topPools.length);
  }catch(e){ logErr('llama',e); }
  const data={ v:3, t:Date.now(), block:blockNum, ethUsd, btcUsd, gasGwei, eth:ethPositions, sol:solPositions, topPools, errors };
  const fs=await import('fs');
  fs.writeFileSync('data.json', JSON.stringify(data));
  console.log('data.json written:', ethPositions.length,'eth +',solPositions.length,'sol · errors:',errors.length);
  if(!ethPositions.length && !solPositions.length){ process.exitCode=1; }
};
main().catch(e=>{ console.error('FATAL',e); process.exit(1); });

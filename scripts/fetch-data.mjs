// v22.2 relay nudge
/* Server-side data refresh for ARC // LP COMMAND.
   Runs in GitHub Actions (Node 20, no deps). Fetches Uniswap V3 + Raydium CLMM
   position data and writes data.json for the static dashboard to consume. */

import fs from 'fs';
const OUT='deck-r7k4x9';
const CONFIG = JSON.parse(fs.readFileSync(OUT+'/config.json','utf8'));
const SOL_RPCS = ['https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com','https://solana.drpc.org'];
const NPM_STD='0xc36442b4a4522e871399cd717abdd847ab11fe88', FACT_STD='0x1f98431c8ad98523631ae4a59f267346ea31f984';
const CHAINS = {
  ethereum:{ tag:'ETH', rpcs:['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://eth.llamarpc.com','https://1rpc.io/eth','https://rpc.mevblocker.io'],
    npm:NPM_STD, factory:FACT_STD, bph:300, startBlock:12369651, llama:'ethereum',
    weth:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    stables:['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0xdac17f958d2ee523a2206206994597c13d831ec7','0x6b175474e89094c44da98b954eedeac495271d0f'] },
  arbitrum:{ tag:'ARB', rpcs:['https://arbitrum-one-rpc.publicnode.com','https://arb1.arbitrum.io/rpc','https://arbitrum.drpc.org'],
    npm:NPM_STD, factory:FACT_STD, bph:14400, startBlock:100000, llama:'arbitrum',
    weth:'0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    stables:['0xaf88d065e77c8cc2239327c5edb3a432268e5831','0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9','0xda10009cbd5d07dd0cecc66161fc93d7c9000da1'] },
  base:{ tag:'BASE', rpcs:['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.drpc.org'],
    npm:'0x03a520b32c04bf3beef7beb72e919cf822ed34f1', factory:'0x33128a8fc17869897dce68ed026d694621f6fdfd', bph:1800, startBlock:1371680, llama:'base',
    weth:'0x4200000000000000000000000000000000000006',
    stables:['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'] },
  optimism:{ tag:'OP', rpcs:['https://optimism-rpc.publicnode.com','https://mainnet.optimism.io','https://optimism.drpc.org'],
    npm:NPM_STD, factory:FACT_STD, bph:1800, startBlock:1000000, llama:'optimism',
    weth:'0x4200000000000000000000000000000000000006',
    stables:['0x0b2c639c533813f4aa9d7837caf62653d097ff85','0x94b008aa00579c1307b0ef2c499ad98a8ce58e58','0xda10009cbd5d07dd0cecc66161fc93d7c9000da1'] },
  polygon:{ tag:'POLY', rpcs:['https://polygon-bor-rpc.publicnode.com','https://polygon-rpc.com','https://polygon.drpc.org'],
    npm:NPM_STD, factory:FACT_STD, bph:1700, startBlock:22757547, llama:'polygon',
    weth:'0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
    stables:['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xc2132d05d31c914a87c6611c10748aeb04b58e8f','0x8f3cf7ad23cd3cadbd9735aff958023239c6a063'] },
};


const CHAINLINK_ETH='0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
const CHAINLINK_BTC='0xf4030086522a5beea4988f8ca5b36dba0d0f58a6';
const SEL={positions:'0x99fbab88',ownerOf:'0x6352211e',getPool:'0x1698ee82',slot0:'0x3850c7bd',symbol:'0x95d89b41',decimals:'0x313ce567',latestAnswer:'0x50d25bcd',collect:'0xfc6f7865'};
const TOPIC_INC='0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const TOPIC_DEC='0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const TOPIC_COL='0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const SEL2={balanceOf:'0x70a08231', tokenOfOwnerByIndex:'0x2f745c59'};

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
async function evm(chainKey,method,params){
  let last;
  for(const url of CHAINS[chainKey].rpcs){
    try{
      const js=await post(url,{jsonrpc:'2.0',id:rpcId++,method,params});
      if(js.error) throw new Error(js.error.message||JSON.stringify(js.error));
      return js.result;
    }catch(e){ last=e; }
  }
  throw last;
}
const evmCall=(ck,to,data,block='latest',from)=>evm(ck,'eth_call',[{to,data,...(from?{from}:{})},block]);
const eth=(method,params)=>evm('ethereum',method,params);
const ethCall=(to,data,block='latest',from)=>evmCall('ethereum',to,data,block,from);
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


/* ---------- EVM pipeline (chain-generic) ---------- */
const tokenMeta=new Map();
async function meta(ck,addr){
  addr=addr.toLowerCase(); const key=ck+':'+addr;
  if(tokenMeta.has(key)) return tokenMeta.get(key);
  let symbol='???',decimals=18;
  try{ symbol=decodeString(await evmCall(ck,addr,SEL.symbol)); }catch(e){}
  try{ decimals=Number(BigInt(await evmCall(ck,addr,SEL.decimals))); }catch(e){}
  const m={symbol:symbol==='WETH'?'ETH':symbol,decimals};
  tokenMeta.set(key,m); return m;
}
/* universal pricing: DefiLlama coins API, pool-derived fallback */
const priceCache={};
async function llamaPrices(keys){
  const need=keys.filter(k=>!(k in priceCache));
  for(let i=0;i<need.length;i+=40){
    const batch=need.slice(i,i+40);
    try{
      const js=await getJson('https://coins.llama.fi/prices/current/'+batch.join(','),20000);
      for(const k of batch){ const c=js.coins&&js.coins[k]; priceCache[k]=c?c.price:null; }
    }catch(e){ for(const k of batch) priceCache[k]=null; }
  }
}
async function evmHistory(ck,id){
  const C=CHAINS[ck];
  const topicId='0x'+pad32(id.toString(16));
  const logs=await evm(ck,'eth_getLogs',[{address:C.npm,topics:[[TOPIC_INC,TOPIC_DEC,TOPIC_COL],topicId],fromBlock:'0x'+C.startBlock.toString(16),toBlock:'latest'}]);
  const parse=lg=>({block:Number(BigInt(lg.blockNumber)),tx:lg.transactionHash,a0:BigInt(word(lg.data,1)),a1:BigInt(word(lg.data,2))});
  return { inc:logs.filter(l=>l.topics[0]===TOPIC_INC).map(parse),
           dec:logs.filter(l=>l.topics[0]===TOPIC_DEC).map(parse),
           col:logs.filter(l=>l.topics[0]===TOPIC_COL).map(parse) };
}
async function walletPositionIds(ck,wallet){
  const C=CHAINS[ck];
  const wp=pad32(wallet);
  let bal=0;
  try{ bal=Number(BigInt(await evmCall(ck,C.npm,SEL2.balanceOf+wp))); }
  catch(e){ logErr('balanceOf '+ck+' '+wallet.slice(0,8),e); }
  const ids=new Set();
  for(let i=0;i<bal && i<80;i++){
    try{ ids.add(Number(BigInt(await evmCall(ck,C.npm,SEL2.tokenOfOwnerByIndex+wp+pad32(i.toString(16)))))); }
    catch(e){ logErr('enum '+ck+' '+wallet.slice(0,8)+'['+i+']',e); }
    await sleep(100);
  }
  if(ids.size<bal){
    // fallback: NFT Transfer logs into this wallet, then verify current ownership
    try{
      const TT='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const logs=await evm(ck,'eth_getLogs',[{address:C.npm,topics:[TT,null,'0x'+wp],fromBlock:'0x'+C.startBlock.toString(16),toBlock:'latest'}]);
      for(const lg of logs){
        const id=Number(BigInt(lg.topics[3]));
        if(ids.has(id)) continue;
        try{
          const o=('0x'+(await evmCall(ck,C.npm,SEL.ownerOf+pad32(id.toString(16)))).slice(-40)).toLowerCase();
          if(o==='0x'+wallet.toLowerCase()) ids.add(id);
        }catch(e){}
        await sleep(80);
      }
    }catch(e){ logErr('transferScan '+ck+' '+wallet.slice(0,8),e); }
  }
  return [...ids];
}
async function fetchEvmPosition(ck,id,blockNum,ethUsd,btcUsd){
  const C=CHAINS[ck];
  const idHex=pad32(id.toString(16));
  const pos=await evmCall(ck,C.npm,SEL.positions+idHex);
  const token0='0x'+word(pos,2).slice(-40), token1='0x'+word(pos,3).slice(-40);
  const fee=Number(BigInt(word(pos,4)));
  const tickLower=Number(toSigned(BigInt(word(pos,5)),24)), tickUpper=Number(toSigned(BigInt(word(pos,6)),24));
  const liquidity=BigInt(word(pos,7));
  let owner=null; try{ owner='0x'+(await evmCall(ck,C.npm,SEL.ownerOf+idHex)).slice(-40); }catch(e){}
  const [m0,m1]=[await meta(ck,token0),await meta(ck,token1)];
  const pool='0x'+(await evmCall(ck,C.factory,SEL.getPool+pad32(token0)+pad32(token1)+pad32(fee.toString(16)))).slice(-40);
  const slot0=await evmCall(ck,pool,SEL.slot0);
  const sqrtPriceX96=BigInt(word(slot0,0));
  const tick=Number(toSigned(BigInt(word(slot0,1)),24));
  const MAX='f'.repeat(32).padStart(64,'0');
  const collectData=SEL.collect+idHex+pad32(owner||C.npm)+MAX+MAX;
  let f0=bigToFloat(BigInt(word(pos,10)),m0.decimals), f1=bigToFloat(BigInt(word(pos,11)),m1.decimals);
  const feesOwedAt=async blk=>{
    const r=await evmCall(ck,C.npm,collectData,blk,owner||undefined);
    return { f0:bigToFloat(BigInt(word(r,0)),m0.decimals), f1:bigToFloat(BigInt(word(r,1)),m1.decimals) };
  };
  try{ const now=await feesOwedAt('latest'); f0=now.f0; f1=now.f1; }catch(e){}
  if(liquidity===0n && f0===0 && f1===0) return null;    // closed & empty — skip
  const d0=m0.decimals,d1=m1.decimals, scale=10**(d0-d1);
  const sp=Number(sqrtPriceX96)/Q96, sa=tickToSqrt(tickLower), sb=tickToSqrt(tickUpper);
  const [ra0,ra1]=amounts(Number(liquidity),sp,sa,sb);
  const amt0=ra0/10**d0, amt1=ra1/10**d1;
  const price=sp*sp*scale, priceLower=tickToPrice(tickLower)*scale, priceUpper=tickToPrice(tickUpper)*scale;
  await llamaPrices([C.llama+':'+token0, C.llama+':'+token1]);
  let usd0=priceCache[C.llama+':'+token0]??null, usd1=priceCache[C.llama+':'+token1]??null;
  if(usd0==null&&usd1!=null) usd0=price*usd1;
  if(usd1==null&&usd0!=null) usd1=usd0/price;
  const valueUsd=(usd0!=null&&usd1!=null)?amt0*usd0+amt1*usd1:null;
  const feesUsd=(usd0!=null&&usd1!=null)?f0*usd0+f1*usd1:null;
  let hist={inc:[],dec:[],col:[]}, mintTs=null, entryEthUsd=null;
  try{ hist=await evmHistory(ck,id); }catch(e){ logErr(ck+' hist#'+id,e); }
  if(hist.inc.length){
    const mintBlock=Math.min(...hist.inc.map(x=>x.block));
    try{ const blk=await evm(ck,'eth_getBlockByNumber',['0x'+mintBlock.toString(16),false]); mintTs=Number(BigInt(blk.timestamp))*1000; }catch(e){}
    if(ck==='ethereum'){
      try{ const r=await ethCall(CHAINLINK_ETH,SEL.latestAnswer,'0x'+mintBlock.toString(16)); entryEthUsd=bigToFloat(BigInt(r),8); }catch(e){}
    }
  }
  const sum=(arr,k,dec)=>arr.reduce((s,x)=>s+bigToFloat(x[k],dec),0);
  const dep0=sum(hist.inc,'a0',d0), dep1=sum(hist.inc,'a1',d1);
  const wdr0=sum(hist.dec,'a0',d0), wdr1=sum(hist.dec,'a1',d1);
  const col0=sum(hist.col,'a0',d0), col1=sum(hist.col,'a1',d1);
  const feeCol0=Math.max(0,col0-wdr0), feeCol1=Math.max(0,col1-wdr1);
  const ageDays=mintTs?(Date.now()-mintTs)/86400000:null;
  let costUsd=null,roiPct=null,roiMode='hodl',feeAprPct=null,feesEverUsd=null,ilUsd=null,lpVsHodlUsd=null,hodlNowUsd=null;
  if(usd0!=null&&usd1!=null&&(dep0>0||dep1>0)){
    let e0=usd0,e1=usd1;
    if(ck==='ethereum'&&entryEthUsd&&ethUsd){
      const st=new Set(C.stables);
      const sc=(addr,cur)=>{const a=addr.toLowerCase(); if(st.has(a))return 1; if(a===C.weth)return entryEthUsd; return cur!=null?cur*(entryEthUsd/ethUsd):null;};
      const s0=sc(token0,usd0),s1=sc(token1,usd1);
      if(s0!=null&&s1!=null){e0=s0;e1=s1;roiMode='entry';}
    }
    costUsd=dep0*e0+dep1*e1;
    feesEverUsd=(feeCol0*usd0+feeCol1*usd1)+(feesUsd??0);
    const totalNow=(valueUsd??0)+(wdr0*usd0+wdr1*usd1)+feesEverUsd;
    if(costUsd>0){ roiPct=(totalNow-costUsd)/costUsd*100; if(ageDays>0.05) feeAprPct=(feesEverUsd/costUsd)*(365/ageDays)*100; }
    // impermanent loss: what the position (incl. withdrawals) is worth NOW vs just holding the deposits
    hodlNowUsd=dep0*usd0+dep1*usd1;
    ilUsd=((valueUsd??0)+wdr0*usd0+wdr1*usd1)-hodlNowUsd;
    lpVsHodlUsd=ilUsd+(feesEverUsd??0);   // positive → pooling beat holding
  }
  // fees accrued BEFORE the current month started (for the monthly fee ledger)
  let feesMonthStartUsd=null;
  try{
    if(usd0!=null&&usd1!=null&&mintTs!=null){
      const nowD=new Date();
      const msTs=Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth(),1);
      if(mintTs>=msTs) feesMonthStartUsd=0;
      else{
        const hoursAgo=(Date.now()-msTs)/3600000;
        const msBlock=Math.max(1,blockNum-Math.round(hoursAgo*C.bph));
        const old=await feesOwedAt('0x'+msBlock.toString(16));
        const cb0=sum(hist.col.filter(x=>x.block<msBlock),'a0',d0), cb1=sum(hist.col.filter(x=>x.block<msBlock),'a1',d1);
        const wb0=sum(hist.dec.filter(x=>x.block<msBlock),'a0',d0), wb1=sum(hist.dec.filter(x=>x.block<msBlock),'a1',d1);
        feesMonthStartUsd=(Math.max(0,cb0-wb0)+old.f0)*usd0+(Math.max(0,cb1-wb1)+old.f1)*usd1;
      }
    }
  }catch(e){}
  const opTxs=[...new Map([...hist.inc,...hist.dec,...hist.col].filter(x=>x.tx).map(x=>[x.tx,{tx:x.tx,block:x.block}])).values()];
  const bpd=C.bph*24;
  const aprW={t:Date.now()};
  for(const [key,days] of [['d1',1],['d7',7],['d30',30],['d365',365]]){
    aprW[key]=null;
    if(ageDays!=null&&ageDays<days) continue;
    try{
      const blk=blockNum-Math.round(days*bpd);
      if(blk<=C.startBlock) continue;
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
  const rangePos=(price-priceLower)/(priceUpper-priceLower); // linear price space (v19)
  const dLow=(price-priceLower)/price*100, dUp=(priceUpper-price)/price*100;
  return { id, chain:ck, chainTag:C.tag, owner, relay:true, pool, token0, token1,
    m0:{symbol:m0.symbol}, m1:{symbol:m1.symbol}, d0, d1, tick, price, priceLower, priceUpper,
    amt0, amt1, f0, f1, usd0, usd1, valueUsd, feesUsd, feesEverUsd, feesMonthStartUsd, opTxs, ilUsd, lpVsHodlUsd, hodlNowUsd, costUsd, roiPct, roiMode, feeAprPct, aprW,
    mintTs, ageDays, inRange, rangePos, dLow, dUp,
    nearestEdge: dLow<dUp?'lower':'upper',
    edgeDist: inRange?Math.min(dLow,dUp):-(price<priceLower?(priceLower-price)/price*100:(price-priceUpper)/price*100),
    pairLabel:m0.symbol+' / '+m1.symbol, feeLabel:(fee/10000)+'%' };
}

/* ---------- volatility (chain-generic) ---------- */
async function poolVolatility(ck,pool,scale,blockNum){
  const bpd=CHAINS[ck].bph*24;
  const samples=[];
  for(let i=14;i>=0;i--){
    const blk=blockNum-Math.round(i*2*bpd);
    try{
      const r=await evmCall(ck,pool,SEL.slot0,'0x'+blk.toString(16));
      const sp=Number(BigInt(word(r,0)))/Q96;
      samples.push(sp*sp*scale);
    }catch(e){ samples.push(null); }
  }
  const rets=[], moves=[];
  for(let i=1;i<samples.length;i++){
    if(samples[i]!=null&&samples[i-1]!=null&&samples[i]>0&&samples[i-1]>0){
      const r=Math.log(samples[i]/samples[i-1]);
      rets.push(r); moves.push(Math.abs(r)*100);
    } else moves.push(null);
  }
  if(rets.length<5) return null;
  const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
  return { sigma: Math.sqrt(rets.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(rets.length-1))/Math.sqrt(2), moves };
}
async function poolVol24(ck,pool,scale,blockNum){
  const bph=CHAINS[ck].bph;
  const pts=[];
  for(let i=12;i>=0;i--){
    const blk=blockNum-Math.round(i*2*bph);
    try{
      const r=await evmCall(ck,pool,SEL.slot0,'0x'+blk.toString(16));
      const sp=Number(BigInt(word(r,0)))/Q96;
      pts.push(sp*sp*scale);
    }catch(e){ pts.push(null); }
  }
  const rets=[], moves=[];
  for(let i=1;i<pts.length;i++){
    if(pts[i]!=null&&pts[i-1]!=null&&pts[i]>0&&pts[i-1]>0){
      const r=Math.log(pts[i]/pts[i-1]);
      rets.push(r); moves.push(Math.abs(r)*100);
    } else moves.push(null);
  }
  if(rets.length<6) return null;
  const mean=rets.reduce((a,b)=>a+b,0)/rets.length;
  return { sigma: Math.sqrt(rets.reduce((a,b)=>a+(b-mean)*(b-mean),0)/(rets.length-1))*Math.sqrt(12), moves };
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
const ORCA='whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
/* Orca Whirlpool layouts — offsets derived from the official IDL (@orca-so/whirlpools-sdk) */
const parseOrcaPosition=b=>({ whirlpool:pk(b,8), positionMint:pk(b,40), liquidity:leU128(b,72),
  tickLower:leI32(b,88), tickUpper:leI32(b,92),
  fgCheckA:leU128(b,96), feeOwedA:leU64(b,112), fgCheckB:leU128(b,120), feeOwedB:leU64(b,136) });
const parseWhirlpool=b=>({ tickSpacing:leU16(b,41), feeRate:leU16(b,45), sqrtPriceX64:leU128(b,65),
  tickCurrent:leI32(b,81), mintA:pk(b,101), fgGlobalA:leU128(b,165), mintB:pk(b,181), fgGlobalB:leU128(b,245) });
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

async function fetchSolana(SOL_WALLETS){
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
  const pdas=[], orcaPdas=[];
  for(const c of cat){
    pdas.push(await pda([new TextEncoder().encode('position'),b58d(c.mint)],CLMM));
    orcaPdas.push(await pda([new TextEncoder().encode('position'),b58d(c.mint)],ORCA));
  }
  const found=[], orcaFound=[];
  for(let i=0;i<pdas.length;i+=100){
    const res=await sol('getMultipleAccounts',[pdas.slice(i,i+100),{encoding:'base64'}]);
    res.value.forEach((a,j)=>{
      if(!a||a.owner!==CLMM) return;
      const b=b64(a.data[0]);
      const pp={nftMint:pk(b,9),poolId:pk(b,41),tickLower:leI32(b,73),tickUpper:leI32(b,77),liquidity:leU128(b,81),fgInsideLast0:leU128(b,97),fgInsideLast1:leU128(b,113),feesOwed0:leU64(b,129),feesOwed1:leU64(b,137)};
      if(pp.liquidity>0n) found.push({cat:cat[i+j],pda:pdas[i+j],pp});
    });
  }
  for(let i=0;i<orcaPdas.length;i+=100){
    const res=await sol('getMultipleAccounts',[orcaPdas.slice(i,i+100),{encoding:'base64'}]);
    res.value.forEach((a,j)=>{
      if(!a||a.owner!==ORCA) return;
      const op=parseOrcaPosition(b64(a.data[0]));
      if(op.liquidity>0n) orcaFound.push({cat:cat[i+j],pda:orcaPdas[i+j],op});
    });
  }
  console.log('sol found:', found.length,'raydium +',orcaFound.length,'orca');
  if(!found.length && !orcaFound.length) return out;
  // ---------- ORCA branch ----------
  if(orcaFound.length){
    const wpIds=[...new Set(orcaFound.map(x=>x.op.whirlpool))];
    const wres=await sol('getMultipleAccounts',[wpIds,{encoding:'base64'}]);
    const wps=new Map();
    wres.value.forEach((a,i)=>{ if(a) wps.set(wpIds[i], parseWhirlpool(b64(a.data[0]))); });
    const oMints=[...new Set([...wps.values()].flatMap(w=>[w.mintA,w.mintB]))];
    // decimals straight from SPL mint accounts (offset 44)
    const decMap={};
    const mres=await sol('getMultipleAccounts',[oMints,{encoding:'base64'}]);
    mres.value.forEach((a,i)=>{ if(a) decMap[oMints[i]]=b64(a.data[0])[44]; });
    const oPrices={}; const oSyms={};
    try{
      const js=await getJson('https://lite-api.jup.ag/price/v3?ids='+oMints.join(','));
      for(const m of oMints){ if(js[m]?.usdPrice!=null) oPrices[m]=Number(js[m].usdPrice); }
    }catch(e){ logErr('jup orca',e); }
    for(const m of oMints){
      if(SOL_KNOWN[m]){ oSyms[m]=SOL_KNOWN[m]; continue; }
      try{ const js=await getJson('https://lite-api.jup.ag/tokens/v2/search?query='+m);
        oSyms[m]=(Array.isArray(js)?js.find(t=>t.id===m):null)?.symbol||m.slice(0,4)+'…'; }
      catch(e){ oSyms[m]=m.slice(0,4)+'…'; }
    }
    // precise pending fees via Orca tick arrays (88 ticks/array, ASCII start-index seed)
    const MASKO=(1n<<128n)-1n;
    const taCacheO=new Map();
    async function orcaTick(whirlpool, spacing, tick){
      const per=spacing*88, start=Math.floor(tick/per)*per;
      const key=whirlpool+':'+start;
      if(!taCacheO.has(key)){
        const addr=await pda([new TextEncoder().encode('tick_array'), b58d(whirlpool), new TextEncoder().encode(String(start))], ORCA);
        const r=await sol('getMultipleAccounts',[[addr],{encoding:'base64'}]);
        taCacheO.set(key, r.value[0]?b64(r.value[0].data[0]):null);
      }
      const b=taCacheO.get(key);
      if(!b) return null;
      const idx=Math.round((tick-Math.floor(tick/per)*per)/spacing);
      if(idx<0||idx>=88) return null;
      if(b.length>=9988){
        // legacy fixed TickArray: 88 × 113-byte ticks at offset 12
        const base=12+idx*113;
        return { fgA:leU128(b,base+33), fgB:leU128(b,base+49) };
      }
      // DynamicTickArray: start@8, whirlpool@12, bitmap@44, then 88 borsh-enum ticks @60
      // tag 0 = Uninitialized (1 byte, fee growth outside = 0); tag 1 = Initialized (1 + 112 bytes)
      let off=60;
      for(let i=0;i<88;i++){
        if(off>=b.length) return null;
        const tag=b[off];
        if(i===idx){
          if(tag===0) return { fgA:0n, fgB:0n };
          return { fgA:leU128(b,off+1+32), fgB:leU128(b,off+1+48) };
        }
        off += 1 + (tag===1?112:0);
      }
      return null;
    }
    const fgIn=(g,lo,up,cur,tl,tu)=>{
      const below=cur>=tl?lo:(g-lo)&MASKO;
      const above=cur<tu?up:(g-up)&MASKO;
      return (g-below-above)&MASKO;
    };
    for(const {cat:c, pda:pd, op} of orcaFound){
      const w=wps.get(op.whirlpool); if(!w) continue;
      const dA=decMap[w.mintA]??9, dB=decMap[w.mintB]??9, scale=10**(dA-dB);
      const sp=Number(w.sqrtPriceX64)/Q64;
      const [ra,rb]=amounts(Number(op.liquidity),sp,tickToSqrt(op.tickLower),tickToSqrt(op.tickUpper));
      const amtA=ra/10**dA, amtB=rb/10**dB;
      const price=sp*sp*scale, priceLower=tickToPrice(op.tickLower)*scale, priceUpper=tickToPrice(op.tickUpper)*scale;
      let usdA=oPrices[w.mintA]??null, usdB=oPrices[w.mintB]??null;
      if(usdA==null&&usdB!=null) usdA=price*usdB;
      if(usdB==null&&usdA!=null) usdB=usdA/price;
      let fRawA=op.feeOwedA, fRawB=op.feeOwedB;
      try{
        const loT=await orcaTick(op.whirlpool,w.tickSpacing,op.tickLower);
        const upT=await orcaTick(op.whirlpool,w.tickSpacing,op.tickUpper);
        if(loT&&upT){
          const inA=fgIn(w.fgGlobalA,loT.fgA,upT.fgA,w.tickCurrent,op.tickLower,op.tickUpper);
          const inB=fgIn(w.fgGlobalB,loT.fgB,upT.fgB,w.tickCurrent,op.tickLower,op.tickUpper);
          let dAg=(inA-op.fgCheckA)&MASKO, dBg=(inB-op.fgCheckB)&MASKO;
          if(dAg>(1n<<127n)) dAg=0n;
          if(dBg>(1n<<127n)) dBg=0n;
          fRawA=op.feeOwedA+((dAg*op.liquidity)>>64n);
          fRawB=op.feeOwedB+((dBg*op.liquidity)>>64n);
        }
      }catch(e){ logErr('orcaFees '+op.positionMint.slice(0,6),e); }
      const fA=Number(fRawA)/10**dA, fB=Number(fRawB)/10**dB;
      const tick=w.tickCurrent;
      const inRange=tick>=op.tickLower&&tick<op.tickUpper;
      const rangePos=(price-priceLower)/(priceUpper-priceLower); // linear price space (v19)
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
      out.push({ id:'sol:'+op.positionMint, chain:'sol', venue:'orca', relay:true, wallet:c.wallet,
        nftMint:op.positionMint, poolId:op.whirlpool, pda:pd,
        m0:{symbol:oSyms[w.mintA]}, m1:{symbol:oSyms[w.mintB]}, d0:dA, d1:dB, tick, price, priceLower, priceUpper,
        amt0:amtA, amt1:amtB, f0:fA, f1:fB, usd0:usdA, usd1:usdB,
        valueUsd:(usdA!=null&&usdB!=null)?amtA*usdA+amtB*usdB:null,
        feesUsd:(usdA!=null&&usdB!=null)?fA*usdA+fB*usdB:null,
        feesEverUsd:null, costUsd:null, roiPct:null, roiMode:'sol', feeAprPct:null,
        poolAprPct:null, poolAprDay:null, poolAprWeek:null, poolAprMonth:null,
        mintTs, ageDays:mintTs?(Date.now()-mintTs)/86400000:null,
        inRange, rangePos, dLow, dUp, nearestEdge:dLow<dUp?'lower':'upper',
        edgeDist:inRange?Math.min(dLow,dUp):-(price<priceLower?(priceLower-price)/price*100:(price-priceUpper)/price*100),
        pairLabel:oSyms[w.mintA]+' / '+oSyms[w.mintB],
        feeLabel:(w.feeRate/1e4).toFixed(w.feeRate%100?2:1).replace(/\.0$/,'')+'%' });
    }
  }
  if(!found.length) return out;
  // ---------- RAYDIUM branch ----------
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
    const rangePos=(price-priceLower)/(priceUpper-priceLower); // linear price space (v19)
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
  const blockNums={};
  for(const ck in CHAINS){ try{ blockNums[ck]=Number(BigInt(await evm(ck,'eth_blockNumber',[]))); }catch(e){ logErr('block '+ck,e); } }
  const blockNum=blockNums.ethereum;
  let gasGwei=null; try{ gasGwei=Number(BigInt(await eth('eth_gasPrice',[])))/1e9; }catch(e){}
  let ethUsd=null,btcUsd=null,ethUsdChg24=null;
  try{ ethUsd=bigToFloat(BigInt(await ethCall(CHAINLINK_ETH,SEL.latestAnswer)),8); }catch(e){ logErr('chainlinkEth',e); }
  try{
    const ago=bigToFloat(BigInt(await ethCall(CHAINLINK_ETH,SEL.latestAnswer,'0x'+(blockNum-7200).toString(16))),8);
    if(ethUsd&&ago) ethUsdChg24=(ethUsd/ago-1)*100;
  }catch(e){}
  try{ btcUsd=bigToFloat(BigInt(await ethCall(CHAINLINK_BTC,SEL.latestAnswer)),8); }catch(e){}
  let topPools=[];
  try{
    const js=await getJson('https://yields.llama.fi/pools',45000);
    // v20: broad multi-venue sweep, volatile/volatile pairs ONLY (no stables in either leg)
    const VENUES=['uniswap-v3','uniswap-v4','raydium-clmm','raydium-amm','raydium-amm-v3','orca-dex','orca','pancakeswap-amm-v3','pancakeswap-v3','pancakeswap-amm','aerodrome-slipstream','aerodrome-v1','velodrome-v3','velodrome-v2','velodrome-slipstream','camelot-v3','camelot-v2','thena-v3','thena-fusion','quickswap-v3','quickswap-dex','sushiswap-v3','meteora-dlmm','meteora-damm-v2','meteora'];
    const CHAINS_OK=['Ethereum','Solana','Arbitrum','Base','Optimism','Polygon','BSC','Avalanche'];
    const STABLE=/(USD|DAI|FRAX|MIM|GHO|BUSD|EUR|LUSD|CRVUSD|DOLA|BOLD|MKUSD|PYUSD|FDUSD|TUSD|USDE|SUSDE|GUSD|PAI|UXD)/i;
    const cand=(js.data||[]).filter(x=>{
      if(!CHAINS_OK.includes(x.chain)||!VENUES.includes(x.project)) return false;
      if(!(x.tvlUsd>=2e6 && x.apy>3 && x.apy<=500)) return false;
      const legs=String(x.symbol||'').split('-');
      if(legs.length<2) return false;
      if(legs.some(l=>STABLE.test(l))) return false;          // no stablecoin legs
      if((x.apyBase??0)<=0 && (x.apyReward??0)>(x.apy*0.98)) return false; // pure-emission farms with zero fee income
      return true;
    });
    // rank on the sturdier of spot APY vs 30-day mean (kills one-day mirages), dedupe fee tiers, cap 8/venue
    cand.sort((a,b)=>Math.min(b.apy,b.apyMean30d??b.apy)-Math.min(a.apy,a.apyMean30d??a.apy));
    const seen=new Set(), perVenue={};
    for(const x of cand){
      const k=x.project+'|'+x.chain+'|'+x.symbol;
      if(seen.has(k)) continue;
      if((perVenue[x.project]||0)>=8) continue;
      seen.add(k); perVenue[x.project]=(perVenue[x.project]||0)+1;
      topPools.push({chain:x.chain,project:x.project,symbol:x.symbol,tvl:x.tvlUsd,apy:x.apy,
        base:x.apyBase??null,reward:x.apyReward??null,il:x.ilRisk??null,id:x.pool,
        mean30:x.apyMean30d??null,sig:x.sigma??null,vol1d:x.volumeUsd1d??null});
      if(topPools.length>=25) break;
    }
    console.log('topPools:',topPools.length,'venues:',JSON.stringify(perVenue));
  }catch(e){ logErr('llama pools',e); }

  for(const profile of CONFIG.profiles){
    errors.length=0;
    const chainErrs=new Set();
    const excluded=new Set((profile.excluded||[]).map(String));
    const evmPositions=[];
    for(const w of (profile.wallets||[]).filter(w=>w.chain!=='solana')){
      const ck=w.chain in CHAINS ? w.chain : 'ethereum';
      if(blockNums[ck]==null) continue;
      try{
        const ids=await walletPositionIds(ck, w.address.toLowerCase().replace(/^0x/,''));
        console.log(profile.slug, ck, w.address.slice(0,8), '→', ids.length, 'NFTs');
        for(const id of ids){
          if(excluded.has(ck+':'+id) || excluded.has(String(id))) continue;
          try{
            const p=await fetchEvmPosition(ck,id,blockNums[ck],ethUsd,btcUsd);
            if(p){ p.wallet='0x'+w.address.toLowerCase().replace(/^0x/,''); evmPositions.push(p); }
          }catch(e){ logErr(ck+'#'+id,e); }
          await sleep(200);
        }
      }catch(e){ logErr('wallet '+w.address.slice(0,8)+' '+ck,e); chainErrs.add(ck); }
    }
    for(const pin of (profile.pinned||[])){
      const ck=pin.chain in CHAINS ? pin.chain : 'ethereum';
      if(excluded.has(ck+':'+pin.id)) continue;
      if(evmPositions.some(p=>p.chain===ck&&p.id===pin.id)) continue;
      try{ const p=await fetchEvmPosition(ck,pin.id,blockNums[ck],ethUsd,btcUsd); if(p) evmPositions.push(p); }
      catch(e){ logErr('pin '+ck+'#'+pin.id,e); }
    }
    // deploy dating for duplicate-pair token0s
    async function tokenDeployTs(ck,addr){
      try{
        const codeNow=await evm(ck,'eth_getCode',[addr,'latest']);
        if(codeNow==='0x') return null;
        let lo=1, hi=blockNums[ck];
        for(let i=0;i<20;i++){
          const mid=Math.floor((lo+hi)/2);
          try{ const code=await evm(ck,'eth_getCode',[addr,'0x'+mid.toString(16)]); if(code&&code!=='0x') hi=mid; else lo=mid+1; }
          catch(e){ lo=mid+1; }
        }
        const blk=await evm(ck,'eth_getBlockByNumber',['0x'+hi.toString(16),false]);
        return Number(BigInt(blk.timestamp))*1000;
      }catch(e){ return null; }
    }
    {
      const byPair={};
      for(const p of evmPositions){ (byPair[p.chain+p.pairLabel]=byPair[p.chain+p.pairLabel]||new Set()).add(p.token0); }
      const dup=new Set();
      for(const k in byPair) if(byPair[k].size>1) byPair[k].forEach(t=>dup.add(t));
      const deployTs={};
      for(const p of evmPositions){
        if(dup.has(p.token0)){
          const key=p.chain+':'+p.token0;
          if(!(key in deployTs)) deployTs[key]=await tokenDeployTs(p.chain,p.token0);
          p.token0DeployTs=deployTs[key];
        }
      }
    }
    // volatility per unique pool
    const volCache={}, vol24Cache={};
    for(const p of evmPositions){
      try{
        const key=p.chain+':'+p.pool;
        if(!(key in volCache)) volCache[key]=await poolVolatility(p.chain,p.pool,10**(p.d0-p.d1),blockNums[p.chain]);
        if(!(key in vol24Cache)) vol24Cache[key]=await poolVol24(p.chain,p.pool,10**(p.d0-p.d1),blockNums[p.chain]);
        p.range=rangeAnalytics(p.price,p.priceLower,p.priceUpper,volCache[key]?.sigma);
        p.sigma30=volCache[key]?.sigma??null; p.vol24=vol24Cache[key]?.sigma??null;
        p.volHist30=volCache[key]?.moves??null; p.volHist24=vol24Cache[key]?.moves??null;
      }catch(e){ p.range=null; }
    }
    // solana
    let solPositions=[];
    const solWallets=(profile.wallets||[]).filter(w=>w.chain==='solana').map(w=>w.address);
    if(solWallets.length){
      try{ solPositions=await fetchSolana(solWallets); }
      catch(e){ logErr('sol',e); chainErrs.add('solana'); }
    }
    // ---- harvest ledger: detect fee collections between snapshots (Solana has no easy event log) ----
    try{
      let ledger={}; try{ ledger=JSON.parse(fs.readFileSync(OUT+'/ledger-'+profile.slug+'.json','utf8')); }catch(e){}
      let prev=null; try{ prev=JSON.parse(fs.readFileSync(OUT+'/data-'+profile.slug+'.json','utf8')); }catch(e){}
      const prevSol=new Map((prev&&prev.sol||[]).map(p=>[p.id,p]));
      for(const p of solPositions){
        const L=ledger[p.id]=ledger[p.id]||{collectedUsd:0};
        const pv=prevSol.get(p.id);
        if(pv && pv.feesUsd!=null && p.feesUsd!=null){
          const drop=pv.feesUsd-p.feesUsd;
          const valStable=Math.abs((pv.valueUsd||0)-(p.valueUsd||0)) < Math.max(50,(p.valueUsd||1)*0.5);
          if(drop>0.5 && valStable) L.collectedUsd+=drop;   // pending fees fell without the position changing → harvested
        }
        p.feesCollectedUsd=L.collectedUsd;
        p.feesEverUsd=L.collectedUsd+(p.feesUsd||0);
        if(p.ageDays>0.05 && p.valueUsd>0) p.feeAprPct=(p.feesEverUsd/p.valueUsd)*(365/p.ageDays)*100;
      }
      fs.writeFileSync(OUT+'/ledger-'+profile.slug+'.json', JSON.stringify(ledger,null,1));
    }catch(e){ logErr('ledger',e); }
    // ---- monthly fee ledger: MTD earned across ACTIVE + CLOSED LPs, claimed + unclaimed ----
    let feeMonth=null;
    const justClosed=[];   // evm positions that vanished this run — their final close tx still owes gas accounting
    try{
      const monthKey=new Date().toISOString().slice(0,7);
      let fl={month:monthKey, closed:0, pos:{}, months:[]};
      try{ fl=JSON.parse(fs.readFileSync(OUT+'/fees-'+profile.slug+'.json','utf8')); }catch(e){}
      if(fl.month!==monthKey){
        const prevTotal=(fl.closed||0)+Object.values(fl.pos||{}).reduce((s,x)=>s+Math.max(0,x.last-x.m0),0);
        fl.months=[...(fl.months||[]),{m:fl.month,total:Math.round(prevTotal*100)/100,ilEnd:fl.lastIl??null}].slice(-12);
        fl.month=monthKey; fl.closed=0;
        for(const id in fl.pos) fl.pos[id].m0=fl.pos[id].last;
      }
      const seen=new Set();
      for(const p of [...evmPositions,...solPositions]){
        const cum=p.feesEverUsd ?? (p.feesUsd!=null?p.feesUsd:null);
        if(cum==null) continue;
        seen.add(String(p.id));
        const e=fl.pos[p.id];
        if(!e){
          const mintedThisMonth=p.mintTs && new Date(p.mintTs).toISOString().slice(0,7)===monthKey;
          // baseline priority: 0 if minted this month → archive-read month-start fees → first-seen value
          const m0=mintedThisMonth?0:(p.feesMonthStartUsd!=null?Math.min(p.feesMonthStartUsd,cum):cum);
          fl.pos[p.id]={m0:Math.round(m0*100)/100, last:Math.round(cum*100)/100, ck:p.chain||'ethereum'};
        } else e.last=Math.round(cum*100)/100;
      }
      for(const id of Object.keys(fl.pos)){
        if(!seen.has(String(id))){
          fl.closed=(fl.closed||0)+Math.max(0,fl.pos[id].last-fl.pos[id].m0);
          const ck=fl.pos[id].ck||'ethereum';
          if(ck!=='sol'&&ck in CHAINS) justClosed.push({id,ck});
          delete fl.pos[id];
        }
      }
      fl.closed=Math.round((fl.closed||0)*100)/100;
      const mtd=fl.closed+Object.values(fl.pos).reduce((s,x)=>s+Math.max(0,x.last-x.m0),0);
      const nowD=new Date();
      const daysInMonth=new Date(Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth()+1,0)).getUTCDate();
      const elapsed=(Date.now()-Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth(),1))/86400000;
      fl.lastIl=Math.round(evmPositions.reduce((s,p)=>s+(p.ilUsd||0),0)*100)/100;
      feeMonth={month:monthKey, mtd:Math.round(mtd*100)/100, ilNow:fl.lastIl, elapsedDays:Math.round(elapsed*100)/100, daysInMonth,
        proj: elapsed>0.25?Math.round(mtd/elapsed*daysInMonth*100)/100:null, prev:fl.months||[]};
      fs.writeFileSync(OUT+'/fees-'+profile.slug+'.json', JSON.stringify(fl,null,1));
    }catch(e){ logErr('feeMonth',e); }
    // ---- monthly COST ledger: gas for every LP op + ALL rebalance swap fees (any pool, any route) ----
    let costMonth=null;
    try{
      const monthKey=new Date().toISOString().slice(0,7);
      let cl={month:monthKey, gasUsd:0, swapFeeUsd:0, txs:{}, scan:{}, months:[]};
      try{ cl=JSON.parse(fs.readFileSync(OUT+'/costs-'+profile.slug+'.json','utf8')); }catch(e){}
      cl.scan=cl.scan||{};
      if(cl.month!==monthKey){
        cl.months=[...(cl.months||[]),{m:cl.month,gas:Math.round(cl.gasUsd*100)/100,swapFee:Math.round(cl.swapFeeUsd*100)/100}].slice(-12);
        cl.month=monthKey; cl.gasUsd=0; cl.swapFeeUsd=0; cl.txs={};
      }
      const SWAP_V3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
      const SWAP_V2='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
      const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const nowD=new Date();
      const msTs=Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth(),1);
      const msBlockOf=ck=>Math.max(1, blockNums[ck]-Math.round((Date.now()-msTs)/3600000*CHAINS[ck].bph));
      // pool metadata cache (fee tier, tokens, prices) for ANY pool a swap routes through
      const poolCache={};
      const swapFeeOf=async(ck,lg)=>{
        const addr=String(lg.address).toLowerCase(), key=ck+addr, isV2=lg.topics[0]===SWAP_V2;
        let pc=poolCache[key];
        if(!pc){
          try{
            const t0='0x'+(await evmCall(ck,addr,'0x0dfe1681')).slice(-40);
            const t1='0x'+(await evmCall(ck,addr,'0xd21220a7')).slice(-40);
            let fee=3000; // V2 fixed 0.3%
            if(!isV2){ try{ fee=Number(BigInt(await evmCall(ck,addr,'0xddca3f43'))); }catch(e){} }
            const mm0=await meta(ck,t0), mm1=await meta(ck,t1);
            await llamaPrices([CHAINS[ck].llama+':'+t0,CHAINS[ck].llama+':'+t1]);
            pc={fee,d0:mm0.decimals,d1:mm1.decimals,u0:priceCache[CHAINS[ck].llama+':'+t0],u1:priceCache[CHAINS[ck].llama+':'+t1]};
          }catch(e){ pc=null; }
          poolCache[key]=pc||{fee:0,d0:18,d1:18,u0:null,u1:null};
          pc=poolCache[key];
        }
        let inUsd=0;
        if(isV2){
          const in0=bigToFloat(BigInt(word(lg.data,0)),pc.d0), in1=bigToFloat(BigInt(word(lg.data,1)),pc.d1);
          inUsd=in0*(pc.u0||0)+in1*(pc.u1||0);
        }else{
          const a0=toSigned(BigInt(word(lg.data,0)),256), a1=toSigned(BigInt(word(lg.data,1)),256);
          inUsd=(a0>0n?bigToFloat(a0,pc.d0)*(pc.u0||0):0)+(a1>0n?bigToFloat(a1,pc.d1)*(pc.u1||0):0);
        }
        return inUsd*pc.fee/1e6;
      };
      const countReceipt=async(ck,tx,requireRelevant)=>{
        if(cl.txs[tx]) return;
        try{
          const rc=await evm(ck,'eth_getTransactionReceipt',[tx]);
          if(!rc){ return; }
          const swaps=(rc.logs||[]).filter(l=>l.topics&&(l.topics[0]===SWAP_V3||l.topics[0]===SWAP_V2));
          const touchesNpm=(rc.logs||[]).some(l=>String(l.address).toLowerCase()===CHAINS[ck].npm.toLowerCase());
          if(requireRelevant && !swaps.length && !touchesNpm){ cl.txs[tx]=2; return; }  // plain transfer — seen, not a cost
          cl.txs[tx]=1;
          cl.gasUsd+=bigToFloat(BigInt(rc.gasUsed)*BigInt(rc.effectiveGasPrice),18)*(ethUsd||0);
          for(const sw of swaps) cl.swapFeeUsd+=await swapFeeOf(ck,sw);
        }catch(e){ logErr('cost '+String(tx).slice(0,10),e); }
        await sleep(120);
      };
      // 1) LP operations of live positions (mint/add/remove/collect)
      for(const p of evmPositions) for(const o of (p.opTxs||[]))
        if(blockNums[p.chain]!=null && o.block>=msBlockOf(p.chain)) await countReceipt(p.chain,o.tx,false);
      // 2) final close txs of positions that vanished this run
      for(const jc of justClosed){
        try{ const h=await evmHistory(jc.ck,Number(jc.id)||jc.id);
          for(const x of [...h.inc,...h.dec,...h.col]) if(x.tx&&blockNums[jc.ck]!=null&&x.block>=msBlockOf(jc.ck)) await countReceipt(jc.ck,x.tx,false);
        }catch(e){ logErr('cost closed#'+jc.id,e); }
      }
      // 3) wallet swap sweep: every tx this month where a wallet sent or received tokens,
      //    kept only if it contains swap events or touches the position manager
      for(const w of (profile.wallets||[]).filter(w=>w.chain!=='solana')){
        const ck=w.chain in CHAINS?w.chain:'ethereum';
        if(blockNums[ck]==null) continue;
        const wt='0x'+pad32(w.address.toLowerCase().replace(/^0x/,''));
        const skey=ck+':'+w.address.toLowerCase();
        let from=cl.scan[skey]!=null?cl.scan[skey]+1:msBlockOf(ck);
        const tip=blockNums[ck], CHUNK=ck==='ethereum'?9000:45000;
        let guard=0;
        while(from<=tip && guard<40){
          guard++;
          const to=Math.min(tip,from+CHUNK-1);
          let hs=[];
          try{
            const out=await evm(ck,'eth_getLogs',[{fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[TRANSFER,wt]}]);
            const inn=await evm(ck,'eth_getLogs',[{fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),topics:[TRANSFER,null,wt]}]);
            hs=[...new Set([...out,...inn].map(l=>l.transactionHash))];
          }catch(e){ logErr('swapscan '+ck+' '+from,e); break; }
          for(const tx of hs) await countReceipt(ck,tx,true);
          cl.scan[skey]=to; from=to+1;
          await sleep(150);
        }
      }
      cl.gasUsd=Math.round(cl.gasUsd*100)/100; cl.swapFeeUsd=Math.round(cl.swapFeeUsd*100)/100;
      const counted=Object.values(cl.txs).filter(v=>v===1).length;
      costMonth={month:monthKey, gasUsd:cl.gasUsd, swapFeeUsd:cl.swapFeeUsd,
        total:Math.round((cl.gasUsd+cl.swapFeeUsd)*100)/100, txCount:counted, prev:cl.months||[]};
      fs.writeFileSync(OUT+'/costs-'+profile.slug+'.json', JSON.stringify(cl,null,1));
    }catch(e){ logErr('costMonth',e); }
    const usedChains=new Set((profile.wallets||[]).map(w=>w.chain==='solana'?'solana':(w.chain in CHAINS?w.chain:'ethereum')));
    const chainStatus={};
    for(const ck of usedChains){
      chainStatus[ck] = ck==='solana' ? (chainErrs.has('solana')?'down':'ok')
        : (blockNums[ck]==null||chainErrs.has(ck) ? 'down' : 'ok');
    }
    // persistent portfolio history (value + cumulative pending fees), ~30 days at 15-min cadence
    let history=[];
    try{ history=JSON.parse(fs.readFileSync(OUT+'/hist-'+profile.slug+'.json','utf8')); }catch(e){}
    {
      const totV=[...evmPositions,...solPositions].reduce((s,p)=>s+(p.valueUsd||0),0);
      const totF=[...evmPositions,...solPositions].reduce((s,p)=>s+(p.feesUsd||0),0);
      history.push({t:Date.now(), v:Math.round(totV*100)/100, f:Math.round(totF*100)/100});
      if(history.length>3000) history=history.slice(-3000);
      fs.writeFileSync(OUT+'/hist-'+profile.slug+'.json', JSON.stringify(history));
    }
    const data={ v:6, t:Date.now(), profile:profile.slug, chainStatus, history, feeMonth, costMonth, ethUsdChg24, block:blockNum, blocks:blockNums, ethUsd, btcUsd, gasGwei,
      eth:evmPositions, sol:solPositions, topPools, errors:[...errors] };
    for(const p of data.eth) delete p.opTxs;   // internal bookkeeping — keep payload lean
    fs.writeFileSync(OUT+'/data-'+profile.slug+'.json', JSON.stringify(data));
    if(profile===CONFIG.profiles[0]) fs.writeFileSync(OUT+'/data.json', JSON.stringify(data));
    console.log('profile',profile.slug,':',evmPositions.length,'evm +',solPositions.length,'sol · errors:',errors.length);
  }
};
main().catch(e=>{ console.error('FATAL',e); process.exit(1); });

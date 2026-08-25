// v22.2 relay nudge
/* Server-side data refresh for ARC // LP COMMAND.
   Runs in GitHub Actions (Node 20, no deps). Fetches Uniswap V3 + Raydium CLMM
   position data and writes data.json for the static dashboard to consume. */

import { pathToFileURL } from 'node:url';
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
/* Real prices as of a past moment. A historical price never changes, so anything derived
   from one can be cached permanently — which is the whole point: a cost basis must be a fact
   about the past, not a figure recomputed from today's market on every run. */
async function llamaHistorical(keys,ts){
  const out={};
  try{
    const js=await getJson('https://coins.llama.fi/prices/historical/'+Math.floor(ts)+'/'+keys.join(','),20000);
    for(const k of keys){ const c=js&&js.coins&&js.coins[k]; if(c&&c.price!=null) out[k]=c.price; }
  }catch(e){ logErr('llamaHist',e); }
  return out;
}
async function blockTs(ck,block){
  const key=ck+':'+block, hit=blockCache.blkTs[key];
  if(hit!=null) return hit;
  try{
    const blk=await evm(ck,'eth_getBlockByNumber',['0x'+block.toString(16),false]);
    const t=Number(BigInt(blk.timestamp));
    blockCache.blkTs[key]=t; return t;
  }catch(e){ return null; }
}
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
/* v25.2: public RPCs no longer allow unbounded eth_getLogs (10k-block cap) —
   every log scan now walks the range in CHUNK-sized windows. */
async function getLogsChunked(ck,filter,fromBlock,toBlock){
  const CHUNK=ck==='ethereum'?9000:45000;
  const out=[];
  let from=fromBlock, guard=0;
  while(from<=toBlock && guard<220){
    guard++;
    const to=Math.min(toBlock,from+CHUNK-1);
    // One flaky chunk used to throw away the whole scan — losing a position's entire
    // history (cost basis, fee totals) for the cycle. Retry before giving up.
    let lg=null,err=null;
    for(let attempt=0;attempt<3;attempt++){
      try{ lg=await evm(ck,'eth_getLogs',[{...filter,fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16)}]); err=null; break; }
      catch(e){ err=e; await sleep(500*(attempt+1)); }
    }
    if(err) throw err;
    out.push(...lg);
    from=to+1;
    if(from<=toBlock) await sleep(120);
  }
  if(from<=toBlock) throw new Error('chunk guard hit at '+from+'/'+toBlock);
  return out;
}
/* persistent scan cache (committed with the other JSON ledgers):
   mint  — position id → mint block, found once by binary search, then never again
   tscan — wallet NFT-transfer scan checkpoint + candidate ids */
let blockCache={mint:{},tscan:{},evh:{},mintInfo:{},tokMeta:{},depUsd:{},blkTs:{}};
/* Only an explicit revert proves "this id did not exist yet". Everything else — including
   phrasings we have never seen — is treated as "the node could not answer" and retried.
   The asymmetry is deliberate: over-calling infra costs one logged error and a recompute
   next run, while under-calling it silently caches a wrong mint block forever. Public RPCs
   return things like "service temporarily unavailable", which no infra allowlist catches. */
const RPC_REVERT=/revert|invalid token id|invalid opcode|out of gas|execution failed/i;
/* One probe of positions(id) at a historical block.
   true = live, false = reverted (not minted yet), throw = the node could not tell us.
   Conflating the third case with the second walks the search past the real mint block,
   and since the answer is cached permanently that bakes in an understated cost basis. */
async function positionsLiveAt(ck,npm,idHex,block){
  for(let attempt=0;attempt<3;attempt++){
    try{ await evmCall(ck,npm,SEL.positions+idHex,'0x'+block.toString(16)); return true; }
    catch(e){
      if(RPC_REVERT.test(String((e&&e.message)||e))) return false;   // a real revert
      await sleep(400*(attempt+1));
    }
  }
  throw new Error('mint probe indeterminate at block '+block);
}
async function positionMintBlock(ck,id,tip){
  const key=ck+':'+id;
  if(blockCache.mint[key]!=null) return blockCache.mint[key];
  const C=CHAINS[ck], idHex=pad32(id.toString(16));
  // Precondition: the search is only monotone while the position is live. positions(id)
  // also reverts after a burn, so probing a closed id would binary-search on noise.
  if(!await positionsLiveAt(ck,C.npm,idHex,tip)) throw new Error('position '+id+' not live at tip');
  let lo=C.startBlock, hi=tip;   // positions(id) reverts before mint → monotone for live positions
  while(lo<hi){
    const mid=Math.floor((lo+hi)/2);
    if(await positionsLiveAt(ck,C.npm,idHex,mid)) hi=mid; else lo=mid+1;
    await sleep(60);
  }
  blockCache.mint[key]=Math.max(C.startBlock,hi-1);
  return blockCache.mint[key];
}
/* ETH/USD at a historical block, from the Chainlink feed. Cached per block — a position
   with several top-ups reuses blocks, and neighbouring positions often share them. */
const ethUsdBlockCache={};
async function ethUsdAtBlock(block){
  if(block in ethUsdBlockCache) return ethUsdBlockCache[block];
  try{
    const r=await ethCall(CHAINLINK_ETH,SEL.latestAnswer,'0x'+block.toString(16));
    const v=bigToFloat(BigInt(r),8);
    return ethUsdBlockCache[block]=(v>0?v:null);
  }catch(e){ return ethUsdBlockCache[block]=null; }
}
async function evmHistory(ck,id,fromBlock,tip){
  const C=CHAINS[ck];
  const topicId='0x'+pad32(id.toString(16));
  const logs=await getLogsChunked(ck,{address:C.npm,topics:[[TOPIC_INC,TOPIC_DEC,TOPIC_COL],topicId]},fromBlock,tip);
  const parse=lg=>({block:Number(BigInt(lg.blockNumber)),tx:lg.transactionHash,a0:BigInt(word(lg.data,1)),a1:BigInt(word(lg.data,2))});
  return { inc:logs.filter(l=>l.topics[0]===TOPIC_INC).map(parse),
           dec:logs.filter(l=>l.topics[0]===TOPIC_DEC).map(parse),
           col:logs.filter(l=>l.topics[0]===TOPIC_COL).map(parse) };
}
async function walletPositionIds(ck,wallet,tip){
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
    // fallback: NFT Transfer logs into this wallet, then verify current ownership.
    // v25.2: chunked + checkpointed — first run backfills 60 days, later runs scan only the delta.
    try{
      const TT='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const skey=ck+':'+wallet;
      const tc=blockCache.tscan[skey]||{last:Math.max(C.startBlock,tip-60*C.bph*24)-1,ids:[]};
      const news=await getLogsChunked(ck,{address:C.npm,topics:[TT,null,'0x'+wp]},tc.last+1,tip);
      for(const lg of news){
        const id=Number(BigInt(lg.topics[3]));
        if(!tc.ids.includes(id)) tc.ids.push(id);
      }
      tc.last=tip; blockCache.tscan[skey]=tc;
      for(const id of tc.ids){
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
  let histFrom=null;
  try{ const mb=await positionMintBlock(ck,id,blockNum); histFrom=mb; hist=await evmHistory(ck,id,mb,blockNum); }catch(e){ logErr(ck+' hist#'+id,e); }
  if(hist.inc.length){
    const mintBlock=Math.min(...hist.inc.map(x=>x.block));
    try{ const blk=await evm(ck,'eth_getBlockByNumber',['0x'+mintBlock.toString(16),false]); mintTs=Number(BigInt(blk.timestamp))*1000; }catch(e){}
    if(ck==='ethereum'){
      try{ const r=await ethCall(CHAINLINK_ETH,SEL.latestAnswer,'0x'+mintBlock.toString(16)); entryEthUsd=bigToFloat(BigInt(r),8); }catch(e){}
    }
  }
  const sum=(arr,k,dec)=>arr.reduce((s,x)=>s+bigToFloat(x[k],dec),0);
  const rDep0=sum(hist.inc,'a0',d0), rDep1=sum(hist.inc,'a1',d1);
  const rWdr0=sum(hist.dec,'a0',d0), rWdr1=sum(hist.dec,'a1',d1);
  const rCol0=sum(hist.col,'a0',d0), rCol1=sum(hist.col,'a1',d1);
  /* A public RPC can return a partial log set without erroring — that is exactly what zeroed
     this position's collected fees earlier today. Every sum here is cumulative over the
     position's life and can only grow, so a reading below the previous one is proof the scan
     came back short, not that history changed. Hold the high-water values so cost basis, fees,
     ROI and IL stay right, and refuse to publish the window-scoped figures, which cannot be
     reconstructed from a short read and would otherwise report a falsely low APR. */
  const evKey=ck+':'+id, prevEv=blockCache.evh[evKey]||null;
  const obsEv={nInc:hist.inc.length,nDec:hist.dec.length,nCol:hist.col.length,
               dep0:rDep0,dep1:rDep1,wdr0:rWdr0,wdr1:rWdr1,col0:rCol0,col1:rCol1,mintTs:mintTs||null};
  let histPartial=false;
  if(prevEv) for(const k of ['nInc','nDec','nCol','dep0','dep1','wdr0','wdr1','col0','col1'])
    if((obsEv[k]||0) < (prevEv[k]||0)-1e-9){ histPartial=true; break; }
  const mx=(a,b)=>Math.max(a||0,b||0);
  const dep0=histPartial?mx(rDep0,prevEv.dep0):rDep0, dep1=histPartial?mx(rDep1,prevEv.dep1):rDep1;
  const wdr0=histPartial?mx(rWdr0,prevEv.wdr0):rWdr0, wdr1=histPartial?mx(rWdr1,prevEv.wdr1):rWdr1;
  const col0=histPartial?mx(rCol0,prevEv.col0):rCol0, col1=histPartial?mx(rCol1,prevEv.col1):rCol1;
  if(histPartial){
    logErr(ck+' partial log read #'+id, new Error('inc/dec/col '+obsEv.nInc+'/'+obsEv.nDec+'/'+obsEv.nCol
      +' < seen '+prevEv.nInc+'/'+prevEv.nDec+'/'+prevEv.nCol+' — held high-water totals, windows suppressed'));
    if(prevEv.mintTs && (!mintTs || prevEv.mintTs<mintTs)) mintTs=prevEv.mintTs;
  } else blockCache.evh[evKey]=obsEv;
  /* Everything ever collected = principal released by DecreaseLiquidity + fees, so netting
     the cumulative totals is the right identity. Per-transaction matching is NOT — a decrease
     credits tokensOwed and the collect frequently lands in a later transaction, which would
     then count released principal as fee income.
     feesEverUsd currently comes back equal to feesUsd for every position, i.e. this nets to
     zero even after a real collect, so the components are published for diagnosis. */
  const feeCol0=Math.max(0,col0-wdr0), feeCol1=Math.max(0,col1-wdr1);
  const feeDbg={nInc:hist.inc.length, nDec:hist.dec.length, nCol:hist.col.length,
    col0:+col0.toFixed(6), col1:+col1.toFixed(8), wdr0:+wdr0.toFixed(6), wdr1:+wdr1.toFixed(8),
    from:histFrom};
  const ageDays=mintTs?(Date.now()-mintTs)/86400000:null;
  let costUsd=null,roiPct=null,roiMode='hodl',feeAprPct=null,feesEverUsd=null,ilUsd=null,lpVsHodlUsd=null,hodlNowUsd=null;
  if(usd0!=null&&usd1!=null&&(dep0>0||dep1>0)){
    let e0=usd0,e1=usd1;
    const st=new Set(C.stables);
    const pricerAt=eAt=>(addr,cur)=>{const a=addr.toLowerCase(); if(st.has(a))return 1; if(a===C.weth)return eAt; return cur!=null?cur*(eAt/ethUsd):null;};
    // Value every deposit at the ETH price of ITS OWN block. dep0/dep1 sum all
    // IncreaseLiquidity events, so pricing the whole stack at the first mint's ETH price
    // misstated the basis of later top-ups by however much ETH had moved in between.
    /* Not on a partial read. dep/wdr/col above are all held at their high-water marks when the
       log set comes back short, but this loop walks the RAW event list — so a dropped
       IncreaseLiquidity would shrink the basis while IL kept the full deposits, inflating both
       roiPct and feeAprPct. A position with a top-up (two inc events) that reads back one would
       show roughly double its true return. Fall back to the guarded dep totals instead. */
    let perEvent=null;
    if(ck==='ethereum'&&ethUsd&&hist.inc.length&&!histPartial){
      /* Price every deposit at the real prices of ITS OWN moment, then cache that dollar
         figure permanently. The previous estimate — today's token price scaled by the ETH
         ratio — silently assumed the token held its value in ETH terms. When LCX moved ~90%
         against ETH in a day, four positions' bases inflated 63-70% with no capital added,
         which flowed straight into ROI and fee APR. */
      let acc=0;
      for(const ev of hist.inc){
        const dk=ck+':'+id+':'+ev.block;
        let v=blockCache.depUsd[dk];
        if(v==null){
          const ts=await blockTs(ck,ev.block);
          if(ts!=null){
            const k0=C.llama+':'+token0, k1=C.llama+':'+token1;
            const hp=await llamaHistorical([k0,k1],ts);
            if(hp[k0]!=null&&hp[k1]!=null){
              v=bigToFloat(ev.a0,d0)*hp[k0]+bigToFloat(ev.a1,d1)*hp[k1];
              blockCache.depUsd[dk]=v;          // a fact about the past — never recomputed
            }
          }
          if(v==null){
            // No historical quote. Fall back to the old estimate for this run only, and do
            // NOT cache it, so a later run can still record the real figure.
            const eAt=await ethUsdAtBlock(ev.block);
            if(eAt==null){ acc=null; break; }
            const sc=pricerAt(eAt);
            const p0=sc(token0,usd0), p1=sc(token1,usd1);
            if(p0==null||p1==null){ acc=null; break; }
            v=bigToFloat(ev.a0,d0)*p0+bigToFloat(ev.a1,d1)*p1;
          }
        }
        acc+=v;
      }
      perEvent=acc;
    }
    if(perEvent!=null){ costUsd=perEvent; roiMode='entry'; }
    else{
      // fallback: single entry price for the whole stack (pre-existing behaviour)
      if(ck==='ethereum'&&entryEthUsd&&ethUsd){
        const sc=pricerAt(entryEthUsd);
        const s0=sc(token0,usd0),s1=sc(token1,usd1);
        if(s0!=null&&s1!=null){e0=s0;e1=s1;roiMode='entry';}
      }
      costUsd=dep0*e0+dep1*e1;
    }
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
    if(usd0!=null&&usd1!=null&&mintTs!=null&&!histPartial){
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
    if(histPartial) continue;              // a short read understates the window → publish nothing
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
    amt0, amt1, f0, f1, usd0, usd1, valueUsd, feesUsd, feesEverUsd, feesMonthStartUsd, opTxs, ilUsd, lpVsHodlUsd, hodlNowUsd, costUsd, roiPct, roiMode, feeAprPct, aprW, feeDbg, histPartial,
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
      m0:{symbol:symbols[pool.mint0]}, m1:{symbol:symbols[pool.mint1]}, mint0:pool.mint0, mint1:pool.mint1, d0, d1, tick, price, priceLower, priceUpper,
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

/* ---------- IDLE BALANCES: what is sitting in the wallets, not in an LP ----------
   The dashboard has always measured deployed capital and been blind to everything else,
   which makes "should I pool more?" unanswerable from the data. This scans each wallet for
   native + token balances and prices them with the same feeds the LP side already uses.

   EVM token discovery: ERC-20 has no "list my tokens" call, so candidates come from a known
   list plus every contract that has sent this wallet a Transfer, checkpointed in blockcache
   so later runs only walk the delta. Solana needs none of that — getTokenAccountsByOwner
   returns every SPL balance in one call. */
const TOPIC_XFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const KNOWN_ERC20={
  ethereum:[
    '0x8cd41041505885ef0ad3858181d66f17be8aae7e',   // LCX (new)
    '0x037a54aab062628c9bbae1fdb1583c195585fe41',   // LCX (old)
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',   // WETH
    '0x66761fa41377003622aee3c7675fc7b5c1c2fac5',   // CPOOL (Clearpool)
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',   // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7',   // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f',   // DAI
  ],
};
async function erc20Candidates(ck,wallet,tip){
  const C=CHAINS[ck], out=new Set((KNOWN_ERC20[ck]||[]).map(a=>a.toLowerCase()));
  const key='bal:'+ck+':'+wallet;
  const tc=blockCache.tscan[key]||{last:Math.max(C.startBlock,tip-180*C.bph*24)-1,ids:[]};
  try{
    const logs=await getLogsChunked(ck,{topics:[TOPIC_XFER,null,'0x'+pad32(wallet)]},tc.last+1,tip);
    for(const lg of logs){ const a=String(lg.address||'').toLowerCase(); if(a&&!tc.ids.includes(a)) tc.ids.push(a); }
    tc.last=tip; blockCache.tscan[key]=tc;
  }catch(e){ logErr('balScan '+ck+' '+wallet.slice(0,8),e); }
  for(const a of tc.ids) out.add(a);
  return [...out];
}
async function evmWalletBalances(ck,wallet,tip){
  const C=CHAINS[ck], rows=[];
  try{
    const wei=BigInt(await evm(ck,'eth_getBalance',['0x'+wallet,'latest']));
    if(wei>0n) rows.push({addr:'native',symbol:C.tag==='ETH'?'ETH':'native',decimals:18,amount:bigToFloat(wei,18),native:true});
  }catch(e){ logErr('nativeBal '+ck+' '+wallet.slice(0,8),e); }
  const cands=await erc20Candidates(ck,wallet,tip);
  for(const addr of cands){
    try{
      const raw=await evmCall(ck,addr,SEL2.balanceOf+pad32(wallet));
      const bal=BigInt(raw);
      if(bal<=0n) continue;
      const m=await meta(ck,addr);
      rows.push({addr,symbol:m.symbol,decimals:m.decimals,amount:bigToFloat(bal,m.decimals)});
    }catch(e){}
    await sleep(70);
  }
  return rows;
}
async function solWalletBalances(wallet){
  const rows=[];
  try{
    const r=await sol('getBalance',[wallet]);
    const lam=Number(r?.value ?? r ?? 0);
    if(lam>0) rows.push({addr:'native',symbol:'SOL',decimals:9,amount:lam/1e9,native:true});
  }catch(e){ logErr('solBal '+wallet.slice(0,6),e); }
  try{
    const r=await sol('getTokenAccountsByOwner',[wallet,{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{encoding:'jsonParsed'}]);
    for(const acc of (r?.value||[])){
      const info=acc?.account?.data?.parsed?.info;
      const amt=Number(info?.tokenAmount?.uiAmount||0);
      if(!(amt>0)) continue;
      rows.push({addr:info.mint,symbol:SOL_KNOWN[info.mint]||null,decimals:info.tokenAmount.decimals,amount:amt});
    }
  }catch(e){ logErr('solTokens '+wallet.slice(0,6),e); }
  return rows;
}

/* ---------- Solana fee collections, read from transaction history ----------
   The snapshot method compares pending fees between runs and books the drop. A harvest that
   lands between two runs — with fees re-accruing before the next one — leaves no drop to see,
   so it books nothing: on 08-16 roughly $173 was collected and $14 recorded. Fees here accrue
   fast enough ($66 in two hours on one pool) that this is the normal case, not an edge case.

   So read the position's own transaction history instead. For every signature since the last
   checkpoint, take the owner's positive balance change in the pool's two mints — tokens moving
   out of the pool to the owner is what a collect is. This sees the harvest itself rather than
   its after-image, whatever the scan timing.

   Limits, stated rather than hidden: a single transaction that harvests AND redeposits nets
   out and is undercounted; amounts are valued at current prices, as on the EVM side; and the
   first run only records a checkpoint, booking nothing, so it cannot double-count against what
   the snapshot method already wrote. */
/* Attribute a harvest to the position it actually came from.
   Wallet balance deltas cannot do this: when one transaction collects from several positions
   the wallet just sees one lump, and every position claims all of it. The transaction itself
   knows better. Each Raydium instruction names the personal position PDA in its account list,
   and the token transfers it triggers sit in the innerInstructions group indexed to it — so
   the transfers under the instruction naming THIS pda are this position's fees, and no other
   position's. Returns null when the shape is not recognisable, and the caller falls back. */
function solAttribute(tx, pda, mints, owner){
  try{
    const msg=tx.transaction&&tx.transaction.message; if(!msg) return null;
    const keys=(msg.accountKeys||[]).map(k=>typeof k==='string'?k:(k&&k.pubkey));
    const top=msg.instructions||[];
    const idxs=[];
    top.forEach((ix,i)=>{ const a=ix.accounts||[]; if(Array.isArray(a)&&a.some(x=>x===pda)) idxs.push(i); });
    if(!idxs.length) return null;                     // this pda is not named by any instruction
    const inner=tx.meta&&tx.meta.innerInstructions;
    if(!Array.isArray(inner)||!inner.length) return null;
    const bal=[...(tx.meta.preTokenBalances||[]),...(tx.meta.postTokenBalances||[])];
    const mintOf={}, decOf={}, ownerOf={};
    for(const b of bal){
      const addr=keys[b.accountIndex];
      if(addr&&b.mint) mintOf[addr]=b.mint;
      if(addr&&b.owner) ownerOf[addr]=b.owner;
      if(b.mint&&b.uiTokenAmount&&b.uiTokenAmount.decimals!=null) decOf[b.mint]=b.uiTokenAmount.decimals;
    }
    const amt={}; let saw=false;
    for(const g of inner){
      if(!idxs.includes(g.index)) continue;
      for(const ins of (g.instructions||[])){
        const pi=ins.parsed; if(!pi) continue;
        if(pi.type!=='transfer'&&pi.type!=='transferChecked') continue;
        const info=pi.info||{};
        const mint=info.mint||mintOf[info.destination];
        if(!mint) continue;
        if(mints.length&&!mints.includes(mint)) continue;
        /* Direction matters, and dropping this check is what broke it. Fees flow vault -> your
           token account; a redeposit flows the other way, your account -> vault. Counting both
           booked a $105 redeposit into 6sGWez as $105 of fee income on top of its real $29.
           The wallet-delta method this replaced had the check implicitly, in "owner === owner
           and delta > 0". Only an inflow to THIS owner is income. */
        if(owner && ownerOf[info.destination]!==owner) continue;
        let v=null;
        if(info.tokenAmount&&info.tokenAmount.uiAmount!=null) v=Number(info.tokenAmount.uiAmount);
        else if(info.amount!=null&&decOf[mint]!=null) v=Number(info.amount)/Math.pow(10,decOf[mint]);
        if(v==null||!(v>0)) continue;
        amt[mint]=(amt[mint]||0)+v; saw=true;
      }
    }
    return saw?amt:null;
  }catch(e){ return null; }
}
async function solCollectedSince(pos, sinceSig, booked, costSink){
  const out={amt:{}, newest:null, scanned:0, ok:false, err:null, shared:0, attributed:0, lump:0};
  const addr=pos.pda||pos.nftMint, owner=pos.wallet;
  if(!addr||!owner) { out.err='no position address'; return out; }
  try{
    const q={limit:40}; if(sinceSig) q.until=sinceSig;
    const sigs=await sol('getSignaturesForAddress',[addr,q]);
    if(!Array.isArray(sigs)){ out.err='bad signature response'; return out; }
    out.ok=true;
    if(!sigs.length) return out;                 // nothing new since the checkpoint
    out.newest=sigs[0].signature;
    if(!sinceSig) return out;                    // first sight: checkpoint only, book nothing
    const mints=[pos.mint0,pos.mint1].filter(Boolean);
    for(const s of sigs.slice(0,8)){             // cap the work per position per run
      if(s.err) continue;
      /* One harvest can collect from several of this wallet's positions in a single
         transaction, and that transaction then appears in EVERY one of their signature lists.
         The delta measured below is the WALLET's, not this position's, so without this guard
         each position books the full combined amount and the same dollars land in MTD two or
         three times. Whoever reaches the transaction first books it; the rest skip it. */
      if(booked && booked.has(s.signature)){ out.shared++; continue; }
      let tx=null;
      try{ tx=await sol('getTransaction',[s.signature,{maxSupportedTransactionVersion:0,encoding:'jsonParsed'}]); }
      catch(e){ out.err=out.err||String((e&&e.message)||e).slice(0,60); continue; }
      if(!tx||!tx.meta) continue;
      out.scanned++;
      /* The transaction fee is right here and was being thrown away, so every Solana operation
         has been costing real money that the monthly ledger recorded as zero. Keyed by
         signature, so a transaction touching several positions is charged once. */
      if(costSink && tx.meta.fee!=null) costSink[s.signature]=Number(tx.meta.fee);
      /* Preferred: read this position's own transfers out of the transaction. Exact even when
         several positions were harvested together, so no cross-position guard is needed. */
      const att=solAttribute(tx, addr, mints, owner);
      if(att){
        for(const m in att) out.amt[m]=(out.amt[m]||0)+att[m];
        out.attributed++;
        await sleep(60);
        continue;
      }
      const pre=tx.meta.preTokenBalances||[], post=tx.meta.postTokenBalances||[];
      const amtOf=(arr,i)=>{ const e=arr.find(x=>x.accountIndex===i); return e?Number(e.uiTokenAmount.uiAmount||0):0; };
      const rows=[...pre,...post].filter(x=>x.owner===owner && (!mints.length||mints.includes(x.mint)));
      const seen=new Set();
      let got=0;
      for(const r of rows){
        if(seen.has(r.accountIndex)) continue; seen.add(r.accountIndex);
        const d=amtOf(post,r.accountIndex)-amtOf(pre,r.accountIndex);
        if(d>0){ out.amt[r.mint]=(out.amt[r.mint]||0)+d; got+=d; }   // received from the pool
      }
      // Claim the signature only if value was actually taken from it. A zero-delta read must
      // not lock another position out of booking a transaction that did pay it.
      if(got>0){ out.lump++; if(booked) booked.add(s.signature); }
      await sleep(60);
    }
  }catch(e){ out.err=String((e&&e.message)||e).slice(0,80); }
  return out;
}

/* ---------- main ---------- */
/* ---- daily record: the raw material for "why did the total move" ----
   Extracted to module scope because two callers build it — the live refresh below, and the
   backfill that reconstructs past days from committed payloads. Two copies of this arithmetic
   would drift, and a drifted backfill produces attribution that silently disagrees with itself
   across the boundary between reconstructed and live days. */
const sq=x=>Math.sqrt(x);
/* L from published amounts and range. In range either side gives the same answer, so take
   the token with the larger balance — the smaller one can be dust whose rounding dominates. */
const liqOf=p=>{
  const P=p.price, A=p.priceLower, B=p.priceUpper;
  if(!(P>0&&A>0&&B>0&&B>A)) return null;
  const sP=sq(P), sA=sq(A), sB=sq(B);
  if(P<=A) return (p.amt0>0) ? p.amt0/(1/sA-1/sB) : null;
  if(P>=B) return (p.amt1>0) ? p.amt1/(sB-sA) : null;
  const fromX = (p.amt0>0) ? p.amt0/(1/sP-1/sB) : null;
  const fromY = (p.amt1>0) ? p.amt1/(sP-sA) : null;
  if(fromX==null) return fromY;
  if(fromY==null) return fromX;
  return (p.amt0*(p.usd0||0) >= p.amt1*(p.usd1||0)) ? fromX : fromY;
};
const r6=x=>x==null?null:Number(x.toPrecision(8));
const r2=x=>x==null?null:Math.round(x*100)/100;
/* A ticker is not an identity. CPOOL is quoted at $0.0194 on Ethereum and $0.0432 on
   Solana — a 2.2x gap between two tokens sharing a name — and LCX runs two Ethereum
   contracts at once. Aggregating a price move by symbol merges assets that demonstrably do
   not trade together, and then reports the move of one as the move of all of them. Key on
   chain and contract; carry the symbol only for display. */
const tkey=(p,which)=>{
  const ch = p.chain==='sol' ? 'sol' : 'evm';
  const addr = p.chain==='sol' ? (which?p.mint1:p.mint0) : (which?p.token1:p.token0);
  return ch+':'+String(addr||(which?p.m1?.symbol:p.m0?.symbol)||'?').toLowerCase();
};
const snapOf=p=>({ i:String(p.id), n:p.pairLabel||'', c:p.chain==='sol'?'sol':'evm',
  s0:p.m0?.symbol||'?', s1:p.m1?.symbol||'?', k0:tkey(p,0), k1:tkey(p,1),
  v:r2(p.valueUsd), a0:r6(p.amt0), a1:r6(p.amt1), u0:r6(p.usd0), u1:r6(p.usd1),
  pr:r6(p.price), pl:r6(p.priceLower), pu:r6(p.priceUpper), L:r6(liqOf(p)), r:!!p.inRange });
/* Wallet holdings, aggregated on the same token key as the LP side. A price move hits both,
   and answering "what did CPOOL falling cost me" with only the LP half understates it and
   leaves the reader to do the other half by hand. */
const walletOf=(idle)=>{
  const m=new Map();
  for(const r of (idle?.rows||[])){
    if(r.usd==null || !(r.amount>0)) continue;
    const ch=r.chain==='sol'?'sol':'evm';
    const k=ch+':'+String(r.addr||r.symbol||'?').toLowerCase();
    const e=m.get(k)||{k, s:r.symbol||'?', a:0, u:null};
    e.a+=r.amount; if(e.u==null) e.u=r.usd/r.amount;
    m.set(k,e);
  }
  return [...m.values()].filter(e=>e.a*e.u>=1)
    .map(e=>({k:e.k, s:e.s, a:r6(e.a), u:r6(e.u)}));
};

/* One record per UTC day, rewritten in place while that day is current, frozen once it is not.
   A day is the right grain: shorter and the record is noise, longer and a move has too many
   causes to name. */
export function dailyRecord(evmPositions, solPositions, idle, tsMs){
  const all=[...(evmPositions||[]),...(solPositions||[])];
  return { d:new Date(tsMs).toISOString().slice(0,10), t:tsMs, w:walletOf(idle),
    v:r2(all.reduce((s,p)=>s+(p.valueUsd||0),0)),
    f:r2(all.reduce((s,p)=>s+(p.feesUsd||0),0)),
    fe:r2(all.reduce((s,p)=>s+(p.feesEverUsd||0),0)),
    ps:all.map(snapOf) };
}

const main=async()=>{
  try{ const bc=JSON.parse(fs.readFileSync(OUT+'/blockcache.json','utf8')); blockCache={mint:bc.mint||{},tscan:bc.tscan||{},evh:bc.evh||{},mintInfo:bc.mintInfo||{},tokMeta:bc.tokMeta||{},depUsd:bc.depUsd||{},blkTs:bc.blkTs||{}}; }catch(e){}
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
  // header ticker strip: SOL / LCX(new contract) / CPOOL — price + 24h change via DefiLlama
  let tickers=null;
  try{
    const KEYS={SOL:'solana:So11111111111111111111111111111111111111112',
                LCX:'ethereum:0x8cd41041505885ef0ad3858181d66f17be8aae7e',
                CPOOL:'ethereum:0x66761fa41377003622aee3c7675fc7b5c1c2fac5'};
    const ks=Object.values(KEYS).join(',');
    const nowJ=await getJson('https://coins.llama.fi/prices/current/'+ks,20000);
    const agoJ=await getJson('https://coins.llama.fi/prices/historical/'+Math.floor(Date.now()/1000-86400)+'/'+ks,20000);
    tickers=Object.entries(KEYS).map(([sym,k])=>{
      const c=nowJ.coins?.[k]?.price??null, a=agoJ.coins?.[k]?.price??null;
      return {sym, usd:c, chg:(c!=null&&a)?(c/a-1)*100:null};
    }).filter(t=>t.usd!=null);
    if(!tickers.length) tickers=null;
  }catch(e){ logErr('tickers',e); }
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
    // Chains where we failed to LOOK this run. "Absent from the scan" is only evidence of a
    // close when the scan actually succeeded — otherwise an RPC blip silently books a live
    // position as closed, banks its MTD fees into fl.closed, and drops its baseline.
    const scanIncomplete=new Set();
    const excluded=new Set((profile.excluded||[]).map(String));
    const evmPositions=[];
    for(const w of (profile.wallets||[]).filter(w=>w.chain!=='solana')){
      const ck=w.chain in CHAINS ? w.chain : 'ethereum';
      if(blockNums[ck]==null) continue;
      try{
        const ids=await walletPositionIds(ck, w.address.toLowerCase().replace(/^0x/,''), blockNums[ck]);
        console.log(profile.slug, ck, w.address.slice(0,8), '→', ids.length, 'NFTs');
        for(const id of ids){
          if(excluded.has(ck+':'+id) || excluded.has(String(id))) continue;
          try{
            const p=await fetchEvmPosition(ck,id,blockNums[ck],ethUsd,btcUsd);
            if(p){ p.wallet='0x'+w.address.toLowerCase().replace(/^0x/,''); evmPositions.push(p); }
          }catch(e){ logErr(ck+'#'+id,e); scanIncomplete.add(ck); }
          await sleep(200);
        }
      }catch(e){ logErr('wallet '+w.address.slice(0,8)+' '+ck,e); chainErrs.add(ck); scanIncomplete.add(ck); }
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
      catch(e){ logErr('sol',e); chainErrs.add('solana'); scanIncomplete.add('sol'); }
    }
    let solTxFees={};
    // ---- harvest ledger: detect fee collections between snapshots (Solana has no easy event log) ----
    try{
      let ledger={}; try{ ledger=JSON.parse(fs.readFileSync(OUT+'/ledger-'+profile.slug+'.json','utf8')); }catch(e){}
      let prev=null; try{ prev=JSON.parse(fs.readFileSync(OUT+'/data-'+profile.slug+'.json','utf8')); }catch(e){}
      const prevSol=new Map((prev&&prev.sol||[]).map(p=>[p.id,p]));
      // Shared across every position this run, and persisted, so a harvest transaction is
      // booked exactly once no matter how many positions it touched or which run reaches it.
      const booked=new Set(Array.isArray(ledger.__sigs)?ledger.__sigs:[]);
      solTxFees={};        // signature -> lamports, handed to the cost ledger below
      for(const p of solPositions){
        const L=ledger[p.id]=ledger[p.id]||{collectedUsd:0};
        // Solana has no fee event log, so collectedUsd only ever covers what this bot has
        // WATCHED. Stamp when that started: annualising a partial fee history over the
        // position's full age understates it by the ratio of the two (a 289-day position
        // seen for 12 days reads ~23x too low).
        if(!L.since) L.since=Date.now();
        /* Transaction history is authoritative when it can be read; the snapshot diff below is
           only the fallback. Never run both for the same position — that double-counts. */
        let txOk=false;
        try{
          const r=await solCollectedSince(p, L.sig||null, booked, solTxFees);
          if(r.ok){
            txOk=true;
            const first=!L.sig;
            if(r.newest) L.sig=r.newest;
            let add=0;
            for(const m in r.amt){
              const px = m===p.mint0 ? p.usd0 : (m===p.mint1 ? p.usd1 : null);
              if(px!=null) add += r.amt[m]*px;
            }
            if(!first && add>0){ L.collectedUsd+=add; L.lastBooked=Math.round(add*100)/100; }
            L.txScanned=r.scanned;
            if(r.shared) L.sharedTx=r.shared; else delete L.sharedTx;
            L.attrib=r.attributed||0; L.lump=r.lump||0;
          }
          if(r.err) L.txErr=r.err; else delete L.txErr;
        }catch(e){ /* fall through to the snapshot method */ }
        if(!txOk){
          const pv=prevSol.get(p.id);
          if(pv && pv.feesUsd!=null && p.feesUsd!=null){
            const drop=pv.feesUsd-p.feesUsd;
            const valStable=Math.abs((pv.valueUsd||0)-(p.valueUsd||0)) < Math.max(50,(p.valueUsd||1)*0.5);
            if(drop>0.5 && valStable) L.collectedUsd+=drop;   // pending fees fell without the position changing → harvested
          }
        }
        p.feeSource = txOk ? 'tx' : 'snapshot';
        p.feesCollectedUsd=L.collectedUsd;
        p.feesEverUsd=L.collectedUsd+(p.feesUsd||0);
        // Annualise over the OBSERVED window, not the position's age, and flag that the
        // figure is partial so the UI can say "since tracked" rather than "since open".
        const obsDays=(Date.now()-L.since)/86400000;
        p.feesObservedDays=Math.round(obsDays*100)/100;
        p.feesPartial=p.ageDays!=null && p.ageDays>obsDays+1;
        if(obsDays>0.5 && p.valueUsd>0) p.feeAprPct=(p.feesEverUsd/p.valueUsd)*(365/obsDays)*100;
        else p.feeAprPct=null;
      }
      ledger.__sigs=[...booked].slice(-400);   // newest kept; bounded so the file cannot grow forever
      fs.writeFileSync(OUT+'/ledger-'+profile.slug+'.json', JSON.stringify(ledger,null,1));
    }catch(e){ logErr('ledger',e); }
    let catMtd=null, catMonths=[];
    // ---- monthly fee ledger: MTD earned across ACTIVE + CLOSED LPs, claimed + unclaimed ----
    let feeMonth=null;
    const justClosed=[];   // evm positions that vanished this run — their final close tx still owes gas accounting
    try{
      const monthKey=new Date().toISOString().slice(0,7);
      /* A position's identity is dropped the moment it closes — only the pooled total survived,
         which is why August's wide/narrow split had to be reconstructed by hand. The category is
         now stamped on the entry while the position is still alive, and closes are banked per
         category as well as into the total. Band width splits a pair only where both kinds exist;
         everything else is just the pair. */
      const catKeyOf=q=>{
        const pair=q.pairLabel||'—';
        const span=(q.priceLower>0&&q.priceUpper>0)?q.priceUpper/q.priceLower:null;
        // chain rides in the key so costs, which are only knowable per chain, can be applied
        // to the right rows without the reader having to know where each pair trades
        return (q.chain==='sol'?'sol':'evm')+'|'+pair+(span==null?'':(span>5?' · wide':' · narrow'));
      };
      let fl={month:monthKey, closed:0, pos:{}, months:[], catClosed:{}};
      try{ fl=JSON.parse(fs.readFileSync(OUT+'/fees-'+profile.slug+'.json','utf8')); }catch(e){}
      if(fl.month!==monthKey){
        const prevTotal=(fl.closed||0)+Object.values(fl.pos||{}).reduce((s,x)=>s+(x.acc!=null?x.acc:Math.max(0,x.last-x.m0)),0);
        // archive the finished month's split before the counters reset
        const prevCat={};
        for(const k in (fl.catClosed||{})) prevCat[k]=(prevCat[k]||0)+fl.catClosed[k];
        for(const id in (fl.pos||{})){
          const e=fl.pos[id], a=(e.acc!=null?e.acc:Math.max(0,e.last-e.m0));
          const k=e.cat||'—'; prevCat[k]=(prevCat[k]||0)+a;
        }
        for(const k in prevCat) prevCat[k]=Math.round(prevCat[k]*100)/100;
        fl.months=[...(fl.months||[]),{m:fl.month,total:Math.round(prevTotal*100)/100,ilEnd:fl.lastIl??null,cat:prevCat}].slice(-12);
        fl.month=monthKey; fl.closed=0; fl.catClosed={};
        for(const id in fl.pos) fl.pos[id].m0=fl.pos[id].last;
      }
      /* August's closes pre-date category stamping: their fees sit in the pooled scalar with no
         record of where they came from. Seeded here rather than by editing the file, because a
         run already in flight writes its own copy back and erased exactly that edit twice.
         In code it is idempotent and cannot be raced. Every August close was an LCX/ETH band of
         1.86x-2.41x, narrow under the same rule applied above. Fires once: after this the map
         is non-empty and later closes attribute themselves. */
      if(fl.month==='2026-08' && (fl.closed||0)>0 && !Object.keys(fl.catClosed||{}).length){
        fl.catClosed={'evm|LCX / ETH · narrow': Math.round((fl.closed||0)*100)/100};
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
          fl.pos[p.id]={m0:Math.round(m0*100)/100, last:Math.round(cum*100)/100,
                        hwm:Math.round(cum*100)/100, acc:Math.round(Math.max(0,cum-m0)*100)/100,
                        ck:p.chain||'ethereum'};
        } else {
          // cum is re-derived from chain each run and priced at spot, so it can fall for
          // reasons that are not "you un-earned fees": a collect, or the fee tokens simply
          // being worth less today. Accrue against a high-water mark so real growth is
          // counted once and a dip never rewrites what the month already earned.
          if(e.acc==null){ e.acc=Math.max(0,(e.last||0)-(e.m0||0)); e.hwm=e.last||0; }
          if(cum>e.hwm){ e.acc=Math.round((e.acc+(cum-e.hwm))*100)/100; e.hwm=Math.round(cum*100)/100; }
          e.last=Math.round(cum*100)/100;
        }
        // refreshed every run: a position that is re-ranged keeps its id but can change class
        fl.pos[p.id].cat=catKeyOf(p);
      }
      for(const id of Object.keys(fl.pos)){
        if(!seen.has(String(id))){
          const ckRaw=fl.pos[id].ck||'ethereum';
          const chainKey=(String(id).startsWith('sol:')||ckRaw==='sol')?'sol':ckRaw;
          // Absent because we could not look ≠ absent because it closed. Booking a close is
          // irreversible here (fees banked, baseline dropped), so defer to a clean run.
          if(scanIncomplete.has(chainKey)){
            console.log('deferring close verdict for',id,'— scan incomplete on',chainKey);
            continue;
          }
          const gone=fl.pos[id];
          const goneAmt=(gone.acc!=null?gone.acc:Math.max(0,gone.last-gone.m0));
          fl.closed=(fl.closed||0)+goneAmt;
          fl.catClosed=fl.catClosed||{};
          const gk=gone.cat||'—'; fl.catClosed[gk]=(fl.catClosed[gk]||0)+goneAmt;
          const ck=ckRaw;
          // v25.2: legacy ledger entries have no .ck — a Solana id must never fall through to the EVM scanner
          if(!String(id).startsWith('sol:')&&ck!=='sol'&&ck in CHAINS) justClosed.push({id,ck});
          delete fl.pos[id];
        }
      }
      fl.closed=Math.round((fl.closed||0)*100)/100;
      const mtd=fl.closed+Object.values(fl.pos).reduce((s,x)=>s+(x.acc!=null?x.acc:Math.max(0,x.last-x.m0)),0);
      // live month-to-date split: closed positions keep the category they had when they closed
      catMtd={};
      for(const k in (fl.catClosed||{})) catMtd[k]=(catMtd[k]||0)+fl.catClosed[k];
      for(const id in fl.pos){
        const e=fl.pos[id], a=(e.acc!=null?e.acc:Math.max(0,e.last-e.m0));
        const k=e.cat||'—'; catMtd[k]=(catMtd[k]||0)+a;
      }
      for(const k in catMtd) catMtd[k]=Math.round(catMtd[k]*100)/100;
      catMonths=(fl.months||[]).filter(x=>x&&x.cat);
      fl.catClosed=fl.catClosed||{};
      const nowD=new Date();
      const daysInMonth=new Date(Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth()+1,0)).getUTCDate();
      const elapsed=(Date.now()-Date.UTC(nowD.getUTCFullYear(),nowD.getUTCMonth(),1))/86400000;
      fl.lastIl=Math.round(evmPositions.reduce((s,p)=>s+(p.ilUsd||0),0)*100)/100;
      /* Straight extrapolation of the month-to-date average: what has been earned so far,
         scaled to the full month. Simple and stable by design. dayRate (the current run rate
         of open positions) is published alongside for reference — it will read lower than the
         projection implies whenever earlier weeks earned faster or closed LPs contributed. */
      let dayRate=0;
      for(const p of [...evmPositions,...solPositions]){
        const a=(p.chain==='sol')?(p.poolAprDay??null):(p.aprW?(p.aprW.d1??null):null);
        if(a!=null && p.valueUsd>0) dayRate+=p.valueUsd*a/100/365;
      }
      feeMonth={month:monthKey, mtd:Math.round(mtd*100)/100, ilNow:fl.lastIl, elapsedDays:Math.round(elapsed*100)/100, daysInMonth,
        proj: elapsed>0.25?Math.round(mtd/elapsed*daysInMonth*100)/100:null,
        projBasis:'average', dayRate:Math.round(dayRate*100)/100, prev:fl.months||[]};
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
        cl.months=[...(cl.months||[]),{m:cl.month,gas:Math.round(cl.gasUsd*100)/100,swapFee:Math.round(cl.swapFeeUsd*100)/100,
                     solGas:Math.round((cl.solGasUsd||0)*100)/100}].slice(-12);
        cl.month=monthKey; cl.gasUsd=0; cl.swapFeeUsd=0; cl.solGasUsd=0; cl.txs={}; cl.solTxs={};
      }
      /* Solana operations, from the fee actually paid on chain rather than an estimate. Deposits
         into a CLMM position pay no pool fee — only a swap does — so for this portfolio the
         transaction fee IS the Solana cost. Any swap fee remains uncounted and solPartial says so
         rather than letting the total read as complete. */
      let solUsd=null;   // SOL_MINT is already defined at module scope
      for(const sp of solPositions){
        if(sp.mint0===SOL_MINT && sp.usd0!=null){ solUsd=sp.usd0; break; }
        if(sp.mint1===SOL_MINT && sp.usd1!=null){ solUsd=sp.usd1; break; }
      }
      cl.solTxs=cl.solTxs||{};
      cl.solGasUsd=cl.solGasUsd||0;   // present at 0, not absent, when nothing was scanned
      if(solUsd!=null){
        for(const sig in solTxFees){
          if(cl.solTxs[sig]) continue;
          cl.solTxs[sig]=1;
          // kept apart from EVM gas: a per-pool-type net needs to know which chain paid
          cl.solGasUsd=(cl.solGasUsd||0)+(solTxFees[sig]/1e9)*solUsd;
        }
      }
      cl.solPartial=true;   // swap fees on Solana are not detected
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
        // closed positions only owe cost accounting for THIS month → scan from month start, not from mint
        try{ const h=await evmHistory(jc.ck,Number(jc.id)||jc.id,msBlockOf(jc.ck),blockNums[jc.ck]);
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
      /* total carries every chain, because it is what the headline net and the month-over-month
         costs column subtract. txCount stays EVM-only, and the per-operation average is computed
         from the EVM figures rather than from total, so the two do not get mixed. */
      costMonth={month:monthKey, gasUsd:cl.gasUsd, swapFeeUsd:cl.swapFeeUsd,
        solGasUsd:cl.solGasUsd||0, solPartial:!!cl.solPartial,
        total:Math.round((cl.gasUsd+cl.swapFeeUsd+(cl.solGasUsd||0))*100)/100,
        txCount:counted, prev:cl.months||[]};
      fs.writeFileSync(OUT+'/costs-'+profile.slug+'.json', JSON.stringify(cl,null,1));
    }catch(e){ logErr('costMonth',e); }
    const usedChains=new Set((profile.wallets||[]).map(w=>w.chain==='solana'?'solana':(w.chain in CHAINS?w.chain:'ethereum')));
    const chainStatus={};
    for(const ck of usedChains){
      chainStatus[ck] = ck==='solana' ? (chainErrs.has('solana')?'down':'ok')
        : (blockNums[ck]==null||chainErrs.has(ck) ? 'down' : 'ok');
    }
    // persistent portfolio history (value + cumulative pending fees), ~30 days at 15-min cadence
    let profileDaily=[], profilePxChg=null;
    let history=[];
    try{ history=JSON.parse(fs.readFileSync(OUT+'/hist-'+profile.slug+'.json','utf8')); }catch(e){}
    {
      const totV=[...evmPositions,...solPositions].reduce((s,p)=>s+(p.valueUsd||0),0);
      const totF=[...evmPositions,...solPositions].reduce((s,p)=>s+(p.feesUsd||0),0);
      // g: gas price at this sample. Without a stored series there is nothing to call a gas
      // price high or low AGAINST, and a gauge with no distribution behind it is decoration.
      history.push({t:Date.now(), v:Math.round(totV*100)/100, f:Math.round(totF*100)/100,
                    g:gasGwei!=null?Math.round(gasGwei*1000)/1000:null});
      if(history.length>3000) history=history.slice(-3000);
      fs.writeFileSync(OUT+'/hist-'+profile.slug+'.json', JSON.stringify(history));
    }
    // ---- idle balances: everything held that is NOT in an LP ----
    let idle=null;
    try{
      const rows=[];
      for(const w of (profile.wallets||[])){
        const addr=w.address;
        if(w.chain==='solana'){
          for(const r of await solWalletBalances(addr)) rows.push({...r, chain:'sol', wallet:addr});
        }else{
          const ck=w.chain in CHAINS ? w.chain : 'ethereum';
          if(blockNums[ck]==null) continue;
          const clean=addr.toLowerCase().replace(/^0x/,'');
          for(const r of await evmWalletBalances(ck,clean,blockNums[ck])) rows.push({...r, chain:ck, wallet:addr});
        }
      }
      // price: EVM via the same DefiLlama feed the LP side uses, Solana via Jupiter
      const llamaKeys=[...new Set(rows.filter(r=>r.chain!=='sol'&&!r.native).map(r=>CHAINS[r.chain].llama+':'+r.addr))];
      if(llamaKeys.length) await llamaPrices(llamaKeys);
      const solNativeUsd=(tickers||[]).find(t=>t.sym==='SOL')?.usd ?? null;
      const solMints=[...new Set(rows.filter(r=>r.chain==='sol'&&!r.native).map(r=>r.addr))];
      let jp={};
      if(solMints.length){
        for(let i=0;i<solMints.length;i+=80){
          try{ const js=await getJson('https://lite-api.jup.ag/price/v3?ids='+solMints.slice(i,i+80).join(','));
               for(const m of solMints.slice(i,i+80)) if(js[m]?.usdPrice!=null) jp[m]=Number(js[m].usdPrice); }
          catch(e){ logErr('jupBal',e); }
        }
      }
      // Resolve names/symbols for Solana mints. A wallet full of "AeXrLf…" is unreadable,
      // and for a token whose identity is in question the registered name is the fastest
      // way to tell a bridged asset from an unrelated one sharing a ticker.
      /* Names do not change, and a mint no registry lists will not be listed in fifteen
         minutes either. Cache both outcomes — hits indefinitely, misses for a week — so the
         same ~30 lookups stop running every quarter hour. */
      const tokMeta=Object.assign({}, blockCache.tokMeta||{});
      const META_MISS_TTL=7*86400000;
      const metaFresh=m=>{ const c=tokMeta[m]; return !!c && (!c.miss || Date.now()-c.at<META_MISS_TTL); };
      const needMeta=[...new Set(rows.filter(r=>r.chain==='sol'&&!r.native&&!r.symbol).map(r=>r.addr))]
        .filter(m=>!metaFresh(m)).slice(0,15);
      let metaHard=0, metaErr=null;
      // Registries disagree on response shape (bare array / {tokens:[]} / single object), so
      // accept all three and fall back to a second endpoint before giving up.
      const pickHit=(js,m)=>{
        const arr=Array.isArray(js)?js
          :(Array.isArray(js&&js.tokens)?js.tokens
          :((js&&(js.id||js.address))?[js]:[]));
        return arr.find(t=>t&&(t.id===m||t.address===m)) || (arr.length===1?arr[0]:null);
      };
      for(const m of needMeta){
        let hit=null, answered=false;
        for(const url of ['https://lite-api.jup.ag/tokens/v2/search?query='+m,'https://tokens.jup.ag/token/'+m]){
          try{ hit=pickHit(await getJson(url,12000),m); answered=true; if(hit) break; }
          catch(e){ if(!metaErr) metaErr=String((e&&e.message)||e).slice(0,80); }
        }
        if(hit) tokMeta[m]={symbol:hit.symbol||null, name:hit.name||null, at:Date.now()};
        else if(answered) tokMeta[m]={symbol:null, name:null, miss:true, at:Date.now()};
        else metaHard++;
        await sleep(150);
      }
      blockCache.tokMeta=tokMeta;
      /* A registry that answers "no such token" has told us something true: the mint is
         unlisted. That is a fact about the token, not a fault in the read, and raising it as an
         error every run put a permanent banner on the dashboard — which is how an error strip
         gets ignored. Only an endpoint that would not answer at all is worth reporting. */
      if(metaHard) logErr('solTokenMeta', new Error(metaHard+'/'+needMeta.length+' lookups failed'+(metaErr?' · '+metaErr:'')));
      for(const r of rows){
        if(r.chain!=='sol') continue;
        const c=tokMeta[r.addr];
        if(!c||c.miss) continue;
        if(!r.symbol&&c.symbol) r.symbol=c.symbol;
        if(c.name) r.name=c.name;
      }
      for(const r of rows){
        r.usd = r.native
          ? (r.chain==='sol' ? (solNativeUsd!=null?r.amount*solNativeUsd:null) : (ethUsd!=null?r.amount*ethUsd:null))
          : (r.chain==='sol' ? (jp[r.addr]!=null?r.amount*jp[r.addr]:null)
                             : (priceCache[CHAINS[r.chain].llama+':'+r.addr]!=null?r.amount*priceCache[CHAINS[r.chain].llama+':'+r.addr]:null));
        r.usd = r.usd!=null ? Math.round(r.usd*100)/100 : null;   // null = unpriced, never 0
      }
      rows.sort((x,y)=>(y.usd??-1)-(x.usd??-1));
      /* Provenance for any Solana holding worth caring about. A ticker proves nothing — this
         wallet holds a fake "Zcash" and a fake "JitoSOL" — so publish the facts that actually
         distinguish a bridged asset from a lookalike: total supply (compare to the real
         token's), whether anyone can still mint more, whether it can be frozen, and how the
         registry tags it. */
      /* Supply, authorities and registry tags change on the order of never, so refreshing
         them every quarter hour was pure run time. Reuse yesterday's answer. */
      const mintInfo=Object.assign({}, blockCache.mintInfo||{});
      const DAY=86400000;
      const wantInfo=[...new Set(rows.filter(r=>r.chain==='sol'&&!r.native&&(r.usd==null||r.usd>=50)).map(r=>r.addr))]
        .filter(m=>!(mintInfo[m]&&mintInfo[m].at&&Date.now()-mintInfo[m].at<DAY)).slice(0,12);
      for(const m of wantInfo){
        const o={};
        try{ const r=await sol('getTokenSupply',[m]);
             o.supply=r?.value?.uiAmountString??null; o.decimals=r?.value?.decimals??null; }catch(e){}
        try{ const r=await sol('getAccountInfo',[m,{encoding:'jsonParsed'}]);
             const i=r?.value?.data?.parsed?.info;
             o.mintAuthority=i?.mintAuthority??null; o.freezeAuthority=i?.freezeAuthority??null; }catch(e){}
        try{ const js=await getJson('https://lite-api.jup.ag/tokens/v2/search?query='+m,12000);
             const hit=Array.isArray(js)?js.find(t=>t.id===m):(Array.isArray(js&&js.tokens)?js.tokens.find(t=>t.id===m):null);
             if(hit){ o.name=hit.name??null; o.symbol=hit.symbol??null;
                      o.verified=hit.isVerified??null; o.tags=hit.tags??null; o.holders=hit.holderCount??null; } }catch(e){}
        o.at=Date.now();
        mintInfo[m]=o;
        await sleep(120);
      }
      blockCache.mintInfo=mintInfo;
      idle={ t:Date.now(), rows, totalUsd:Math.round(rows.reduce((s,r)=>s+(r.usd||0),0)*100)/100,
             unpriced:rows.filter(r=>r.usd==null).length, mintInfo };
      fs.writeFileSync(OUT+'/balances-'+profile.slug+'.json', JSON.stringify(idle,null,1));
      console.log('idle balances:',rows.length,'rows, $'+idle.totalUsd,'('+idle.unpriced+' unpriced)');
    }catch(e){ logErr('balances',e); }

    /* ---- daily snapshot: the raw material for "why did the total move" ----
       The 15-minute series carries a total and nothing else, so a $3,797 drop over two days can
       be seen but not explained. Attribution needs, per position, what it held and what those
       holdings were worth — and the range and liquidity, so the price move can be separated from
       capital going in or out. Liquidity is not published on the positions, so derive it here
       from the amounts and the range: for a concentrated position L is exactly recoverable, and
       storing it once beats every reader re-deriving it.

       One record per UTC day, rewritten in place while that day is current, frozen once it is
       not. A day is the right grain: shorter and the record is noise, longer and a move has too
       many causes to name. */
    try{
      const rec=dailyRecord(evmPositions, solPositions, idle, Date.now());
      let daily=[];
      try{ daily=JSON.parse(fs.readFileSync(OUT+'/daily-'+profile.slug+'.json','utf8')); }catch(e){}
      /* Backfill from the 15-minute series for days that predate per-position recording. Those
         days can carry a total and a change but no attribution, and that is worth saying out
         loud — a table that starts empty for two days is worse than one that starts honest. */
      if(!daily.some(x=>x.ps)){
        const byDay=new Map();
        for(const h of history){
          const d=new Date(h.t).toISOString().slice(0,10);
          if(d===rec.d) continue;                       // today is the live record's job
          byDay.set(d, {d, t:h.t, v:h.v, f:h.f, ps:null});   // last sample of each day wins
        }
        const have=new Set(daily.map(x=>x.d));
        const seeded=[...byDay.values()].filter(x=>!have.has(x.d));
        if(seeded.length){
          daily=[...seeded,...daily].sort((x,y)=>x.d<y.d?-1:1);
          console.log('daily: backfilled',seeded.length,'value-only day(s) from the history series');
        }
      }
      /* Never overwrite a finished day with a degraded read: a cycle that lost a chain would
         otherwise rewrite today as if those positions had closed, and the next day's attribution
         would report a phantom withdrawal followed by a phantom deposit. */
      const chainsOk=Object.values(chainStatus).every(v=>v==='ok');
      const last=daily[daily.length-1];
      if(chainsOk){
        if(last && last.d===rec.d) daily[daily.length-1]=rec; else daily.push(rec);
        if(daily.length>120) daily=daily.slice(-120);
        /* One record per line. This file is committed every 15 minutes and only its last entry
           changes; as a single line that is a whole-file rewrite in every diff, and at ~2 KB a
           day the repository pays for that ninety-six times daily. */
        fs.writeFileSync(OUT+'/daily-'+profile.slug+'.json',
          '[\n'+daily.map(r=>JSON.stringify(r)).join(',\n')+'\n]\n');
      }else{
        console.log('daily: skipped, chainStatus', JSON.stringify(chainStatus));
      }
      /* Attribute here, not in the browser. The full per-position records are 2 KB a day — 35 of
         them would more than double a payload that has to reach a phone every 15 minutes. The
         answers are 300 bytes a day, they are identical for every reader, and computing them
         once against the full-resolution record beats recomputing them everywhere against a
         truncated one. The detailed file stays on the server, so this can be recomputed later. */
      /* Every place this portfolio touches a ticker: LP positions and wallet balances alike.
         A symbol reached by more than one contract needs disambiguating wherever it is printed,
         and the price each one carries is what makes the case that they are not the same asset. */
      const symKeys=new Map();
      {
        const add=(sym,ch,addr,px)=>{
          if(!sym) return;
          const k=(ch==='sol'?'sol':'evm')+':'+String(addr||sym).toLowerCase();
          const list=symKeys.get(sym)||[];
          const hit=list.find(x=>x.k===k);
          if(hit){ if(hit.px==null) hit.px=px; } else list.push({k, ch:ch==='sol'?'sol':'evm', addr:String(addr||''), px});
          symKeys.set(sym,list);
        };
        for(const p2 of [...evmPositions,...solPositions]){
          const sol=p2.chain==='sol';
          add(p2.m0?.symbol, sol?'sol':'evm', sol?p2.mint0:p2.token0, p2.usd0);
          add(p2.m1?.symbol, sol?'sol':'evm', sol?p2.mint1:p2.token1, p2.usd1);
        }
        for(const r of (idle?.rows||[]))
          add(r.symbol, r.chain==='sol'?'sol':'evm', r.addr, (r.usd!=null&&r.amount)?r.usd/r.amount:null);
      }
      const CHAIN_NAME={sol:'Solana', evm:'Ethereum'};
      /* Distinguish the tokens the market distinguishes, and no others. Address equality is the
         wrong test: WETH and native ETH sit at different addresses and are one asset, while
         Ethereum CPOOL and Solana CPOOL share a ticker and trade 2.2x apart. Price is the test
         that separates those two cases. */
      const tokLabel=(k, sym)=>{
        const list=symKeys.get(sym)||[];
        if(list.length<2) return sym;
        const me=list.find(x=>x.k===k);
        if(!(me&&me.px>0)) return sym;
        const distinct=list.filter(x=>x.k===k || (x.px>0 && Math.abs(x.px/me.px-1)>0.05));
        if(distinct.length<2) return sym;
        const ch=k.split(':')[0], addr=k.slice(ch.length+1);
        let out=sym;
        if(new Set(distinct.map(x=>x.ch)).size>1) out+=' ('+(CHAIN_NAME[ch]||ch)+')';
        /* two genuinely different contracts on one chain still need the address to tell apart */
        if(distinct.filter(x=>x.ch===ch).length>1 && addr && addr.length>6) out+=' ·'+addr.slice(-4);
        return out;
      };
      const amtsAt=(L,P,A,B)=>{
        if(!(L>0&&P>0&&A>0&&B>0&&B>A)) return null;
        const sP=sq(P), sA=sq(A), sB=sq(B);
        if(P<=A) return [L*(1/sA-1/sB), 0];
        if(P>=B) return [0, L*(sB-sA)];
        return [L*(1/sP-1/sB), L*(sP-sA)];
      };
      const attrib=(y,t)=>{
        /* vPrev/dPrev belong to every move, not only the ones that can be itemised. The value
           tile measures the day's change against them, and a day whose breakdown is missing still
           has a perfectly good previous close — leaving them off the no-detail branch silently
           cost the tile its day-over-day line. */
        const base={ d:t.d, t:t.t, v:t.v, dV:r2((t.v||0)-(y.v||0)), vPrev:y.v, dPrev:y.d,
                     days:Math.max(1,Math.round((t.t-y.t)/86400000)) };
        if(!y.ps || !t.ps) return {...base, noDetail:true};
        const my=new Map(y.ps.map(x=>[x.i,x])), mt=new Map(t.ps.map(x=>[x.i,x]));
        const tok=new Map(); let price=0, flow=0, exact=true;
        const opened=[], closed=[];
        for(const [id,a] of my){
          const b=mt.get(id);
          if(!b){ closed.push({n:a.n||id, usd:r2(-(a.v||0))}); continue; }
          let hyp=amtsAt(a.L, b.pr, a.pl, a.pu);
          if(!hyp){ hyp=[a.a0,a.a1]; exact=false; }
          const vHyp=hyp[0]*(b.u0||0)+hyp[1]*(b.u1||0);
          price += vHyp-(a.v||0);
          flow  += (b.v||0)-vHyp;
          const put=(key,sym,vy,vt,px)=>{ const e=tok.get(key)||{sym,vy:0,vt:0,px:null};
            e.vy+=vy; e.vt+=vt; if(e.px==null) e.px=px; tok.set(key,e); };
          put(a.k0||('?:'+a.s0), a.s0, (a.a0||0)*(a.u0||0), (a.a0||0)*(b.u0||0), b.u0);
          put(a.k1||('?:'+a.s1), a.s1, (a.a1||0)*(a.u1||0), (a.a1||0)*(b.u1||0), b.u1);
        }
        for(const [id,b] of mt) if(!my.has(id)) opened.push({n:b.n||id, usd:r2(b.v||0)});
        /* Two contracts the feed prices identically collapse to the same label, and two lines
           reading "LCX" with different numbers is worse than one line reading LCX. Group on the
           label so what is printed is what was measured. */
        const byLabel=new Map();
        for(const [k,e] of tok){
          const lbl=tokLabel(k, e.sym);
          const g=byLabel.get(lbl)||{lbl, s:e.sym, k, vy:0, vt:0, px:e.px};
          g.vy+=e.vy; g.vt+=e.vt; byLabel.set(lbl,g);
        }
        const tokens=[...byLabel.values()].map(g=>({s:g.s, lbl:g.lbl, usd:r2(g.vt-g.vy),
            pct:g.vy>0?Math.round((g.vt/g.vy-1)*1000)/10:null, _k:g.k, _px:g.px}))
          .filter(x=>Math.abs(x.usd)>=0.5).sort((x,z)=>Math.abs(z.usd)-Math.abs(x.usd));
        /* State the blast radius. A price that moved on one chain says nothing about the same
           ticker elsewhere, and the reader needs to know which of their holdings it touched —
           and which it did not. */
        const elsewhere=[];
        for(const t2 of tokens){
          for(const o of (symKeys.get(t2.s)||[])){
            if(o.k===t2._k || o.px==null || !(t2._px>0)) continue;
            /* Only a quote that genuinely differs is worth a warning. Wrapped natives resolve to
               a different address than the native token and would otherwise be flagged as a
               separate market — WETH is not a separate market from ETH. Nor are LCX's two
               contracts while the feed prints one price for both: that ambiguity is real, but it
               is the playbook's to raise, and repeating it on every daily move is noise. */
            if(Math.abs(o.px/t2._px-1) <= 0.05) continue;
            elsewhere.push({s:t2.s, from:t2.lbl, to:tokLabel(o.k,t2.s), px:Number(o.px.toPrecision(5))});
          }
        }
        /* Same arithmetic, applied to what is held rather than pooled: yesterday's balance
           revalued at today's price. A balance that changed in between is a transfer, not a
           price move, so report it as unattributed rather than folding it into the token line. */
        let wallet=null;
        if(Array.isArray(y.w) && y.w.length){
          const pxNow=new Map((t.w||[]).map(x=>[x.k,x.u]));
          for(const [k,e] of tok) if(e.px>0 && !pxNow.has(k)) pxNow.set(k, e.px);
          const amtNow=new Map((t.w||[]).map(x=>[x.k,x.a]));
          const rowsW=new Map(); let moved=0, transfer=0;
          for(const h of y.w){
            const u2=pxNow.get(h.k);
            if(u2==null || !(h.u>0)) continue;
            const usd=h.a*(u2-h.u);
            moved+=usd;
            const an=amtNow.get(h.k);
            if(an!=null) transfer+=(an-h.a)*u2;
            const lbl=tokLabel(h.k, h.s);
            const g=rowsW.get(lbl)||{lbl, vy:0, vt:0};
            g.vy+=h.a*h.u; g.vt+=h.a*u2; rowsW.set(lbl,g);
          }
          const tw=[...rowsW.values()].map(g=>({lbl:g.lbl, usd:r2(g.vt-g.vy),
              pct:g.vy>0?Math.round((g.vt/g.vy-1)*1000)/10:null}))
            .filter(x=>Math.abs(x.usd)>=0.5).sort((x,z)=>Math.abs(z.usd)-Math.abs(x.usd));
          if(tw.length) wallet={tokens:tw, total:r2(moved), transfer:r2(transfer)};
        }
        for(const t2 of tokens){ delete t2._k; delete t2._px; }
        return {...base, tokens, elsewhere, wallet, rebal:r2(price-tokens.reduce((s2,x)=>s2+x.usd,0)), flow:r2(flow),
                opened, closed, exact,
                dFees:(t.fe!=null&&y.fe!=null)?r2(t.fe-y.fe):null};
      };
      const moves=[];
      for(let i=1;i<daily.length;i++) moves.push(attrib(daily[i-1], daily[i]));
      /* Only the itemised block reads the wallet breakdown and the divergent-quote note, and it
         only ever shows the newest day. Carrying both on all 35 would nearly double the payload
         to render a table row that never looks at them. Three covers the case where the newest
         day has no detail to itemise. */
      profileDaily = moves.slice(-35).map((m,i,arr)=>
        i>=arr.length-3 ? m : (({wallet, elsewhere, ...rest})=>rest)(m));

      /* Per-token day-over-day price change, keyed the same way everything else here is keyed.
         The idle panel needs it per row, and a row is a contract, not a ticker — CPOOL fell 31%
         on Solana and 1% on Ethereum on the same day, so one number per symbol would be wrong on
         one of those lines. Measured from the same reference the value tile uses: the close of
         the most recent day that is not today. */
      const baseDay=[...daily].reverse().find(r=>r.d!==rec.d && r.ps);
      if(baseDay){
        const then=new Map();
        for(const h of (baseDay.w||[])) if(h.u>0) then.set(h.k, h.u);
        for(const q of (baseDay.ps||[])){
          if(q.u0>0 && !then.has(q.k0)) then.set(q.k0, q.u0);
          if(q.u1>0 && !then.has(q.k1)) then.set(q.k1, q.u1);
        }
        const now=new Map();
        for(const h of (rec.w||[])) if(h.u>0) now.set(h.k, h.u);
        for(const q of (rec.ps||[])){
          if(q.u0>0 && !now.has(q.k0)) now.set(q.k0, q.u0);
          if(q.u1>0 && !now.has(q.k1)) now.set(q.k1, q.u1);
        }
        const chg={};
        for(const [k,u0] of then){
          const u1=now.get(k);
          if(u1>0 && u0>0) chg[k]=Math.round((u1/u0-1)*1000)/10;
        }
        if(Object.keys(chg).length) profilePxChg={from:baseDay.d, chg};
      }
    }catch(e){ logErr('daily',e); }
    const data={ v:6, t:Date.now(), profile:profile.slug, chainStatus, history, daily:profileDaily, pxChg:profilePxChg, feeMonth, costMonth, catMtd, catMonths, ethUsdChg24, tickers, block:blockNum, blocks:blockNums, ethUsd, btcUsd, gasGwei,
      eth:evmPositions, sol:solPositions, topPools, idle, errors:[...errors] };
    for(const p of data.eth) delete p.opTxs;   // internal bookkeeping — keep payload lean
    fs.writeFileSync(OUT+'/data-'+profile.slug+'.json', JSON.stringify(data));
    if(profile===CONFIG.profiles[0]) fs.writeFileSync(OUT+'/data.json', JSON.stringify(data));
    console.log('profile',profile.slug,':',evmPositions.length,'evm +',solPositions.length,'sol · errors:',errors.length);
  }
  try{ fs.writeFileSync(OUT+'/blockcache.json', JSON.stringify(blockCache)); }catch(e){}
};
/* Run only when this file IS the entry point. The backfill imports dailyRecord from here, and
   an unguarded call would have it fetch the whole portfolio as a side effect of an import. */
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(e=>{ console.error('FATAL',e); process.exit(1); });

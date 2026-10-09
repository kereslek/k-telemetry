/* Price gaps: where the same token can be bought in one place and sold in another for more, after
   every cost, at the size the owner trades — and how long such a gap has held.

   Venues are the ones the owner can trade on: the exchanges with an account (Kraken, Coinbase,
   Bybit; Binance lists neither token) read from their public order books, and the chains' best
   routes (Ethereum through ParaSwap, which covers the Uniswap pools and the rest; Solana through
   Jupiter, which covers Orca, Raydium, Meteora and the rest). Every price is what a trade of the
   set size would actually get: an exchange's book walked level by level, less its taker fee; a
   route's executable quote, which already carries its pools' fees and slippage, less gas.

   The arithmetic is in pure functions at the top so it can be tested without a network. */

export const TOKENS={
  LCX:{ name:'LCX', eth:'0x8cd41041505885ef0ad3858181d66f17be8aae7e', ethDec:18,
        cex:{ kraken:'LCXUSD', coinbase:'LCX-USD', bybit:'LCXUSDT' }, dex:['eth'] },
  CPOOL:{ name:'CPOOL', eth:'0x66761fa41377003622aee3c7675fc7b5c1c2fac5', ethDec:18, sol:'AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg', solDec:9,
        cex:{ kraken:'CPOOLUSD', bybit:'CPOOLUSDT' }, dex:['eth','sol'] },
};
export const VENUES={
  kraken:{ name:'Kraken', kind:'cex' }, coinbase:{ name:'Coinbase', kind:'cex' }, bybit:{ name:'Bybit', kind:'cex' },
  eth:{ name:'Ethereum DEX', kind:'dex' }, sol:{ name:'Solana DEX', kind:'dex' },
};
// taker fees at the lowest volume tier, in percent; the owner can change them in the dashboard
export const DEFAULT_CFG={ size:1000, minNet:0.5, holdMin:10,
  venues:{ kraken:true, coinbase:true, bybit:true, eth:true, sol:true },
  fees:{ kraken:0.40, coinbase:1.20, bybit:0.10 } };
const USDC_E='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', USDC_S='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_GAS_USD=0.01;          // a Solana swap's fee and a priority tip, rounded up
const KEEP_HIST=60*60000, KEEP_LOG=48*3600000;

/* ---------- arithmetic ---------- */

// Spend `usd` against asks [[price, qty], …] (best first): tokens received, or null if the book is too thin.
export function walkBuy(asks, usd){
  let left=usd, got=0;
  for(const [p,q] of asks){ if(!(p>0&&q>0)) continue; const cost=p*q;
    if(cost>=left){ got+=left/p; left=0; break; } got+=q; left-=cost; }
  return left>1e-9?null:got;
}
// Sell `qty` tokens into bids [[price, qty], …] (best first): dollars received, or null if too thin.
export function walkSell(bids, qty){
  let left=qty, usd=0;
  for(const [p,q] of bids){ if(!(p>0&&q>0)) continue;
    if(q>=left){ usd+=left*p; left=0; break; } usd+=p*q; left-=q; }
  return left>1e-12?null:usd;
}
/* An exchange's prices for a trade of `size` dollars: buy = dollars paid per token received, sell =
   dollars received per token for the same number of tokens, both after the taker fee. */
export function cexQuote(book, size, qty, feePct){
  const f=1-(feePct||0)/100, bids=book.bids, asks=book.asks;
  if(!bids||!asks||!bids.length||!asks.length) return {err:'empty book'};
  const mid=(bids[0][0]+asks[0][0])/2, got=walkBuy(asks,size), usd=walkSell(bids,qty);
  return { mid, buyPx: got?size/(got*f):null, sellPx: usd!=null?usd*f/qty:null, gasUsd:0,
           thin: !got||usd==null, top:{bid:bids[0][0], ask:asks[0][0]} };
}
/* Every buy-here-sell-there pair: tokens bought with `size` at A, sold at B, less both legs' gas.
   Returns them best first; net is in percent of `size`. */
export function opportunities(quotes, size){
  const out=[];
  for(const a of quotes) for(const b of quotes){
    if(a===b||!(a.buyPx>0)||!(b.sellPx>0)) continue;
    const tokens=size/a.buyPx, usd=tokens*b.sellPx, gas=(a.gasUsd||0)+(b.gasUsd||0);
    const profit=usd-size-gas;
    const gap=a.mid>0&&b.mid>0?(b.mid/a.mid-1)*100:null;
    out.push({ buy:a.id, sell:b.id, gross:gap, net:profit/size*100, netUsd:profit, gasUsd:gas, tokens });
  }
  return out.sort((x,y)=>y.net-x.net);
}
/* One reading's best edge folded into the token's state: a gap opens when the edge reaches the
   threshold, keeps its start across a change of route, survives one reading with no quotes, and
   closes into the log with how long it held and its peak. */
export function step(st, best, now, cfg, priced){
  st=st||{hist:[], log:[], open:null, miss:0};
  st.hist.push([now, best?Math.round(best.net*1000)/1000:null]);
  st.hist=st.hist.filter(h=>now-h[0]<=KEEP_HIST);
  /* no reading, or the open gap's own route went unpriced (a venue that did not answer): a miss,
     not a close — two in a row close it */
  const lost=st.open&&priced&&!(priced.has(st.open.buy)&&priced.has(st.open.sell));
  if(!best||(lost&&!(best.net>=cfg.minNet))){ st.miss=(st.miss||0)+1; if(st.open&&st.miss>=2) close(st, now); return st; }
  st.miss=0;
  if(best.net>=cfg.minNet){
    if(!st.open) st.open={since:now, peak:best.net, buy:best.buy, sell:best.sell};
    st.open.peak=Math.max(st.open.peak,best.net); st.open.buy=best.buy; st.open.sell=best.sell; st.open.net=best.net; st.open.at=now;
  } else if(st.open) close(st, now);
  return st;
}
function close(st, now){
  const o=st.open; st.open=null;
  st.log.push({since:o.since, until:now, mins:Math.round((now-o.since)/60000), peak:Math.round(o.peak*1000)/1000, buy:o.buy, sell:o.sell});
  st.log=st.log.filter(l=>now-l.until<=KEEP_LOG).slice(-60);
}
export function heldMins(st, now){ return st&&st.open?Math.floor((now-st.open.since)/60000):0; }

/* ---------- reading the venues ---------- */

const UA={'user-agent':'Mozilla/5.0 (kt-pulse)', accept:'application/json'};
async function getJ(url, opt={}){
  let r=await fetch(url,{...opt, headers:{...UA,...(opt.headers||{})}, signal:AbortSignal.timeout(8000)});
  // a shared egress address meets rate limits now and then: one retry after a short pause
  if(r.status===429){ await new Promise(z=>setTimeout(z,700)); r=await fetch(url,{...opt, headers:{...UA,...(opt.headers||{})}, signal:AbortSignal.timeout(8000)}); }
  const txt=await r.text();
  if(!r.ok) throw new Error('HTTP '+r.status+(/country|restricted/i.test(txt)?' (blocked in this region)':''));
  return JSON.parse(txt);
}
const nums=l=>(l||[]).map(x=>[Number(x[0]),Number(x[1])]);
export async function book(venue, sym){
  if(venue==='kraken'){ const j=await getJ('https://api.kraken.com/0/public/Depth?pair='+sym+'&count=100');
    if(j.error&&j.error.length) throw new Error(j.error.join(',')); const d=Object.values(j.result||{})[0]||{}; return {bids:nums(d.bids), asks:nums(d.asks)}; }
  if(venue==='coinbase'){
    try{ const j=await getJ('https://api.exchange.coinbase.com/products/'+sym+'/book?level=2'); return {bids:nums(j.bids).slice(0,100), asks:nums(j.asks).slice(0,100)}; }
    catch(e){ if(!/HTTP 429/.test(e.message)) throw e;
      // rate-limited on the exchange API: the same book from Coinbase's public Advanced Trade API
      const b=(await getJ('https://api.coinbase.com/api/v3/brokerage/market/product_book?product_id='+sym+'&limit=100')).pricebook||{};
      const lv=l=>(l||[]).map(x=>[Number(x.price),Number(x.size)]);
      return {bids:lv(b.bids), asks:lv(b.asks)}; } }
  if(venue==='bybit'){ const j=await getJ('https://api.bybit.com/v5/market/orderbook?category=spot&symbol='+sym+'&limit=100');
    if(j.retCode) throw new Error(j.retMsg||'bybit error'); return {bids:nums(j.result&&j.result.b), asks:nums(j.result&&j.result.a)}; }
  throw new Error('unknown venue');
}
// ParaSwap price route, exact-in. Returns the amount out (raw), gas in dollars and the pools used.
async function paraswap(src, dst, amountRaw, srcDec, dstDec){
  const j=await getJ('https://api.paraswap.io/prices?srcToken='+src+'&destToken='+dst+'&amount='+amountRaw+'&srcDecimals='+srcDec+'&destDecimals='+dstDec+'&side=SELL&network=1');
  const pr=j.priceRoute; if(!pr) throw new Error(j.error||'no route');
  const pools=(pr.bestRoute||[]).flatMap(r=>(r.swaps||[]).flatMap(s=>(s.swapExchanges||[]).flatMap(e=>(e.poolAddresses||[]).map(a=>String(a).toLowerCase()))));
  const via=[...new Set((pr.bestRoute||[]).flatMap(r=>(r.swaps||[]).flatMap(s=>(s.swapExchanges||[]).map(e=>e.exchange))))];
  return {out:Number(pr.destAmount), gasUsd:Number(pr.gasCostUSD)||0, pools, via};
}
async function jupiter(inMint, outMint, amountRaw){
  const j=await getJ('https://lite-api.jup.ag/swap/v1/quote?inputMint='+inMint+'&outputMint='+outMint+'&amount='+amountRaw+'&slippageBps=100');
  if(!j.outAmount) throw new Error(j.error||'no route');
  const plan=j.routePlan||[];
  return {out:Number(j.outAmount), gasUsd:SOL_GAS_USD, pools:plan.map(p=>p.swapInfo&&p.swapInfo.ammKey).filter(Boolean), via:[...new Set(plan.map(p=>p.swapInfo&&p.swapInfo.label).filter(Boolean))]};
}
const raw=(x,dec)=>BigInt(Math.floor(x*10**Math.min(dec,6)))*10n**BigInt(Math.max(0,dec-6));

/* One reading of one token at every enabled venue. `ownPools` are the owner's pool addresses (to
   flag a route that trades against them); `blocked` remembers venues that refused this region. */
export async function readToken(symbol, cfg, ownPools, blocked, now){
  const T=TOKENS[symbol], size=cfg.size, quotes=[], errs={};
  const on=v=>cfg.venues[v]!==false;
  const cexIds=Object.keys(T.cex).filter(v=>on(v)&&!(blocked[v]&&now-blocked[v]<3600000));
  // first the books and the route buys, which also give a reference price for the sell size
  const books=await Promise.allSettled(cexIds.map(v=>book(v,T.cex[v])));
  const dexIds=T.dex.filter(on);
  const buys=await Promise.allSettled(dexIds.map(c=>c==='eth'
    ? paraswap(USDC_E, T.eth, String(Math.round(size*1e6)), 6, T.ethDec)
    : jupiter(USDC_S, T.sol, String(Math.round(size*1e6)))));
  const mids=[];
  books.forEach((b,i)=>{ if(b.status==='fulfilled'&&b.value.bids.length&&b.value.asks.length) mids.push((b.value.bids[0][0]+b.value.asks[0][0])/2); });
  buys.forEach((b,i)=>{ if(b.status==='fulfilled'&&b.value.out>0) mids.push(size/(b.value.out/10**(dexIds[i]==='eth'?T.ethDec:T.solDec))); });
  if(!mids.length) return {quotes, errs:Object.fromEntries([...cexIds,...dexIds].map(v=>[v,'no answer'])), ref:null};
  const ref=mids.sort((a,b)=>a-b)[Math.floor(mids.length/2)], qty=size/ref;
  books.forEach((b,i)=>{ const v=cexIds[i];
    if(b.status!=='fulfilled'){ const m=String(b.reason&&b.reason.message||b.reason); errs[v]=m.slice(0,80); if(/blocked|HTTP 403|HTTP 451/.test(m)) blocked[v]=now; return; }
    const q=cexQuote(b.value, size, qty, cfg.fees[v]); if(q.err){ errs[v]=q.err; return; }
    quotes.push({id:v, ...q, fee:cfg.fees[v]}); });
  const sells=await Promise.allSettled(dexIds.map((c,i)=>buys[i].status!=='fulfilled'?Promise.reject(buys[i].reason):(c==='eth'
    ? paraswap(T.eth, USDC_E, raw(qty,T.ethDec).toString(), T.ethDec, 6)
    : jupiter(T.sol, USDC_S, raw(qty,T.solDec).toString()))));
  dexIds.forEach((c,i)=>{
    const b=buys[i], s=sells[i], dec=c==='eth'?T.ethDec:T.solDec;
    if(b.status!=='fulfilled'){ errs[c]=String(b.reason&&b.reason.message||b.reason).slice(0,80); return; }
    const tok=b.value.out/10**dec, buyPx=tok>0?size/tok:null;
    const sellPx=s.status==='fulfilled'&&s.value.out>0?(s.value.out/1e6)/qty:null;
    if(s.status!=='fulfilled') errs[c]=String(s.reason&&s.reason.message||s.reason).slice(0,80);
    const pools=[...b.value.pools,...(s.status==='fulfilled'?s.value.pools:[])];
    // the gas of one leg: a buy and a sell are separate trades, each paying its own
    const gasUsd=Math.max(b.value.gasUsd||0, s.status==='fulfilled'?s.value.gasUsd||0:0);
    quotes.push({id:c, mid:buyPx&&sellPx?(buyPx+sellPx)/2:buyPx, buyPx, sellPx, gasUsd, via:[...new Set([...b.value.via,...(s.status==='fulfilled'?s.value.via:[])])],
      own:pools.some(p=>ownPools.has(String(p).toLowerCase())||ownPools.has(String(p)))});
  });
  return {quotes, errs, ref, qty};
}

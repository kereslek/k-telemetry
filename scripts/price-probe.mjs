/* CPOOL's price, venue by venue: which source is behind? Public market data only, read by hand
   (price-probe.yml). Every price is printed against the median of the exchanges' CPOOL/USDT
   tickers, so the log carries percentages, venue names, counts and size buckets: no amount, no
   address, nothing of anyone's. Solana CPOOL is a bridged copy of the Ethereum token, and the bridge
   has been shut before, so it can trade at a price of its own; this says by how much, and which
   price can actually be traded on Solana right now (Jupiter quotes both ways). */
const CPOOL_SOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg', CPOOL_ETH='0x66761fa41377003622aee3c7675fc7b5c1c2fac5', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const sleep=ms=>new Promise(f=>setTimeout(f,ms));
const get=async u=>{ for(let k=0;k<3;k++){ try{ const r=await fetch(u,{signal:AbortSignal.timeout(20000),headers:{accept:'application/json','user-agent':'k-telemetry-price-probe'}}); if(r.ok) return await r.json(); }catch(e){} await sleep(1500*(k+1)); } return null; };
const pct=(x,ref)=>!(x>0&&ref>0)?'—':((x/ref-1)>=0?'+':'−')+Math.abs((x/ref-1)*100).toFixed(1)+'%';
const bucket=v=>!(v>0)?'—':v<1e3?'under 1k':v<1e4?'1k–10k':v<1e5?'10k–100k':v<1e6?'100k–1M':'over 1M';
const median=a=>{ const s=a.filter(x=>x>0).sort((x,y)=>x-y); if(!s.length) return null; const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };

/* the exchanges: CPOOL/USDT where it is listed */
const cex={};
{ const b=await get('https://api.bybit.com/v5/market/tickers?category=spot&symbol=CPOOLUSDT'); const x=b&&b.result&&b.result.list&&b.result.list[0]; if(x&&+x.lastPrice>0) cex.Bybit=+x.lastPrice; }
{ const g=await get('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=CPOOL_USDT'); const x=Array.isArray(g)&&g[0]; if(x&&+x.last>0) cex.Gate=+x.last; }
{ const m=await get('https://api.mexc.com/api/v3/ticker/price?symbol=CPOOLUSDT'); if(m&&+m.price>0) cex.MEXC=+m.price; }
{ const k=await get('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=CPOOL-USDT'); const x=k&&k.data; if(x&&+x.price>0) cex.KuCoin=+x.price; }
{ const t=await get('https://api.bitget.com/api/v2/spot/market/tickers?symbol=CPOOLUSDT'); const x=t&&t.data&&t.data[0]; if(x&&+x.lastPr>0) cex.Bitget=+x.lastPr; }
const REF=median(Object.values(cex));
console.log('exchanges with a CPOOL/USDT price: '+Object.keys(cex).length+(REF?' · against their median: '+Object.entries(cex).map(([k,v])=>k+' '+pct(v,REF)).join(', '):''));
if(!REF){ console.log('no exchange price: nothing to measure against'); process.exit(0); }

/* DefiLlama: the Solana mint, the Ethereum token and CoinGecko's id, with how old each price is */
{ const ks=['solana:'+CPOOL_SOL,'ethereum:'+CPOOL_ETH,'coingecko:clearpool'], j=await get('https://coins.llama.fi/prices/current/'+ks.join(','));
  for(const [k,label] of [[ks[0],'Solana mint'],[ks[1],'Ethereum token'],[ks[2],'CoinGecko id']]){ const c=j&&j.coins&&j.coins[k];
    console.log('DefiLlama, '+label+': '+(c?pct(c.price,REF)+' · '+Math.round((Date.now()/1000-c.timestamp)/60)+' min old · confidence '+(c.confidence??'—'):'no price')); } }

/* Jupiter: the price it reports, and what can be traded through it right now, both ways */
{ const p=await get('https://lite-api.jup.ag/price/v3?ids='+CPOOL_SOL), x=p&&p[CPOOL_SOL];
  console.log('Jupiter price: '+(x&&x.usdPrice>0?pct(+x.usdPrice,REF)+(x.priceChange24h!=null?' · its own 24 h change '+(+x.priceChange24h).toFixed(1)+'%':''):'none'));
  const D=10**((x&&x.decimals!=null)?+x.decimals:9);   // CPOOL's decimals on Solana, as Jupiter states them
  for(const usd of [50,500]){
    const sell=await get('https://lite-api.jup.ag/swap/v1/quote?inputMint='+CPOOL_SOL+'&outputMint='+USDC+'&amount='+Math.round(usd/REF*D)+'&slippageBps=100');
    const buy=await get('https://lite-api.jup.ag/swap/v1/quote?inputMint='+USDC+'&outputMint='+CPOOL_SOL+'&amount='+Math.round(usd*1e6)+'&slippageBps=100');
    const bid=sell&&+sell.outAmount>0?(+sell.outAmount/1e6)/(+sell.inAmount/D):null, ask=buy&&+buy.outAmount>0?(+buy.inAmount/1e6)/(+buy.outAmount/D):null;
    const venues=q=>q&&q.routePlan?[...new Set(q.routePlan.map(r=>r.swapInfo&&r.swapInfo.label))].filter(Boolean).join('+')+' ('+q.routePlan.length+' leg'+(q.routePlan.length>1?'s':'')+')':'—';
    console.log('Jupiter, about '+usd+' dollars of CPOOL: sell at '+pct(bid,REF)+' via '+venues(sell)+' · buy at '+pct(ask,REF)+' via '+venues(buy)+(bid&&ask?' · middle '+pct(Math.sqrt(bid*ask),REF):''));
    await sleep(600); } }

/* the pools themselves: where CPOOL trades on Solana and on Ethereum */
for(const [chain,addr] of [['solana',CPOOL_SOL],['ethereum',CPOOL_ETH]]){
  const r=await get('https://api.dexscreener.com/tokens/v1/'+chain+'/'+addr), list=(Array.isArray(r)?r:[]).map(pr=>{
    const base=String(pr.baseToken&&pr.baseToken.address).toLowerCase()===addr.toLowerCase(), pu=+pr.priceUsd, pn=+pr.priceNative;
    return {dex:pr.dexId, px:base?pu:(pn>0?pu/pn:null), liq:+(pr.liquidity&&pr.liquidity.usd)||0, vol:+(pr.volume&&pr.volume.h24)||0, tx1:((pr.txns&&pr.txns.h1)||{}), tx24:((pr.txns&&pr.txns.h24)||{})}; })
    .filter(x=>x.px>0).sort((a,b)=>b.liq-a.liq);
  console.log(chain+' pools with CPOOL: '+list.length);
  for(const x of list.slice(0,10)) console.log('   '+x.dex+' · '+pct(x.px,REF)+' · depth '+bucket(x.liq)+' · traded 24 h '+bucket(x.vol)+' · trades last hour '+((x.tx1.buys||0)+(x.tx1.sells||0))+', last 24 h '+((x.tx24.buys||0)+(x.tx24.sells||0)));
  await sleep(500); }

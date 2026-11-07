/* Which public exchanges serve one-minute candles 28 days back, for CPOOL, LCX and SOL? Market data only,
   no secrets: the log says, per source, whether it answered now and 27 days back, and how many candles. */
const now=Date.now(), back=now-27*864e5, s=x=>Math.floor(x/1000);
const tries=[
 ['coinbase SOL-USD', t=>`https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60&start=${new Date(t).toISOString()}&end=${new Date(t+290*60e3).toISOString()}`, j=>Array.isArray(j)?j.length:0],
 ['coinbase LCX-USD', t=>`https://api.exchange.coinbase.com/products/LCX-USD/candles?granularity=60&start=${new Date(t).toISOString()}&end=${new Date(t+290*60e3).toISOString()}`, j=>Array.isArray(j)?j.length:0],
 ['kraken SOLUSD', t=>`https://api.kraken.com/0/public/OHLC?pair=SOLUSD&interval=1&since=${s(t)}`, j=>{ const r=j&&j.result; if(!r) return 0; const k=Object.keys(r).find(x=>x!=='last'); return k?r[k].filter(c=>c[0]*1000<t+300*60e3).length:0; }],
 ['kraken LCXUSD', t=>`https://api.kraken.com/0/public/OHLC?pair=LCXUSD&interval=1&since=${s(t)}`, j=>{ const r=j&&j.result; if(!r) return 0; const k=Object.keys(r).find(x=>x!=='last'); return k?r[k].filter(c=>c[0]*1000<t+300*60e3).length:0; }],
 ['gate CPOOL_USDT', t=>`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=CPOOL_USDT&interval=1m&from=${s(t)}&to=${s(t+290*60e3)}`, j=>Array.isArray(j)?j.length:0],
 ['gate LCX_USDT', t=>`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=LCX_USDT&interval=1m&from=${s(t)}&to=${s(t+290*60e3)}`, j=>Array.isArray(j)?j.length:0],
 ['mexc CPOOLUSDT', t=>`https://api.mexc.com/api/v3/klines?symbol=CPOOLUSDT&interval=1m&startTime=${t}&endTime=${t+290*60e3}&limit=500`, j=>Array.isArray(j)?j.length:0],
 ['bybit CPOOLUSDT', t=>`https://api.bybit.com/v5/market/kline?category=spot&symbol=CPOOLUSDT&interval=1&start=${t}&end=${t+290*60e3}&limit=500`, j=>j&&j.result&&Array.isArray(j.result.list)?j.result.list.length:0],
 ['kucoin CPOOL-USDT', t=>`https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=CPOOL-USDT&startAt=${s(t)}&endAt=${s(t+290*60e3)}`, j=>j&&Array.isArray(j.data)?j.data.length:0],
 ['bitget CPOOLUSDT', t=>`https://api.bitget.com/api/v2/spot/market/history-candles?symbol=CPOOLUSDT&granularity=1min&endTime=${t+290*60e3}&limit=200`, j=>j&&Array.isArray(j.data)?j.data.length:0],
 ['binance SOLUSDT', t=>`https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&startTime=${t}&limit=300`, j=>Array.isArray(j)?j.length:0],
 ['htx cpoolusdt (now only)', t=>`https://api.huobi.pro/market/history/kline?symbol=cpoolusdt&period=1min&size=300`, j=>j&&Array.isArray(j.data)?j.data.length:0],
];
for(const [n,f,cnt] of tries){ const out=[];
  for(const [lab,t] of [['now',now-300*60e3],['27 d back',back]]){
    try{ const r=await fetch(f(t),{headers:{'user-agent':'k-telemetry-probe'},signal:AbortSignal.timeout(20000)}); let j=null; try{ j=await r.json(); }catch(e){}
      out.push(lab+': HTTP '+r.status+', '+cnt(j)+' candle(s)'); }catch(e){ out.push(lab+': '+String(e.message||e).slice(0,50)); } }
  console.log(n.padEnd(26)+out.join(' · ')); }

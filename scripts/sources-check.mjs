/* Can every data source the deck relies on be read right now? Each one asked the way the relay or the page
   asks it, its answer checked for sense (a price where a price should be, close to the others), and timed.
   CoinGecko stays the last resort; this checks everything that comes before it, and CoinGecko too.
   A source that fails is asked once more after a pause; one that still fails ends the run failed, so GitHub
   emails the owner (sources-check.yml, weekly). Market data only: the log names sources and says yes/no,
   how long, and how far apart prices are. The private Solana node is asked one harmless question and named
   only as "your private node". */
const T=Date.now(), CPOOL_SOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg', SOL='So11111111111111111111111111111111111111112';
const LCX='0x8cd41041505885ef0ad3858181d66f17be8aae7e', CL_ETH='0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', CL_BTC='0xf4030086522a5beea4988f8ca5b36dbc97bee88c';
/* the relay's Ethereum nodes, in its order (scripts/fetch-data.mjs, CHAINS.ethereum.rpcs) */
const ETH_RELAY=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth','https://rpc.mevblocker.io'];
const sleep=ms=>new Promise(f=>setTimeout(f,ms));
async function ask(url,opt={},ms=15000){ const t0=Date.now(); try{ const r=await fetch(url,{...opt,headers:{'user-agent':'k-telemetry-check',...(opt.headers||{})},signal:AbortSignal.timeout(ms)});
  let j=null; const tx=await r.text(); try{ j=JSON.parse(tx); }catch(e){} return {ok:r.ok, st:r.status, j, ms:Date.now()-t0}; }catch(e){ return {ok:false, st:String(e.name||'error'), j:null, ms:Date.now()-t0}; } }
const rpc=(u,method,params)=>ask(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});

/* each check returns its rows and the prices it saw; a check with a failed row is run once more */
const checks=[];
const C=(fn)=>checks.push(fn);
const R=(group,name,role,r,val,ok)=>({group,name,role,good:!!(r.ok&&ok),ms:r.ms,st:r.st,val});

// ---- Solana token prices
C(async()=>{ const r=await ask('https://lite-api.jup.ag/price/v3?ids='+SOL+','+CPOOL_SOL), s=+r.j?.[SOL]?.usdPrice, c=+r.j?.[CPOOL_SOL]?.usdPrice;
  return {rows:[R('Solana prices','Jupiter','primary',r,s>0?'SOL $'+s.toFixed(2)+' · CPOOL $'+(c||0).toFixed(5):'—',s>0&&c>0)], px:{sol:s>0?[['Jupiter',s]]:[], cpool:c>0?[['Jupiter',c]]:[]}}; });
C(async()=>{ const r=await ask('https://coins.llama.fi/prices/current/solana:'+SOL+',solana:'+CPOOL_SOL+',coingecko:ethereum,coingecko:bitcoin,ethereum:'+LCX), Q=r.j?.coins||{};
  const s=Q['solana:'+SOL]?.price, c=Q['solana:'+CPOOL_SOL]?.price, e=Q['coingecko:ethereum']?.price, b=Q['coingecko:bitcoin']?.price, l=Q['ethereum:'+LCX]?.price;
  const age=Math.round((Date.now()/1000-(Q['solana:'+CPOOL_SOL]?.timestamp||0))/60);
  return {rows:[R('Solana prices','DefiLlama','cross-check, takes over beyond 2%',r,c>0?'CPOOL $'+c.toFixed(5)+' · '+age+' min old':'—',s>0&&c>0&&age<120),
                R('Ethereum prices','DefiLlama (tokens)','primary for tokens',r,l>0?'LCX $'+l.toFixed(5)+' · ETH $'+(e||0).toFixed(0):'—',l>0&&e>0)],
          px:{sol:s>0?[['DefiLlama',s]]:[], cpool:c>0?[['DefiLlama',c]]:[], eth:e>0?[['DefiLlama',e]]:[], btc:b>0?[['DefiLlama',b]]:[]}}; });
// ---- Chainlink, read on Ethereum through each of the relay's nodes
for(const u of ETH_RELAY) C(async()=>{
  const r=await rpc(u,'eth_call',[{to:CL_ETH,data:'0x50d25bcd'},'latest']), v=r.j?.result?Number(BigInt(r.j.result))/1e8:null;
  const rb=await rpc(u,'eth_call',[{to:CL_BTC,data:'0x50d25bcd'},'latest']), w=rb.j?.result?Number(BigInt(rb.j.result))/1e8:null;
  return {rows:[R('Ethereum prices','Chainlink via '+new URL(u).host,'primary for ETH and BTC',r,v>0?'ETH $'+v.toFixed(0)+' · BTC $'+(w||0).toFixed(0):'—',v>0&&w>0)],
          px:{eth:v>0?[['Chainlink',v]]:[], btc:w>0?[['Chainlink',w]]:[]}}; });
// ---- hourly and minute prices
C(async()=>{ const r=await ask('https://coins.llama.fi/chart/coingecko:solana?span=24&period=1h'), n=r.j?.coins?.['coingecko:solana']?.prices?.length||0;
  return {rows:[R('Hourly prices','DefiLlama chart','MARKET vs YOUR POOLS',r,n+' hourly points',n>=20)]}; });
C(async()=>{ const r=await ask('https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60'), n=Array.isArray(r.j)?r.j.length:0, v=n?r.j[0][4]:null;
  return {rows:[R('Minute prices','Coinbase SOL-USD','arbitrage study',r,n+' candles · SOL $'+(v||0).toFixed(2),n>100)], px:{sol:v>0?[['Coinbase',v]]:[]}}; });
for(const [name,u,get] of [
  ['MEXC CPOOLUSDT','https://api.mexc.com/api/v3/klines?symbol=CPOOLUSDT&interval=1m&limit=60',j=>Array.isArray(j)&&j.length?[j.length,+j[j.length-1][4]]:[0,null]],
  ['KuCoin CPOOL-USDT','https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=CPOOL-USDT',j=>Array.isArray(j?.data)&&j.data.length?[j.data.length,+j.data[0][2]]:[0,null]],
  ['Bitget CPOOLUSDT','https://api.bitget.com/api/v2/spot/market/candles?symbol=CPOOLUSDT&granularity=1min&limit=60',j=>Array.isArray(j?.data)&&j.data.length?[j.data.length,+j.data[j.data.length-1][4]]:[0,null]]])
  C(async()=>{ const r=await ask(u), [n,v]=get(r.j);
    return {rows:[R('Minute prices',name,'arbitrage study (median of three)',r,n+' candles · CPOOL $'+(v||0).toFixed(5),n>10&&v>0)], px:{cpool:v>0?[[name.split(' ')[0],v]]:[]}}; });
// ---- pools
C(async()=>{ const r=await ask('https://api.geckoterminal.com/api/v2/networks/solana/tokens/'+CPOOL_SOL+'/pools?page=1'), n=r.j?.data?.length||0;
  return {rows:[R('Pool data','GeckoTerminal (public)','census: every pool, daily volume',r,n+' CPOOL pools listed',n>0)]}; });
C(async()=>{ const r=await ask('https://api-v3.raydium.io/pools/info/mint?mint1='+CPOOL_SOL+'&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=20&page=1'), n=(r.j?.data?.data||r.j?.data||[]).length||0;
  return {rows:[R('Pool data','Raydium API','census: Raydium pools, fee rates',r,n+' CPOOL pools listed',n>0)]}; });
C(async()=>{ const r=await ask('https://eth.blockscout.com/api/v2/stats'), ok=!!r.j?.total_blocks;
  return {rows:[R('Pool data','Blockscout','Ethereum history and token lists',r,ok?'answering':'—',ok)]}; });
// ---- chains
const KEY=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean)[0];
for(const [name,u] of [...(KEY?[['your private node',KEY]]:[]),['publicnode','https://solana-rpc.publicnode.com'],['mainnet-beta','https://api.mainnet-beta.solana.com']])
  C(async()=>{ const r=await rpc(u,'getSlot',[]), s=r.j?.result;
    return {rows:[R('Solana','Solana · '+name,name==='your private node'?'primary':'fallback',r,s?'slot '+s:(r.j?.error?.message?'refused':'—'),s>0)]}; });
C(async()=>{ const r=await rpc(ETH_RELAY[0],'eth_gasPrice',[]), g=r.j?.result?Number(BigInt(r.j.result))/1e9:null;
  return {rows:[R('Network fees','Ethereum gas (publicnode)','gas dial',r,g!=null?g.toFixed(3)+' gwei':'—',g!=null)]}; });
C(async()=>{ const r=await ask('https://mempool.space/api/v1/fees/recommended'), v=r.j?.halfHourFee; return {rows:[R('Network fees','mempool.space','Bitcoin fee, primary',r,v!=null?v+' sat/vB':'—',v>0)]}; });
C(async()=>{ const r=await ask('https://blockstream.info/api/fee-estimates'), v=r.j?.['3']; return {rows:[R('Network fees','blockstream.info','Bitcoin fee, fallback',r,v!=null?v.toFixed(1)+' sat/vB':'—',v>0)]}; });
// ---- the last resort
C(async()=>{ const r=await ask('https://api.coingecko.com/api/v3/simple/price?ids=solana,clearpool&vs_currencies=usd'), s=r.j?.solana?.usd, c=r.j?.clearpool?.usd;
  return {rows:[R('Last resort','CoinGecko (public, no key)','SOL in the page if Jupiter fails',r,s>0?'SOL $'+s.toFixed(2)+' · CPOOL $'+(c||0).toFixed(5):'—',s>0)], px:{sol:s>0?[['CoinGecko',s]]:[], cpool:c>0?[['CoinGecko',c]]:[]}}; });

/* run every check; the ones that failed once more after 20 s, keeping the second answer */
const res=[]; for(const fn of checks) res.push(await fn());
const again=res.map((x,i)=>x.rows.some(r=>!r.good)?i:-1).filter(i=>i>=0);
if(again.length){ await sleep(20000); for(const i of again){ const y=await checks[i](); y.rows.forEach(r=>{ r.retried=true; }); res[i]=y; } }
const rows=res.flatMap(x=>x.rows), px={sol:[], cpool:[], eth:[], btc:[]};
for(const x of res) for(const [k,l] of Object.entries(x.px||{})) px[k].push(...l);

// ---- report
let g=''; for(const x of rows){ if(x.group!==g){ g=x.group; console.log('\n'+g.toUpperCase()); }
  console.log('  '+(x.good?'ok  ':'FAIL')+' '+x.name.padEnd(34)+(x.role).padEnd(38)+String(x.ms+' ms').padStart(8)+'  '+(x.good?x.val:'HTTP '+x.st+' · '+x.val)+(x.retried?' (asked twice)':'')); }
if(!KEY) console.log('\n  note: no private Solana node is set (the SOL_RPC_URL secret is empty); the public nodes above are used');
console.log('\nDO THE PRICES AGREE? (each source against the median of all)');
for(const [k,list] of Object.entries(px)){ if(!list.length) continue; const v=list.map(x=>x[1]).sort((a,b)=>a-b), m=v[Math.floor(v.length/2)];
  console.log('  '+k.toUpperCase().padEnd(6)+list.map(([n,p])=>n+' '+((p/m-1)*100>=0?'+':'')+((p/m-1)*100).toFixed(2)+'%').join(' · ')); }
const bad=rows.filter(r=>!r.good);
console.log('\n'+(rows.length-bad.length)+' of '+rows.length+' sources answered sensibly · '+again.length+' asked twice · '+((Date.now()-T)/1000).toFixed(1)+' s');
if(bad.length){ console.log('::error::'+bad.length+' data source(s) still failing after a second try: '+bad.map(r=>r.name).join(', ')); process.exitCode=1; }

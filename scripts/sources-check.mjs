/* Can every data source the deck relies on be read right now? Each one asked the way the relay or the page
   asks it, its answer checked for sense (a price where a price should be, close to the others), and timed.
   CoinGecko stays the last resort; this checks everything that comes before it, and CoinGecko too.
   Market data only: the log names sources and says yes/no, how long, and how far apart prices are. The
   private Solana node is asked one harmless question and named only as "your private node". */
const T=Date.now(), CPOOL_SOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg', SOL='So11111111111111111111111111111111111111112';
const LCX='0x8cd41041505885ef0ad3858181d66f17be8aae7e', CL_ETH='0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', CL_BTC='0xf4030086522a5beea4988f8ca5b36dbc97bee88c';
const rows=[]; let fails=0;
async function ask(url,opt={},ms=15000){ const t0=Date.now(); try{ const r=await fetch(url,{...opt,headers:{'user-agent':'k-telemetry-check',...(opt.headers||{})},signal:AbortSignal.timeout(ms)});
  let j=null; const tx=await r.text(); try{ j=JSON.parse(tx); }catch(e){} return {ok:r.ok, st:r.status, j, ms:Date.now()-t0}; }catch(e){ return {ok:false, st:String(e.name||'error'), j:null, ms:Date.now()-t0}; } }
const rpc=(u,method,params)=>ask(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
function row(group,name,role,r,val,ok,note=''){ const good=r.ok&&ok; if(!good) fails++;
  rows.push({group,name,role,good,ms:r.ms,st:r.st,val,note}); }
const px={sol:[], cpool:[], eth:[], btc:[]};

// ---- Solana token prices
{ const r=await ask('https://lite-api.jup.ag/price/v3?ids='+SOL+','+CPOOL_SOL), s=+r.j?.[SOL]?.usdPrice, c=+r.j?.[CPOOL_SOL]?.usdPrice;
  if(s>0) px.sol.push(['Jupiter',s]); if(c>0) px.cpool.push(['Jupiter',c]); row('Solana prices','Jupiter','primary',r,s>0?'SOL $'+s.toFixed(2)+' · CPOOL $'+(c||0).toFixed(5):'—',s>0&&c>0); }
{ const r=await ask('https://coins.llama.fi/prices/current/solana:'+SOL+',solana:'+CPOOL_SOL+',coingecko:ethereum,coingecko:bitcoin,ethereum:'+LCX), C=r.j?.coins||{};
  const s=C['solana:'+SOL]?.price, c=C['solana:'+CPOOL_SOL]?.price, e=C['coingecko:ethereum']?.price, b=C['coingecko:bitcoin']?.price, l=C['ethereum:'+LCX]?.price;
  const age=Math.round((Date.now()/1000-(C['solana:'+CPOOL_SOL]?.timestamp||0))/60);
  if(s>0) px.sol.push(['DefiLlama',s]); if(c>0) px.cpool.push(['DefiLlama',c]); if(e>0) px.eth.push(['DefiLlama',e]); if(b>0) px.btc.push(['DefiLlama',b]);
  row('Solana prices','DefiLlama','cross-check, takes over beyond 2%',r,c>0?'CPOOL $'+c.toFixed(5)+' · '+age+' min old':'—',s>0&&c>0&&age<120);
  row('Ethereum prices','DefiLlama (tokens)','primary for tokens',r,l>0?'LCX $'+l.toFixed(5)+' · ETH $'+(e||0).toFixed(0):'—',l>0&&e>0); }
// ---- Chainlink, read on Ethereum through the relay's public nodes
for(const u of ['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://eth.llamarpc.com','https://1rpc.io/eth','https://rpc.mevblocker.io']){
  const r=await rpc(u,'eth_call',[{to:CL_ETH,data:'0x50d25bcd'},'latest']), v=r.j?.result?Number(BigInt(r.j.result))/1e8:null;
  const rb=await rpc(u,'eth_call',[{to:CL_BTC,data:'0x50d25bcd'},'latest']), w=rb.j?.result?Number(BigInt(rb.j.result))/1e8:null;
  if(v>0) px.eth.push(['Chainlink',v]); if(w>0) px.btc.push(['Chainlink',w]);
  row('Ethereum prices','Chainlink via '+new URL(u).host,'primary for ETH and BTC',r,v>0?'ETH $'+v.toFixed(0)+' · BTC $'+(w||0).toFixed(0):'—',v>0&&w>0); }
// ---- hourly and minute prices
{ const r=await ask('https://coins.llama.fi/chart/coingecko:solana?span=24&period=1h'), n=r.j?.coins?.['coingecko:solana']?.prices?.length||0;
  row('Hourly prices','DefiLlama chart','MARKET vs YOUR POOLS',r,n+' hourly points',n>=20); }
{ const r=await ask('https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60'), n=Array.isArray(r.j)?r.j.length:0, v=n?r.j[0][4]:null;
  if(v>0) px.sol.push(['Coinbase',v]); row('Minute prices','Coinbase SOL-USD','arbitrage study',r,n+' candles · SOL $'+(v||0).toFixed(2),n>100); }
for(const [name,u,get] of [
  ['MEXC CPOOLUSDT','https://api.mexc.com/api/v3/klines?symbol=CPOOLUSDT&interval=1m&limit=60',j=>Array.isArray(j)&&j.length?[j.length,+j[j.length-1][4]]:[0,null]],
  ['KuCoin CPOOL-USDT','https://api.kucoin.com/api/v1/market/candles?type=1min&symbol=CPOOL-USDT',j=>Array.isArray(j?.data)&&j.data.length?[j.data.length,+j.data[0][2]]:[0,null]],
  ['Bitget CPOOLUSDT','https://api.bitget.com/api/v2/spot/market/candles?symbol=CPOOLUSDT&granularity=1min&limit=60',j=>Array.isArray(j?.data)&&j.data.length?[j.data.length,+j.data[j.data.length-1][4]]:[0,null]]]){
  const r=await ask(u), [n,v]=get(r.j); if(v>0) px.cpool.push([name.split(' ')[0],v]); row('Minute prices',name,'arbitrage study (median of three)',r,n+' candles · CPOOL $'+(v||0).toFixed(5),n>10&&v>0); }
// ---- pools
{ const r=await ask('https://api.geckoterminal.com/api/v2/networks/solana/tokens/'+CPOOL_SOL+'/pools?page=1'), n=r.j?.data?.length||0;
  row('Pool data','GeckoTerminal (public)','census: every pool, daily volume',r,n+' CPOOL pools listed',n>0); }
{ const r=await ask('https://api-v3.raydium.io/pools/info/mint?mint1='+CPOOL_SOL+'&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=20&page=1'), n=(r.j?.data?.data||r.j?.data||[]).length||0;
  row('Pool data','Raydium API','census: Raydium pools, fee rates',r,n+' CPOOL pools listed',n>0); }
{ const r=await ask('https://eth.blockscout.com/api/v2/stats'), ok=!!r.j?.total_blocks;
  row('Pool data','Blockscout','Ethereum history and token lists',r,ok?'answering':'—',ok); }
// ---- chains
const KEY=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean)[0];
for(const [name,u] of [...(KEY?[['your private node',KEY]]:[]),['publicnode','https://solana-rpc.publicnode.com'],['mainnet-beta','https://api.mainnet-beta.solana.com']]){
  const r=await rpc(u,'getSlot',[]), s=r.j?.result; row('Solana','Solana · '+name,name==='your private node'?'primary':'fallback',r,s?'slot '+s:(r.j?.error?.message?'refused':'—'),s>0); }
{ const r=await rpc('https://ethereum-rpc.publicnode.com','eth_gasPrice',[]), g=r.j?.result?Number(BigInt(r.j.result))/1e9:null;
  row('Network fees','Ethereum gas (publicnode)','gas dial',r,g!=null?g.toFixed(3)+' gwei':'—',g!=null); }
{ const r=await ask('https://mempool.space/api/v1/fees/recommended'), v=r.j?.halfHourFee; row('Network fees','mempool.space','Bitcoin fee, primary',r,v!=null?v+' sat/vB':'—',v>0); }
{ const r=await ask('https://blockstream.info/api/fee-estimates'), v=r.j?.['3']; row('Network fees','blockstream.info','Bitcoin fee, fallback',r,v!=null?v.toFixed(1)+' sat/vB':'—',v>0); }
// ---- the last resort
{ const r=await ask('https://api.coingecko.com/api/v3/simple/price?ids=solana,clearpool&vs_currencies=usd'), s=r.j?.solana?.usd, c=r.j?.clearpool?.usd;
  if(s>0) px.sol.push(['CoinGecko',s]); if(c>0) px.cpool.push(['CoinGecko',c]);
  row('Last resort','CoinGecko (public, no key)','SOL in the page if Jupiter fails',r,s>0?'SOL $'+s.toFixed(2)+' · CPOOL $'+(c||0).toFixed(5):'—',s>0); }

// ---- report
let g=''; for(const x of rows){ if(x.group!==g){ g=x.group; console.log('\n'+g.toUpperCase()); }
  console.log('  '+(x.good?'ok  ':'FAIL')+' '+x.name.padEnd(34)+(x.role).padEnd(38)+String(x.ms+' ms').padStart(8)+'  '+(x.good?x.val:'HTTP '+x.st+' · '+x.val)); }
console.log('\nDO THE PRICES AGREE? (each source against the median of all)');
for(const [k,list] of Object.entries(px)){ if(!list.length) continue; const v=list.map(x=>x[1]).sort((a,b)=>a-b), m=v[Math.floor(v.length/2)];
  console.log('  '+k.toUpperCase().padEnd(6)+list.map(([n,p])=>n+' '+((p/m-1)*100>=0?'+':'')+((p/m-1)*100).toFixed(2)+'%').join(' · ')); }
console.log('\n'+rows.filter(r=>r.good).length+' of '+rows.length+' sources answered sensibly · '+((Date.now()-T)/1000).toFixed(1)+' s');
process.exit(0);

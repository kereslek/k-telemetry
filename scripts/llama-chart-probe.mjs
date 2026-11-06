/* Does DefiLlama's hourly chart answer from GitHub's runners? Market data only (the three majors),
   no secrets; the log says what each way of asking returns. */
const H=3600e3, nowH=Math.floor(Date.now()/H)*H, keys=['coingecko:bitcoin','coingecko:ethereum','coingecko:solana'];
const tries=[['31 days back, 168 points','start='+Math.floor((nowH-31*24*H)/1000)+'&span=168&period=1h&searchWidth=1200'],
  ['31 days back, 168 points, no searchWidth','start='+Math.floor((nowH-31*24*H)/1000)+'&span=168&period=1h'],
  ['last day, 24 points','start='+Math.floor((nowH-24*H)/1000)+'&span=24&period=1h'],
  ['ending now, 24 points','end='+Math.floor(nowH/1000)+'&span=24&period=1h'],
  ['31 days back, 744 points','start='+Math.floor((nowH-31*24*H)/1000)+'&span=744&period=1h']];
for(const [n,q] of tries){ const t0=Date.now();
  try{ const r=await fetch('https://coins.llama.fi/chart/'+keys.join(',')+'?'+q,{signal:AbortSignal.timeout(30000)}); const tx=await r.text(); let j=null; try{ j=JSON.parse(tx); }catch(e){}
    const c=j&&j.coins?Object.entries(j.coins).map(([k,v])=>k.split(':')[1]+' '+((v.prices||[]).length)).join(', '):'not JSON: '+tx.slice(0,80).replace(/\s+/g,' ');
    console.log(n+': HTTP '+r.status+' in '+(Date.now()-t0)+' ms · '+c); }
  catch(e){ console.log(n+': '+String(e.message||e).slice(0,80)+' after '+(Date.now()-t0)+' ms'); } }

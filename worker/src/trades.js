/* The trades the dial lists, from the recorder's minutes and its readings (events).

   Minutes from before the live event log become runs of back-to-back minutes; readings become trades with their exact
   time. A run of minutes carries no side by itself, so the readings kept in the long memory for the same minutes
   (`old`, oldest first) give it its side (which token was sold into each pool) and its size; without them a run shows
   the pool alone, as before. */
import {biggest} from './big.js';
export const TRADE_MIN=0.005;
const MIN=60000;
export function tradesOf(all, ev, evStart, old){
  const r=x=>Math.round(x*1e4)/1e4, out=[];
  const runs=[]; let cur=null;
  for(const [t,usd,,pools] of all){
    if(!(usd>=TRADE_MIN)){ cur=null; continue; }
    if(cur && t-cur.end===MIN){ cur.usd+=usd; cur.end=t; if(usd>cur.peak){ cur.peak=usd; cur.t=t; } }
    else { cur={t, start:t, end:t, peak:usd, usd, pools:{}}; runs.push(cur); }
    if(pools) for(const k in pools) cur.pools[k]=(cur.pools[k]||0)+pools[k];
  }
  const gaps=[]; for(let i=1;i<runs.length;i++) gaps.push(Math.round((runs[i].start-runs[i-1].end)/MIN)-1);
  // minutes before the event log covers them; the minute it began in is left to the events
  const evMin=evStart!=null?Math.floor(evStart/MIN)*MIN:Infinity;
  /* each run's readings from the long memory: those whose middle falls inside its minutes (runs and readings are both in
     time order, so one pass) */
  let j=0; const O=Array.isArray(old)?old:[];
  for(const x of runs){ if(!(x.end<evMin)) continue;
    const lo=x.start, hi=x.end+MIN, side={}, px={};
    while(j<O.length&&(O[j][1]+O[j][0])/2<lo) j++;
    for(let i=j;i<O.length;i++){ const [t,a,,,sd,p]=O[i], at=(a+t)/2; if(at>=hi) break;
      for(const k in sd||{}){ const s=side[k]||(side[k]=[0,0]); s[0]+=sd[k][0]; s[1]+=sd[k][1]; }
      for(const k in p||{}){ const q=px[k]||(px[k]={p:null, usd:0, n:0}); q.p=p[k][0]; if(p[k][1]!=null){ q.usd+=p[k][1]; q.n++; } } }
    out.push({t:x.t, start:x.start, end:x.end, usd:x.usd, pools:x.pools, ...(Object.keys(side).length?{side}:{}), ...(Object.keys(px).length?{px}:{})}); }
  let tr=null;
  for(const [t,a,usd,pools,side,px] of ev){
    const at=Math.round((a+t)/2);
    // a reading's midpoint can fall before the previous one's when spans differ (12 s Ethereum, 3 s Solana)
    if(tr && at-tr.end<=Math.max(5000,1.5*(t-a))){ tr.usd+=usd; tr.start=Math.min(tr.start,at); tr.end=Math.max(tr.end,at); if(usd>tr.peak){ tr.peak=usd; tr.t=at; } }
    else { tr={k:at, t:at, start:at, end:at, peak:usd, usd, pools:{}, side:{}, px:{}, x:1}; out.push(tr); }
    for(const k in pools||{}) tr.pools[k]=(tr.pools[k]||0)+pools[k];
    for(const k in side||{}){ const s=tr.side[k]||(tr.side[k]=[0,0]); s[0]+=side[k][0]; s[1]+=side[k][1]; }
    // the price after the trade's last reading, and the size summed over its readings
    for(const k in px||{}){ const q=tr.px[k]||(tr.px[k]={p:null, usd:0, n:0}); q.p=px[k][0];
      if(px[k][1]!=null){ q.usd+=px[k][1]; q.n++; } }
  }
  const fmt=e=>({...(e.x?{k:e.k,x:1}:{}), t:e.t, start:e.start, end:e.end, usd:r(e.usd),
             pools:Object.fromEntries(Object.entries(e.pools).map(([k,v])=>[k,r(v)])),
             ...(e.side&&Object.keys(e.side).length?{side:Object.fromEntries(Object.entries(e.side).map(([k,v])=>[k,[r(v[0]),r(v[1])]]))}:{}),
             ...(e.px&&Object.keys(e.px).length?{px:Object.fromEntries(Object.entries(e.px).map(([k,v])=>[k,[v.p, v.n?Math.round(v.usd*100)/100:null]]))}:{})});
  // the biggest of the last 24 hours and of today (Budapest), from every trade held, not only the 20 listed
  const B=biggest(out, Date.now());
  return { trades: out.slice(-20).reverse().map(fmt),
           big:{d24:B.d24?fmt(B.d24):null, today:B.today?fmt(B.today):null, day0:B.day0},
           gaps, from: all.length?all[0][0]:null };
}

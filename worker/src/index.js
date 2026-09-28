/* ARC pulse: a minute-by-minute record of fee income, kept so the dashboard can show the last
   60 minutes whether or not anyone had it open.

   A cron trigger fires every minute and hands over to one Durable Object, which reads every
   position's fee growth from the chains (sampler.js), turns the change since the previous
   reading into dollars, and keeps the last 24 hours of minutes. GET /m?n=60 returns them.

   A reading that fails leaves that position's previous reading in place; the next good one
   covers the gap and its fees are spread evenly over the minutes it spans, so a missed minute
   never shows as a spike beside a hole. Gaps over 30 minutes are dropped, not smeared. */
import {positionsFrom, readGrowth, earned, SOL_RPCS} from './sampler.js';

const KEEP=1440, MAX_SPAN=30, MIN=60000;
const cors={'access-control-allow-origin':'*','x-robots-tag':'noindex'};

export class Pulse {
  constructor(ctx, env){ this.ctx=ctx; this.env=env; this.s=ctx.storage; }

  async fetch(req){
    const u=new URL(req.url);
    if(u.pathname==='/tick'){
      // a failed minute is kept where /m can show it, instead of vanishing into the logs
      try{ const r=await this.tick(); await this.s.put('fail',null); return Response.json(r); }
      catch(e){ const f={at:Date.now(), err:String(e&&e.stack||e).slice(0,400)}; await this.s.put('fail',f); return Response.json(f,{status:500}); }
    }
    const n=Math.max(1,Math.min(KEEP,Number(u.searchParams.get('n'))||60));
    const [mins,meta,fail]=await Promise.all([this.s.get('mins'),this.s.get('meta'),this.s.get('fail')]);
    const since=Math.floor(Date.now()/MIN)*MIN-n*MIN;
    const rows=Object.entries(mins||{}).map(([t,v])=>[Number(t),v[0],v[1]]).filter(r=>r[0]>=since).sort((a,b)=>a[0]-b[0]);
    return Response.json({now:Date.now(), ...(meta||{}), ...(fail?{fail}:{}), mins:rows});
  }

  // the dashboard's own position list and prices, refreshed every ten minutes
  async positions(){
    let src=await this.s.get('src');
    if(!src || Date.now()-src.at>10*MIN){
      try{
        const r=await fetch(this.env.SRC_URL+'?t='+Date.now(),{cf:{cacheTtl:0}});
        if(!r.ok) throw new Error('src HTTP '+r.status);
        src={at:Date.now(), ps:positionsFrom(await r.json())};
        await this.s.put('src',src);
      }catch(e){ if(!src) throw e; }
    }
    return src.ps;
  }

  async tick(){
    const ps=await this.positions();
    const cache=(await this.s.get('cache'))||{};
    const solRpcs=this.env.SOL_RPC_URL?[this.env.SOL_RPC_URL,...SOL_RPCS]:SOL_RPCS;
    const cur=await readGrowth(ps, cache, {solRpcs});
    await this.s.put('cache',cache);
    const prev=(await this.s.get('prev'))||{};          // id -> {t, reading}
    const mins=(await this.s.get('mins'))||{};
    const slot=Math.floor(cur.t/MIN)*MIN-MIN;           // the minute that just ended
    let got=0;
    for(const p of ps){
      const b=cur.g[p.id]; if(!b) continue;
      const a=prev[p.id];
      prev[p.id]={t:cur.t, r:b};
      if(!a) continue;
      const span=Math.max(1,Math.round((cur.t-a.t)/MIN));
      if(span>MAX_SPAN) continue;
      const e=earned({g:{[p.id]:a.r}}, {g:{[p.id]:b}}, [p]);
      if(!(p.id in e.by)) continue;
      got++;
      for(let k=0;k<span;k++){ const t=slot-k*MIN; const v=mins[t]||(mins[t]=[0,0]); v[0]+=e.by[p.id]/span; v[1]++; }
    }
    // forget positions that are no longer listed, and minutes older than a day
    for(const id of Object.keys(prev)) if(!ps.some(p=>p.id===id)) delete prev[id];
    const cut=slot-KEEP*MIN;
    for(const t of Object.keys(mins)){ if(Number(t)<cut) delete mins[t]; else mins[t][0]=Math.round(mins[t][0]*1e6)/1e6; }
    const meta={N:ps.length, last:cur.t, read:Object.keys(cur.g).length, err:cur.err};
    await this.s.put({prev, mins, meta});
    return {slot, got, ...meta};
  }
}

export default {
  async scheduled(ev, env, ctx){
    const stub=env.PULSE.get(env.PULSE.idFromName('main'));
    ctx.waitUntil(stub.fetch('https://pulse/tick'));
  },
  async fetch(req, env){
    const u=new URL(req.url);
    if(req.method==='OPTIONS') return new Response(null,{headers:{...cors,'access-control-allow-methods':'GET'}});
    if(u.pathname!=='/m') return new Response('Not found',{status:404,headers:cors});
    const stub=env.PULSE.get(env.PULSE.idFromName('main'));
    const r=await stub.fetch('https://pulse/m'+u.search);
    return new Response(r.body,{headers:{...cors,'content-type':'application/json','cache-control':'public, max-age=20'}});
  },
};

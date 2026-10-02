/* ARC pulse: a minute-by-minute record of fee income, kept so the dashboard can show the last
   60 minutes whether or not anyone had it open.

   A cron trigger fires every minute and hands over to one Durable Object, which reads every
   position's fee growth from the chains (sampler.js), turns the change since the previous
   reading into dollars, and keeps the last 24 hours of minutes. GET /m?n=60 returns them;
   GET /m?n=60&live=1, which the open dashboard asks every three seconds, reads faster first.

   A reading that fails leaves that position's previous reading in place; the next good one
   covers the gap and its fees are spread evenly over the minutes it spans, so a missed minute
   never shows as a spike beside a hole. Gaps over 30 minutes are dropped, not smeared. */
import {positionsFrom, readGrowth, earned, SOL_RPCS} from './sampler.js';

const KEEP=1440, MAX_SPAN=30, MIN=60000;
const cors={'access-control-allow-origin':'*','x-robots-tag':'noindex'};

/* Trades, as the dashboard shows them. While someone is watching, readings come every few seconds
   and each one that found fees is an event, stamped at the middle of the span it covers. A run of
   readings that each found fees is one trade (two events at most one and a half reading spans
   apart), so a single quiet reading ends it; the trade keeps its first event's time as its key
   while it grows. Minutes from before the event log
   began are grouped the old way: a run of consecutive earning minutes is one trade. Newest first,
   with the pools they came from. The gaps between minute runs are the quiet stretches the lull
   meter compares against, and `from` says how far back the record reaches. */
const TRADE_MIN=0.005, EV_KEEP=3*60*MIN, EV_MAX=5000;
function tradesOf(all, ev, evStart){
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
  for(const x of runs) if(x.end<evMin) out.push({t:x.t, start:x.start, end:x.end, usd:x.usd, pools:x.pools});
  let tr=null;
  for(const [t,a,usd,pools] of ev){
    const at=Math.round((a+t)/2);
    // a reading's midpoint can fall before the previous one's when spans differ (12 s Ethereum, 3 s Solana)
    if(tr && at-tr.end<=Math.max(5000,1.5*(t-a))){ tr.usd+=usd; tr.start=Math.min(tr.start,at); tr.end=Math.max(tr.end,at); if(usd>tr.peak){ tr.peak=usd; tr.t=at; } }
    else { tr={k:at, t:at, start:at, end:at, peak:usd, usd, pools:{}, x:1}; out.push(tr); }
    for(const k in pools||{}) tr.pools[k]=(tr.pools[k]||0)+pools[k];
  }
  return { trades: out.slice(-20).reverse().map(e=>({...(e.x?{k:e.k,x:1}:{}), t:e.t, start:e.start, end:e.end, usd:r(e.usd),
             pools:Object.fromEntries(Object.entries(e.pools).map(([k,v])=>[k,r(v)]))})),
           gaps, from: all.length?all[0][0]:null };
}

/* Fast only while watching. The page asks for /m?live=1 every three seconds while it is open, and
   each of those asks reads Solana again if the last read is 2.5 s old and Ethereum if it is 11 s
   old (a block is 12 s; reading faster only reads the same block again). Nothing runs on a timer
   of its own: when no page asks, the minute cron is the only reader, exactly as before.
   The record lives in memory between asks and is written to storage at most once a minute, so
   fast reading costs no storage writes; if the object is evicted, the next reading is measured
   from the last saved one and nothing is lost, only stamped later. */
const FAST={sol:2500, eth:11000};
export class Pulse {
  constructor(ctx, env){ this.ctx=ctx; this.env=env; this.s=ctx.storage; this.mem=null; this.src=null;
    this.lastRead={eth:0, sol:0}; this.busy={}; this.savedAt=0; this.err={}; this.watchAt=0; }

  async load(){
    if(this.mem) return this.mem;
    const [prev,mins,cache,meta,ev,evStart]=await Promise.all(['prev','mins','cache','meta','ev','evStart'].map(k=>this.s.get(k)));
    // another request may have loaded it while this one waited
    if(!this.mem) this.mem={prev:prev||{}, mins:mins||{}, cache:cache||{}, meta:meta||{}, ev:ev||[], evStart:evStart??null};
    return this.mem;
  }
  async save(){
    const m=this.mem; if(!m) return;
    await this.s.put({prev:m.prev, mins:m.mins, cache:m.cache, meta:m.meta, ev:m.ev, evStart:m.evStart});
    this.savedAt=Date.now();
  }

  async fetch(req){
    const u=new URL(req.url);
    if(u.pathname==='/tick'){
      // a failed minute is kept where /m can show it, instead of vanishing into the logs
      try{ const r=await this.tick(); await this.s.put('fail',null); return Response.json(r); }
      catch(e){ const f={at:Date.now(), err:String(e&&e.stack||e).slice(0,400)}; await this.s.put('fail',f); return Response.json(f,{status:500}); }
    }
    const m=await this.load();
    if(u.searchParams.get('live')==='1'){
      const now=Date.now(), jobs=[]; this.watchAt=now;
      for(const c of ['sol','eth']) if(now-this.lastRead[c]>=FAST[c]) jobs.push(this.readChain(c));
      // answer within 2.5 s either way; a slow read finishes on its own and shows on the next ask
      if(jobs.length) await Promise.race([Promise.allSettled(jobs), new Promise(r=>setTimeout(r,2500))]);
      if(Date.now()-this.savedAt>MIN) await this.save().catch(()=>{});
    }
    const n=Math.max(1,Math.min(KEEP,Number(u.searchParams.get('n'))||60));
    const fail=await this.s.get('fail');
    const since=Math.floor(Date.now()/MIN)*MIN-n*MIN;
    const all=Object.entries(m.mins).map(([t,v])=>[Number(t),v[0],v[1],v[2]||null]).sort((a,b)=>a[0]-b[0]);
    const rows=all.filter(r=>r[0]>=since).map(r=>r[3]?r:r.slice(0,3));
    const fast=Date.now()-this.watchAt<10000;
    return Response.json({now:Date.now(), ...m.meta, fast, ...(fail?{fail}:{}), mins:rows, ...tradesOf(all, m.ev, m.evStart)});
  }

  // the dashboard's own position list and prices, refreshed every ten minutes
  async positions(){
    let src=this.src||await this.s.get('src');
    if(!src || Date.now()-src.at>10*MIN){
      try{
        const r=await fetch(this.env.SRC_URL+'?t='+Date.now(),{cf:{cacheTtl:0}});
        if(!r.ok) throw new Error('src HTTP '+r.status);
        src={at:Date.now(), ps:positionsFrom(await r.json())};
        await this.s.put('src',src);
      }catch(e){ if(!src) throw e; }
    }
    this.src=src;
    return src.ps;
  }

  // one chain at a time; asks that arrive while a read is under way share it
  readChain(c){
    if(!this.busy[c]) this.busy[c]=this.read([c]).finally(()=>{ this.busy[c]=null; });
    return this.busy[c];
  }

  async read(chains){
    const m=await this.load();
    const all=await this.positions(), ps=all.filter(p=>chains.includes(p.chain));
    const solRpcs=this.env.SOL_RPC_URL?[this.env.SOL_RPC_URL,...SOL_RPCS]:SOL_RPCS;
    const cur=await readGrowth(ps, m.cache, {solRpcs, solFirst:!!this.env.SOL_RPC_URL, chains});
    for(const c of chains) this.err[c]=cur.err.length?cur.err.join(' | '):null;
    /* Each reading's fees are spread over the minutes it actually covers, in proportion to the
       time, so a reading that lands a few seconds either side of the minute neither double-fills
       one minute nor skips the next. The second number is coverage in position-minutes: a minute
       every position covered in full holds N. Nothing below awaits, so two readings never
       interleave here. */
    const {prev, mins}=m;
    let got=0, evUsd=0, evFrom=Infinity; const evPools={};
    for(const p of ps){
      const b=cur.g[p.id]; if(!b) continue;
      const a=prev[p.id];
      if(!a||!(cur.t>a.t)||cur.t-a.t>MAX_SPAN*MIN){ prev[p.id]={t:cur.t, r:b}; continue; }
      const e=earned({g:{[p.id]:a.r}}, {g:{[p.id]:b}}, [p]);
      // a reading from a node behind the last one is dropped; the newer reading stays the base
      if(!(p.id in e.by)) continue;
      prev[p.id]={t:cur.t, r:b};
      got++;
      const span=cur.t-a.t, v=e.by[p.id], k=p.lbl||p.id;
      for(let t=Math.floor(a.t/MIN)*MIN; t<cur.t; t+=MIN){
        const lo=Math.max(a.t,t), hi=Math.min(cur.t,t+MIN); if(!(hi>lo)) continue;
        const row=mins[t]||(mins[t]=[0,0]), part=v*(hi-lo)/span;
        row[0]+=part; row[1]+=(hi-lo)/MIN;
        // which pool it came from, so the dashboard can colour and list trades by pool
        if(part>=0.0005) (row[2]||(row[2]={}))[k]=(row[2][k]||0)+part;
      }
      evUsd+=v; evFrom=Math.min(evFrom,a.t); if(v>=0.0005) evPools[k]=(evPools[k]||0)+v;
    }
    // the event log starts with the first reading that measured anything
    if(m.evStart==null && got) m.evStart=evFrom;
    if(evUsd>=TRADE_MIN){ const r=x=>Math.round(x*1e6)/1e6;
      m.ev.push([cur.t, evFrom, r(evUsd), Object.fromEntries(Object.entries(evPools).map(([k,v])=>[k,r(v)]))]); }
    for(const c of chains) this.lastRead[c]=cur.t;
    // forget positions that are no longer listed, minutes older than a day, events older than three hours
    for(const id of Object.keys(prev)) if(!all.some(p=>p.id===id)) delete prev[id];
    const cut=Math.floor(cur.t/MIN)*MIN-KEEP*MIN;
    for(const t of Object.keys(mins)){ if(Number(t)<cut) delete mins[t]; else { const v=mins[t]; v[0]=Math.round(v[0]*1e6)/1e6; v[1]=Math.round(v[1]*100)/100;
      if(v[2]) for(const k in v[2]) v[2][k]=Math.round(v[2][k]*1e6)/1e6; } }
    const evCut=Math.max(cur.t-EV_KEEP, m.ev.length>EV_MAX?m.ev[m.ev.length-EV_MAX][0]:0);
    if(m.ev.length && m.ev[0][0]<evCut){ m.ev=m.ev.filter(x=>x[0]>=evCut); if(m.evStart!=null) m.evStart=Math.max(m.evStart,evCut); }
    const fresh=Object.values(prev).filter(x=>cur.t-x.t<90000).length;
    m.meta={N:all.length, last:Math.max(m.meta.last||0,cur.t), read:fresh, err:Object.values(this.err).filter(Boolean)};
    return {slot:Math.floor(cur.t/MIN)*MIN, got, ...m.meta};
  }

  // the minute cron: reads whatever no watcher has read in the last 45 s, then saves
  async tick(){
    const now=Date.now(), chains=['eth','sol'].filter(c=>now-this.lastRead[c]>45000);
    const r=chains.length?await this.read(chains):{...(await this.load()).meta, fast:true};
    await this.save();
    return r;
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
    const live=u.searchParams.get('live')==='1';
    return new Response(r.body,{headers:{...cors,'content-type':'application/json','cache-control':live?'no-store':'public, max-age=20'}});
  },
};

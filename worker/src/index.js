/* ARC pulse: a minute-by-minute record of fee income, kept so the dashboard can show the last
   60 minutes whether or not anyone had it open.

   A cron trigger fires every minute and hands over to one Durable Object, which reads every
   position's fee growth from the chains (sampler.js), turns the change since the previous
   reading into dollars, and keeps the last 24 hours of minutes. GET /m?n=60 returns them;
   GET /m?n=60&live=1, which the open dashboard asks every three seconds, reads faster first.

   A reading that fails leaves that position's previous reading in place; the next good one
   covers the gap and its fees are spread evenly over the minutes it spans, so a missed minute
   never shows as a spike beside a hole. Gaps over 30 minutes are dropped, not smeared. */
import {positionsFrom, readGrowth, earned, poolTraded, SOL_RPCS, EVM_RPCS, one} from './sampler.js';
import {TOKENS, DEFAULT_CFG, readToken, opportunities, step} from './gaps.js';

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
  return { trades: out.slice(-20).reverse().map(e=>({...(e.x?{k:e.k,x:1}:{}), t:e.t, start:e.start, end:e.end, usd:r(e.usd),
             pools:Object.fromEntries(Object.entries(e.pools).map(([k,v])=>[k,r(v)])),
             ...(e.side&&Object.keys(e.side).length?{side:Object.fromEntries(Object.entries(e.side).map(([k,v])=>[k,[r(v[0]),r(v[1])]]))}:{}),
             ...(e.px&&Object.keys(e.px).length?{px:Object.fromEntries(Object.entries(e.px).map(([k,v])=>[k,[v.p, v.n?Math.round(v.usd*100)/100:null]]))}:{})})),
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
const SWAP_V3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
/* Your own swaps are not income. A swap of yours through one of your own pools pays its fee to
   your own positions: the wallet's money going round, which the monthly ledger takes out. Here it
   never goes in. When a reading finds new fees in a pool, the deck's own wallets are asked whether
   they swapped in that pool during the same seconds (Solana: their latest signatures and the
   transaction's accounts and logs; Ethereum: the pool's Swap logs in those blocks and who sent
   each). If they did, that pool's fees for the span stay out of the minutes and the trades, so the
   dial never draws, births or flashes them. Then, every ten minutes, the relay's exact list of
   own-swap fees (costs-main.json, selfPend) settles the amounts: an estimate made here is
   corrected, and anything the live check could not see (a reading too soon after the swap, the
   recorder asleep) is taken out of the minute and trade it landed in. */
export class Pulse {
  constructor(ctx, env){ this.ctx=ctx; this.env=env; this.s=ctx.storage; this.mem=null; this.src=null;
    this.lastRead={eth:0, sol:0}; this.busy={}; this.savedAt=0; this.err={}; this.watchAt=0;
    this.sigMemo=new Map(); this.txMemo=new Map(); }

  async load(){
    if(this.mem) return this.mem;
    const [prev,mins,cache,meta,ev,evStart,own,selfSeen,poolPrev]=await Promise.all(['prev','mins','cache','meta','ev','evStart','own','selfSeen','poolPrev'].map(k=>this.s.get(k)));
    // another request may have loaded it while this one waited
    if(!this.mem) this.mem={prev:prev||{}, mins:mins||{}, cache:cache||{}, meta:meta||{}, ev:ev||[], evStart:evStart??null, own:own||[], selfSeen:selfSeen||{}, poolPrev:poolPrev||{}};
    return this.mem;
  }
  async save(){
    const m=this.mem; if(!m) return;
    await this.s.put({prev:m.prev, mins:m.mins, cache:m.cache, meta:m.meta, ev:m.ev, evStart:m.evStart, own:m.own, selfSeen:m.selfSeen, poolPrev:m.poolPrev||{}});
    this.savedAt=Date.now();
  }

  async fetch(req){
    const u=new URL(req.url);
    if(u.pathname.startsWith('/auth/')) return this.auth(req,u);
    if(u.pathname==='/gapstick'){
      // asked on demand (the token-holder's "read now"), a reading under 30 s old is answered as is
      const via=u.searchParams.get('via')||'cron', last=await this.s.get('gapsRun');
      if(via==='ask' && last && last.ok && Date.now()-last.at<30000) return Response.json({...last, cached:true});
      return Response.json(await this.gapsRun(via));
    }
    if(u.pathname==='/gaps'){ const [G,run]=await Promise.all([this.s.get('gaps'), this.s.get('gapsRun')]);
      return Response.json({now:Date.now(), ...(G||{cfg:gapCfg(null), tok:{}}), run:run||null}); }
    if(u.pathname==='/gaps/cfg' && req.method==='POST'){
      let b={}; try{ b=JSON.parse(await req.text()); }catch(e){}
      const G=(await this.s.get('gaps'))||{tok:{}, blocked:{}};
      G.cfg=gapCfg({...(G.cfg||{}), ...b, venues:{...((G.cfg||{}).venues||{}), ...(b.venues||{})}, fees:{...((G.cfg||{}).fees||{}), ...(b.fees||{})}});
      await this.s.put('gaps',G); return Response.json({cfg:G.cfg});
    }
    if(u.pathname==='/tick'){
      // a failed minute is kept where /m can show it, instead of vanishing into the logs
      try{ const r=await this.tick(); await this.s.put('fail',null);
        // the gap reading has its own schedule; should that ever stop firing, the minute picks it up
        const g=await this.s.get('gapsRun'); if(!g||Date.now()-g.at>5*MIN) await this.gapsRun('minute');
        return Response.json(r); }
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
    const pairs={}; for(const p of (this.src&&this.src.ps)||[]) if(p.lbl&&p.s0&&p.s1) pairs[p.lbl]=[p.s0,p.s1];
    return Response.json({now:Date.now(), ...m.meta, fast, ...(fail?{fail}:{}), mins:rows, pairs, ...tradesOf(all, m.ev, m.evStart)});
  }

  // the dashboard's own position list and prices, refreshed every ten minutes
  async positions(){
    let src=this.src||await this.s.get('src');
    if(!src || Date.now()-src.at>10*MIN){
      try{
        const r=await fetch(this.env.SRC_URL+'?t='+Date.now(),{cf:{cacheTtl:0}});
        if(!r.ok) throw new Error('src HTTP '+r.status);
        src={at:Date.now(), ps:positionsFrom(await this.open(await r.json())), wallets:src&&src.wallets||{sol:[],eth:[]}, selfPend:src&&src.selfPend||[]};
        const base=this.env.SRC_URL.replace(/data-main\.json.*$/,'');
        try{ const c=await this.open(await (await fetch(base+'config.json?t='+Date.now(),{cf:{cacheTtl:0}})).json()), w=(c.profiles&&c.profiles[0]&&c.profiles[0].wallets)||[];
          src.wallets={sol:w.filter(x=>x.chain==='solana').map(x=>x.address), eth:w.filter(x=>x.chain==='ethereum').map(x=>String(x.address).toLowerCase())}; }catch(e){}
        try{ const c=await this.open(await (await fetch(base+'costs-main.json?t='+Date.now(),{cf:{cacheTtl:0}})).json()); if(Array.isArray(c.selfPend)) src.selfPend=c.selfPend; }catch(e){}
        await this.s.put('src',src);
        this.src=src; if(this.mem) this.reconcile(this.mem);
      }catch(e){ if(!src) throw e; }
    }
    this.src=src;
    return src.ps;
  }
  solRpcs(){ return this.env.SOL_RPC_URL?[this.env.SOL_RPC_URL,...SOL_RPCS]:SOL_RPCS; }
  /* The relay's files are sealed when the deck is locked (scripts/lock.mjs). This worker is given
     the derived key as the DECK_KEY secret, never the passphrase; a plain file passes through. */
  async open(j){
    if(!(j && j.lock===1 && j.iv && j.ct)) return j;
    if(!this.env.DECK_KEY) throw new Error('sealed file and no DECK_KEY');
    const b=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
    this.aes=this.aes||await crypto.subtle.importKey('raw', b(this.env.DECK_KEY), 'AES-GCM', false, ['decrypt']);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM', iv:b(j.iv)}, this.aes, b(j.ct))));
  }

  // the share of each pool's fees in this span that came from the deck's own swaps (0 to 1)
  async ownShare(pools, to){
    const out={}, W=(this.src&&this.src.wallets)||{sol:[],eth:[]};
    const sol=Object.entries(pools).filter(([,v])=>v.chain==='sol'), eth=Object.entries(pools).filter(([,v])=>v.chain==='eth');
    if(sol.length && W.sol.length){
      const from=Math.min(...sol.map(([,v])=>v.from)), rpcs=this.solRpcs();
      for(const w of W.sol){
        const sigs=await one(rpcs,'getSignaturesForAddress',[w,{limit:8,commitment:'confirmed'}]);
        for(const g of sigs||[]){ if(g.err||!g.blockTime) continue; const ts=g.blockTime*1000; if(ts<from-3000||ts>to+3000) continue;
          let keys=this.sigMemo.get(g.signature);
          if(keys===undefined){
            const tx=await one(rpcs,'getTransaction',[g.signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
            const all=[...((tx&&tx.transaction&&tx.transaction.message&&(tx.transaction.message.accountKeys||tx.transaction.message.staticAccountKeys))||[]),
              ...((tx&&tx.meta&&tx.meta.loadedAddresses&&tx.meta.loadedAddresses.writable)||[]),...((tx&&tx.meta&&tx.meta.loadedAddresses&&tx.meta.loadedAddresses.readonly)||[])];
            // a harvest or a deposit touches the pool too, but only a swap pays a fee into it
            keys=((tx&&tx.meta&&tx.meta.logMessages)||[]).some(l=>/Instruction: Swap/i.test(l))?all:[];
            this.sigMemo.set(g.signature,keys); if(this.sigMemo.size>400) this.sigMemo.delete(this.sigMemo.keys().next().value); }
          for(const [pl] of sol) if(keys.includes(pl)) out[pl]=1; } } }
    if(eth.length && W.eth.length){
      const latest=parseInt(await one(EVM_RPCS,'eth_blockNumber',[]),16);
      for(const [pl,v] of eth){
        const nb=Math.ceil((to-v.from)/12000)+2;
        const logs=await one(EVM_RPCS,'eth_getLogs',[{address:pl,topics:[SWAP_V3],fromBlock:'0x'+Math.max(0,latest-nb).toString(16),toBlock:'0x'+latest.toString(16)}]);
        let mine=0, tot=0;
        for(const lg of logs||[]){ tot++; let f=this.txMemo.get(lg.transactionHash);
          if(f===undefined){ const tx=await one(EVM_RPCS,'eth_getTransactionByHash',[lg.transactionHash]); f=String((tx&&tx.from)||'').toLowerCase();
            this.txMemo.set(lg.transactionHash,f); if(this.txMemo.size>400) this.txMemo.delete(this.txMemo.keys().next().value); }
          if(W.eth.includes(f)) mine++; }
        if(mine) out[pl]=mine/tot; } }
    return out;
  }

  /* The deck's access log, kept by its own instance of this class ('gate'), apart from the fee
     record. The front door has already checked the token (a failed passphrase is the one thing
     logged without it, at most 20 an hour from one address) and added what Cloudflare knows about
     the request: the address, and the city, region, country and network that address belongs to.
     A sign-in, a visit that opened with the key remembered on the device, a wrong passphrase, a
     device forgetting its key; every minute an open dashboard says it is still there, and a
     session is live while it does. A device can be signed out from another one: its next
     heartbeat is told so, and it forgets its key. */
  async auth(req,u){
    const A=this.acc||(this.acc=(await this.s.get('acc'))||{ev:[],ses:{},dev:{},rev:{},rate:{}});
    const now=Date.now(), save=()=>this.s.put('acc',A);
    if(u.pathname==='/auth/log'){
      for(const k in A.ses) if(now-A.ses[k].last>86400000) delete A.ses[k];
      const live=Object.values(A.ses).filter(x=>!x.bye && now-x.last<150000).sort((a,b)=>b.last-a.last);
      return Response.json({now, live, ev:A.ev.slice(-200).reverse(), dev:A.dev, rev:A.rev});
    }
    const b=await req.json().catch(()=>({})), who=b._who||{}, did=String(b.did||'').slice(0,40), sid=String(b.sid||'').slice(0,40);
    if(u.pathname==='/auth/revoke'){ if(did){ A.rev[did]=now; A.ev.push({t:now,type:'revoke',did,by:String(b.by||'').slice(0,40),ip:who.ip,loc:who.loc}); await save(); } return Response.json({ok:1}); }
    if(u.pathname==='/auth/name'){ if(did&&A.dev[did]){ A.dev[did].name=String(b.name||'').slice(0,40)||null; await save(); } return Response.json({ok:1}); }
    // /auth/ev
    const type=String(b.type||''); if(!['login','resume','fail','forget','beat','bye'].includes(type)) return Response.json({err:'type'},{status:400});
    if(type==='fail'){ const key=who.ip||'?', w=(A.rate[key]||[]).filter(t=>now-t<3600000); if(w.length>=20) return Response.json({err:'rate'},{status:429}); w.push(now); A.rate[key]=w;
      for(const k in A.rate) if(!A.rate[k].some(t=>now-t<3600000)) delete A.rate[k]; }
    const dev={...(b.dev||{})}; for(const k in dev) dev[k]=String(dev[k]).slice(0,80);
    const revoked=!!(did && A.rev[did] && type!=='login');
    if(type==='login' && did && A.rev[did]) delete A.rev[did];   // signing in again with the passphrase lifts a remote sign-out
    if(type!=='beat' && type!=='bye'){
      const fresh=!!(did && !A.dev[did] && type!=='fail');
      A.ev.push({t:now, type, did, sid, ip:who.ip, loc:who.loc, dev, ...(fresh?{fresh:1}:{})});
      if(A.ev.length>400) A.ev=A.ev.slice(-400);
    }
    if(did && type!=='fail'){ const d=A.dev[did]||(A.dev[did]={first:now, n:0}); d.last=now; d.dev=dev; d.ip=who.ip; d.loc=who.loc; if(type==='login'||type==='resume') d.n++; }
    if(sid && type!=='fail' && type!=='forget'){
      const x=A.ses[sid]||(A.ses[sid]={sid, did, start:now}); x.last=now; x.ip=who.ip; x.loc=who.loc; x.dev=dev; x.how=x.how||(type==='login'?'passphrase':type==='resume'?'remembered':x.how);
      if(type==='bye') x.bye=now; else delete x.bye;
    }
    if(sid && type==='forget' && A.ses[sid]) A.ses[sid].bye=now;
    await save();
    return Response.json({ok:1, ...(revoked?{revoked:1}:{})});
  }

  // the relay's exact own-swap fees settle what was taken out here (see SWAP_V3 above)
  reconcile(m){
    const S=this.src; if(!S||!Array.isArray(S.selfPend)) return;
    const now=Date.now();
    for(const x of S.selfPend){
      if(!x||!x.id||!(x.back>0)||m.selfSeen[x.id]) continue;
      if(!x.t||now-x.t>KEEP*MIN){ m.selfSeen[x.id]=now; continue; }
      const pool=x.chain==='sol'?String(x.pool):String(x.pool).toLowerCase(), p=S.ps.find(q=>q.pool===pool), lbl=p?(p.lbl||p.id):null;
      const recs=m.own.filter(r=>r[2]===pool && !r[5] && r[1]-5000<=x.t && r[0]+5000>=x.t);
      const took=recs.reduce((a,r)=>a+r[3],0); recs.forEach(r=>{ r[5]=1; });
      const delta=took-x.back;                       // above zero: too much was kept out; below: too little
      if(Math.abs(delta)>=0.0005) this.adjust(m,x.t,lbl,delta);
      m.selfSeen[x.id]=now;
    }
    for(const k of Object.keys(m.selfSeen)) if(now-m.selfSeen[k]>8*86400000) delete m.selfSeen[k];
  }
  // puts back (delta > 0) or takes out (delta < 0) a pool's fees at time t, in its minutes and its trade
  adjust(m,t,lbl,delta){
    const t0=Math.floor(t/MIN)*MIN; let left=delta;
    for(const tt of [t0,t0+MIN,t0-MIN,t0+2*MIN,t0-2*MIN]){
      if(Math.abs(left)<0.0005) break; const row=m.mins[tt]; if(!row) continue;
      if(left>0){ row[0]+=left; if(lbl){ row[2]=row[2]||{}; row[2][lbl]=(row[2][lbl]||0)+left; } left=0; break; }
      const avail=lbl&&row[2]&&row[2][lbl]!=null?row[2][lbl]:row[0], take=Math.min(-left,avail,row[0]); if(!(take>0)) continue;
      row[0]-=take; if(lbl&&row[2]&&row[2][lbl]!=null){ row[2][lbl]-=take; if(row[2][lbl]<0.0005) delete row[2][lbl]; } left+=take; }
    let d=delta;
    for(const ev of m.ev){ if(Math.abs(d)<0.0005) break; if(!(ev[1]-5000<=t && ev[0]+5000>=t)) continue;
      const pools=ev[3]||(ev[3]={});
      if(d>0){ ev[2]+=d; if(lbl) pools[lbl]=(pools[lbl]||0)+d; d=0; break; }
      const avail=lbl&&pools[lbl]!=null?pools[lbl]:ev[2], take=Math.min(-d,avail,ev[2]); if(!(take>0)) continue;
      ev[2]-=take; if(lbl&&pools[lbl]!=null){ pools[lbl]-=take; if(pools[lbl]<0.0005) delete pools[lbl]; } d+=take; }
    m.ev=m.ev.filter(ev=>ev[2]>=TRADE_MIN);
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
    // pools that earned anything in this reading, measured against the last one (nothing booked yet)
    const earning={};
    for(const p of ps){ const b=cur.g[p.id], a=m.prev[p.id];
      if(!b||!a||!(cur.t>a.t)||cur.t-a.t>MAX_SPAN*MIN) continue;
      const v=earned({g:{[p.id]:a.r}},{g:{[p.id]:b}},[p]).by[p.id];
      if(v>=0.0005){ const e=earning[p.pool]||(earning[p.pool]={chain:p.chain,from:a.t}); e.from=Math.min(e.from,a.t); } }
    let own={};
    if(Object.keys(earning).length){ try{ own=await this.ownShare(earning,cur.t); this.err.own=null; }catch(e){ this.err.own='own-swap check: '+String(e.message||e).slice(0,120); } }
    /* Each reading's fees are spread over the minutes it actually covers, in proportion to the
       time, so a reading that lands a few seconds either side of the minute neither double-fills
       one minute nor skips the next. The second number is coverage in position-minutes: a minute
       every position covered in full holds N. Nothing below awaits, so two readings never
       interleave here. */
    const {prev, mins}=m;
    let got=0, evUsd=0, evFrom=Infinity; const evPools={}, evSide={}, evPx={};
    /* each pool's price after this reading, and what traded through it since its last one ($) */
    m.poolPrev=m.poolPrev||{}; const traded={};
    for(const [pl,b] of Object.entries(cur.pools||{})){
      const p=ps.find(x=>x.pool===pl), a=m.poolPrev[pl], T=p?poolTraded(a,b):null;
      /* a pool that takes its fee in one fixed token: the price says which way it went (up, token1
         paid in; down, token0), and an unmoved price says nothing (null), not "both ways" */
      const dir=b.feeOn?(a&&a.P>0&&b.P>0&&b.P!==a.P?(b.P>a.P?1:0):null):undefined;
      traded[pl]={P:b.P, usd:T?T.in0*p.usd0+T.in1*p.usd1:null, dir};
      m.poolPrev[pl]=b; }
    for(const p of ps){
      const b=cur.g[p.id]; if(!b) continue;
      const a=prev[p.id];
      if(!a||!(cur.t>a.t)||cur.t-a.t>MAX_SPAN*MIN){ prev[p.id]={t:cur.t, r:b}; continue; }
      const e=earned({g:{[p.id]:a.r}}, {g:{[p.id]:b}}, [p]);
      // a reading from a node behind the last one is dropped; the newer reading stays the base
      if(!(p.id in e.by)) continue;
      prev[p.id]={t:cur.t, r:b};
      got++;
      const span=cur.t-a.t, k=p.lbl||p.id, sh=Math.min(1,Math.max(0,own[p.pool]||0)), mineV=e.by[p.id]*sh, v=e.by[p.id]-mineV;
      if(mineV>=0.0005) m.own.push([cur.t, a.t, p.pool, Math.round(mineV*1e6)/1e6, k]);
      for(let t=Math.floor(a.t/MIN)*MIN; t<cur.t; t+=MIN){
        const lo=Math.max(a.t,t), hi=Math.min(cur.t,t+MIN); if(!(hi>lo)) continue;
        const row=mins[t]||(mins[t]=[0,0]), part=v*(hi-lo)/span;
        row[0]+=part; row[1]+=(hi-lo)/MIN;
        // which pool it came from, so the dashboard can colour and list trades by pool
        if(part>=0.0005) (row[2]||(row[2]={}))[k]=(row[2][k]||0)+part;
      }
      evUsd+=v; evFrom=Math.min(evFrom,a.t); if(v>=0.0005) evPools[k]=(evPools[k]||0)+v;
      // the fee's token is the token sold, unless the pool takes its fee in one fixed token
      const dir=traded[p.pool]?traded[p.pool].dir:undefined, es=dir===undefined?e.side[p.id]:dir===null?null:(dir?[0,v]:[v,0]);
      if(v>=0.0005 && es){ const f=dir===undefined?1-sh:1, sd=evSide[k]||(evSide[k]=[0,0]); sd[0]+=es[0]*f; sd[1]+=es[1]*f; }
      // a pool with two positions of yours is one trade: its price and size are kept once
      if(v>=0.0005 && traded[p.pool] && !evPx[k]){ const x=traded[p.pool]; evPx[k]=[x.P, x.usd!=null?x.usd*(1-sh):null]; }
    }
    // the event log starts with the first reading that measured anything
    if(m.evStart==null && got) m.evStart=evFrom;
    if(evUsd>=TRADE_MIN){ const r=x=>Math.round(x*1e6)/1e6;
      m.ev.push([cur.t, evFrom, r(evUsd), Object.fromEntries(Object.entries(evPools).map(([k,v])=>[k,r(v)])),
                 Object.fromEntries(Object.entries(evSide).map(([k,v])=>[k,[r(v[0]),r(v[1])]])),
                 Object.fromEntries(Object.entries(evPx).map(([k,v])=>[k,[v[0], v[1]!=null?Math.round(v[1]*100)/100:null]]))]); }
    for(const c of chains) this.lastRead[c]=cur.t;
    // forget positions that are no longer listed, minutes older than a day, events older than three hours
    for(const id of Object.keys(prev)) if(!all.some(p=>p.id===id)) delete prev[id];
    const cut=Math.floor(cur.t/MIN)*MIN-KEEP*MIN;
    for(const t of Object.keys(mins)){ if(Number(t)<cut) delete mins[t]; else { const v=mins[t]; v[0]=Math.round(v[0]*1e6)/1e6; v[1]=Math.round(v[1]*100)/100;
      if(v[2]) for(const k in v[2]) v[2][k]=Math.round(v[2][k]*1e6)/1e6; } }
    const evCut=Math.max(cur.t-EV_KEEP, m.ev.length>EV_MAX?m.ev[m.ev.length-EV_MAX][0]:0);
    if(m.ev.length && m.ev[0][0]<evCut){ m.ev=m.ev.filter(x=>x[0]>=evCut); if(m.evStart!=null) m.evStart=Math.max(m.evStart,evCut); }
    m.own=m.own.filter(r=>cur.t-r[0]<26*60*MIN);
    if(this.src) this.reconcile(m);
    const fresh=Object.values(prev).filter(x=>cur.t-x.t<90000).length;
    // what has been kept out as the deck's own swaps: caught live, and settled against the relay's list
    const ownOut={live:m.own.length, liveUsd:Math.round(m.own.reduce((x,r)=>x+r[3],0)*100)/100, settled:Object.keys(m.selfSeen).length};
    // how many of each chain's pools this reading priced (counts only), so a pool left without a price shows
    const pools={...(m.meta.pools||{})};
    for(const c of chains){ const pl=[...new Set(ps.filter(p=>p.chain===c).map(p=>p.pool))];
      pools[c]=[pl.filter(x=>cur.pools&&cur.pools[x]&&cur.pools[x].P>0).length, pl.length]; }
    m.meta={N:all.length, last:Math.max(m.meta.last||0,cur.t), read:fresh, err:Object.values(this.err).filter(Boolean), ownOut, pools};
    return {slot:Math.floor(cur.t/MIN)*MIN, got, ...m.meta};
  }

  /* Price gaps, every two minutes (gaps.js): each token at every venue the owner can trade on, the
     best buy-here-sell-there edge after all costs, and how long it has held. Alongside, the owner's
     own pools: each token's price there (from this recorder's last reading of the pool) and the
     owner's share of the pool's active liquidity, since trading against one's own pool mostly moves
     one's own money. */
  /* One gap reading with its outcome kept, so /gaps can say when the last one ran and why it failed. */
  async gapsRun(via){
    const at=Date.now(); let run;
    try{ const r=await this.gapsTick(); run={at, ms:Date.now()-at, ok:true, via, tokens:r.tokens}; }
    catch(e){ run={at, ms:Date.now()-at, ok:false, via, err:String(e&&e.stack||e).slice(0,300)}; }
    await this.s.put('gapsRun',run); return run;
  }
  async gapsTick(){
    const now=Date.now();
    const G=(await this.s.get('gaps'))||{tok:{}, blocked:{}};
    G.cfg=gapCfg(G.cfg); G.blocked=G.blocked||{}; G.tok=G.tok||{};
    let ps=[]; try{ ps=await this.positions(); }catch(e){}
    const m=await this.load();
    const ownPools=new Set(ps.flatMap(p=>[p.pool, String(p.pool).toLowerCase()]));
    for(const sym of Object.keys(TOKENS)){
      let r; try{ r=await readToken(sym, G.cfg, ownPools, G.blocked, now); }catch(e){ r={quotes:[], errs:{all:String(e&&e.message||e).slice(0,80)}}; }
      const opps=opportunities(r.quotes, G.cfg.size), best=opps[0]||null;
      const priced=new Set(r.quotes.filter(q=>q.buyPx>0||q.sellPx>0).map(q=>q.id));
      const st=step(G.tok[sym]&&G.tok[sym].st, best, now, G.cfg, priced);
      let own=[]; try{ own=ownPoolsOf(sym, ps, m); }catch(e){}
      G.tok[sym]={t:now, quotes:r.quotes, errs:r.errs, ref:r.ref||null, qty:r.qty||null, best, opps:opps.slice(0,6), st, own};
    }
    G.t=now; await this.s.put('gaps',G);
    return {t:now, tokens:Object.keys(G.tok).length};
  }

  // the minute cron: reads whatever no watcher has read in the last 45 s, then saves
  async tick(){
    const now=Date.now(), chains=['eth','sol'].filter(c=>now-this.lastRead[c]>45000);
    const r=chains.length?await this.read(chains):{...(await this.load()).meta, fast:true};
    await this.save();
    return r;
  }
}

/* The owner's settings for the gap alert, kept within sensible bounds. */
function gapCfg(c){
  const d=DEFAULT_CFG, x=c||{}, num=(v,lo,hi,def)=>{ const n=Number(v); return isFinite(n)?Math.min(hi,Math.max(lo,n)):def; };
  return { size:num(x.size,50,100000,d.size), minNet:num(x.minNet,-5,50,d.minNet), holdMin:num(x.holdMin,0,240,d.holdMin),
    venues:Object.fromEntries(Object.keys(d.venues).map(v=>[v, x.venues&&typeof x.venues[v]==='boolean'?x.venues[v]:d.venues[v]])),
    fees:Object.fromEntries(Object.keys(d.fees).map(v=>[v, num(x.fees&&x.fees[v],0,5,d.fees[v])])) };
}
/* Each of the owner's pools holding `sym`: the token's dollar price there (from the pool's last
   reading by this recorder and the relay's price of the other token) and the owner's share of the
   liquidity trading at the current price (positions in range over the pool's active liquidity). */
function ownPoolsOf(sym, ps, m){
  const by=new Map();
  for(const p of ps){
    const i=String(p.s0||'').toUpperCase()===sym?0:String(p.s1||'').toUpperCase()===sym?1:-1; if(i<0) continue;
    const b=m.poolPrev&&m.poolPrev[p.pool]; if(!b||!(b.P>0)) continue;
    const e=by.get(p.pool)||{lbl:p.lbl, chain:p.chain, usd:i===0?b.P*p.usd1:p.usd0/b.P, mine:0n, L:BigInt(b.L||'0')};
    const r=m.prev&&m.prev[p.id]&&m.prev[p.id].r; if(p.inr&&r&&r.L) e.mine+=BigInt(r.L);
    by.set(p.pool,e);
  }
  return [...by.values()].map(e=>({lbl:e.lbl, chain:e.chain, usd:e.usd, share:e.L>0n?Math.min(1,Number(e.mine*10000n/e.L)/10000):null}));
}

export default {
  async scheduled(ev, env, ctx){
    const stub=env.PULSE.get(env.PULSE.idFromName('main'));
    ctx.waitUntil(stub.fetch('https://pulse/tick'));
    /* the price-gap reading, every even minute, as a request of its own so it never shares the
       minute's budget (a separate two-minute schedule never reached it in production) */
    if(Math.floor((ev.scheduledTime||Date.now())/60000)%2===0) ctx.waitUntil(stub.fetch('https://pulse/gapstick?via=cron'));
  },
  async fetch(req, env){
    const u=new URL(req.url);
    if(req.method==='OPTIONS') return new Response(null,{headers:{...cors,'access-control-allow-methods':'GET, POST'}});
    if(u.pathname.startsWith('/auth/')){
      /* the access log: everything needs the token except reporting a wrong passphrase */
      const ok=!env.PULSE_TOKEN || u.searchParams.get('k')===env.PULSE_TOKEN;
      let body=null; if(req.method==='POST'){ try{ body=JSON.parse(await req.text()); }catch(e){ body={}; } }
      if(!ok && !(u.pathname==='/auth/ev' && body && body.type==='fail')) return new Response('{"locked":1}',{status:403,headers:{...cors,'content-type':'application/json'}});
      const cf=req.cf||{}, who={ip:req.headers.get('cf-connecting-ip')||null,
        loc:{city:cf.city||null, region:cf.region||null, country:cf.country||null, lat:cf.latitude||null, lon:cf.longitude||null, tz:cf.timezone||null, asn:cf.asn||null, org:cf.asOrganization||null, colo:cf.colo||null}};
      const gate=env.PULSE.get(env.PULSE.idFromName('gate'));
      const r=await gate.fetch('https://gate'+u.pathname, req.method==='POST'?{method:'POST', body:JSON.stringify({...body, _who:who})}:{});
      return new Response(r.body,{status:r.status,headers:{...cors,'content-type':'application/json','cache-control':'no-store'}});
    }
    if(u.pathname==='/gaps'||u.pathname==='/gaps/cfg'||u.pathname==='/gaps/run'){
      if(env.PULSE_TOKEN && u.searchParams.get('k')!==env.PULSE_TOKEN) return new Response('{"locked":1}',{status:403,headers:{...cors,'content-type':'application/json'}});
      if(u.pathname!=='/gaps' && req.method!=='POST') return new Response('{"err":"POST"}',{status:405,headers:{...cors,'content-type':'application/json'}});
      const stub=env.PULSE.get(env.PULSE.idFromName('main'));
      const r=u.pathname==='/gaps/run'?await stub.fetch('https://pulse/gapstick?via=ask')
        :await stub.fetch('https://pulse'+u.pathname, req.method==='POST'?{method:'POST', body:await req.text()}:{});
      return new Response(r.body,{status:r.status,headers:{...cors,'content-type':'application/json','cache-control':'no-store'}});
    }
    if(u.pathname!=='/m') return new Response('Not found',{status:404,headers:cors});
    /* Locked deck: only a page that opened the lock knows the token (derived with the key). */
    if(env.PULSE_TOKEN && u.searchParams.get('k')!==env.PULSE_TOKEN) return new Response('{"locked":1}',{status:403,headers:{...cors,'content-type':'application/json'}});
    u.searchParams.delete('k');
    const stub=env.PULSE.get(env.PULSE.idFromName('main'));
    const r=await stub.fetch('https://pulse/m'+u.search);
    const live=u.searchParams.get('live')==='1';
    return new Response(r.body,{headers:{...cors,'content-type':'application/json','cache-control':live?'no-store':'public, max-age=20'}});
  },
};

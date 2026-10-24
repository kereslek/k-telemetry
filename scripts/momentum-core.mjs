/* Momentum, the arithmetic. Kept apart from the job that reads the sealed records and fetches the
   price histories (scripts/momentum.mjs), so every rule here can be tested on made-up records.

   The question it answers: how fast are your tokens and pools moving, how unusual is that, and how
   does it compare with the last time they ran like this.

   · The index counts market moves only. Each day it values what you held at the end of the day
     before at that day's prices, so money put in, taken out or spent never moves it: those change
     the amounts, and the index only ever looks at the prices.
   · A level is a move measured against its own usual size. The move of the last 3, 6 or 10 days is
     divided by the usual move of that length (the daily swing of the month before, scaled by the
     square root of the days); whichever of the three is most unusual counts, and every half a usual
     move is one step: ▲6 is three times the usual move, ▲10 five times or more.
   · A run starts at level 5 and ends at the turn: the first 5% fall from its top (a climb) or the
     first 5% bounce off its bottom (a fall). A climb that reached ▲6 ends in a sell signal; a fall
     that reached ▼6 and went below where the last climb began ends in a buy signal.
   · The reference point is the last top: the latest climb that reached ▲5 and turned (for a fall,
     the last bottom). Today's run is compared with it day by day from their first day up. */

export const STABLE=/^(usdt|usdc|dai|usde|pyusd|fdusd|tusd|usds|usdp|gusd|lusd|usdd|frax|usdc\.e|usdt0|usd1)$/i;
const WETH='evm:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', WSOL='sol:so11111111111111111111111111111111111111112';
/* wrapped ETH and SOL are the same asset as the coin itself: one key, so a move from the wallet into
   a pool does not read as one token sold and another bought */
export const canon=k=>k===WETH?'evm:native':k===WSOL?'sol:native':k;
export const SIG_MIN=0.004;          // a portfolio of mostly dollars must not turn a 0.1% move into ▲10
export const WINS=[3,6,10];
export const START=5, SIGNAL=6, TURN=0.05;

export const dayNum=d=>Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10))/864e5;
export const dayStr=n=>new Date(n*864e5).toISOString().slice(0,10);
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const r4=x=>x==null||!isFinite(x)?null:Math.round(x*1e4)/1e4;
const median=a=>{ const s=a.filter(x=>x!=null&&isFinite(x)).sort((x,y)=>x-y); if(!s.length) return null; const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };

/* What one day record held: amount, price and symbol per token, pools and wallets together. */
export function holdingsOf(rec){
  const m=new Map();
  const add=(k,s,a,u)=>{ if(!k||!(a>0)||!(u>0)) return; k=canon(k);
    const e=m.get(k)||{k,s:null,a:0,px:[]}; e.a+=a; e.px.push([a*u,u]); if(s&&s!=='?'&&!e.s) e.s=s; m.set(k,e); };
  for(const p of rec.ps||[]){ add(p.k0,p.s0,p.a0,p.u0); add(p.k1,p.s1,p.a1,p.u1); }
  for(const x of rec.w||[]) add(x.k,x.s,x.a,x.u);
  // one price per token a day: the one most of its value was read at
  for(const e of m.values()){ e.u=e.px.sort((x,y)=>y[0]-x[0])[0][1]; delete e.px;
    e.s=e.k==='evm:native'?'ETH':e.k==='sol:native'?'SOL':e.s||'?'; }
  return m;
}
export const isStable=(s,u)=>!!s&&STABLE.test(s)&&u>0.9&&u<1.1;

/* An outside daily price for a Budapest day: the reading nearest its close (midnight UTC after it). */
export const extAt=(ext,k,d)=>{ const e=ext&&ext[k]; if(!e) return null; return e[dayStr(dayNum(d)+1)]??e[d]??null; };

/* The index: 100 on the first day with holdings, then each day the return of the day before's
   holdings at this day's prices. A record price far from the outside one (a misread) gives way to
   it; a token with neither price that day is left out, and the share that was priced is kept. */
export function buildIndex(recs, ext={}){
  const use=recs.filter(r=>r&&r.d&&(Array.isArray(r.ps)||Array.isArray(r.w))).sort((a,b)=>a.d<b.d?-1:a.d>b.d?1:0);
  const H=use.map(holdingsOf), px=[];
  let misreads=0;
  use.forEach((r,j)=>{ const P=new Map();
    for(const [k,e] of H[j]){ let u=e.u; const x=extAt(ext,k,r.d);
      if(x>0 && Math.abs(Math.log(u/x))>Math.log(1.5)){ u=x; misreads++; }
      P.set(k,u); }
    px.push(P); });
  const priceOn=(j,k)=>px[j].get(k) ?? extAt(ext,k,use[j].d);
  const days=[]; let I=100;
  if(use.length) days.push({d:use[0].d, i:100, r:0, cov:1, H:H[0], P:px[0], first:true});
  for(let j=1;j<use.length;j++){
    let pnl=0, pv=0, V=0; const parts=new Map();
    for(const [k,e] of H[j-1]){ const p0=px[j-1].get(k), p1=priceOn(j,k); V+=e.a*(p0||0);
      if(!(p0>0&&p1>0)) continue;
      // a price that triples or thirds overnight with nothing outside to confirm it is a misread, not a market
      if(!(ext[k]) && Math.abs(Math.log(p1/p0))>Math.log(3)){ misreads++; continue; }
      pnl+=e.a*(p1-p0); pv+=e.a*p0; parts.set(k,{w:e.a*p0, r:p1/p0-1, s:e.s}); }
    const r=pv>0?pnl/pv:0, cov=V>0?pv/V:0, gap=Math.round(dayNum(use[j].d)-dayNum(use[j-1].d));
    // a missing day shares the move evenly with the day after it, so neither carries it all
    const step=gap>1?Math.pow(1+r,1/gap)-1:r;
    for(let g=1;g<gap;g++){ I*=1+step; days.push({d:dayStr(dayNum(use[j-1].d)+g), i:I, r:step, cov, filled:true}); }
    I*=1+step;
    for(const v of parts.values()) v.w=pv>0?v.w/pv:0;
    days.push({d:use[j].d, i:I, r:step, cov, H:H[j], P:px[j], parts});
  }
  return {days, misreads, records:use.length};
}

/* Levels on any daily series (the index, or one token's price). */
export function levels(vals){
  const n=vals.length, lr=vals.map((v,i)=>i&&v>0&&vals[i-1]>0?Math.log(v/vals[i-1]):null), out=[];
  for(let i=0;i<n;i++){
    const w=lr.slice(Math.max(1,i-32),Math.max(1,i-2)).filter(x=>x!=null);
    if(w.length<20||!(vals[i]>0)){ out.push({L:null}); continue; }
    const m=w.reduce((a,b)=>a+b,0)/w.length, sig=Math.max(SIG_MIN,Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/w.length));
    const z={}; let best=null, bn=null;
    for(const k of WINS){ if(i-k<0||!(vals[i-k]>0)) continue; z[k]=Math.log(vals[i]/vals[i-k])/(sig*Math.sqrt(k));
      if(best==null||Math.abs(z[k])>=Math.abs(best)){ best=z[k]; bn=k; } }
    if(best==null){ out.push({L:null}); continue; }
    const L=Math.sign(best)*Math.min(10,Math.floor(Math.abs(best)/0.5+1e-9));
    out.push({L, z:best, win:bn, z3:z[3]??null, sig});
  }
  return out;
}

/* Where a run began: the lowest point of the 15 days before (the highest, for a fall), moved on to the
   last day the run was still at that base, so day 0 is the day the climb left it rather than a quiet
   fortnight before. "At the base" is within a tenth of the whole move, or half a usual daily swing. */
export function runStart(vals, lv, i, up){
  let b=i; for(let j=Math.max(0,i-15);j<=i;j++) if(up?vals[j]<vals[b]:vals[j]>vals[b]) b=j;
  const move=Math.abs(vals[i]/vals[b]-1), tol=Math.max(0.5*((lv&&lv[i]&&lv[i].sig)||0.02), 0.1*move);
  const edge=up?vals[b]*(1+tol):vals[b]*(1-tol);
  let s=b; for(let j=b+1;j<=i;j++) if(up?vals[j]<=edge:vals[j]>=edge) s=j;
  return s;
}

/* Runs, one pass forward: a climb opens at ▲5 and closes at the turn (5% off its top), a fall opens
   at ▼5 and closes at the bounce (5% off its bottom). A climb that goes 20 days without a new top
   and without turning has faded; so has a fall. */
export function runs(vals, lv, ds){
  const out=[]; let cur=null, lastClimbStart=null;
  const startOf=(i,up)=>runStart(vals,lv,i,up);
  for(let i=0;i<vals.length;i++){
    const L=lv[i]?.L, v=vals[i];
    if(cur){
      if(cur.up){ if(v>cur.top){ cur.top=v; cur.topI=i; } if(L!=null&&L>cur.peak) cur.peak=L;
        if(v<=cur.top*(1-TURN)){ cur.end=i; cur.how='turn'; cur.signal=cur.peak>=SIGNAL; }
        else if(i-cur.topI>20){ cur.end=i; cur.how='faded'; } }
      else { if(v<cur.top){ cur.top=v; cur.topI=i; } if(L!=null&&L<cur.peak) cur.peak=L;
        if(v>=cur.top*(1+TURN)){ cur.end=i; cur.how='bounce';
          cur.signal=cur.peak<=-SIGNAL && (cur.below==null||cur.top<cur.below); }
        else if(i-cur.topI>20){ cur.end=i; cur.how='faded'; } }
      if(cur.end!=null){ out.push(cur); if(cur.up) lastClimbStart=vals[cur.start]; cur=null; continue; }
    }
    if(!cur && L!=null && Math.abs(L)>=START){
      const up=L>0, s=startOf(i,up);
      cur={up, start:s, open:i, top:v, topI:i, peak:L, end:null, how:null, signal:false, below:up?null:lastClimbStart};
      // the top or bottom so far may sit before the day the level got there
      for(let j=s;j<=i;j++) if(up?vals[j]>cur.top:vals[j]<cur.top){ cur.top=vals[j]; cur.topI=j; }
    }
  }
  if(cur) out.push(cur);
  return out.map(r=>({...r, d0:ds?ds[r.start]:r.start, dTop:ds?ds[r.topI]:r.topI, dEnd:r.end!=null&&ds?ds[r.end]:r.end}));
}

/* What came after a signal: the next 30 days against the day it fired. */
export function after(vals, r){
  if(r.end==null) return null;
  const v=vals[r.end], nxt=vals.slice(r.end+1, r.end+31);
  if(!nxt.length) return {days:0};
  const lo=Math.min(...nxt), hi=Math.max(...nxt);
  return r.up ? {days:nxt.length, low:r4(lo/v-1), high:r4(hi/v-1), back:hi>r.top}
              : {days:nxt.length, low:r4(lo/v-1), high:r4(hi/v-1), back:lo<r.top};
}

/* The five readings, each 0-10, for day i of a run in direction `up`: pace, days the right way,
   stretch from the 20-day average, speed-up, breadth (filled in by the caller when known). */
export function readings(vals, lv, i, up){
  const s=up?1:-1, x=lv[i]; if(!x||x.L==null) return null;
  const z3=x.z3??0, z3b=lv[i-3]?.z3??0;
  let n=0; for(let j=Math.max(1,i-5);j<=i;j++) if(s*(vals[j]-vals[j-1])>0) n++;
  const a=vals.slice(Math.max(0,i-19),i+1), sma=a.reduce((p,q)=>p+q,0)/a.length;
  const st=Math.log(vals[i]/sma), dz=s*z3-s*z3b;
  return { pace:r4(clamp(Math.abs(z3)*2,0,10)), paceX:r4(Math.abs(z3)), up:r4(n/6*10), upN:n,
    stretch:r4(clamp(s*st/(x.sig||SIG_MIN),0,10)), stretchP:r4(sma>0?vals[i]/sma-1:null),
    speed:r4(clamp(5+dz*1.25,0,10)), speedW:dz>0.5?'speeding up':dz<-0.5?'slowing':'steady' };
}
export function alike(a,b){
  const ks=['pace','up','stretch','speed','breadth'].filter(k=>a&&b&&a[k]!=null&&b[k]!=null);
  if(ks.length<3) return null;
  return Math.round(100*(1-ks.reduce((t,k)=>t+Math.abs(a[k]-b[k]),0)/ks.length/10));
}

/* How often each level comes, from a long series: runs per year reaching it, rises and falls apart. */
export function often(lv, days){
  const yrs=days/365.25, out={};
  for(let k=1;k<=10;k++) for(const s of [1,-1]){
    let n=0, on=false;
    for(const x of lv){ const hit=x&&x.L!=null&&s*x.L>=k; if(hit&&!on) n++; on=hit; }
    out[s*k]={n, perYear:r4(n/yrs)};
  }
  return out;
}

/* The long test: today's mix of tokens held through years of their own daily prices. Tokens with no
   price on a day count as cash that day, and how much of the mix was covered is said. */
export function mixTest(weights, ext, from, to){
  const keys=Object.keys(weights).filter(k=>ext[k]), out={vals:[], ds:[], cov:[]};
  let S=100;
  for(let n=dayNum(from); n<=dayNum(to); n++){
    const d=dayStr(n), p=dayStr(n-1); let r=0, c=0;
    for(const k of keys){ const a=ext[k][p], b=ext[k][d]; if(a>0&&b>0&&Math.abs(Math.log(b/a))<Math.log(3)){ r+=weights[k]*(b/a-1); c+=weights[k]; } }
    S*=1+r; out.vals.push(S); out.ds.push(d); out.cov.push(c);
  }
  return out;
}
export function summarize(rs, vals){
  const climbs=rs.filter(r=>r.up&&r.how==='turn'), sells=climbs.filter(r=>r.signal), falls=rs.filter(r=>!r.up&&r.how==='bounce'), buys=falls.filter(r=>r.signal);
  const pack=r=>({d0:r.d0, top:r.dTop, end:r.dEnd, peak:r.peak, signal:r.signal, ...after(vals,r)});
  const A=sells.map(r=>after(vals,r)).filter(a=>a&&a.days>=10), B=buys.map(r=>after(vals,r)).filter(a=>a&&a.days>=10);
  return { climbs:climbs.length, sells:sells.length, falls:falls.length, buys:buys.length,
    sell:{n:A.length, lowMed:r4(median(A.map(a=>a.low))), highMed:r4(median(A.map(a=>a.high))), back:A.filter(a=>a.back).length},
    buy:{n:B.length, highMed:r4(median(B.map(a=>a.high))), lowMed:r4(median(B.map(a=>a.low))), back:B.filter(a=>a.back).length},
    list:rs.filter(r=>r.how==='turn'||r.how==='bounce').slice(-12).map(pack) };
}

/* Everything the page shows, from the day records, the outside price histories and the last output
   (for the steady level). Nothing in here is an amount: the index starts at 100, tokens carry their
   share of the value, and every move is a ratio. */
export function analyze({recs, ext={}, prev=null, today=null, mixYears=3}){
  const {days, misreads, records}=buildIndex(recs, ext);
  const base={v:1, records, misreads};
  if(days.length<2) return {...base, status:'none', need:24};
  const vals=days.map(x=>x.i), ds=days.map(x=>x.d), lv=levels(vals), last=days.length-1;
  const raw=lv[last].L;
  // a level needs 20 daily moves before the last three to measure against: 24 days of records
  if(raw==null) return {...base, status:'short', have:days.length, need:Math.max(1,24-days.length), days:days.slice(-90).map(x=>({d:x.d, i:r4(x.i)}))};
  /* the level shown changes only once a new reading has held for two passes in a row */
  let L=raw, pend=null; const pn=prev&&prev.status==='ok'&&prev.now?prev.now:null;
  if(pn && pn.L!=null && raw!==pn.L){ if(pn.raw===raw) L=raw; else { L=pn.L; pend=raw; } }
  const rs=runs(vals, lv, ds), open=rs.find(r=>r.end==null)||null;
  const dir=open?(open.up?1:-1):(L>0?1:L<0?-1:1), up=dir>0;
  const startNow=open?open.start:runStart(vals, lv, last, up);
  const runDays=last-startNow;

  /* tokens: share of the value now, own level, move over 6 days, part of the index move */
  const lastH=(()=>{ for(let j=last;j>=0;j--) if(days[j].H) return j; return null; })();
  const priceAt=(j,k)=>{ for(let q=j;q>=Math.max(0,j-2);q--){ const p=days[q].P&&days[q].P.get(k); if(p>0) return p; } return extAt(ext,k,ds[j]); };
  const tokens=[];
  if(lastH!=null){ const H=days[lastH].H; let V=0; for(const e of H.values()) V+=e.a*(days[lastH].P.get(e.k)||0);
    for(const e of H.values()){ const u=days[lastH].P.get(e.k)||0, w=V>0?e.a*u/V:0;
      if(isStable(e.s,u)||w<0.02) continue;
      const lo=Math.max(0,last-60), ser=[]; for(let j=lo;j<=last;j++) ser.push(priceAt(j,e.k)||null);
      // a token's level needs a month of its own prices: the outside history gives it one when the records do not
      const pre=[]; if(ext[e.k]) for(let n=dayNum(ds[lo])-45;n<dayNum(ds[lo]);n++){ const p=ext[e.k][dayStr(n+1)]??ext[e.k][dayStr(n)]; if(p>0) pre.push(p); }
      const full=[...pre,...ser].map(x=>x>0?x:null), ok=full.map((x,i)=>x??full.slice(0,i).reverse().find(y=>y>0)??null);
      const tl=levels(ok), tL=tl[tl.length-1]?.L??null, n=ok.length-1;
      let c6=0; for(let j=Math.max(1,last-5);j<=last;j++){ const pt=days[j].parts&&days[j].parts.get(e.k); if(pt) c6+=pt.w*pt.r; }
      let upN=0; for(let j=Math.max(1,n-5);j<=n;j++) if(ok[j]>ok[j-1]) upN++;
      tokens.push({k:e.k, s:e.s, w:r4(w), L:tL, move6:n>=6&&ok[n-6]>0?r4(ok[n]/ok[n-6]-1):null, up6:upN, c6:r4(c6)}); }
    tokens.sort((a,b)=>b.w-a.w); }
  const breadthAt=i=>{ const same=[], all=[]; let ws=0, wa=0;
    for(const t of tokens){ const a=priceAt(Math.max(0,i-6),t.k), b=priceAt(i,t.k); if(!(a>0&&b>0)) continue;
      all.push(t.s); wa+=t.w; if(dir*(b/a-1)>0){ same.push(t.s); ws+=t.w; } }
    return all.length?{breadth:r4(wa>0?ws/wa*10:0), breadthN:[same.length, all.length]}:{}; };
  const read=readings(vals, lv, last, up); if(read) Object.assign(read, breadthAt(last));

  /* the reference point: the last finished run the same way — the last top for a climb */
  const pick=(list,want)=>{ const done=list.filter(r=>r.end!=null&&r.up===want&&(r.how==='turn'||r.how==='bounce')&&Math.abs(r.peak)>=START);
    return done.length?done[done.length-1]:null; };
  let ref=null; const own=pick(rs,up);
  const mk=(r,v,d,src,lvl)=>{ const len=Math.min(v.length-1-r.start, Math.max(r.end-r.start+5, 20));
    const path=[]; for(let j=0;j<=len;j++) path.push(r4(v[r.start+j]/v[r.start]-1));
    let rd=null; const at=r.start+runDays; if(at<v.length&&at<=r.end+5){ rd=readings(v,lvl,at,r.up); if(rd&&src==='own') Object.assign(rd, breadthAt(at)); }
    return {src, kind:r.up?'top':'bottom', d0:d[r.start], top:d[r.topI], end:d[r.end], peak:r.peak, signal:r.signal, topAt:r.topI-r.start, endAt:r.end-r.start, path, read:rd}; };
  if(own) ref=mk(own, vals, ds, 'own', lv);

  /* the long test: today's mix through years of its tokens' own prices */
  let test=null;
  const w={}; for(const t of tokens) if(ext[t.k]) w[t.k]=t.w;
  const covered=Object.values(w).reduce((a,b)=>a+b,0), held=tokens.reduce((a,t)=>a+t.w,0);
  const extDays=Object.values(ext).flatMap(e=>Object.keys(e)).sort();
  if(covered>0 && extDays.length){
    const to=today?dayStr(dayNum(today)-1):extDays[extDays.length-1], from=[dayStr(dayNum(to)-Math.round(mixYears*365.25)), extDays[0]].sort().pop();
    const M0=mixTest(w, ext, from, to);
    /* the test starts where at least 80% of the mix has prices: a token too young for the early years
       would otherwise sit in them as cash and make those years look calmer than they were */
    let s0=0; M0.cov.forEach((c,i)=>{ if(c<0.8*covered) s0=i+1; });
    const M={vals:M0.vals.slice(s0), ds:M0.ds.slice(s0)};
    if(M.vals.length>=120){
      const ml=levels(M.vals), mr=runs(M.vals, ml, M.ds);
      test={from:M.ds[0], to, days:M.vals.length, years:r4(M.vals.length/365.25), cov:r4(held>0?covered/held:0), ...summarize(mr, M.vals), often:often(ml, M.vals.length)};
      if(!ref){ const m=pick(mr,up); if(m) ref=mk(m, M.vals, M.ds, 'mix', ml); }
    }
  }
  const ownSum=summarize(rs, vals);
  const alikeNow=ref&&ref.read&&read?alike(read, ref.read):null;

  /* where today's run stands: its top or bottom so far, and how far from the turn */
  const run={start:ds[startNow], days:runDays, path:vals.slice(startNow).map(v=>r4(v/vals[startNow]-1))};
  if(open){ run.peak=open.peak; run.top=r4(open.top/vals[startNow]-1); run.topD=ds[open.topI];
    run.fromTop=r4(vals[last]/open.top-1); run.armed=open.up?open.peak>=SIGNAL:open.peak<=-SIGNAL; }
  const recent=rs.filter(r=>r.end!=null&&r.end>=last-3&&(r.how==='turn'||r.how==='bounce')).pop()||null;
  const fired=recent&&recent.signal?{kind:recent.up?'sell':'buy', d:ds[recent.end], peak:recent.peak, from:r4(vals[recent.end]/recent.top-1)}:null;

  /* six days of daily parts compound into the move; each token keeps its share of the compounding,
     so the parts add up to the move and "others" is only ever tokens outside the four shown */
  const all6=vals[last]/vals[Math.max(0,last-6)]-1; let sumR=0; for(let j=Math.max(1,last-5);j<=last;j++) sumR+=days[j].r||0;
  const k6=Math.abs(sumR)>1e-9?all6/sumR:1; for(const t of tokens) t.c6=r4((t.c6||0)*k6);
  const drv={win:6, all:r4(all6), parts:tokens.slice(0,4).map(t=>[t.s, t.c6])};
  const rest=r4(all6-drv.parts.reduce((a,p)=>a+(p[1]||0),0)); if(Math.abs(rest)>=0.001) drv.parts.push(['others', rest]);

  return {...base, status:'ok', now:{d:ds[last], live:today?ds[last]===today:null, L, raw, pend, z:r4(lv[last].z), win:lv[last].win, sig:r4(lv[last].sig),
      move6:r4(vals[last]/vals[Math.max(0,last-6)]-1), read, alike:alikeNow, dir},
    run, fired, ref, tok:tokens.map(({k,...t})=>t), drv, own:{climbs:ownSum.climbs, sells:ownSum.sells, falls:ownSum.falls, buys:ownSum.buys},
    test, cov:r4(median(days.slice(-30).map(x=>x.cov))),
    days:days.slice(-90).map((x,j,a)=>({d:x.d, i:r4(x.i), L:lv[days.length-a.length+j].L})) };
}

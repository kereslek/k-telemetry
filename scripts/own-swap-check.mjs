/* Own swaps through the deck's own pools, checked with the minute recorder (activity-audit.mjs).

   A swap of the deck's own through one of its pools pays its fee into the deck's own positions. The
   relay books that fee as it lands and takes it back out (the swap's `back`) a pass or two later. In
   between, other traders keep paying fees into the same positions, so the dip a deduction leaves in
   the booked total is smaller than the deduction, and can vanish. Comparing the dips with the
   deductions therefore says little on a busy day. The minute recorder measures what landed in the
   positions from the chain, minute by minute, independently of the relay, so over readings that
   start before a swap and end after its deduction

       taken out = what the recorder measured landing - how much the booked total rose

   and that must equal the swaps' `back`: other traders' fees are on both sides and cancel. More taken
   out than that is fees lost; less is the deck's own money still counted as income. (The recorder
   keeps the own swaps' part out of its minutes, settled to the relay's `back` within half an hour, so
   it is added back here.)

   Each stretch is widened until its first and last readings fall where the recorder saw no fees for
   ten minutes, so it does not matter that the relay stamps a reading a few minutes after it read the
   chain. Pure: no I/O, no amounts printed; tested by own-swap-check.test.mjs. */
const MIN=60000;

/* hist:  [[t, {positionId: booked running total}]], the relay's readings (fees ledger posHist), for one
          pool's positions
   fees:  Map minute start (ms) -> fees the recorder measured for that pool in that minute (own swaps'
          part kept out); minutes it read with nothing earned may be absent
   read:  Set of minute starts the recorder read at all (a missing one is a gap in its record)
   swaps: [{t, at, back, applied}] the deck's own swaps through that pool: when made, when the relay
          queued its fee, the fee that came back, and whether the relay has taken it out yet */
export function ownSwapCheck({hist, fees, read, swaps, now, quietMin=10, settleMin=30}){
  const H=(hist||[]).filter(x=>x&&x[1]).sort((a,b)=>a[0]-b[0]);
  const settled=x=>x.applied && x.back>0 && now-x.at>=settleMin*MIN;
  const out={n:0, recent:(swaps||[]).filter(x=>x.back>0&&!settled(x)).length, unplaced:0,
             taken:0, expected:0, dips:0, other:0, gapMin:0, busyEdge:0};
  const S=(swaps||[]).filter(settled);
  if(H.length<2||!S.length) return out;
  // the booked change from one reading to the next, over the positions present in both
  const d=[0]; for(let j=1;j<H.length;j++){ let s=0; for(const id in H[j][1]) if(H[j-1][1][id]!=null) s+=H[j][1][id]-H[j-1][1][id]; d.push(s); }
  // the recorder's fees between two moments, a minute's fees spread evenly over the minute
  const feeIn=(a,b)=>{ let s=0; for(let m=Math.floor(a/MIN)*MIN; m<b; m+=MIN){ const v=fees.get(m); if(v) s+=v*(Math.min(b,m+MIN)-Math.max(a,m))/MIN; } return s; };
  // a reading is a clean edge when nothing landed in the ten minutes before it: no fee, no own swap,
  // and every one of those minutes read (a minute the recorder missed is unknown, not quiet)
  const quiet=j=>{ const s=H[j][0];
    for(let m=Math.floor((s-quietMin*MIN)/MIN)*MIN; m<=s; m+=MIN) if(!read.has(m)) return false;
    return feeIn(s-quietMin*MIN, s+MIN)<=0.005 && !(swaps||[]).some(x=>x.t>=s-quietMin*MIN&&x.t<=s+MIN); };
  // each swap's stretch: from a reading made before it to the reading that took its fee back out
  const W=[];
  for(const x of S){
    let a=-1; for(let j=0;j<H.length;j++) if(H[j][0]<=x.t-quietMin*MIN) a=j;
    let b=H.findIndex(h=>h[0]>x.at);
    if(a<0||b<0||b<=a){ out.unplaced++; continue; }
    while(a>0 && !quiet(a)) a--;
    while(b<H.length-1 && !quiet(b)) b++;
    W.push([a,b]);
  }
  W.sort((p,q)=>p[0]-q[0]);
  const M=[]; for(const w of W){ const l=M[M.length-1]; if(l&&w[0]<=l[1]) l[1]=Math.max(l[1],w[1]); else M.push([...w]); }
  for(const [a,b] of M){
    const t0=H[a][0], t1=H[b][0], inS=(swaps||[]).filter(x=>x.back>0&&x.t>t0&&x.t<=t1);
    // a swap inside the stretch that is not settled yet would count as not taken out: all wait for it
    if(inS.some(x=>!settled(x))){ out.recent+=inS.filter(settled).length; continue; }
    let booked=0, dips=0; for(let j=a+1;j<=b;j++){ booked+=d[j]; if(d[j]<0) dips-=d[j]; }
    const other=feeIn(t0,t1), back=inS.reduce((s,x)=>s+x.back,0);
    out.n+=inS.length; out.expected+=back; out.taken+=other+back-booked; out.dips+=dips; out.other+=other;
    for(let m=Math.floor(t0/MIN)*MIN; m<t1; m+=MIN) if(!read.has(m)) out.gapMin++;
    if(!quiet(a)) out.busyEdge++; if(!quiet(b)) out.busyEdge++;
  }
  return out;
}

/* The verdict, in words and ratios only. Prices differ a little between the relay's reading and the
   recorder's minute, so the two may part by a few percent of the fees that landed meanwhile, and the
   relay keeps its totals in cents. */
export function ownSwapVerdict(r){
  if(!r.n) return null;
  const tol=Math.max(0.25, 0.03*r.other+0.02*r.expected), diff=r.taken-r.expected, pct=x=>Math.round(x*100)+'%';
  const unsure=r.gapMin>0||r.busyEdge>0;
  const st=Math.abs(diff)<=tol?'ok  ':unsure?'note':'WARN';
  const what=Math.abs(diff)<=tol?'all taken back out of your fees':diff>0?'MORE came out of your fees than they paid in: fees lost':'LESS came out of your fees than they paid in: part of your own money still counted as income';
  // the allowance itself is never printed: at its floor it would give away what the swaps paid in
  return st+' '+r.n+' own swap(s) through one of your pools: '+what+' (taken out '+pct(r.taken/r.expected)+' of what they paid in'
    +', once the other traders’ fees that landed in the same readings are counted; the dips alone showed '+pct(r.dips/r.expected)+')'
    +(r.gapMin?' · the recorder has '+r.gapMin+' unread minute(s) in those readings, so this cannot be exact':'')
    +(r.busyEdge?' · '+r.busyEdge+' edge(s) fell in the middle of trading: checked again on the next run':'');
}

/* Today's own swaps, pool by pool, from the relay's files and the recorder's minutes, as the audit's
   lines. `rec` is the recorder's own position list (sampler.js positionsFrom on the relay's data), so
   the pools are grouped and labelled exactly as the recorder groups them, and a minute counts as
   read only when the recorder read every one of those positions in it. */
export function ownSwapLines({posHist, selfDone, selfPend, rec, rows, start, now, normId=x=>x}){
  const keyOf=p=>p.lbl||p.id, poolKey=(chain,pool)=>chain==='sol'?String(pool):String(pool).toLowerCase();
  const lblOfPool=new Map(rec.map(p=>[poolKey(p.chain,p.pool), keyOf(p)]));
  const idsOf=new Map(); for(const p of rec){ const k=keyOf(p); idsOf.set(k,[...(idsOf.get(k)||[]), String(p.id)]); }
  const read=new Set((rows||[]).filter(r=>r[2]>=rec.length-0.05).map(r=>r[0]));
  const done=new Set((selfDone||[]).map(normId)), swapsBy=new Map();
  for(const x of selfPend||[]){ if(!x||!(x.back>0)||!(x.t>=start)) continue;
    const k=lblOfPool.get(poolKey(x.chain,x.pool)); if(!k) continue;
    swapsBy.set(k,[...(swapsBy.get(k)||[]), {t:x.t, at:x.at, back:x.back, applied:done.has(normId(x.id))}]); }
  if(!swapsBy.size) return [];
  if(!(rows||[]).length) return ['note the minute recorder could not be read: own swaps through your pools not checked this run'];
  const lines=[];
  for(const [k,sw] of swapsBy){
    const ids=idsOf.get(k)||[], fm=new Map(); for(const r of rows) if(r[3]&&r[3][k]>0) fm.set(r[0], r[3][k]);
    const hist=(posHist||[]).filter(x=>x[0]>=start-6*3600e3).map(x=>[x[0], Object.fromEntries(ids.filter(id=>x[1][id]!=null).map(id=>[id,x[1][id]]))]);
    const r=ownSwapCheck({hist, fees:fm, read, swaps:sw, now}), v=ownSwapVerdict(r);
    if(v) lines.push(v);
    if(r.recent) lines.push('     '+r.recent+' own swap(s) there waiting for the next run: a swap in those readings is under half an hour old');
    if(r.unplaced) lines.push('     '+r.unplaced+' own swap(s) there outside the relay’s readings: not checked');
  }
  return lines;
}

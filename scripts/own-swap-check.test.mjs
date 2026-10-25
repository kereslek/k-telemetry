/* own-swap-check.mjs on made-up days: a relay that reads the chain every seven minutes and stamps
   the reading three minutes later, a recorder that reads every minute, other traders paying fees
   at random minutes and the deck's own swaps taken back out a pass later. Every case is checked
   against the answer it must give. Run: node scripts/own-swap-check.test.mjs */
import { ownSwapCheck, ownSwapVerdict } from './own-swap-check.mjs';

const MIN=60000, T0=Date.UTC(2026,9,25,0,0);
let fails=0; const ok=(c,m)=>{ console.log((c?'ok    ':'FAIL  ')+m); if(!c) fails++; };
function rnd(seed){ let s=seed>>>0; return ()=>((s=Math.imul(s^(s>>>15),2246822507)^Math.imul(s^(s>>>13),3266489909))>>>0)/2**32; }

/* A day. `own`: [{min, back, landed}] own swaps (landed: what really came into the positions).
   `fault`: how the relay misbehaves, if at all. `noise`: the relay's price against the recorder's. */
function day({seed=1, own=[], fault=null, noise=0, busyMin=[], gap=null, endAt=24*60}){
  const R=rnd(seed), trades=new Map();
  for(let m=0;m<endAt;m++) if(R()<0.12) trades.set(m, 0.2+R()*6);         // other traders' fees, $
  for(const m of busyMin) trades.set(m,(trades.get(m)||0)+3);
  for(const x of own) for(let m=x.min-12;m<=x.min+12;m++) if(m!==x.min&&R()<0.5) trades.set(m,(trades.get(m)||0)+1+R()*4);   // bots answering it
  const landed=m=>(trades.get(m)||0)+own.filter(x=>x.min===m).reduce((s,x)=>s+(x.landed??x.back),0);
  // the recorder: everything that landed, the own swaps' `back` kept out, a gap if asked for
  const fees=new Map(), read=new Set();
  for(let m=0;m<endAt;m++){ if(gap&&m>=gap[0]&&m<gap[1]) continue; read.add(T0+m*MIN);
    const v=landed(m)-own.filter(x=>x.min===m).reduce((s,x)=>s+x.back,0); if(v>0.0005) fees.set(T0+m*MIN, v); }
  // the relay: reads at r, stamps at r+3, queues an own swap's fee a minute after the reading that saw it,
  // takes it out on the next pass
  const hist=[], swaps=own.map(x=>({t:T0+x.min*MIN+20000, at:null, back:x.back, applied:false}));
  let run={A:100, B:50}, lastRead=-1, k=0;
  for(let r=0; r+3<endAt; r+=7, k++){
    let got=0; for(let m=lastRead+1;m<=r;m++) got+=landed(m);
    if(fault==='lost'&&k===40) got=Math.max(0,got-5);                       // a pass that drops $5 of fees
    const px=1+noise*(R()*2-1);
    run.A+=got*0.7*px; run.B+=got*0.3*px;
    for(const x of swaps) if(x.at!=null&&!x.applied&&x.at<T0+(r+3)*MIN){
      const n=fault==='twice'?2:fault==='never'?0:1; run.A-=x.back*0.7*n; run.B-=x.back*0.3*n; x.applied=true; }
    hist.push([T0+(r+3)*MIN, {...run}]);
    for(const x of swaps) if(x.at==null&&x.t<=T0+r*MIN) x.at=T0+(r+4)*MIN;
    lastRead=r;
  }
  return {hist, fees, read, swaps, now:T0+endAt*MIN};
}
const own3=[{min:470, back:12}, {min:800, back:20}, {min:805, back:8}];

{ const r=ownSwapCheck(day({own:own3})), v=ownSwapVerdict(r);
  ok(r.n===3 && Math.abs(r.taken-r.expected)<1e-6, 'done right: all three taken out exactly ('+(r.taken/r.expected*100).toFixed(2)+'%)');
  ok(r.dips<r.expected*0.95, 'and the dips alone fall short of it, as the bots’ fees fill them ('+Math.round(r.dips/r.expected*100)+'%)');
  ok(/^ok /.test(v), 'verdict: '+v); }
{ const r=ownSwapCheck(day({own:own3, noise:0.01})), v=ownSwapVerdict(r);
  ok(/^ok /.test(v), 'prices 1% apart between relay and recorder still pass: '+Math.round(r.taken/r.expected*100)+'%'); }
{ const r=ownSwapCheck(day({own:own3, fault:'twice'})), v=ownSwapVerdict(r);
  ok(/^WARN .*fees lost/.test(v) && Math.round(r.taken/r.expected*100)===200, 'taken out twice: fees lost, 200%'); }
{ const r=ownSwapCheck(day({own:own3, fault:'never'})), v=ownSwapVerdict(r);
  ok(/^WARN .*counted as income/.test(v) && Math.abs(r.taken)<1e-6, 'never taken out: own money counted as income, 0%'); }
{ const r=ownSwapCheck(day({own:[{min:290, back:15}], fault:'lost'})), v=ownSwapVerdict(r);
  ok(/^WARN .*fees lost/.test(v), 'a pass that drops fees inside the stretch: fees lost ('+Math.round(r.taken/r.expected*100)+'%)'); }
{ const r=ownSwapCheck(day({own:own3.map(x=>({...x, landed:x.back*1.3}))})), v=ownSwapVerdict(r);
  ok(/^ok /.test(v), 'the relay’s `back` 30% off what really landed: still exact, since the recorder keeps the same `back` out (that estimate is the swap replay’s to check)'); }
{ const r=ownSwapCheck(day({own:own3, gap:[795,830]})), v=ownSwapVerdict(r);
  ok(r.gapMin>0 && /^(ok|note) /.test(v) && (/^ok /.test(v)||/cannot be exact/.test(v)), 'a hole in the recorder: the stretch reaches past it or says so, never blames the relay ('+r.gapMin+' unread minute(s) inside; '+v.slice(0,4).trim()+')'); }
{ const D=day({own:[{min:1380, back:10}], endAt:1400}), r=ownSwapCheck(D);
  ok(r.n===0 && r.recent===1, 'a swap whose fee was queued under half an hour ago waits for the next run'); }
{ const D=day({own:[{min:1300, back:10}], busyMin:Array.from({length:75},(_,i)=>1325+i), endAt:1400}), r=ownSwapCheck(D), v=ownSwapVerdict(r);
  ok(r.busyEdge>=1 && !/^WARN/.test(v||'WARN'), 'the last reading in the middle of trading: noted, not a warning ('+(v||'').slice(0,40)+'…)'); }
{ const r=ownSwapCheck(day({own:[]}));
  ok(r.n===0 && ownSwapVerdict(r)===null, 'no own swaps: nothing to say'); }

/* The whole path the audit takes (ownSwapLines): made-up relay files and recorder minutes in their
   real shapes, two pools with their own labels, one with the deck's own swaps. */
{ const { ownSwapLines } = await import('./own-swap-check.mjs');
  const D=day({own:own3}), lbl='SOL / CPOOL 4%', other='LCX / ETH 0.3%';
  const rec=[{id:'sol:A', chain:'sol', pool:'PoolSol1', lbl}, {id:'sol:B', chain:'sol', pool:'PoolSol1', lbl},
             {id:'777', chain:'eth', pool:'0xabc', lbl:other}];
  const posHist=D.hist.map(([t,v])=>[t, {'sol:A':v.A, 'sol:B':v.B, '777':10}]);
  const rows=[...D.read].sort((a,b)=>a-b).map(t=>{ const f=D.fees.get(t); return f?[t, f+0.01, 3, {[lbl]:f, [other]:0.01}]:[t, 0, 3]; });
  const selfPend=D.swaps.map((x,i)=>({id:'sol:sig'+i+':PoolSol1', chain:'sol', pool:'PoolSol1', t:x.t, at:x.at, back:x.back}));
  const selfDone=D.swaps.filter(x=>x.applied).map((x,i)=>'sol:sig'+i+':PoolSol1');
  const L=ownSwapLines({posHist, selfDone, selfPend, rec, rows, start:T0, now:D.now});
  ok(L.length===1 && /^ok +3 own swap/.test(L[0]), 'the audit’s path, real shapes: '+(L[0]||'').slice(0,70)+'…');
  const thin=rows.map(r=>r[0]>=T0+790*MIN&&r[0]<T0+800*MIN?[r[0], r[1], 2.4, r[3]]:r);   // one position unread for ten minutes
  const L2=ownSwapLines({posHist, selfDone, selfPend, rec, rows:thin, start:T0, now:D.now});
  ok(L2.length===1 && /^(ok|note) /.test(L2[0]), 'a minute the recorder read only partly is not taken as read: '+L2[0].slice(0,5).trim());
  ok(ownSwapLines({posHist, selfDone, selfPend, rec, rows:[], start:T0, now:D.now})[0].startsWith('note the minute recorder could not be read'), 'recorder unreachable: said, nothing checked');
  ok(ownSwapLines({posHist, selfDone, selfPend:[], rec, rows, start:T0, now:D.now}).length===0, 'no own swaps today: no line'); }
console.log(fails?fails+' FAILED':'all passed, the audit’s path included');
process.exit(fails?1:0);

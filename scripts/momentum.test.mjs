// Momentum on made-up day records: node scripts/momentum.test.mjs
// Money in and out must not move the index, a misread price must not either, a steep climb must read
// high and end in a sell signal at the turn, and the level shown must change only once it holds.
import { buildIndex, levels, runs, analyze, holdingsOf, often, dayStr, dayNum } from './momentum-core.mjs';
let fails=0; const ok=(c,m)=>{ if(!c) fails++; console.log((c?'ok    ':'FAIL  ')+m); };
const near=(a,b,t=1e-9)=>Math.abs(a-b)<=t;

/* a made-up market: TKA drifts, runs up 9 days, turns, falls, rests, then climbs again; ETH wanders */
const D0=dayNum('2026-07-20'), N=96, rnd=(i,s)=>{ const x=Math.sin(i*12.9898+s)*43758.5453; return x-Math.floor(x); };
const tka=[], eth=[]; let a=1, e=2500;
for(let i=0;i<N;i++){ const d=dayStr(D0+i);
  let r=(rnd(i,1)-0.5)*0.03;
  if(d>='2026-09-28'&&d<='2026-10-06') r=0.06; else if(d>='2026-10-07'&&d<='2026-10-13') r=-0.05; else if(d>='2026-10-17') r=0.045;
  a*=1+r; e*=1+(rnd(i,2)-0.5)*0.02; tka.push(a); eth.push(e); }
const ext={'evm:0xaaa':{}, 'evm:native':{}};
for(let i=-1200;i<N;i++){ const d=dayStr(D0+i+1), j=Math.max(0,i);   // the outside price at midnight UTC after each day
  ext['evm:0xaaa'][d]=i<0?tka[0]*(1+0.25*Math.sin(i/37))*(1+(rnd(i,3)-0.5)*0.02):tka[j]; ext['evm:native'][d]=i<0?eth[0]:eth[j]; }
// one big made-up climb far back, so the long test has a top to find
for(let i=-700;i<-690;i++) ext['evm:0xaaa'][dayStr(D0+i+1)]*=Math.pow(1.07,i+701);
for(let i=-690;i<-600;i++) ext['evm:0xaaa'][dayStr(D0+i+1)]*=Math.pow(1.07,10)*Math.pow(0.97,Math.min(10,i+690));

function recsWith({deposit=false, spend=false, misread=false, gap=false}={}){
  const out=[];
  for(let i=0;i<N;i++){ const d=dayStr(D0+i); if(gap&&d==='2026-09-01') continue;
    let qa=50000, qe=3, qu=2000;
    if(deposit&&d>='2026-09-10') qa*=1.5;            // more TKA put in
    if(spend&&d>='2026-10-02') { qe=2.5; qu=1500; }  // ETH and dollars spent
    const ua=misread&&d==='2026-09-20'?tka[i]*4:tka[i];
    out.push({d, t:Date.UTC(2026,6,20+i,21,50),
      ps:[{i:'1', k0:'evm:0xaaa', k1:'evm:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', s0:'TKA', s1:'WETH', a0:qa*0.6, a1:1, u0:tka[i], u1:eth[i]}],
      w:[{k:'evm:0xaaa', s:'TKA', a:qa*0.4, u:ua}, {k:'evm:native', s:'ETH', a:qe, u:eth[i]}, {k:'evm:0xusd', s:'USDC', a:qu, u:1}]});
  }
  return out;
}
const plain=buildIndex(recsWith(), ext), withFlows=buildIndex(recsWith({deposit:true, spend:true}), ext);
const same=plain.days.every((x,i)=>near(x.i, withFlows.days[i].i, 1e-6));
ok(plain.days.length===N, 'the index has one value a day ('+plain.days.length+' days)');
ok(!same, 'with different holdings the index differs (the weights move), as it should');
// money in and out only: same prices, so a deposit of TKA at the same price must leave a flat day flat
{ const flat=[...Array(40)].map((_,i)=>({d:dayStr(D0+i), w:[{k:'evm:x', s:'TKX', a:i<20?100:250, u:2}, {k:'evm:y', s:'USDC', a:i===30?10:500, u:1}]}));
  const bi=buildIndex(flat, {}); ok(bi.days.every(x=>near(x.i,100,1e-9)), 'a deposit and a withdrawal at unchanged prices leave the index at 100'); }
{ const mis=buildIndex(recsWith({misread:true}), ext), j=mis.days.findIndex(x=>x.d==='2026-09-20');
  ok(Math.abs(mis.days[j].r)<0.2 && mis.misreads>0, 'a wallet price read 4x the market for a day is replaced by the outside price (move that day '+(mis.days[j].r*100).toFixed(1)+'%, misreads '+mis.misreads+')'); }
{ const g=buildIndex(recsWith({gap:true}), ext), j=g.days.findIndex(x=>x.d==='2026-09-01');
  ok(j>0 && g.days[j].filled && g.days.length===N, 'a missing day is filled by sharing the next day\'s move'); }
{ const h=holdingsOf(recsWith()[0]); ok(h.has('evm:native') && !h.has('evm:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') && Math.abs(h.get('evm:native').a-4)<1e-9, 'wrapped ETH in a pool and ETH in a wallet count as one token'); }

const vals=plain.days.map(x=>x.i), ds=plain.days.map(x=>x.d), lv=levels(vals);
const at=d=>lv[ds.indexOf(d)].L;
ok(lv.slice(0,23).every(x=>x.L==null) && lv[23].L!=null, 'no level until 20 daily moves are there to measure against');
const peak=Math.max(...ds.map((d,i)=>d>='2026-09-28'&&d<='2026-10-07'?lv[i].L??-99:-99));
ok(peak>=7, 'the steep nine-day climb reads ▲'+peak+' at its height');
const calm=ds.map((d,i)=>d>='2026-08-25'&&d<='2026-09-20'?Math.abs(lv[i].L??0):0);
ok(Math.max(...calm)<=4, 'the quiet weeks stay at or below level 4 (highest '+Math.max(...calm)+')');
const rs=runs(vals, lv, ds), top=rs.find(r=>r.up&&r.how==='turn');
ok(!!top && top.signal && top.dTop==='2026-10-06' && top.dEnd>'2026-10-06' && top.dEnd<='2026-10-09', 'the climb ends at the turn within days of its top, with a sell signal (top '+(top&&top.dTop)+', turn '+(top&&top.dEnd)+')');
const fall=rs.find(r=>!r.up&&r.dTop>'2026-10-06');
ok(!fall || fall.d0>='2026-10-06', 'the fall after the top starts from the top, not inside the climb ('+(fall?fall.d0:'none')+')');

const out=analyze({recs:recsWith({deposit:true, spend:true}), ext, today:ds[ds.length-1]});
ok(out.status==='ok' && out.now.L>=5 && out.now.dir===1, 'today reads as a climb: ▲'+out.now.L);
ok(out.ref && out.ref.src==='own' && out.ref.top==='2026-10-06' && out.ref.kind==='top', 'the reference point is the last top: '+(out.ref&&out.ref.top));
ok(out.alike!=null||out.now.alike!=null, 'today is compared with it at the same stage: '+out.now.alike+'% alike');
ok(out.tok.length===2 && out.tok[0].s==='TKA' && out.tok[0].L!=null, 'each token has its own level: '+out.tok.map(t=>t.s+' '+(t.L>0?'▲':t.L<0?'▼':'')+Math.abs(t.L)).join(', '));
const sum=out.drv.parts.reduce((a,p)=>a+p[1],0);
ok(Math.abs(sum-out.drv.all)<0.002, 'what drove the 6 days adds up to the move ('+(out.drv.all*100).toFixed(1)+'%)');
ok(out.test && out.test.years>=3 && out.test.sells>=1 && out.test.often[6].n>=1, 'the long test runs today\'s mix through '+(out.test&&out.test.years)+' years and finds the made-up top ('+(out.test&&out.test.sells)+' sell signal(s))');
const txt=JSON.stringify(out);
ok(!/"a":|"u":|"V":|"H":|"P":|0xaaa/.test(txt) && /"v":1/.test(txt), 'the output carries no amounts, prices of holdings or token addresses (its own version field is fine)');

// the shown level waits for a new reading to hold twice
const prev={status:'ok', now:{L:out.now.L-1, raw:out.now.L-1}};
const o1=analyze({recs:recsWith({deposit:true, spend:true}), ext, prev, today:ds[ds.length-1]});
ok(o1.now.L===out.now.L-1 && o1.now.pend===out.now.L, 'a new level is held back once (shown '+o1.now.L+', waiting '+o1.now.pend+')');
const o2=analyze({recs:recsWith({deposit:true, spend:true}), ext, prev:o1, today:ds[ds.length-1]});
ok(o2.now.L===out.now.L && o2.now.pend==null, 'and shown when it reads the same twice ('+o2.now.L+')');

// too little history: no made-up level, an honest count of what is missing
const short=analyze({recs:recsWith().slice(0,20), ext:{}, today:ds[19]});
ok(short.status==='short' && short.need>0, 'with 20 days of records the level waits ('+short.need+' more days needed)');
const none=analyze({recs:[], ext:{}});
ok(none.status==='none', 'with no records it says so');
const of=often(lv, vals.length);
ok(of[1].n>=of[5].n && of[5].n>=of[9].n, 'higher levels are rarer: '+[1,5,9].map(k=>'▲'+k+' '+of[k].n).join(', '));
console.log(fails?fails+' FAILED':'all passed'); process.exit(fails?1:0);

/* top-core.mjs on made-up swaps: the hundred kept per pool, own swaps never counted, the echo, the dollar
   valuation and the merge across pools. No network. */
import {topSwap, posShares, topRows, TOPK, ECHO} from './top-core.mjs';
let fails=0, n=0; const ok=(c,m)=>{ n++; if(!c){ fails++; console.log('FAIL', m); } else console.log('ok   ', m); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<=e*Math.max(1,Math.abs(b));

// positions in range and their parts
const pos={a:{lo:-10,hi:10,L:300}, b:{lo:0,hi:20,L:100}, c:{lo:50,hi:60,L:999}, d:{lo:-5,hi:5,L:0}};
let ps=posShares(pos,5);
ok(ps.length===2&&ps[0][0]==='a'&&near(ps[0][1],0.75)&&ps[1][0]==='b'&&near(ps[1][1],0.25), 'positions in range, by their part of the deck’s liquidity there');
ok(posShares(pos,null).length===0&&posShares(pos,100).length===0, 'no tick or nothing in range: none');

// not tracked: nothing kept
let st={top:undefined}; ok(topSwap(st,{t:1,w:10,s:0.5})===false&&st.top===undefined, 'a pool not tracked from the first day keeps nothing');

// the hundred
st={top:[]}; for(let i=0;i<150;i++) topSwap(st,{t:i*1000,x:'tx'+i,w:i+1,s:0.5,zin:i%2===0,k0:0,k1:-10});
ok(st.top.length===TOPK, 'a pool keeps its '+TOPK+' best');
ok(st.top[0].w===150&&st.top[TOPK-1].w===51, 'the best first, the hundredth is the 100th best');
ok(topSwap(st,{t:999e6,w:10,s:0.5})===false, 'a smaller one than the hundredth is not kept');
ok(topSwap(st,{t:999e6,w:1000,s:0.5,own:true})===false&&st.top[0].w===150, 'the deck’s own swap is never kept');
ok(topSwap(st,{t:999e6,w:1000,s:0})===false, 'out of range (no share): not kept');

// the echo: later swaps within 30 minutes, own ones left out
st={top:[]}; topSwap(st,{t:0,w:100,s:1}); topSwap(st,{t:60e3,w:10,s:0.5}); topSwap(st,{t:120e3,w:999,s:1,own:true}); topSwap(st,{t:ECHO+1,w:40,s:1});
const big=st.top.find(c=>c.w===100);
ok(near(big.e,10*0.5), 'the echo counts later swaps within 30 minutes, not the deck’s own, not after');

// valuation and merge
const mk=(id,fee,lpCut,top,raw,syms)=>({id, chain:'sol', venue:'Raydium CLMM', name:id, fee, lpCut, state:{top, raw, syms}, days:Object.fromEntries(Object.keys(raw).map(d=>[d,{s:0.5}]))});
const D1='2026-10-14', T=Date.parse(D1+'T21:07:00Z');
const A=mk('poolA',0.04,0.84,[{t:T,x:'s1',w:1e6,s:0.8,fs:0.8e6,z:1,k0:0,k1:-100,p:[['m1',1]],e:2e5}],{[D1]:{w:4e6}},['SOL','CPOOL']);
const B=mk('poolB',0.003,1,[{t:T+1,x:'s2',w:5e7,s:0.3,fs:1.5e7,z:0,k0:0,k1:50,p:[],e:0}],{[D1]:{w:1e8}},['LCX','ETH']);
const census={tokens:[{pools:[{id:'poolA',vol:{[D1]:2000}},{id:'poolB',vol:{[D1]:10000}}]}]};
const R=topRows({pools:[A,B], census, px:new Map()});
const a=R.rows.find(x=>x.pool==='poolA'), b=R.rows.find(x=>x.pool==='poolB');
// poolA: $ per unit 2000/4e6=5e-4 · fee 0.8e6*0.04*0.84*5e-4=13.44 · size 1e6*5e-4=500
ok(near(a.usd,13.44,1e-3)&&near(a.size,500,1e-3)&&near(a.lps,1e6*0.04*0.84*5e-4,1e-3), 'a trade valued at its day’s price: fee to you, size, all LPs’ cut');
ok(near(a.echo,2e5*0.04*0.84*5e-4,1e-3), 'its echo in dollars');
ok(a.sold==='SOL'&&a.bought==='CPOOL'&&b.sold==='ETH'&&b.bought==='LCX', 'what was sold and bought, from the pool’s token order');
ok(near(a.move,1/Math.pow(1.0001,-100)-1,1e-4)&&a.move>0, 'the price it left: the bought token up');
// poolB: $ per unit 1e4/1e8=1e-4 · fee 1.5e7*0.003*1e-4=4.5
ok(near(b.usd,4.5,1e-3)&&R.rows[0].pool==='poolA', 'merged across pools, best first');
ok(near(R.allUsd,2000*0.04*0.84*0.5+10000*0.003*0.5,1e-3)&&near(R.part,(13.44+4.5)/R.allUsd,1e-3), 'what the hundred paid against all the deck earned');
ok(a.dayUsd!=null&&!a.est, 'that day’s total, and a real day price (not an estimate)');
const C=topRows({pools:[mk('poolC',0.01,1,[{t:T,w:100,s:1,fs:100,z:1,k0:0,k1:0,p:[],e:0}],{},['X','Y'])], census:{tokens:[]}, px:new Map([['poolc',{u0:2,d0:2}]])});
ok(C.rows.length===1&&C.rows[0].est===true&&near(C.rows[0].usd,100*0.01*2/100,1e-6), 'no volume for its day: valued at today’s price and marked as an estimate');
ok(topRows({pools:[mk('poolD',0.01,1,[{t:T,w:100,s:1,fs:100,z:1,p:[],e:0}],{},['X','Y'])], census:{tokens:[]}, px:new Map()}).rows.length===0, 'no price at all: left out, never made up');
console.log(fails?fails+' FAILED of '+n:'all '+n+' passed'); process.exit(fails?1:0);

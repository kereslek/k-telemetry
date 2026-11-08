/* The arbitrage study's maths on made-up pools: the swap, the valuation identity, the correction trade,
   the episodes, the classes and the split sale. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { swapRaw, cpoolPx, buyCpool, sellCpool, legValue, bestArb, bookArb, episodes, classify, txFlags, splitSell } from './arb-core.mjs';

// a SOL/CPOOL pool: CPOOL token0 (6 dp), SOL token1 (9 dp); and the same pair the other way round
const mk=(c0,fee=0.04)=>c0?{c0:true, d0:6, d1:9, fee, lpCut:0.84}:{c0:false, d0:9, d1:6, fee, lpCut:0.84};
// a state with CPOOL priced at `px` SOL and liquidity L
const st=(pl,px,L)=>{ const k=10**(pl.d0-pl.d1); return {sp:pl.c0?Math.sqrt(px/k):Math.sqrt(1/(px*k)), L}; };
const near=(a,b,rel=1e-6)=>assert.ok(Math.abs(a-b)<=rel*Math.max(1,Math.abs(a),Math.abs(b)), a+' vs '+b);

test('the state helper prices CPOOL as asked, either way round', ()=>{
  for(const c0 of [true,false]){ const P=mk(c0); near(cpoolPx(P, st(P,1.2e-4,1e9).sp), 1.2e-4); } });

test('buying CPOOL raises its price and selling lowers it, either way round', ()=>{
  for(const c0 of [true,false]){ const P=mk(c0), s=st(P,1e-4,5e10), p0=cpoolPx(P,s.sp);
    const b=buyCpool(P,s,c0?1e8:1e8,P.fee); assert.ok(cpoolPx(P,b.sp)>p0);
    const x=sellCpool(P,s,1e9,P.fee); assert.ok(cpoolPx(P,x.sp)<p0); } });

test('a round trip loses about two fees', ()=>{
  const P=mk(true,0.01), s=st(P,1e-4,1e12), qin=1e9;
  const b=buyCpool(P,s,qin,P.fee), back=sellCpool(P,{...s,sp:b.sp},b.out,P.fee);
  const loss=1-back.out/qin; assert.ok(loss>0.019&&loss<0.021, 'loss '+loss); });

test('valuation: the trader and the LPs together are short by exactly the protocol’s cut', ()=>{
  const P=mk(true), m={cpool:0.02, quote:180};
  const L=legValue(P,{zfo:false, a0:5_000_000_000, a1:500_000_000},m);
  near(L.trader+L.lps, -L.prot); near(L.prot, L.vin*0.04*0.16); });

test('a 10% gap between two 4% pools: the correction leaves them about two costs apart', ()=>{
  const A=mk(true), B=mk(false), sA=st(A,1e-4,3e10), sB=st(B,1.1e-4,3e10), c=0.04*(1-0.84);
  const r=bestArb(A,sA,B,sB,c,c); assert.ok(r&&r.cpool>0);
  const pa=cpoolPx(A,r.spA), pb=cpoolPx(B,r.spB), gap=Math.log(pb/pa);
  assert.ok(gap>0&&gap<0.10, 'gap after '+gap); });

test('a 5% gap is not worth closing for an outside bot paying 4% a leg', ()=>{
  const A=mk(true), B=mk(true), sA=st(A,1e-4,3e10), sB=st(B,1.05e-4,3e10);
  assert.equal(bestArb(A,sA,B,sB,0.04,0.04), null); });

test('your own correction when you are all the liquidity costs about the protocol’s cut and the transaction', ()=>{
  const A=mk(true), B=mk(true), sA=st(A,1e-4,3e10), sB=st(B,1.1e-4,3e10), m={cpool:180*1.05e-4, quote:180}, c=0.04*(1-0.84);
  const r=bestArb(A,sA,B,sB,c,c), all=bookArb(A,B,r,m,1,1,0.05), none=bookArb(A,B,r,m,0,0,0.05);
  near(all.total, -all.prot-0.05, 1e-6);
  // with no share the result is the bot's side alone, and bot + every LP = − the protocol’s cut − the transaction
  near(none.total, none.bot); near(none.bot+none.leak, -none.prot-0.05, 1e-6); });

test('episodes: opened by the event that crosses, closed by the one that comes back', ()=>{
  const e=episodes([{t:1,g:0.005,by:'a'},{t:2,g:0.03,by:'b'},{t:3,g:0.05,by:'c'},{t:4,g:0.01,by:'d'},{t:5,g:-0.04,by:'e'}],0.02);
  assert.equal(e.length,2); assert.equal(e[0].open,'b'); assert.equal(e[0].close,'d'); near(e[0].peak,0.05);
  assert.equal(e[1].open,'e'); assert.equal(e[1].t1,null); });

test('classes', ()=>{
  assert.equal(classify({you:1,n:3}),'you');
  assert.equal(classify({n:12,atomic:10,buy:6,sell:6,jito:0}),'atomic');
  assert.equal(classify({n:30,legsN:30,atomic:0,toward:27,gapMed:0.04,jito:0}),'market', 'takes the pool back to the market');
  assert.equal(classify({n:30,legsN:30,atomic:0,toward:15,gapMed:0.03,jito:0}),'person', 'trades both ways, but no more toward the market than chance');
  assert.equal(classify({n:4,legsN:4,atomic:0,toward:1,gapMed:0,jito:3}),'market', 'tips block builders on most trades');
  assert.equal(classify({n:2,legsN:2,atomic:0,toward:2,gapMed:0.03,jito:0}),'person', 'too few trades to call'); });

test('an atomic round trip is one that ends with the CPOOL it began with', ()=>{
  const M='CP';
  assert.ok(txFlags({legs:[{cpoolAmt:1000},{cpoolAmt:-1000}], d:{[M]:0.5}},M).atomic);
  assert.ok(!txFlags({legs:[{cpoolAmt:1000}], d:{[M]:1000}},M).atomic); });

test('a sale split over two equal pools goes about half each way', ()=>{
  const A=mk(true), B=mk(true), s=st(A,1e-4,3e10);
  const r=splitSell([A,B],[s,{...s}],2e10); const f=r.used[0]/(r.used[0]+r.used[1]); assert.ok(f>0.4&&f<0.6, 'share '+f); });

test('pools quoted in different tokens: the same correction through a conversion at the market', ()=>{
  // A: CPOOL in SOL ($180), B: CPOOL in USDC (6 dp). B prices CPOOL 10% above A in dollars.
  const A=mk(true), B={c0:true, d0:6, d1:6, fee:0.04, lpCut:0.84}, sA=st(A,1e-4,3e10), pbUsd=1e-4*180*1.10;
  const sB={sp:Math.sqrt(pbUsd), L:3e10*Math.sqrt(180)/Math.sqrt(1e3)}, c=0.04*0.16;
  const r=bestArb(A,sA,B,sB,c,c,{rate:1/180, cx:0.0005}); assert.ok(r&&r.cpool>0, 'a trade');
  const b=bookArb(A,B,r,{cpool:0.0189,quote:180},1,1,0.05,{cpool:0.0189,quote:1});
  assert.ok(b.ext>0); near(b.total, -b.prot-0.05-b.ext, 1e-6); });

import { capArb, bootstrap, verdict } from './arb-core.mjs';
test('a correction is capped so neither pool moves more than the cap, and never grows', ()=>{
  const A=mk(true), B=mk(false), sA=st(A,1e-4,3e10), sB=st(B,1.3e-4,3e10), c=0.04*0.16;
  const r=bestArb(A,sA,B,sB,c,c), k=capArb(A,sA,B,sB,r,0.05);
  assert.ok(k&&k.capped&&k.qin<r.qin);
  assert.ok(Math.abs(2*Math.log(k.spA/sA.sp))<=0.0501 && Math.abs(2*Math.log(k.spB/sB.sp))<=0.0501);
  const small=capArb(A,sA,B,sB,r,1); assert.equal(small.capped,false); near(small.qin,r.qin); });
test('the resampled range brackets the total and is the same every run', ()=>{
  const v=[3,-1,2,0,5,-2,1,4,0,2,1,-1,3,2], a=bootstrap(v), b=bootstrap(v), tot=v.reduce((s,x)=>s+x,0);
  assert.ok(a.p10<=a.p50&&a.p50<=a.p90); assert.ok(a.p10<tot&&tot<a.p90); assert.deepEqual(a,b); near(a.noBest,tot-5); });
test('verdicts follow the rules', ()=>{
  assert.equal(verdict({full:10,oos:4,pPos:0.85,slow:2}),'robust');
  assert.equal(verdict({full:10,oos:4,pPos:0.85,slow:-1}),'promising');
  assert.equal(verdict({full:10,oos:-1,pPos:0.65,slow:2}),'promising');
  assert.equal(verdict({full:10,oos:-1,pPos:0.5,slow:2}),'not proven');
  assert.equal(verdict({full:-3,oos:4,pPos:0.9,slow:2}),'not proven'); });

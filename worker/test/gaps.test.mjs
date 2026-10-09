// Tests for worker/src/gaps.js: the arithmetic against hand-worked numbers, and one full reading with
// the network replaced. Run: node worker/test/gaps.test.mjs
import assert from 'node:assert/strict';
import {walkBuy, walkSell, cexQuote, opportunities, step, heldMins, readToken, DEFAULT_CFG} from '../src/gaps.js';
let n=0; const t=(name,fn)=>{ fn(); n++; };
const close=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<=eps, a+' ≠ '+b);

t('walkBuy fills across levels', ()=>{
  // $100 at 1.00 (100 tokens for $100) exactly
  close(walkBuy([[1,100],[2,100]],100), 100);
  // $150: 100 tokens for $100, then $50 at 2.00 = 25 tokens
  close(walkBuy([[1,100],[2,100]],150), 125);
  assert.equal(walkBuy([[1,10]],100), null);          // too thin
  close(walkBuy([[1,0],[1,10]],5), 5);                 // a zero-size level is skipped
});
t('walkSell fills across levels', ()=>{
  close(walkSell([[2,10],[1,10]],15), 25);              // 10×2 + 5×1
  assert.equal(walkSell([[2,10]],11), null);
});
t('cexQuote applies the taker fee to both sides', ()=>{
  const q=cexQuote({bids:[[0.99,1e6]], asks:[[1.01,1e6]]}, 1000, 1000, 0.4);
  close(q.mid,1.00);
  close(q.buyPx, 1000/((1000/1.01)*0.996), 1e-12);      // dollars per token after the fee
  close(q.sellPx, 0.99*0.996, 1e-12);
  assert.equal(q.thin,false);
  assert.equal(cexQuote({bids:[[1,1]],asks:[[1,1]]},1000,1000,0).thin,true);
});
t('opportunities: profit, gas and order', ()=>{
  const qs=[{id:'a',mid:1,buyPx:1.0,sellPx:0.98,gasUsd:0},{id:'b',mid:1.05,buyPx:1.06,sellPx:1.04,gasUsd:2}];
  const o=opportunities(qs,1000);
  assert.equal(o[0].buy,'a'); assert.equal(o[0].sell,'b');
  // 1000 tokens bought at a, sold at b for 1040, less $2 gas = $38 = 3.8%
  close(o[0].netUsd,38,1e-9); close(o[0].net,3.8,1e-9); close(o[0].gross,5,1e-9);
  close(o[1].net,(1000/1.06*0.98-1000-2)/10,1e-9);      // the other way loses
  assert.equal(o.length,2);
  assert.equal(opportunities([{id:'a',buyPx:null,sellPx:1}],1000).length,0);
});
t('step: opens, holds, keeps its start across a route change, peaks, closes', ()=>{
  const cfg={...DEFAULT_CFG, minNet:0.5};
  let st=null, t0=1e12;
  st=step(st,{net:0.2,buy:'a',sell:'b'},t0,cfg); assert.equal(st.open,null);
  st=step(st,{net:0.7,buy:'a',sell:'b'},t0+120e3,cfg); assert.equal(st.open.since,t0+120e3);
  st=step(st,{net:1.1,buy:'c',sell:'b'},t0+240e3,cfg); assert.equal(st.open.since,t0+120e3); assert.equal(st.open.buy,'c'); close(st.open.peak,1.1);
  assert.equal(heldMins(st,t0+720e3),10);
  st=step(st,null,t0+360e3,cfg); assert.ok(st.open,'one missing reading keeps it open');
  st=step(st,{net:0.6,buy:'c',sell:'b'},t0+480e3,cfg); assert.ok(st.open); assert.equal(st.miss,0);
  st=step(st,{net:0.4,buy:'c',sell:'b'},t0+600e3,cfg); assert.equal(st.open,null);
  assert.equal(st.log.length,1); assert.equal(st.log[0].mins,8); close(st.log[0].peak,1.1);
  st=step(st,{net:0.9,buy:'a',sell:'b'},t0+720e3,cfg); st=step(st,null,t0+840e3,cfg); st=step(st,null,t0+960e3,cfg);
  assert.equal(st.open,null,'two missing readings close it'); assert.equal(st.log.length,2);
  assert.ok(st.hist.length<=31);
});
t('step: a gap whose route goes unpriced is a miss, not a close', ()=>{
  const cfg={...DEFAULT_CFG, minNet:0.5}, all=new Set(['a','b','c']), noB=new Set(['a','c']);
  let st=null, t0=1e12;
  st=step(st,{net:0.9,buy:'a',sell:'b'},t0,cfg,all); assert.ok(st.open);
  // b did not answer, so the best is some other, worse pair: the gap stays open on one miss
  st=step(st,{net:-3,buy:'a',sell:'c'},t0+120e3,cfg,noB); assert.ok(st.open); assert.equal(st.miss,1);
  assert.equal(st.hist[st.hist.length-1][1],-3);
  st=step(st,{net:0.8,buy:'a',sell:'b'},t0+240e3,cfg,all); assert.ok(st.open); assert.equal(st.miss,0); assert.equal(st.open.since,t0);
  // two in a row close it
  st=step(st,{net:-3,buy:'a',sell:'c'},t0+360e3,cfg,noB); st=step(st,{net:-3,buy:'a',sell:'c'},t0+480e3,cfg,noB);
  assert.equal(st.open,null); assert.equal(st.log.length,1);
  // with every venue priced, a drop below the line still closes at once
  st=step(st,{net:0.9,buy:'a',sell:'b'},t0+600e3,cfg,all); st=step(st,{net:0.1,buy:'a',sell:'b'},t0+720e3,cfg,all); assert.equal(st.open,null);
  // a different route over the line while the open route is unpriced keeps it open and moves to it
  st=step(st,{net:0.9,buy:'a',sell:'b'},t0+840e3,cfg,all); st=step(st,{net:1.2,buy:'a',sell:'c'},t0+960e3,cfg,noB);
  assert.equal(st.open.sell,'c'); assert.equal(st.open.since,t0+840e3);
});
t('step: history keeps an hour', ()=>{
  let st=null; for(let i=0;i<100;i++) st=step(st,{net:0.1,buy:'a',sell:'b'},1e12+i*120e3,DEFAULT_CFG);
  assert.ok(st.hist.length===31, 'hist '+st.hist.length);
});

// one full reading with every venue faked
const fakes={
  'api.kraken.com':()=>({error:[], result:{LCXUSD:{bids:[['0.0840','100000']],asks:[['0.0850','100000']]}}}),
  'api.exchange.coinbase.com':()=>{ throw {status:429, body:'slow down'}; },
  'api.coinbase.com':()=>({pricebook:{bids:[{price:'0.0838',size:'100000'}],asks:[{price:'0.0842',size:'100000'}]}}),
  'api.bybit.com':()=>{ throw {status:403, body:'The Amazon CloudFront distribution is configured to block access from your country'}; },
  'api.paraswap.io':u=>{ const p=new URL(u).searchParams; const src=p.get('srcToken');
    // buying: $1000 → tokens at $0.0880; selling: tokens → dollars at $0.0790
    const out=src.startsWith('0xa0b8')?String(BigInt(Math.round(1000/0.088*1e6))*10n**12n):String(Math.round(Number(BigInt(p.get('amount'))/10n**12n)/1e6*0.079*1e6));
    return {priceRoute:{destAmount:out, gasCostUSD:'0.35', bestRoute:[{swaps:[{swapExchanges:[{exchange:'UniswapV3',poolAddresses:['0xOWNPOOL']}]}]}]}}; },
};
globalThis.fetch=async(u)=>{ const h=new URL(u).host, f=fakes[h];
  if(!f) return new Response('nope',{status:404});
  try{ return new Response(JSON.stringify(f(u)),{status:200}); }catch(e){ return new Response(e.body||'err',{status:e.status||500}); } };
const blocked={}, now=Date.now();
const r=await readToken('LCX', DEFAULT_CFG, new Set(['0xownpool']), blocked, now);
t('readToken: books (Coinbase via its second API after a 429), routes, blocked venue, own pool', ()=>{
  const c=r.quotes.find(q=>q.id==='coinbase'); assert.ok(c, 'coinbase priced through the fallback'); close(c.mid,0.084,1e-12);
  const ids=r.quotes.map(q=>q.id).sort(); assert.deepEqual(ids,['coinbase','eth','kraken']);
  assert.ok(blocked.bybit===now, 'a region block is remembered'); assert.match(r.errs.bybit,/403/);
  const k=r.quotes.find(q=>q.id==='kraken'); close(k.mid,0.0845,1e-12); close(k.sellPx,0.0840*0.996,1e-12);
  const e=r.quotes.find(q=>q.id==='eth'); close(e.buyPx,0.088,1e-9); close(e.sellPx,0.079,1e-6); assert.equal(e.own,true); assert.equal(e.gasUsd,0.35);
  // the sell size is the size over the middle reference price
  close(r.qty, 1000/r.ref, 1e-9);
  const best=opportunities(r.quotes,1000)[0];
  // the best: buy where it is cheapest after costs, sell where it pays most after costs
  assert.equal(best.buy,'coinbase'); assert.equal(best.sell,'kraken');
});
const r2=await readToken('LCX', DEFAULT_CFG, new Set(), blocked, now+60e3);
t('readToken: a blocked venue is skipped for an hour', ()=>{ assert.equal(r2.errs.bybit,undefined); });
console.log('gaps.js: '+n+' tests passed');

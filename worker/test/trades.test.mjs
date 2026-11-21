/* The trades the dial lists (trades.js): a run of minutes from before the live event log takes its side and size from
   the readings the long memory kept for the same minutes; a run without such readings shows the pool alone; readings
   still in the live log are trades of their own, as before. Made-up numbers. Run: node test/trades.test.mjs */
import assert from 'node:assert/strict';
import {tradesOf} from '../src/trades.js';
const MIN=60000, T=Date.UTC(2026,10,21,10,0), K='SOL / CPOOL 4%', E='ETH / LCX 1%';
let n=0; const ok=(c,m)=>{ n++; assert.ok(c,m); console.log('ok   ',m); };
// minutes: a run 10:00–10:01 in the SOL pool, a lone minute 10:05 in the ETH pool, a run 10:10 in both
const all=[[T,1.2,1,{[K]:1.2}],[T+MIN,0.6,1,{[K]:0.6}],[T+5*MIN,0.3,1,{[E]:0.3}],[T+10*MIN,2,1,{[K]:1.5,[E]:0.5}]];
// the long memory's readings: [t, from, usd, pools, side, px]
const old=[
  [T+20000, T+5000, 1.2, {[K]:1.2}, {[K]:[1.2,0]}, {[K]:[0.0031,300]}],          // inside the first run: SOL sold
  [T+MIN+30000, T+MIN+10000, 0.6, {[K]:0.6}, {[K]:[0.6,0]}, {[K]:[0.0032,150]}],  // still the first run
  [T+10*MIN+30000, T+10*MIN+20000, 2, {[K]:1.5,[E]:0.5}, {[K]:[0,1.5],[E]:[0.5,0]}, {}], // the third run: CPOOL sold, ETH sold
  [T+30*MIN, T+29*MIN, 9, {[K]:9}, {[K]:[9,0]}, {}]];                             // outside every run: ignored
// the live log starts at 10:20 (after every minute here), with one reading of its own
const ev=[[T+21*MIN, T+20*MIN+50000, 0.4, {[K]:0.4}, {[K]:[0,0.4]}, {}]];
const r=tradesOf(all, ev, T+20*MIN, old), byStart=s=>r.trades.find(x=>x.start===s);
const a=byStart(T), b=byStart(T+5*MIN), c=byStart(T+10*MIN);
ok(a&&a.side&&a.side[K][0]===1.8&&a.side[K][1]===0, 'a run takes its side from the readings inside its minutes (SOL sold, both readings)');
ok(a.px&&a.px[K][0]===0.0032&&a.px[K][1]===450, 'and its size: the last price, the sizes summed');
ok(b&&!b.side&&!b.px, 'a run with no kept reading shows the pool alone, as before');
ok(c&&c.side[K][1]===1.5&&c.side[E][0]===0.5, 'a run over two pools gets each pool its own side');
ok(!r.trades.some(x=>x.side&&x.side[K]&&x.side[K][0]===9), 'a kept reading outside every run is ignored');
const live=r.trades.find(x=>x.x); ok(live&&live.side[K][1]===0.4, 'a reading still in the live log is a trade of its own, with its side');
const r0=tradesOf(all, ev, T+20*MIN); ok(r0.trades.length===r.trades.length&&!r0.trades.filter(x=>!x.x).some(x=>x.side), 'without the long memory: the same trades, the runs without a side (as before)');
console.log('all '+n+' passed');

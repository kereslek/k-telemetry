// Tests for worker/src/big.js. Run: node worker/test/big.test.mjs
import assert from 'node:assert/strict';
import {tzMidnight, biggest} from '../src/big.js';
let n=0; const t=(name,fn)=>{ fn(); n++; console.log('ok   '+name); };
t('midnight in Budapest, summer and winter time', ()=>{
  assert.equal(new Date(tzMidnight(Date.UTC(2026,9,24,12,0))).toISOString(), '2026-10-23T22:00:00.000Z');   // CEST, UTC+2
  assert.equal(new Date(tzMidnight(Date.UTC(2026,10,1,21,0))).toISOString(), '2026-10-31T23:00:00.000Z');  // CET, UTC+1: 22:00 on 1 Nov
  assert.equal(new Date(tzMidnight(Date.UTC(2026,10,1,23,30))).toISOString(), '2026-11-01T23:00:00.000Z');  // 00:30 Budapest is the next day
});
t('the biggest of 24 h and of today differ when the big one was yesterday', ()=>{
  const now=Date.UTC(2026,10,1,8,0);             // 09:00 Budapest
  const tr=[{t:now-20*3600e3, usd:18.4}, {t:now-2*3600e3, usd:3.1}, {t:now-30*60e3, usd:4.8}, {t:now-25*3600e3, usd:99}];
  const b=biggest(tr, now);
  assert.equal(b.d24.usd, 18.4);                  // 20 h ago: inside 24 h, before midnight
  assert.equal(b.today.usd, 4.8);                 // since 00:00 Budapest
});
t('no trade in a window: null, never a made-up one', ()=>{
  const now=Date.UTC(2026,10,1,23,10);            // 00:10 Budapest
  const b=biggest([{t:now-3600e3, usd:2}], now);
  assert.equal(b.today, null); assert.equal(b.d24.usd, 2);
  assert.deepEqual(biggest([], now), {d24:null, today:null, day0:b.day0});
});
t('a tie goes to the later trade; zero-paying entries never win', ()=>{
  const now=Date.UTC(2026,10,1,12,0);
  const b=biggest([{t:now-3e6, usd:5, k:'a'}, {t:now-2e6, usd:5, k:'b'}, {t:now-1e6, usd:0, k:'c'}], now);
  assert.equal(b.d24.k, 'b');
});
console.log('all '+n+' passed');

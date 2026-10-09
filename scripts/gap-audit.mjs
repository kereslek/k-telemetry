/* Audit of the price-gap alert (worker/src/gaps.js behind /gaps, and the deck's gap UI).

   Each round waits for a fresh recorder reading, then right away:
   - reads every venue again from here, independently (order books walked with this file's own
     arithmetic, ParaSwap and Jupiter quoted at the same size) and compares prices;
   - recomputes every buy-here-sell-there edge from the recorder's own quotes;
   - checks the held/closed bookkeeping, the history's cadence and freshness, and sanity bounds;
   and, once at the start and once at the end, opens the live deck and clicks through the gap UI.

   This log is public: it prints market prices, percentages, venue names and pass/fail only —
   never the trade size, dollar edges, own-pool details or anything from the sealed files.
   ROUNDS (default 6) and SPACING (seconds between rounds, default 240); PAGE=0 skips the page. */
import crypto from 'node:crypto';
const LIVE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/', W='https://kt-pulse.kereslek.workers.dev';
const ROUNDS=Math.max(1,+process.env.ROUNDS||6), SPACING=Math.max(0,+process.env.SPACING||240), PAGE=process.env.PAGE!=='0';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const L=await (await fetch(LIVE+'lock.json?t='+Date.now())).json();
if(!PASS||!L.salt) { console.log('FAIL  no DECK_PASSPHRASE or lock.json salt'); process.exit(1); }
const BITS=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256'), TOK=BITS.subarray(32).toString('hex');

const fails=[], warns=[];
const FAIL=m=>{ fails.push(m); console.log('FAIL  '+m); }, WARN=m=>{ warns.push(m); console.log('WARN  '+m); }, OK=m=>console.log('ok    '+m);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rel=(a,b)=>Math.abs(a/b-1)*100;
const px=v=>v==null?'—':'$'+(v>=1?v.toFixed(4):v.toFixed(6));
const pc=v=>v==null?'—':(v>=0?'+':'')+v.toFixed(2)+'%';
const near=(a,b,eps)=>Math.abs(a-b)<=eps*Math.max(1,Math.abs(a),Math.abs(b));
async function j(url, opt){ const r=await fetch(url,{...opt, signal:AbortSignal.timeout(15000), headers:{'user-agent':'Mozilla/5.0 (gap-audit)', accept:'application/json'}});
  const t=await r.text(); if(!r.ok) throw new Error('HTTP '+r.status); return JSON.parse(t); }
const gaps=()=>j(W+'/gaps?k='+TOK);
const runNow=()=>j(W+'/gaps/run?k='+TOK,{method:'POST'});
const hide=s=>String(s).replace(/0x[0-9a-fA-F]{6,}/g,'0x…').replace(/[1-9A-HJ-NP-Za-km-z]{30,88}/g,'…');
const runLine=r=>!r?'no run recorded':(r.ok?'ok':'FAILED')+' via '+r.via+', '+((Date.now()-r.at)/60000).toFixed(1)+' min ago, took '+(r.ms/1000).toFixed(1)+' s'+(r.err?' · '+hide(r.err).split('\n')[0]:'');

/* ---------- independent venue readings (written apart from gaps.js on purpose) ---------- */
const TOK_ADDR={ LCX:{eth:['0x8cd41041505885ef0ad3858181d66f17be8aae7e',18]},
  CPOOL:{eth:['0x66761fa41377003622aee3c7675fc7b5c1c2fac5',18], sol:['AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg',9]} };
const CEX={ LCX:{kraken:'LCXUSD', coinbase:'LCX-USD', bybit:'LCXUSDT'}, CPOOL:{kraken:'CPOOLUSD', bybit:'CPOOLUSDT'} };
async function bookOf(v, s){
  if(v==='kraken'){ const r=await j('https://api.kraken.com/0/public/Depth?pair='+s+'&count=100'); if(r.error&&r.error.length) throw new Error(r.error[0]);
    const d=Object.values(r.result)[0]; return {b:d.bids.map(x=>[+x[0],+x[1]]), a:d.asks.map(x=>[+x[0],+x[1]])}; }
  if(v==='coinbase'){ const r=await j('https://api.exchange.coinbase.com/products/'+s+'/book?level=2'); return {b:r.bids.map(x=>[+x[0],+x[1]]), a:r.asks.map(x=>[+x[0],+x[1]])}; }
  if(v==='bybit'){ const r=await j('https://api.bybit.com/v5/market/orderbook?category=spot&symbol='+s+'&limit=100'); return {b:r.result.b.map(x=>[+x[0],+x[1]]), a:r.result.a.map(x=>[+x[0],+x[1]])}; }
}
// what `usd` buys walking the asks, and what `n` tokens fetch walking the bids
function fill(levels, amount, spendUsd){
  let left=amount, out=0;
  for(const [p,q] of levels){ if(!(p>0&&q>0)) continue;
    const cap=spendUsd?p*q:q; const take=Math.min(left,cap);
    out+=spendUsd?take/p:take*p; left-=take; if(left<=1e-12*amount) return out; }
  return null;
}
async function paraswapOut(src, dst, amt, sd, dd){
  const r=await j('https://api.paraswap.io/prices?srcToken='+src+'&destToken='+dst+'&amount='+amt+'&srcDecimals='+sd+'&destDecimals='+dd+'&side=SELL&network=1');
  return {out:+r.priceRoute.destAmount, gas:+r.priceRoute.gasCostUSD||0}; }
async function jupOut(a, b, amt){ const r=await j('https://lite-api.jup.ag/swap/v1/quote?inputMint='+a+'&outputMint='+b+'&amount='+amt+'&slippageBps=100'); return {out:+r.outAmount, gas:0.01}; }
const toRaw=(x,dec)=>(BigInt(Math.floor(x*1e6))*10n**BigInt(dec-6)).toString();
async function independent(sym, cfg, qty){
  const out={};
  for(const [v,s] of Object.entries(CEX[sym])){
    if(cfg.venues[v]===false) continue;
    try{ const bk=await bookOf(v,s), f=1-cfg.fees[v]/100, got=fill(bk.a,cfg.size,true), usd=fill(bk.b,qty,false);
      out[v]={mid:(bk.b[0][0]+bk.a[0][0])/2, buyPx:got?cfg.size/(got*f):null, sellPx:usd!=null?usd*f/qty:null}; }
    catch(e){ out[v]={err:String(e.message||e).slice(0,60)}; }
  }
  for(const [c,[addr,dec]] of Object.entries(TOK_ADDR[sym])){
    if(cfg.venues[c]===false) continue;
    try{
      const USDC=c==='eth'?'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', u=String(Math.round(cfg.size*1e6));
      const b=c==='eth'?await paraswapOut(USDC,addr,u,6,dec):await jupOut(USDC,addr,u);
      const s=c==='eth'?await paraswapOut(addr,USDC,toRaw(qty,dec),dec,6):await jupOut(addr,USDC,toRaw(qty,dec));
      out[c]={buyPx:cfg.size/(b.out/10**dec), sellPx:s.out/1e6/qty, gas:Math.max(b.gas,s.gas)};
    }catch(e){ out[c]={err:String(e.message||e).slice(0,60)}; }
  }
  return out;
}

/* ---------- checks on one recorder reading ---------- */
const seen={answered:{}, asked:{}, diffs:{}, best:{}, via:{}, opens:0, rounds:0};
function checkToken(sym, g, cfg, now){
  const tag=sym+': ';
  const age=(now-g.t)/60000;
  (age>5?FAIL:OK)(tag+'reading '+age.toFixed(1)+' min old');
  const q=g.quotes||[];
  for(const v of [...Object.keys(CEX[sym]),...Object.keys(TOK_ADDR[sym])]) if(cfg.venues[v]!==false){
    seen.asked[sym+'/'+v]=(seen.asked[sym+'/'+v]||0)+1;
    if(q.find(x=>x.id===v&&x.buyPx>0&&x.sellPx>0)) seen.answered[sym+'/'+v]=(seen.answered[sym+'/'+v]||0)+1;
  }
  console.log('      '+sym+' venues  '+q.map(x=>x.id+' pay '+px(x.buyPx)+' get '+px(x.sellPx)+(x.thin?' (thin)':'')).join(' · ')
    +(Object.keys(g.errs||{}).length?'  · no answer: '+Object.entries(g.errs).map(([v,e])=>v+' ('+e.replace(/\d{6,}/g,'…')+')').join(', '):''));
  if(!q.length){ WARN(tag+'no venue answered'); return; }
  // sanity: every price within 25% of the middle reference, and a round trip at one venue never pays
  for(const x of q){
    for(const k of ['mid','buyPx','sellPx']) if(x[k]!=null && g.ref && rel(x[k],g.ref)>25) FAIL(tag+x.id+' '+k+' '+px(x[k])+' is '+rel(x[k],g.ref).toFixed(0)+'% from the reference '+px(g.ref));
    if(x.buyPx>0&&x.sellPx>0&&x.sellPx>x.buyPx*1.0001) FAIL(tag+x.id+' sells for more than it buys ('+px(x.sellPx)+' > '+px(x.buyPx)+'): a pricing error');
    if(!(x.gasUsd>=0&&x.gasUsd<100)) FAIL(tag+x.id+' gas out of bounds');
  }
  if(g.qty&&g.ref&&!near(g.qty*g.ref,cfg.size,1e-9)) FAIL(tag+'sell quantity is not the size at the reference price');
  // every pair recomputed from the recorder's quotes
  const mine=[];
  for(const a of q) for(const b of q){ if(a===b||!(a.buyPx>0)||!(b.sellPx>0)) continue;
    const n=(cfg.size/a.buyPx*b.sellPx-cfg.size-(a.gasUsd||0)-(b.gasUsd||0))/cfg.size*100; mine.push({buy:a.id,sell:b.id,net:n}); }
  mine.sort((x,y)=>y.net-x.net);
  if(!mine.length){ if(g.best) FAIL(tag+'a best edge with no priceable pair'); else OK(tag+'no priceable pair'); }
  else {
    if(!g.best) FAIL(tag+'pairs are priceable but no best edge');
    else if(!near(g.best.net,mine[0].net,1e-9)) FAIL(tag+'best edge '+pc(g.best.net)+' ≠ recomputed '+pc(mine[0].net));
    else OK(tag+'best edge recomputed: buy '+g.best.buy+', sell '+g.best.sell+' '+pc(g.best.net)+' (mid gap '+pc(g.best.gross)+')');
    for(const o of g.opps||[]){ const m=mine.find(x=>x.buy===o.buy&&x.sell===o.sell);
      if(!m||!near(o.net,m.net,1e-9)) FAIL(tag+'pair '+o.buy+'→'+o.sell+' net '+pc(o.net)+' does not recompute ('+(m?pc(m.net):'missing')+')');
      if(!near(o.netUsd/cfg.size*100,o.net,1e-9)) FAIL(tag+'pair '+o.buy+'→'+o.sell+' dollar and percent edges disagree'); }
    const b=seen.best[sym]=seen.best[sym]||[]; b.push(g.best?g.best.net:null);
  }
  // the bookkeeping
  const st=g.st||{}, o=st.open, h=st.hist||[];
  if(!h.length) FAIL(tag+'no history');
  else {
    const last=h[h.length-1];
    if(last[0]!==g.t) FAIL(tag+'history does not end at the reading');
    if((g.best?Math.round(g.best.net*1000)/1000:null)!==last[1]) FAIL(tag+'history last value '+last[1]+' ≠ best '+(g.best&&g.best.net));
    if(g.t-h[0][0]>60*60000) FAIL(tag+'history keeps more than an hour');
    const steps=h.slice(1).map((x,i)=>(x[0]-h[i][0])/60000), late=steps.filter(s=>s>3.5).length;
    for(let i=1;i<h.length;i++) if(h[i][0]<=h[i-1][0]) { FAIL(tag+'history out of order'); break; }
    (late>2?WARN:OK)(tag+h.length+' readings in the last hour, '+late+' interval(s) over 3.5 min'+(steps.length?' (longest '+Math.max(...steps).toFixed(1)+' min)':''));
  }
  if(g.best&&g.best.net>=cfg.minNet){
    if(!o) FAIL(tag+'edge at or over the threshold but no open gap');
    else { if(o.buy!==g.best.buy||o.sell!==g.best.sell) FAIL(tag+'open gap route differs from the best');
      if(!(o.since<=g.t)) FAIL(tag+'open gap starts after the reading');
      if(!(o.peak>=g.best.net-1e-12)) FAIL(tag+'open gap peak below the current edge');
      seen.opens++; OK(tag+'gap OPEN, held '+((g.t-o.since)/60000).toFixed(0)+' min, peak '+pc(o.peak)+(((now-o.since)/60000>=cfg.holdMin)?' — alerting':' — forming')); }
  } else if(g.best&&o&&st.miss===0) FAIL(tag+'edge under the threshold but the gap is still open');
  for(const l of st.log||[]){
    if(!(l.until>l.since)) FAIL(tag+'a closed gap ends before it starts');
    if(Math.abs(l.mins-Math.round((l.until-l.since)/60000))>0) FAIL(tag+'a closed gap\'s minutes do not match its times');
    if(now-l.until>48.5*3600000) FAIL(tag+'the gap log keeps more than 48 hours');
  }
  // own pools: only that they make sense; what they are stays out of this log
  for(const x of g.own||[]) if(!(x.usd>0&&(x.share==null||(x.share>=0&&x.share<=1)))||(g.ref&&rel(x.usd,g.ref)>40)) FAIL(tag+'an own-pool price or share is out of bounds');
}
function compare(sym, g, ind, cfg){
  for(const [v,r] of Object.entries(ind)){
    const w=(g.quotes||[]).find(x=>x.id===v), key=sym+'/'+v;
    if(r.err){ if(w) console.log('      '+key+': recorder answered, this runner did not ('+r.err+')'); continue; }
    if(!w){ WARN(key+': this runner priced it, the recorder did not ('+((g.errs||{})[v]||'missing')+')'); continue; }
    for(const k of ['buyPx','sellPx']){ if(r[k]==null||w[k]==null) continue;
      const d=rel(w[k],r[k]); (seen.diffs[key+' '+k]=seen.diffs[key+' '+k]||[]).push(d);
      if(d>8) FAIL(key+' '+k+': recorder '+px(w[k])+' vs here '+px(r[k])+' ('+d.toFixed(2)+'% apart)');
      else if(d>2.5) WARN(key+' '+k+': recorder '+px(w[k])+' vs here '+px(r[k])+' ('+d.toFixed(2)+'% apart)'); }
    if(r.gas!=null&&Math.abs(r.gas-w.gasUsd)>Math.max(2,r.gas)) WARN(key+': gas differs a lot (recorder vs here)');
  }
}

/* ---------- the endpoints ---------- */
async function endpoints(){
  for(const [n,u,o] of [['GET /gaps without the token',W+'/gaps'],['GET /gaps with a wrong token',W+'/gaps?k=00'+TOK.slice(2)],
      ['POST /gaps/cfg without the token',W+'/gaps/cfg',{method:'POST',body:'{"minNet":49}'}]]){
    const r=await fetch(u,{...o, signal:AbortSignal.timeout(15000)}); (r.status===403?OK:FAIL)(n+' → '+r.status); }
  const a=await gaps(), r=await fetch(W+'/gaps/cfg?k='+TOK,{method:'POST',body:'{}',signal:AbortSignal.timeout(15000)});
  const c=r.ok?(await r.json()).cfg:null, b=await gaps();
  (c&&JSON.stringify(c)===JSON.stringify(a.cfg)&&JSON.stringify(b.cfg)===JSON.stringify(a.cfg)?OK:FAIL)('settings unchanged by the refused POST and by an empty one');
  (a.run&&a.run.ok&&Date.now()-a.run.at<5*60000?OK:FAIL)('last scheduled reading: '+runLine(a.run));
  for(const m of ['GET','PUT']){ const r=await fetch(W+'/gaps/run'+(m==='GET'?'?k='+TOK:''),{method:m,signal:AbortSignal.timeout(15000)}); ((m==='GET'?r.status===405:r.status===403)?OK:FAIL)(m+' /gaps/run '+(m==='GET'?'with':'without')+' the token → '+r.status); }
  const n=await runNow(); (n.ok?OK:FAIL)('a reading on demand: '+runLine(n));
  const x=a.cfg; ((x.size>=50&&x.size<=100000&&x.minNet>=-5&&x.minNet<=50&&x.holdMin>=0&&x.holdMin<=240&&Object.values(x.fees).every(f=>f>=0&&f<=5))?OK:FAIL)('settings within bounds');
  return await gaps();
}

/* ---------- the page ---------- */
async function pageTest(label){
  const {chromium}=await import('playwright');
  const br=await chromium.launch(); let bad=0;
  const P=m=>{ bad++; FAIL('page['+label+'] '+m); };
  for(const vw of [{width:390,height:844},{width:1300,height:900}]){
    const ctx=await br.newContext({viewport:vw});
    await ctx.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey', JSON.stringify({salt,bits})); }catch(e){} }, [L.salt, BITS.toString('base64')]);
    const pg=await ctx.newPage(), errs=[]; pg.on('pageerror',e=>errs.push(e.message));
    await pg.goto(LIVE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
    const got=await pg.waitForFunction(()=>typeof state!=='undefined'&&state.gaps&&state.gaps.cfg,null,{timeout:90000}).then(()=>true,()=>false);
    if(!got){ P(vw.width+'px: the page never loaded /gaps'); await ctx.close(); continue; }
    if(!await pg.evaluate(()=>Object.keys(state.gaps.tok||{}).length)){ P(vw.width+'px: /gaps has no tokens, nothing to click through'); await ctx.close(); continue; }
    const r=await pg.evaluate(async()=>{
      const o={build:BUILD, fresh:(Date.now()-state.gaps.t)/60000};
      const c=state.gaps.cfg; o.fields=[+$('#gapMinNet').value===c.minNet, +$('#gapHold').value===c.holdMin, +$('#gapSize').value===c.size,
        +$('#gapFeeKraken').value===c.fees.kraken, +$('#gapFeeCoinbase').value===c.fees.coinbase, +$('#gapFeeBybit').value===c.fees.bybit].every(Boolean);
      o.boxes=[...document.querySelectorAll('#gapVens input[data-v]')].filter(i=>i.checked===(c.venues[i.dataset.v]!==false)).length;
      const al=gapAlerts().filter(a=>!a.muted);
      o.alerts=al.length; o.hot=document.querySelectorAll('#hPx .px.gap-hot').length;
      o.badge=+(document.querySelector('#btnNotify .gap-badge')||{}).textContent||0;
      o.rows=[...document.querySelectorAll('.act-gap,[data-gap]')].length;
      o.sheets={};
      for(const s of Object.keys(state.gaps.tok)){
        openGapSheet(s); await new Promise(r=>setTimeout(r,150));
        const sh=document.querySelector('.gap-sheet'), t=sh?sh.innerText:'', g=state.gaps.tok[s];
        o.sheets[s]={open:!!sh, rows:sh?sh.querySelectorAll('.gs-r:not(.gs-hd)').length:0, want:(g.quotes||[]).length+Object.keys(g.errs||{}).length,
          junk:/NaN|undefined|Infinity|\[object/.test(t), chart:!!(sh&&(sh.querySelector('svg.gs-chart')||sh.querySelector('.flow-omit'))),
          over:document.documentElement.scrollWidth>innerWidth+1, wide:sh?sh.getBoundingClientRect().right>innerWidth+1:false};
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); await new Promise(r=>setTimeout(r,50));
        o.sheets[s].closed=!document.querySelector('.gap-sheet-bg');
      }
      return o;
    });
    if(r.fresh>6) P(vw.width+'px: the page\'s gap reading is '+r.fresh.toFixed(1)+' min old');
    if(!r.fields) P(vw.width+'px: threshold fields do not show the saved settings');
    if(r.boxes!==5) P(vw.width+'px: venue boxes '+r.boxes+'/5 match the settings');
    if(r.hot>r.alerts||r.badge!==r.alerts) P(vw.width+'px: alerts '+r.alerts+' but hot tiles '+r.hot+', badge '+r.badge);
    for(const [s,x] of Object.entries(r.sheets)){
      if(!x.open||!x.closed) P(vw.width+'px: '+s+' sheet open '+x.open+', closes on Escape '+x.closed);
      if(x.rows!==x.want) P(vw.width+'px: '+s+' sheet lists '+x.rows+' venues, expected '+x.want);
      if(x.junk) P(vw.width+'px: '+s+' sheet shows NaN/undefined');
      if(!x.chart) P(vw.width+'px: '+s+' sheet has no chart');
      if(x.over||x.wide) P(vw.width+'px: '+s+' sheet overflows the screen');
    }
    if(errs.length) P(vw.width+'px: page errors: '+errs.slice(0,3).map(e=>e.slice(0,80)).join(' | '));
    if(!bad) OK('page['+label+'] '+vw.width+'px: build '+r.build+', settings shown, '+r.alerts+' alert(s) = '+r.hot+' hot tile(s) = badge '+r.badge+', sheets '+Object.keys(r.sheets).join('/')+' open, list every venue, close on Escape, fit the screen');
    await ctx.close();
  }
  await br.close();
}

/* ---------- run ---------- */
console.log('gap audit: '+ROUNDS+' round(s), '+SPACING+' s apart'+(PAGE?', page click-through at start and end':''));
let G=await endpoints();
if(PAGE) await pageTest('start');
for(let i=1;i<=ROUNDS;i++){
  // wait for the next recorder reading, so the independent one is taken seconds after it
  try{ G=await gaps(); }catch(e){}
  const t0=G.t; let waited=0;
  while(waited<150){ await sleep(5000); waited+=5; try{ G=await gaps(); }catch(e){} if(G.t!==t0) break; }
  if(G.t===t0){ FAIL('no scheduled reading within '+waited+' s (expected every 2 min) · '+runLine(G.run)); try{ await runNow(); G=await gaps(); }catch(e){} }
  const now=Date.now();
  console.log('\n— round '+i+'/'+ROUNDS+' · reading '+(G.t?new Date(G.t).toISOString().slice(11,19)+' UTC':'none')+' · '+runLine(G.run));
  if(!G.t){ FAIL('the recorder has no gap reading'); continue; }
  if(G.run) seen.via[G.run.via]=(seen.via[G.run.via]||0)+1;
  seen.rounds++;
  for(const sym of ['LCX','CPOOL']){
    const g=G.tok&&G.tok[sym]; if(!g){ FAIL(sym+': missing from /gaps'); continue; }
    try{ checkToken(sym, g, G.cfg, now); }catch(e){ FAIL(sym+': check threw '+e.message); }
    if(g.qty) try{ compare(sym, g, await independent(sym, G.cfg, g.qty), G.cfg); }catch(e){ WARN(sym+': independent reading threw '+e.message); }
  }
  if(i<ROUNDS && SPACING>120) await sleep((SPACING-120)*1000);
}
if(PAGE) await pageTest('end');

console.log('\n=== summary over '+seen.rounds+' round(s)');
for(const k of Object.keys(seen.asked).sort()) console.log('  answered  '+k.padEnd(16)+(seen.answered[k]||0)+'/'+seen.asked[k]);
for(const [k,d] of Object.entries(seen.diffs).sort()){ const s=[...d].sort((a,b)=>a-b);
  console.log('  recorder vs here  '+k.padEnd(22)+'median '+s[Math.floor(s.length/2)].toFixed(2)+'%  max '+s[s.length-1].toFixed(2)+'%  (n='+s.length+')'); }
for(const [k,b] of Object.entries(seen.best)){ const v=b.filter(x=>x!=null);
  if(v.length) console.log('  best edge '+k+': min '+pc(Math.min(...v))+'  max '+pc(Math.max(...v))+'  over the threshold in '+v.filter(x=>x>=G.cfg.minNet).length+'/'+v.length); }
console.log('  readings by trigger '+JSON.stringify(seen.via));
console.log('  open-gap sightings '+seen.opens+' · warnings '+warns.length+' · failures '+fails.length);
if(fails.length){ console.log('\nFAILED:\n  '+[...new Set(fails)].join('\n  ')); process.exit(1); }
console.log('\nALL CHECKS PASSED');

// One-off: open the live dashboard in a real browser and read the 60-minute pulse. (v35.4 rerun)
import {chromium} from 'playwright';
const b=await chromium.launch();
// a browser that looked a moment ago, so nothing is held for a catch-up and test trades are born live
const c1=await b.newContext({viewport:{width:390,height:844}}); await c1.addInitScript(()=>{ try{ localStorage.setItem('kt.pulse.seen',String(Date.now())); }catch(e){} });
const pg=await c1.newPage();
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
const asks=[]; pg.on('request',r=>{ if(r.url().includes('kt-pulse')) asks.push([Date.now(),r.url().split('?')[1]]); });
await pg.goto('https://kereslek.github.io/k-telemetry/deck-r7k4x9/?v='+Date.now(),{waitUntil:'domcontentloaded'});
await pg.waitForTimeout(25000);
console.log('BUILD', await pg.evaluate(()=>typeof BUILD!=='undefined'?BUILD:null));
const w=await pg.$('#fp60'); console.log(w?(await w.innerText()).slice(0,700):'no #fp60');
console.log('dial marks', await pg.evaluate(()=>document.querySelectorAll('.fpd-dot').length), 'dial present', await pg.evaluate(()=>!!document.querySelector('.fpd-dial')));
console.log('tile link', await pg.evaluate(()=>{const a=document.querySelector('.fp-link60'); return a?a.getAttribute('aria-label')+' bars='+a.querySelectorAll('rect').length:null;}));
const topAt=async lbl=>console.log('TOP', lbl, JSON.stringify(await pg.evaluate(()=>{const b=document.querySelector('#toTop'),r=b.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
  return {y:Math.round(scrollY),cls:b.className,op:getComputedStyle(b).opacity,right:Math.round(innerWidth-r.right),tappable:h===b};})));
await topAt('at top');
for(let i=0;i<12;i++){ await pg.evaluate(()=>scrollBy(0,120)); await pg.waitForTimeout(40); if(i===11) await topAt('mid scroll-down'); }
for(let i=0;i<5;i++){ await pg.evaluate(()=>scrollBy(0,-80)); await pg.waitForTimeout(40); } await topAt('scrolling up');
await pg.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight)); await pg.waitForTimeout(400); await topAt('page bottom');
const dialPos=()=>pg.evaluate(()=>[...document.querySelectorAll('#fp60 .fpd-dot')].map(d=>{ const x=+d.getAttribute('cx')-150, y=+d.getAttribute('cy')-150;
  return [d.getAttribute('aria-label'), +(((Math.atan2(y,x)*180/Math.PI)+90+360)%360).toFixed(3)]; }));
console.log('dial labels', await pg.evaluate(()=>[...document.querySelectorAll('#fp60 .fpd-lbl')].map(e=>e.textContent+'@x'+Math.round(e.getAttribute('x'))).join(' ')));
{ const a=await dialPos(); await pg.waitForTimeout(6000); const b2=await dialPos();
  a.forEach((m,i)=>console.log('DIAL', m[0], 'clock deg', m[1], '->', b2[i]&&b2[i][1], 'delta', b2[i]?(b2[i][1]-m[1]).toFixed(3):'?')); }
console.log('SWEEP', JSON.stringify(await pg.evaluate(()=>{ const sw=document.querySelector('#fp60 .fpd-sweep'); if(!sw) return null;
  const m=new DOMMatrix(getComputedStyle(sw).transform), deg=((Math.atan2(m.b,m.a)*180/Math.PI)+360)%360;
  return {build:BUILD, running:sw.getAnimations().map(a=>a.playState).join(), deg:+deg.toFixed(1), clock:+((Date.now()%7000)/7000*360).toFixed(1), w:sw.offsetWidth, ring:Math.round(document.querySelector('#fp60 .fpd-ring').getBoundingClientRect().width)}; })));
{ const tag=()=>pg.evaluate(()=>[...document.querySelectorAll('#fp60 .fpd-dot')].map(d=>{ d.dataset.n=d.dataset.n||String(Math.random()).slice(2,8);
    return [d.dataset.n, d.getAttribute('aria-label'), +(+d.style.opacity).toFixed(3), d.getAttribute('fill')]; }));
  const a=await tag(); await pg.evaluate(()=>loadPulse()); await pg.waitForTimeout(2500); const b2=await tag();
  for(const x of b2){ const o=a.find(y=>y[1]===x[1]); console.log('MARK', x[1], 'opacity', x[2], x[3], o?(o[0]===x[0]?'kept across refresh':'REBUILT'):'new'); }
  console.log('MARKS', a.length, '->', b2.length, 'build', await pg.evaluate(()=>BUILD)); }
{ // a birth on the live page: a test trade injected into this browser only
  const r=await pg.evaluate(async()=>{ const w=document.getElementById('fp60'); if(!w||!w._sync) return 'no live dial';
    const P=state.pulse, t=Math.floor(Date.now()/60000)*60000-60000;
    P.trades=[{t,start:t,end:t,usd:2.5,pools:{'LCX / ETH 1%':2.5}},...(P.trades||[])];
    w._sync(); await new Promise(r=>setTimeout(r,700));
    const fx=w.querySelectorAll('svg g[pointer-events="none"] > *').length;
    await new Promise(r=>setTimeout(r,8200));
    const d=[...w.querySelectorAll('.fpd-dot')].find(x=>(x.getAttribute('aria-label')||'').includes('2.50'));
    const deg=d?(((Math.atan2(+d.getAttribute('cy')-150,+d.getAttribute('cx')-150)*180/Math.PI)+90+360)%360).toFixed(1):null;
    return {build:BUILD, effectsMidBirth:fx, newDotDeg:deg, opacity:d&&d.style.opacity}; });
  console.log('BIRTH', JSON.stringify(r)); }
console.log('BUDAPEST', JSON.stringify(await pg.evaluate(()=>{ const fm=state.feeMonth||{}, dl=fm.daily||[];
  return {build:BUILD, today:bpDay(Date.now()), month:fm.month, mtd:fm.mtd, lastBar:dl[dl.length-1], prev:(fm.prev||[]).map(x=>[x.m,x.total]),
    note:(document.querySelector('#fpBody .arch-note')||{}).textContent, story:(document.querySelector('.fp-story')||{}).innerText,
    strip:(document.querySelector('#fp60 .fpd-today')||{}).textContent, fees:[...document.querySelectorAll('#tiles .tile')].map(t=>t.innerText.replace(/\s+/g,' ')).find(x=>x.startsWith('FEES EARNED'))}; })));
{ // big-fee screen effects: test trades injected into this browser only, one per tier
  for(const u of [12,48,111.82]){ await pg.waitForTimeout(9000);
    const r=await pg.evaluate(async u=>{ const w=document.getElementById('fp60'); if(!w||!w._sync) return 'no live dial';
      const P=state.pulse, t=Math.floor(Date.now()/60000)*60000-60000-Math.round(u*10)*10;
      P.trades=[{t,start:t,end:t,usd:u,pools:{'LCX / ETH 1%':u}},...(P.trades||[])]; w._sync();
      const seen=new Set(); for(let i=0;i<14;i++){ await new Promise(r=>setTimeout(r,250)); const L=document.getElementById('sfx'); if(L) for(const c of L.children) seen.add(c.className); }
      return [...seen].join(','); },u);
    console.log('SFX', u, r); } }
{ const t1=Date.now(); await pg.waitForTimeout(15000); const n=asks.filter(a=>a[0]>=t1);
  console.log('ASKS in 15 s', n.length, n.length?n[n.length-1][1]:'');
  console.log('FAST', JSON.stringify(await pg.evaluate(()=>{ const P=state.pulse||{}; return {build:BUILD, fast:P.fast, readAgoS:P.now&&P.last?Math.round((P.now-P.last)/1000):null, read:P.read, N:P.N,
    exact:(P.trades||[]).filter(t=>t.x).map(t=>new Date(t.t).toISOString().slice(11,19)+' $'+t.usd).slice(0,6), centre:(document.querySelector('#fp60 .fpd-total')||{}).textContent}; }))); }
{ // catch-up: a browser that last looked 47 minutes ago, with the dial scrolled into view
  const c2=await b.newContext({viewport:{width:390,height:844}}); await c2.addInitScript(v=>{ try{ localStorage.setItem('kt.pulse.seen',String(v)); }catch(e){} }, Date.now()-47*60000);
  const p2=await c2.newPage(); p2.on('pageerror',e=>errs.push('catchup: '+e.message));
  await p2.goto('https://kereslek.github.io/k-telemetry/deck-r7k4x9/?v='+Date.now(),{waitUntil:'domcontentloaded'}); await p2.waitForTimeout(22000);
  const s2=()=>p2.evaluate(()=>{ const w=document.getElementById('fp60'); if(!w) return null; return {build:BUILD, sub:(w.querySelector('.fpd-sub')||{}).textContent, read:(w.querySelector('.fpd-read')||{}).textContent,
    veil:(w.querySelector('svg circle[fill="#000"]')||{getAttribute:()=>null}).getAttribute('opacity'), card:(w.querySelector('.fpd-away')||{}).innerText||null, dots:w.querySelectorAll('.fpd-dot').length}; });
  console.log('CATCHUP before', JSON.stringify(await s2()));
  const dw=await p2.$('#fp60 .fpd-dw'); if(dw){ await dw.scrollIntoViewIfNeeded(); await p2.waitForTimeout(2500); console.log('CATCHUP mid', JSON.stringify(await s2()));
    await p2.waitForTimeout(5000); console.log('CATCHUP after', JSON.stringify(await s2())); }
  await c2.close(); }
console.log('errors', errs);
await b.close();

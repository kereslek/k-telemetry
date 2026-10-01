// One-off: open the live dashboard in a real browser and read the 60-minute pulse.
import {chromium} from 'playwright';
const b=await chromium.launch(); const pg=await b.newPage({viewport:{width:390,height:844}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
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
console.log('errors', errs);
await b.close();

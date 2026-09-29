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
console.log('errors', errs);
await b.close();

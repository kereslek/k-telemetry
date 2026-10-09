/* Where does the live deck land when it is opened? Opens it the way a phone does — Safari's
   engine as an iPhone, Chrome's as an Android phone — and records every move of the page while it
   opens and for a while after: the scroll position over time, which code asked for a move (the
   function names only), when the boot and lock screens went, and which panel ends up at the top.

   Ways in: a fresh open; a reload after reading further down; a revisit hours later (the
   welcome-back strip and the rolling numbers); and typing the passphrase on the lock screen.
   The log is public: positions, times, panel names and function names only — no figure. */
import { webkit, chromium, devices } from 'playwright';
import crypto from 'node:crypto';
const LIVE=process.env.PROBE_URL||'https://kereslek.github.io/k-telemetry/deck-r7k4x9/';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const WATCH=+(process.env.WATCH||45)*1000;
let L=null; try{ L=await (await fetch(LIVE+'lock.json?t='+Date.now())).json(); }catch(e){}
const BITS=L&&L.check&&PASS?crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').toString('base64'):null;

const trace=()=>{
  const T0=performance.now(), ev=[]; window.__probe={ev};
  const now=()=>+((performance.now()-T0)/1000).toFixed(2);
  const who=()=>{ const st=String(new Error().stack||'').split('\n').slice(2,6);
    return st.map(l=>{ const m=l.match(/at (?:async )?([\w$.<>]+) \(.*?:(\d+):\d+\)/)||l.match(/^([\w$.<>]*)@.*?:(\d+):\d+$/)||l.match(/at .*?:(\d+):\d+/);
      return m?(m.length>2?(m[1]||'anon')+':'+m[2]:'anon:'+m[1]):''; }).filter(Boolean).join(' < '); };
  for(const f of ['scrollTo','scrollBy','scroll']){ const o=window[f]; window[f]=function(...a){ ev.push([now(),'call '+f,Math.round(scrollY),String(JSON.stringify(a)).slice(0,40),who()]); return o.apply(this,a); }; }
  const sv=Element.prototype.scrollIntoView; Element.prototype.scrollIntoView=function(...a){ ev.push([now(),'scrollIntoView',Math.round(scrollY),(this.id||this.className||this.tagName).toString().slice(0,30),who()]); return sv.apply(this,a); };
  const fo=HTMLElement.prototype.focus; HTMLElement.prototype.focus=function(...a){ ev.push([now(),'focus',Math.round(scrollY),(this.id||this.className||this.tagName).toString().slice(0,30),who()]); return fo.apply(this,a); };
  let last=0; addEventListener('scroll',()=>{ const y=Math.round(scrollY); if(Math.abs(y-last)>=30){ ev.push([now(),'scrolled',y,'','']); last=y; } },{passive:true,capture:true});
  for(const t of ['touchstart','pointerdown','wheel','keydown']) addEventListener(t,()=>ev.push([now(),'input '+t,Math.round(scrollY),'','']),{capture:true,passive:true});
  addEventListener('load',()=>ev.push([now(),'load',Math.round(scrollY),'','']));
  addEventListener('pageshow',e=>ev.push([now(),'pageshow'+(e.persisted?' (cache)':''),Math.round(scrollY),'','']));
  document.addEventListener('DOMContentLoaded',()=>{
    const mo=new MutationObserver(()=>{
      const bs=document.getElementById('bootScreen'), st=bs?(bs.classList.contains('hide')?'hiding':'up'):'gone';
      const v=document.documentElement.classList.contains('vault-on')?'lock':'';
      const k=st+'|'+v; if(k!==window.__probe.k){ window.__probe.k=k; ev.push([now(),'screens: boot '+st+(v?', lock screen up':''),Math.round(scrollY),'','']); } });
    mo.observe(document.documentElement,{attributes:true,subtree:true,childList:true,attributeFilter:['class']}); });
};
const where=()=>{ const nav=document.querySelector('#quickNav'), y0=(nav?nav.getBoundingClientRect().bottom:0)+8;
  const el=document.elementFromPoint(innerWidth/2, Math.min(innerHeight-1,y0)); const p=el&&el.closest('.panel');
  const tag=p?p.dataset.panel:(el&&el.closest('#tiles')?'tiles':el&&el.closest('header')?'header':el?el.tagName.toLowerCase():'?');
  return {y:Math.round(scrollY), h:document.documentElement.scrollHeight, at:tag, build:(document.querySelector('#buildTag')||{}).textContent||'?'}; };

async function watch(pg, label){
  const ys=[]; const t0=Date.now();
  while(Date.now()-t0<WATCH){ await pg.waitForTimeout(1000); try{ ys.push(await pg.evaluate(()=>Math.round(scrollY))); }catch(e){ ys.push('nav'); } }
  const w=await pg.evaluate(where), ev=await pg.evaluate(()=>window.__probe?window.__probe.ev:[]);
  const moved=ev.filter(e=>e[1]!=='scrolled'||true);
  console.log('  '+label+' · '+w.build+' · lands at y='+ys[2]+' after 3 s, y='+w.y+' after '+WATCH/1000+' s (page '+w.h+' px) · at the top: '+w.at);
  console.log('    scroll position each second: '+ys.join(' '));
  const keep=moved.filter(e=>!/^input/.test(e[1])||true).slice(0,40);
  for(const e of keep) console.log('    '+String(e[0]).padStart(6)+' s  '+e[1]+(e[3]?' '+e[3]:'')+'  y='+e[2]+(e[4]?'  ← '+e[4]:''));
}

for(const [name,type,dev] of [['Safari engine, iPhone',webkit,devices['iPhone 15']],['Chrome, Android phone',chromium,devices['Pixel 7']]]){
  console.log('== '+name);
  let b=null; try{ b=await type.launch(process.env.CHROME&&type===chromium?{executablePath:process.env.CHROME}:{}); }catch(e){ console.log('  could not start it: '+String(e.message||e).split('\n')[0].slice(0,80)); continue; }
  const key=async ctx=>{ if(BITS) await ctx.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey', JSON.stringify({salt,bits})); }catch(e){} }, [L.salt, BITS]); };
  // 1. a fresh open, then 2. a reload after reading further down
  { const ctx=await b.newContext({...dev}); await key(ctx); await ctx.addInitScript(trace);
    const pg=await ctx.newPage(); await pg.goto(LIVE,{waitUntil:'domcontentloaded'});
    await watch(pg,'fresh open');
    const H=await pg.evaluate(()=>document.documentElement.scrollHeight);
    await pg.evaluate(h=>scrollTo(0,Math.round(h*0.45)),H); await pg.waitForTimeout(1500);
    console.log('  (read down to y='+(await pg.evaluate(()=>Math.round(scrollY)))+', then reload)');
    await pg.reload({waitUntil:'domcontentloaded'});
    await watch(pg,'reload while scrolled down');
  // 3. a revisit hours later: the welcome strip and the rolling numbers
    await pg.evaluate(()=>{ const s=JSON.parse(localStorage.getItem('lphud:rnSeen')||'{}'); for(const k in s){ if(s[k].v) s[k].v=+(s[k].v*0.97).toFixed(s[k].d); s[k].t=Date.now()-3*3600e3; }
      localStorage.setItem('lphud:rnSeen',JSON.stringify(s)); localStorage.setItem('lphud:rnVisit',String(Date.now()-3*3600e3)); });
    const pg2=await ctx.newPage(); await pg.close(); await pg2.goto(LIVE,{waitUntil:'domcontentloaded'});
    await watch(pg2,'revisit 3 h later');
    await ctx.close(); }
  // 4. the lock screen: the passphrase typed in
  if(BITS){ const ctx=await b.newContext({...dev}); await ctx.addInitScript(trace);
    const pg=await ctx.newPage(); await pg.goto(LIVE,{waitUntil:'domcontentloaded'});
    try{ await pg.waitForSelector('#lockPass',{timeout:20000}); await pg.tap('#lockPass').catch(()=>pg.click('#lockPass'));
      await pg.fill('#lockPass',PASS); await pg.press('#lockPass','Enter'); await watch(pg,'passphrase typed');
    }catch(e){ console.log('  passphrase typed: the lock screen did not come up ('+String(e.message||e).slice(0,60)+')'); }
    await ctx.close(); }
  await b.close();
}

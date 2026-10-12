/* WHY YOUR FEES MOVED on real devices: the live deck opened as an iPhone (Safari's engine), an
   Android phone (Chrome's) and a laptop, and every part of the panel worked the way a finger would:
   the entrance plays and settles, a pool's days open with a chart, a tap on a day explains it, the
   folds fold, the comparison switches, the checks chip opens the checks, and with reduced motion
   everything is simply there. The log is public: yes/no and counts only. */
import { webkit, chromium, devices } from 'playwright';
import crypto from 'node:crypto';
const LIVE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const L=await (await fetch(LIVE+'lock.json?t='+Date.now())).json();
const BITS=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').toString('base64');
let fails=0; const say=(ok,m)=>{ if(!ok) fails++; console.log((ok?'ok    ':'FAIL  ')+m); };
for(const [name,type,dev,reduce] of [['iPhone (Safari engine)',webkit,devices['iPhone 15'],false],['Android (Chrome)',chromium,devices['Pixel 7'],false],
                                     ['laptop (Chrome, 1440 wide)',chromium,{viewport:{width:1440,height:900}},false],['iPhone, reduced motion',webkit,devices['iPhone 15'],true]]){
  const b=await type.launch(); const ctx=await b.newContext({...dev, ...(reduce?{reducedMotion:'reduce'}:{})});
  await ctx.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey',JSON.stringify({salt,bits})); }catch(e){} },[L.salt,BITS]);
  const pg=await ctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(String(e)));
  try{
    await pg.goto(LIVE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
    await pg.waitForFunction(()=>!!document.querySelector('#censusBody .cz-row'),null,{timeout:60000}).catch(()=>{});
    await pg.waitForTimeout(3000);
    await pg.evaluate(()=>{ const p=document.querySelector('[data-panel="census"]'); if(p){ p.classList.remove('collapsed'); scrollTo(0,p.getBoundingClientRect().top+scrollY-60); } });
    await pg.waitForTimeout(2600);   // the entrance: numbers count, bars rise, lines draw
    const a=await pg.evaluate(()=>{ const h=document.querySelector('#censusBody'), rows=[...h.querySelectorAll('.cz-row')];
      const pre=h.classList.contains('cz-pre'), lad=[...h.querySelectorAll('.cz-lr .tr i')].map(i=>i.getBoundingClientRect().width), big=h.querySelector('.cz-sum');
      const fs=(e)=>e?parseFloat(getComputedStyle(e).fontSize):0;
      return {rows:rows.length, pre, ladder:lad.length, ladderDrawn:lad.filter(x=>x>0).length, sumVisible:!!big&&big.getBoundingClientRect().height>20,
        lineFont:fs(h.querySelector('.cz-ln')), hscroll:document.documentElement.scrollWidth>innerWidth+1,
        smallTap:[...h.querySelectorAll('button')].filter(x=>{ const r=x.getBoundingClientRect(); return r.width>0&&r.height>0&&r.height<28; }).length}; });
    say(a.rows>0&&!a.pre&&a.ladderDrawn===a.ladder&&a.sumVisible&&!a.hscroll, name+': panel shows '+a.rows+' pool line(s); entrance '+(a.pre?'STUCK before it played':'played and settled')+'; share bars drawn '+a.ladderDrawn+' of '+a.ladder+'; '+(a.hscroll?'page WIDER than the screen':'fits the screen'));
    say(a.lineFont>=12&&a.smallTap===0, name+': text '+a.lineFont+' px; '+(a.smallTap?a.smallTap+' button(s) under 28 px tall':'every button at least 28 px tall'));
    // a pool's days
    const tapper=dev.hasTouch?'tap':'click';
    const btn=await pg.$('#censusBody .cz-row .cz-open'); const was=await pg.evaluate(()=>document.querySelector('#censusBody .cz-row .cz-evx').classList.contains('shut'));
    if(was) await btn[tapper](); await pg.waitForTimeout(1500);
    const ev=await pg.evaluate(()=>{ const x=document.querySelector('#censusBody .cz-row .cz-evx'), r=x.getBoundingClientRect(), bars=[...x.querySelectorAll('.cz-chart .bar')];
      const risen=bars.filter(b=>{ const t=getComputedStyle(b).transform; return t==='none'||!/matrix\(1, 0, 0, 0/.test(t); }).length;
      const svg=x.querySelector('.cz-chart svg'), txt=svg?svg.querySelector('text'):null; return {open:!x.classList.contains('shut'), h:r.height, bars:bars.length, risen, label:txt?txt.getBoundingClientRect().height:0, tblOver:(()=>{ const t=x.querySelector('.cz-t'); return t?t.scrollWidth>t.clientWidth+1:false; })()}; });
    // a day under the finger: the chart in the middle of the screen, a day near its middle
    await pg.evaluate(()=>{ const c=document.querySelector('#censusBody .cz-row:first-child .cz-chart'); if(c) c.scrollIntoView({block:'center'}); }); await pg.waitForTimeout(500);
    const hits=await pg.$$('#censusBody .cz-row:first-child .cz-evx .hit'); let tip={shown:false}, gone=null;
    if(hits.length){ const h=hits[Math.floor(hits.length*0.6)];
      const under=await h.evaluate(el=>{ const r=el.getBoundingClientRect(), u=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return u===el?'the day':u?(u.id||String(u.className&&u.className.baseVal!==undefined?u.className.baseVal:u.className||u.tagName)).slice(0,30):'nothing'; });
      await h[tapper](); await pg.waitForTimeout(400);
      tip=await pg.evaluate(()=>{ const t=document.querySelector('#censusBody .cz-row:first-child .cz-tip'); return {shown:!!t&&getComputedStyle(t).display!=='none'&&t.textContent.length>10, marked:!!document.querySelector('#censusBody .cz-row:first-child .hit.on')}; }); tip.under=under;
      if(dev.hasTouch&&tip.shown){ const s=await pg.$('#censusBody .cz-sum'); if(s){ await s.tap(); await pg.waitForTimeout(300); gone=await pg.evaluate(()=>{ const t=document.querySelector('#censusBody .cz-row:first-child .cz-tip'); return !t||getComputedStyle(t).display==='none'; }); } } }
    say(ev.open&&ev.h>150&&ev.bars>0&&ev.risen===ev.bars&&ev.label>=8&&!ev.tblOver&&tip.shown&&gone!==false, name+': a pool’s days open ('+Math.round(ev.h)+' px), '+ev.risen+' of '+ev.bars+' bars risen, chart labels '+Math.round(ev.label)+' px, day table '+(ev.tblOver?'WIDER than the screen':'fits')+', a '+tapper+' on a day '+(tip.shown?'explains it':'shows NOTHING (finger on '+tip.under+', day '+(tip.marked?'marked':'not marked')+')')+(gone==null?'':gone?', a tap elsewhere puts it away':', a tap elsewhere does NOT put it away'));
    // folds, the comparison, the checks chip
    const f=await pg.evaluate(async()=>{ const out={}; const fold=v=>document.querySelector('#censusBody [data-cz="fold"][data-v="'+v+'"]');
      for(const v of ['g','e','et']){ const b=fold(v); if(!b){ out[v]=false; continue; } const x=b.closest('.cz-sh').nextElementSibling, was=x.classList.contains('shut');
        b.click(); await new Promise(r=>setTimeout(r,900)); const h1=x.getBoundingClientRect().height, hid=getComputedStyle(x.firstElementChild).visibility==='hidden'; b.click(); await new Promise(r=>setTimeout(r,900)); const h2=x.getBoundingClientRect().height;
        out[v]=(was?h1>0:h1<1&&hid)&&(was?h2<1:h2>0)&&x.classList.contains('shut')===was; out[v+'h']=Math.round(was?h2:h1); }
      const before=document.querySelector('#censusBody .cz-row .cz-ln').textContent; document.querySelector('#censusBody [data-cz="win"][data-v="d"]').click(); await new Promise(r=>setTimeout(r,500));
      out.win=document.querySelector('#censusBody [data-cz="win"][data-v="d"]').getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#censusBody .cz-row').length>0; out.changed=before!==document.querySelector('#censusBody .cz-row .cz-ln').textContent;
      document.querySelector('#censusBody [data-cz="win"][data-v="w"]').click(); await new Promise(r=>setTimeout(r,400));
      const tb=document.querySelectorAll('#censusBody [data-cz="tok"]'); if(tb[1]){ tb[1].click(); await new Promise(r=>setTimeout(r,400)); out.tok=document.querySelectorAll('#censusBody [data-cz="tok"]')[1].getAttribute('aria-pressed')==='true'; tb[0]&&document.querySelectorAll('#censusBody [data-cz="tok"]')[0].click(); } else out.tok=true;
      document.querySelector('#censusBody .cz-stat').click(); await new Promise(r=>setTimeout(r,1400));
      const ck=document.querySelector('#czChecks'), r=ck.getBoundingClientRect(); out.checks=!ck.querySelector('.cz-x').classList.contains('shut')&&r.top<innerHeight&&r.bottom>0;
      return out; });
    say(f.g&&f.e&&f.et&&f.win&&f.tok&&f.checks, name+': folds '+['g','e','et'].map(k=>({g:'pools',e:'market',et:'pool table'}[k])+(f[k]?' ✓':' ✗ (shut at '+f[k+'h']+' px)')).join(', ')+'; comparison switch '+(f.win?'works':'FAILS')+(f.changed?' (lines change)':'')+'; token switch '+(f.tok?'works':'FAILS')+'; the checks chip '+(f.checks?'opens the checks on screen':'does NOT open them'));
    say(!errs.length, name+': page errors '+errs.length);
  }catch(e){ say(false, name+': '+String(e.message||e).split('\n')[0].slice(0,90)); }
  await b.close();
}
console.log(fails?fails+' check(s) failed':'all checks passed'); process.exitCode=fails?1:0;

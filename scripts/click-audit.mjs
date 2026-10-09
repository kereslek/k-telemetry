/* Click and link audit, read-only. Opens the live deck the way a browser does and presses every
   control on it the way a finger would, then checks every link it carries:

   - every element that answers a click is found as the page builds it (buttons, links, jump
     links, tiles and cards with their own handlers), grouped by kind, and pressed — once per kind,
     at desktop width and again at phone width;
   - a press has to do something you can see: change the page, scroll it, open a window or a sheet.
     One that does nothing, throws an error, or cannot be reached because something covers it is
     reported;
   - the jumps (the quick-nav strip, the "full breakdown" / "by token" links, TOP) have to land
     where they say;
   - links: the page's own (?view=…) have to load and draw; outside ones have to answer, and open
     in a new tab;
   - nothing that changes settings or data is pressed (save, add, remove, delete, harvest…).

   The repository is public, so this log carries kinds, counts, domains and masked labels only —
   never an amount, a pair, an address or a position number. Any FAIL ends the run red. */
import {chromium} from 'playwright';
import crypto from 'node:crypto';

const LIVE=process.env.AUDIT_URL||'https://kereslek.github.io/k-telemetry/deck-r7k4x9/';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
let LOCKMETA=null, BITS=null, LOCKED=false;
try{ LOCKMETA=await (await fetch(LIVE+'lock.json?t='+Date.now())).json(); }catch(e){}
if(PASS && LOCKMETA && LOCKMETA.check){ BITS=crypto.pbkdf2Sync(PASS, Buffer.from(LOCKMETA.salt,'base64'), LOCKMETA.iter, 64, 'sha256'); LOCKED=true; }
const mask=s=>String(s||'').replace(/\s+/g,' ').trim().slice(0,60)
  .replace(/0x[0-9a-fA-F]{4,}/g,'0x…').replace(/[1-9A-HJ-NP-Za-km-z]{25,88}/g,'…')
  .replace(/[+−-]?\$\s?[\d,]+(\.\d+)?[kKmM]?/g,'$…').replace(/\b[A-Za-z]{2,8} ?\/ ?[A-Za-z]{2,8}\b/g,'pair')
  .replace(/\b\d+[.,]\d+\b/g,'…').replace(/\b\d{2,}\b/g,'…');
const fails=[], warns=[];
const FAIL=m=>{ fails.push(m); console.log('FAIL  '+m); }, WARN=m=>{ warns.push(m); console.log('WARN  '+m); }, OK=m=>console.log('ok    '+m);
/* never pressed: anything that writes settings or data, asks for permissions, or leaves the page */
const DANGER=/\b(save|delete|remove|forget|clear|reset|revoke|sign ?out|log ?out|harvest|send|submit|import|export|add|track more|unlock|lock now|apply|confirm|update profiles?|rename|erase|wipe|withdraw|buy|sell|swap|approve)\b/i;
const SKIP_IDS=new Set(['btnNotify']);

const b=await chromium.launch(process.env.CHROME?{executablePath:process.env.CHROME}:{});
async function session(w,h){
  const ctx=await b.newContext({viewport:{width:w,height:h}});
  if(LOCKED) await ctx.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey', JSON.stringify({salt,bits})); }catch(e){} }, [LOCKMETA.salt, BITS.toString('base64')]);
  /* record, as the page builds itself, every element given a click-type handler */
  await ctx.addInitScript(()=>{
    const orig=EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener=function(t,f,o){
      try{ if(this instanceof Element && /^(click|pointerdown|pointerup|mousedown|touchstart|dblclick)$/.test(t)) this.setAttribute('data-kt-click','1'); }catch(e){}
      return orig.call(this,t,f,o); };
    window.__opened=[]; const wo=window.open; window.open=function(u){ window.__opened.push(String(u||'')); return null; };
    /* what changed, by node: the page is never still, so a press counts only changes to nodes that
       were not already changing just before it */
    window.__rec=[]; new MutationObserver(r=>{ for(const x of r) if(!(x.type==='attributes'&&/^data-kt-/.test(x.attributeName||''))) window.__rec.push(x.target); }).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    window.__scr=0; document.addEventListener('scroll',e=>{ if(e.target!==document) window.__scr++; },true);
    window.__clip=0; try{ const cw=navigator.clipboard&&navigator.clipboard.writeText; if(cw) navigator.clipboard.writeText=function(t){ window.__clip++; return Promise.resolve(); }; }catch(e){}
    window.alert=()=>{}; window.confirm=()=>false; window.prompt=()=>null;
  });
  const pg=await ctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
  pg.on('popup',p=>{ p.close().catch(()=>{}); });
  await pg.goto(LIVE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
  const scanned=await pg.waitForFunction(()=>typeof state!=='undefined' && state.scanCount>=1 && !scanning,null,{timeout:+(process.env.SCAN_WAIT||240000)}).then(()=>true,()=>false);
  if(!scanned) WARN('the first live scan did not finish within 4 minutes at '+w+' px');
  await pg.waitForTimeout(6000);
  // every panel open, so what is inside them can be reached
  await pg.evaluate(()=>{ document.querySelectorAll('.panel.collapsed').forEach(p=>{ try{ openPanel(p); }catch(e){ p.classList.remove('collapsed'); } }); });
  await pg.waitForTimeout(1500);
  return {ctx,pg,errs};
}

/* the controls on the page, one entry per kind */
async function inventory(pg, perKind){
  return await pg.evaluate(perKind=>{
    const out=[], kinds=new Map();
    const els=[...document.querySelectorAll('a[href],button,[role="button"],[data-jump],[data-kt-click],summary,input[type="checkbox"],input[type="radio"]')]
      .filter(e=>e.id!=='rnLayer'&&!e.closest('#rnLayer,#bootScreen'));
    els.forEach((e,i)=>{
      e.setAttribute('data-kt-i',String(i));
      const lab=(e.getAttribute('aria-label')||e.innerText||e.title||e.getAttribute('data-l')||e.value||'').trim();
      const sig=[e.tagName, [...e.classList].filter(c=>!/^(on|active|sel|show|hit|go|up|down|open|collapsed|armed|stack|lock|jump-flash)$/.test(c)).sort().join('.'),
        e.getAttribute('data-jump')||'', e.getAttribute('data-nav')||'', e.getAttribute('href')&&/^#/.test(e.getAttribute('href'))?'#':'', lab.replace(/[\d$.,%+−-]+/g,'#').slice(0,24)].join('|');
      const n=kinds.get(sig)||0; kinds.set(sig,n+1);
      if(n<perKind) out.push({i, sig, tag:e.tagName, id:e.id||'', cls:[...e.classList].slice(0,3).join('.'), lab, href:e.getAttribute('href')||'',
        jump:e.getAttribute('data-jump')||'', anchor:e.getAttribute('data-anchor')||'', nav:e.getAttribute('data-nav')||'', target:e.getAttribute('target')||'', rel:e.getAttribute('rel')||'',
        type:e.getAttribute('type')||'', handler:e.hasAttribute('data-kt-click')||typeof e.onclick==='function'});
    });
    return {list:out, kinds:kinds.size, total:els.length};
  }, perKind);
}

/* press one control and say what happened */
/* the kind of a control, the same way the inventory names it */
const SIGFN=`(e=>{ const lab=(e.getAttribute('aria-label')||e.innerText||e.title||e.getAttribute('data-l')||e.value||'').trim();
  return [e.tagName, [...e.classList].filter(c=>!/^(on|active|sel|show|hit|go|up|down|open|collapsed|armed|stack|lock|jump-flash)$/.test(c)).sort().join('.'),
    e.getAttribute('data-jump')||'', e.getAttribute('data-nav')||'', e.getAttribute('href')&&/^#/.test(e.getAttribute('href'))?'#':'', lab.replace(/[\\d$.,%+\\u2212-]+/g,'#').slice(0,24)].join('|'); })`;
async function press(pg, errs, c){
  let h=await pg.$('[data-kt-i="'+c.i+'"]');
  if(!h){ // redrawn since the inventory: the first visible control of the same kind
    const ok=await pg.evaluate(([sig,i,fn])=>{ const f=eval(fn); const els=[...document.querySelectorAll('a[href],button,[role="button"],[data-jump],[data-kt-click],summary')];
      const e=els.find(x=>{ const r=x.getBoundingClientRect(); return (r.width||r.height) && f(x)===sig; }) || els.find(x=>f(x)===sig);
      if(!e) return false; e.setAttribute('data-kt-i',String(i)); return true; },[c.sig,c.i,SIGFN]);
    if(!ok) return {gone:true};
    h=await pg.$('[data-kt-i="'+c.i+'"]'); if(!h) return {gone:true}; }
  const dis=await h.evaluate(e=>!!(e.disabled||e.getAttribute('aria-disabled')==='true')).catch(()=>false);
  if(dis) return {disabled:true};
  const vis=await h.evaluate(e=>{ const r=e.getBoundingClientRect(); const st=getComputedStyle(e); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none'&&!e.closest('[hidden]'); }).catch(()=>false);
  if(!vis) return {hidden:true};
  await h.evaluate(e=>e.scrollIntoView({block:'center'})).catch(()=>{}); await pg.waitForTimeout(250);
  /* the page is never still (clock, countdown, live feeds): watch it for a moment first, and count
     after the press only changes to nodes that were not already changing */
  await pg.evaluate(()=>{ window.__rec.length=0; }); await pg.waitForTimeout(800);
  const before=await pg.evaluate(()=>{ window.__base=new Set(window.__rec); window.__rec.length=0;
    return {y:scrollY, o:window.__opened.length, u:location.href, s:window.__scr, c:window.__clip, t:document.querySelectorAll('.toast').length}; });
  const e0=errs.length;
  let covered=false;
  let by=null;
  try{ await h.click({timeout:1500}); }
  catch(err){ const m=String(err.message);
    if(/intercepts pointer events|not visible|outside of the viewport|not stable/i.test(m)){ covered=true;
      /* what is on top: tag, id and class names only */
      const ix=m.indexOf('intercepts pointer events'), seg=m.slice(Math.max(0,ix-500),ix), all=[...seg.matchAll(/<(\w+)([^>]*)>/g)], t=all[all.length-1];
      if(t){ const at=t[2]||''; const id=(/id="([^"]+)"/.exec(at)||[])[1], cl=(/class="([^"]+)"/.exec(at)||[])[1];
        by=t[1]+(id?'#'+id:'')+(cl?'.'+cl.trim().split(/\s+/).slice(0,2).join('.'):''); }
      try{ await h.click({timeout:1500,force:true}); }catch(e){ return {covered:true, by, failed:true}; } }
    else return {failed:true}; }
  await pg.waitForTimeout(750);
  const after=await pg.evaluate(()=>{ const fresh=window.__rec.filter(t=>!window.__base.has(t)).length;
    return {fresh, y:scrollY, o:window.__opened.length, u:location.href, opened:window.__opened.slice(-1)[0]||'', s:window.__scr, c:window.__clip, t:document.querySelectorAll('.toast').length}; });
  const r={covered, by, err:errs.slice(e0), mut:after.fresh, dy:after.y-before.y, inner:after.s-before.s, clip:after.c-before.c, toast:after.t-before.t,
    opened:after.o>before.o?after.opened:null, nav:after.u!==before.u?after.u:null};
  return r;
}
/* back to a calm page after each press */
async function settle(pg){
  await pg.keyboard.press('Escape').catch(()=>{}); await pg.keyboard.press('Escape').catch(()=>{});
  await pg.evaluate(()=>{ const d=document.querySelector('#drawer.open'); const x=document.getElementById('drawerX'); if(d&&x) x.click(); }).catch(()=>{});
}

async function run(w,h,perKind,label){
  console.log('\n— '+label+' ('+w+'×'+h+') —');
  const {ctx,pg,errs}=await session(w,h);
  const inv=await inventory(pg, perKind);
  OK(inv.total+' clickable elements on the page, '+inv.kinds+' kinds; pressing '+inv.list.length);
  const navH=await pg.evaluate(()=>parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-h'))||34);
  let pressed=0, effect=0, skipped=0, hidden=0, gone=0, disabled=0, notJudged=0, jumps=0; const quiet=[], covered=[], broke=[], offTarget=[], slowJumps=[];
  // links are checked separately; buttons and handlers are pressed here, the page refresh button last
  const order=inv.list.filter(c=>!(c.tag==='A'&&c.href&&!/^#/.test(c.href))).sort((a,b)=>(a.id==='btnRefresh')-(b.id==='btnRefresh'));
  for(const c of order){
    if(SKIP_IDS.has(c.id) || DANGER.test(c.lab) || /input/i.test(c.tag)&&c.type!=='checkbox'){ skipped++; continue; }
    if(c.tag==='INPUT'){ skipped++; continue; }
    const navUrl=await pg.evaluate(()=>location.href);
    const r=await press(pg, errs, c);
    if(r.gone){ gone++; continue; } if(r.hidden){ hidden++; continue; } if(r.disabled){ disabled++; continue; }
    pressed++;
    const name=mask(c.lab)||c.cls||c.tag;
    if(r.failed){ broke.push(name+' (could not be pressed)'); await settle(pg); continue; }
    if(r.covered && !(/fpd-dot/.test(c.cls) && /fpd-hit/.test(r.by||''))) covered.push(name+(r.by?' (under '+r.by+')':''));
    if(r.err&&r.err.length) broke.push(name+' → error: '+mask(r.err[0]));
    const did=r.mut>0||Math.abs(r.dy)>2||r.inner>0||r.clip>0||r.toast>0||r.opened||r.nav;
    if(did) effect++;
    else if(/drag-dots|drag/.test(c.cls)||c.tag==='CANVAS'||c.tag==='svg'||/^(circle|path|rect|g)$/i.test(c.tag)) notJudged++;
    else quiet.push(name+' ['+c.cls+']');
    if(c.jump||c.nav) jumps++;
    /* jumps must land: quick-nav and "jump" links put their panel (or anchor) just under the nav strip */
    if(c.jump||c.nav){
      /* a long page can still be drawing above the target while it scrolls; the page corrects for
         that, so wait for it to settle (up to 4.5 s) and say how long it took */
      let land=null, waited=0;
      for(; waited<=4500; waited+=300){ await pg.waitForTimeout(300);
        land=await pg.evaluate(([jump,anchor,nav])=>{ const id=jump||nav; const p=document.querySelector('.panel[data-panel="'+id+'"]'); const a=anchor&&document.getElementById(anchor);
        const t=a||p; if(!t) return {missing:true}; const r=t.getBoundingClientRect();
        /* measured against the nav strip as it is now: expanded (▾ ALL) it is several rows tall */
        const q=document.querySelector('#quickNav'), nb=q?Math.round(q.getBoundingClientRect().bottom):0;
        return {top:Math.round(r.top)-nb, h:Math.round(r.height), open:p?!p.classList.contains('collapsed'):true, atEnd:scrollY>=document.documentElement.scrollHeight-innerHeight-4, vh:innerHeight-nb}; },[c.jump,c.anchor,c.nav]);
        if(land.missing || (land.top>=-40 && land.top<=90 && land.open)) break; }
      if(!land.missing && waited>2500 && land.top>=-40 && land.top<=90) slowJumps.push(name+' ('+(waited/1000).toFixed(1)+' s)');
      if(land.missing) offTarget.push(name+' → its target is not on the page');
      else if((!(land.top>=-40 && land.top<=90) && !(land.atEnd && land.top>-40 && land.top<land.vh-40)) || !land.open)
        offTarget.push(name+' → lands '+land.top+' px from the nav strip'+(land.open?'':', panel left closed'));
    }
    if(r.nav && r.nav!==navUrl){ await pg.goto(navUrl,{waitUntil:'domcontentloaded'}).catch(()=>{}); await pg.waitForTimeout(4000); }
    await settle(pg);
  }
  // TOP: from far down, back to the top
  await pg.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight)); await pg.waitForTimeout(600);
  const topOk=await pg.evaluate(async()=>{ const b=document.querySelector('#toTop'); if(!b||!b.classList.contains('show')) return 'not shown'; b.click(); await new Promise(r=>setTimeout(r,1800)); return scrollY<5?'ok':'stopped at '+Math.round(scrollY); });
  (topOk==='ok'?OK:FAIL)('TOP button: '+(topOk==='ok'?'back to the top from the bottom of the page':topOk));
  const links=inv.list.filter(c=>c.tag==='A'&&c.href&&!/^#/.test(c.href)).length;
  OK('pressed '+pressed+' kinds of control: '+effect+' did something visible, '+notJudged+' drawn surfaces or drag handles · '+jumps+' jumps checked for where they land');
  OK('not pressed: '+skipped+' that change settings or data, '+disabled+' switched off for now, '+hidden+' not shown in this layout, '+gone+' gone before their turn, '+links+' outside links (checked below)');
  if(broke.length) FAIL(broke.length+' control(s) broke: '+broke.slice(0,8).join(' · '));
  if(offTarget.length) FAIL(offTarget.length+' jump(s) land off target: '+offTarget.slice(0,10).join(' · '));
  if(slowJumps.length) WARN(slowJumps.length+' jump(s) took over 2.5 s to settle on target: '+slowJumps.slice(0,8).join(' · '));
  if(covered.length) WARN(covered.length+' control(s) covered by something else on top of them: '+covered.slice(0,10).join(' · '));
  if(quiet.length) WARN(quiet.length+' control(s) did nothing visible when pressed: '+quiet.slice(0,14).join(' · '));
  if(errs.length) FAIL('page errors during the run: '+errs.length+' (first: '+mask(errs[0])+')');
  await ctx.close();
}

/* ---- links ---- */
async function links(){
  console.log('\n— links —');
  const {ctx,pg}=await session(1440,900);
  const hrefs=await pg.evaluate(()=>[...document.querySelectorAll('a[href]')].map(a=>({href:a.href, raw:a.getAttribute('href'), target:a.target, rel:a.rel, lab:(a.innerText||a.title||a.getAttribute('aria-label')||'').trim()})));
  const uniq=new Map(); for(const h of hrefs) if(!uniq.has(h.href)) uniq.set(h.href,h);
  const own=[], ext=[];
  for(const h of uniq.values()){ if(/^(javascript:|mailto:|tel:)/.test(h.raw)) continue; (h.href.startsWith(LIVE)||h.raw.startsWith('#')||h.raw.startsWith('?')?own:ext).push(h); }
  OK(hrefs.length+' links on the page, '+uniq.size+' different: '+own.length+' to the deck itself, '+ext.length+' outside');
  // the deck's own: hash targets exist, ?view pages load and draw
  for(const h of own){
    if(/^#/.test(h.raw)){ const ok=await pg.evaluate(id=>!!document.getElementById(id), h.raw.slice(1)); (ok?OK:FAIL)('link to '+mask(h.raw)+': '+(ok?'target on the page':'target MISSING')); continue; }
    const view=new URL(h.href).searchParams.get('view');
    if(view){ const p=await ctx.newPage(); const e=[]; p.on('pageerror',x=>e.push(x.message)); await p.goto(h.href,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(9000);
      const drawn=await p.evaluate(v=>v==='pulse'?!!document.querySelector('#fp60'):v==='history'?!!document.querySelector('.ph-svg'):true, view);
      ((drawn&&!e.length)?OK:FAIL)('?view='+view+' page: '+(drawn?'draws':'does NOT draw')+(e.length?', '+e.length+' page error(s)':'')); await p.close(); }
  }
  // outside: they answer, and open in a new tab
  const byDom={}; let noTab=0;
  for(const h of ext){ if(h.target!=='_blank') noTab++; }
  for(const h of ext){
    let st=null, err=null;
    try{ const r=await fetch(h.href,{redirect:'follow',signal:AbortSignal.timeout(12000),headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36','accept':'text/html,*/*'}}); st=r.status; }
    catch(e){ err=String(e.cause&&e.cause.code||e.name||'error'); }
    const dom=new URL(h.href).hostname, path=mask(new URL(h.href).pathname).slice(0,40);
    const k=st==null?'unreachable':st<400?'ok':(st===401||st===403||st===429||st===503||st===520||st===522||st===999)?'refuses robots':'BROKEN';
    (byDom[dom]=byDom[dom]||{}); byDom[dom][k]=(byDom[dom][k]||0)+1;
    if(k==='BROKEN') FAIL('link to '+dom+path+' answers '+st);
    else if(k==='unreachable') WARN('link to '+dom+path+' did not answer ('+err+')');
  }
  for(const [d,c] of Object.entries(byDom)) OK(d+': '+Object.entries(c).map(([k,n])=>n+' '+k).join(', '));
  (noTab?WARN:OK)(noTab?noTab+' outside link(s) open in the same tab, taking you off the dashboard':'every outside link opens in a new tab');
  await ctx.close();
}

await run(1440,900,1,'desktop');
await run(390,844,1,'phone');
await links();
await b.close();
console.log('\n'+fails.length+' fail, '+warns.length+' warn');
process.exit(fails.length?1:0);

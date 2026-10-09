/* Daily audit, read-only. Opens the live deck the way a browser does (live scan + relay) and checks
   that what it shows agrees with the relay and with itself. Any FAIL ends the run red, which is
   what makes GitHub email the owner; the full report is on the run's summary page.

   What it checks, and why each one is here:
   - the page loads and its first scan finishes with no script errors;
   - the relay and the recorder are fresh (a stalled relay leaves every money figure stale);
   - every position the relay knows is on the page, and nothing extra is;
   - money figures (cost, fees earned, APR, own-swap exclusions, LP vs HODL) are the relay's
     exactly: a live calculation replacing one of them is how the last bugs got in;
   - unclaimed fees are not below the relay's (Solana cards read $0 that way);
   - values differ from the relay only by what prices did since its pass;
   - header tiles equal the sum of the cards, and TOKEN EXPOSURE counts idle wallets. */
import {chromium} from 'playwright';
import fs from 'node:fs';
const LIVE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/';
/* Locked deck (DECK_PASSPHRASE set and lock.json carries a check): the page is opened with the
   derived key, the sealed files are opened here, and — because this log is public — every line
   is printed with amounts, pairs, positions and addresses cut out. Pass or fail still shows. */
import crypto from 'node:crypto';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
let LOCKED=false, KEY=null, BITS=null, TOK=null, LOCKMETA=null;
try{ LOCKMETA=await (await fetch(LIVE+'lock.json?t='+Date.now())).json(); }catch(e){}
if(PASS && LOCKMETA && LOCKMETA.check){
  BITS=crypto.pbkdf2Sync(PASS, Buffer.from(LOCKMETA.salt,'base64'), LOCKMETA.iter, 64, 'sha256');
  KEY=BITS.subarray(0,32); TOK=BITS.subarray(32).toString('hex'); LOCKED=true;
}
const openJ=j=>{ if(!(j&&j.lock===1)) return j; if(!KEY) throw new Error('sealed data and no DECK_PASSPHRASE');
  const all=Buffer.from(j.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(j.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); };
const mask=s=>!LOCKED?s:String(s).replace(/0x[0-9a-fA-F]{6,}/g,'0x…').replace(/[1-9A-HJ-NP-Za-km-z]{30,88}/g,'…')
  .replace(/\$\s?-?[\d,]+(\.\d+)?/g,'$…').replace(/\b[A-Za-z]{2,8} \/ [A-Za-z]{2,8}\b/g,'pair').replace(/\b\d+\.\d+\b/g,'…').replace(/\b\d{3,}\b/g,'…');
const fails=[], warns=[], notes=[];
const FAIL=m=>{ m=mask(m); fails.push(m); console.log('FAIL  '+m); }, WARN=m=>{ m=mask(m); warns.push(m); console.log('WARN  '+m); }, OK=m=>{ m=mask(m); notes.push(m); console.log('ok    '+m); };
const lr=x=>x>0&&isFinite(x)?Math.abs(Math.log(x)):0;
const money=v=>v==null?'—':'$'+Number(v).toFixed(2);
console.log(LOCKED?'deck is locked: opening it with the derived key; details are withheld from this public log':'deck is not locked');

/* AUDIT_LOCAL=1 audits this checkout's page against the live data files (before a deploy). */
let srv=null, PAGE=LIVE;
if(process.env.AUDIT_LOCAL){
  const http=await import('node:http'), page=fs.readFileSync('deck-r7k4x9/index.html');
  srv=http.createServer(async (q,r)=>{ const p=q.url.split('?')[0].replace(/^\/+/,'');
    if(p===''||p==='index.html'){ r.writeHead(200,{'content-type':'text/html'}); return r.end(page); }
    try{ const u=await fetch(LIVE+p+'?t='+Date.now()); r.writeHead(u.status,{'content-type':u.headers.get('content-type')||'application/octet-stream'}); r.end(Buffer.from(await u.arrayBuffer())); }
    catch(e){ r.writeHead(502); r.end(); } }).listen(8767);
  PAGE='http://localhost:8767/';
}
const b=await chromium.launch();
const bctx=await b.newContext({viewport:{width:1440,height:900}});
if(LOCKED) await bctx.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey', JSON.stringify({salt,bits})); }catch(e){} }, [LOCKMETA.salt, BITS.toString('base64')]);
const pg=await bctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(PAGE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
const scanned=await pg.waitForFunction(()=>typeof state!=='undefined' && state.scanCount>=1 && !scanning,null,{timeout:240000}).then(()=>true,()=>false);
if(!scanned) FAIL('the first live scan did not finish within 4 minutes');
await pg.waitForTimeout(8000);
const build=await pg.evaluate(()=>typeof BUILD!=='undefined'?BUILD:null);
OK('page build '+build);

const relay=openJ(await (await fetch(LIVE+'data-main.json?t='+Date.now())).json());
if(LOCKED) (await pg.$('.lock-screen') ? FAIL : OK)('the page opened with the derived key (no lock screen)');
const relayAge=(Date.now()-relay.t)/60000;
// the history chart's TOTAL view: points carrying wallets and NFTs, and the daily totals before them
{ const H=relay.history||[], L=H[H.length-1]||{}, withI=H.filter(x=>x.i!=null).length;
  ((L.i!=null&&L.n!=null)?OK:WARN)('portfolio history: '+H.length+' points, '+withI+' with wallets'+(L.n!=null?' and NFTs':'')+' · daily totals '+((relay.totalDays||[]).length)+' day(s)'); }
/* the reconciled history (reconcile.yml, daily): fresh, and drawn by the TOTAL view with its
   reconciliation box; the chart's high is the reconciled one. Yes/no and counts only. */
try{ const R=openJ(await (await fetch(LIVE+'recon-main.json?t='+Date.now())).json()), age=(Date.now()-R.t)/3600e3;
  (age>48?WARN:OK)('reconciled history: '+R.pts.length+' points from '+R.n+' relay passes, rebuilt '+age.toFixed(0)+' h ago, '+(R.adj||[]).length+' correction(s)');
  for(const w of [390,1300]){
    await pg.setViewportSize({width:w,height:900});
    const r=await pg.evaluate(async()=>{ store.set('phMode','total'); store.set('phRange','all'); renderSpark();
      for(let i=0;i<60&&state.recon===undefined;i++) await new Promise(f=>setTimeout(f,250));
      renderSpark(); await new Promise(f=>setTimeout(f,300));
      const box=document.querySelector('#sparkBody .ph-recon'), hiTxt=[...document.querySelectorAll('#sparkBody .ph-stats span')].map(e=>e.innerText).find(t=>/^HIGH/.test(t))||'';
      const hi=Number(hiTxt.replace(/[^\d.]/g,'')), want=state.recon&&state.recon.peaks&&state.recon.peaks.cor?Math.round(state.recon.peaks.cor.v):null;
      const over=box?[...box.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).length:-1;
      const out={loaded:!!state.recon, box:!!box, rc:document.querySelector('#sparkBody .ph-cnote')?/reconciled/.test(document.querySelector('#sparkBody .ph-cnote').innerText):false,
        hiOk:want!=null&&hi>=want-1, over, hscroll:document.documentElement.scrollWidth>innerWidth+1};
      store.set('phMode','lp'); renderSpark(); return out; });
    ((r.loaded&&r.box&&r.rc&&r.hiOk&&r.over===0&&!r.hscroll)?OK:FAIL)('TOTAL view at '+w+': reconciled series '+(r.loaded?'loaded':'NOT loaded')+', box '+(r.box?'shown':'missing')
      +', chart high '+(r.hiOk?'reaches':'falls short of')+' the reconciled high, '+(r.over===0&&!r.hscroll?'fits the screen':'overflows'));
  }
  /* POOLS: the pools' earnings (own swaps out) and the month-by-month bridge; every month must
     add up to its own change, and the chart's last point must be the fee ledger's running total */
  for(const w of [390,1300]){
    await pg.setViewportSize({width:w,height:900});
    const r=await pg.evaluate(async()=>{ store.set('phMode','pools'); store.set('phRange','all'); renderSpark();
      for(let i=0;i<60&&state.recon===undefined;i++) await new Promise(f=>setTimeout(f,250));
      renderSpark(); await new Promise(f=>setTimeout(f,300));
      const sb=document.querySelector('#sparkBody'), cards=[...sb.querySelectorAll('.pb-card')];
      const num=t=>t==='—'?0:(t[0]==='−'?-1:1)*Number(t.replace(/[^\d.]/g,''));
      const adds=cards.map(c=>{ const v=[...c.querySelectorAll('.pb-row')].map(x=>num(x.querySelector('.pb-v').childNodes[0].textContent)); return v.length===5&&Math.abs(v[0]+v[1]+v[2]+v[3]-v[4])<=4; });
      /* the view's own arithmetic: total − total without the pools = what the pools earned, and
         that is never more than the fee ledger's running total */
      const fm=state.feeMonth, cum=fm&&Array.isArray(fm.daily)?fm.daily.reduce((a,x)=>a+(x.usd||0),0):null;
      const n=t=>Number(String(t||'').replace(/[^\d.]/g,''));
      const big=n((sb.querySelector('.ph-now b')||{}).innerText), st=[...sb.querySelectorAll('.ph-stats span')].map(e=>e.innerText);
      const pe=n((st.find(t=>/^POOLS EARNED/.test(t))||'').replace(/^POOLS EARNED/,'')), woT=(st.find(t=>/^WITHOUT THEM/.test(t))||'').split(' ').find(x=>/^\$/.test(x)), wo=n(woT);
      const panes=!!(sb.querySelector('.ph-band')&&sb.querySelector('.ph-wo')&&sb.querySelector('.ph-pl'));
      /* inside a box built to scroll sideways (the pool-type grid, like the matrix) is not overflow */
      const inScroller=e=>{ for(let a=e.parentElement; a&&a!==sb; a=a.parentElement){ const o=getComputedStyle(a).overflowX; if(o==='auto'||o==='scroll') return true; } return false; };
      const offs=[...sb.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth+1&&!inScroller(e)), over=offs.length;
      /* which element, by tag and class only (never its text), and by how much */
      const where=offs.slice(0,3).map(e=>e.tagName.toLowerCase()+'.'+String(e.className&&e.className.baseVal!=null?e.className.baseVal:e.className).replace(/[^\w .-]/g,'').split(' ')[0]+' +'+Math.round(e.getBoundingClientRect().right-innerWidth)+'px').join(', ');
      const out={mode:store.get('phMode'), cards:cards.length, adds:adds.every(Boolean), ledger:panes&&cum!=null&&Math.abs(big-wo-pe)<=2&&pe<=Math.round(cum)+1, over, where, hscroll:document.documentElement.scrollWidth>innerWidth+1};
      store.set('phMode','lp'); renderSpark(); return out; });
    ((r.mode==='pools'&&r.cards>=2&&r.adds&&r.ledger&&r.over===0&&!r.hscroll)?OK:FAIL)('POOLS view at '+w+': '+(r.mode==='pools'?'drawn':'NOT drawn')+', '+r.cards+' month card(s), '
      +(r.adds?'every one adds up':'a month does NOT add up')+', '+(r.ledger?'total, total-without-pools and pools pane agree with each other and the fee ledger':'the panes do NOT agree (or are missing)')+', '+(r.over===0&&!r.hscroll?'fits the screen':'overflows'+(r.where?' ('+r.where+')':'')));
  }
  await pg.setViewportSize({width:1440,height:900});
}catch(e){ WARN('reconciled history not read: '+String(e.message||e).slice(0,60)); }
/* ROLLING NUMBERS: a revisit three hours later with every remembered figure 3% lower. In a browser
   profile of its own (the main page's memory must not mix in): it opens at the top, says welcome
   back, the figures on screen roll, each figure's text stays the plain figure all the while, and
   nothing is left behind. Counts and yes/no only. */
try{
  const ctx2=await b.newContext({viewport:{width:390,height:844}});
  if(LOCKED) await ctx2.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey', JSON.stringify({salt,bits})); }catch(e){} }, [LOCKMETA.salt, BITS.toString('base64')]);
  const e2=[];
  let q=await ctx2.newPage(); q.on('pageerror',e=>e2.push(e.message));
  await q.goto(PAGE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
  await q.waitForFunction(()=>!document.getElementById('bootScreen'),null,{timeout:240000}).catch(()=>{});
  await q.waitForTimeout(3000); await q.evaluate(()=>scrollTo(0,1800)); await q.waitForTimeout(400); await q.close();
  const qs=await ctx2.newPage(); await qs.goto(LIVE+'lock.json?t='+Date.now());
  const nk=await qs.evaluate(()=>{ const s=JSON.parse(localStorage.getItem('lphud:rnSeen')||'{}'); for(const k in s){ if(s[k].v) s[k].v=+(s[k].v*0.97).toFixed(s[k].d); s[k].t=Date.now()-3*3600e3; }
    localStorage.setItem('lphud:rnSeen',JSON.stringify(s)); localStorage.setItem('lphud:rnVisit',String(Date.now()-3*3600e3)); return Object.keys(s).length; });
  await qs.close();
  q=await ctx2.newPage(); q.on('pageerror',e=>e2.push(e.message));
  await q.goto(PAGE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
  let rolled=0, clean=true, top=true;
  for(let i=0;i<200&&!rolled;i++){ await q.waitForTimeout(100); rolled=await q.evaluate(()=>document.querySelectorAll('.rn-col').length); }
  for(let i=0;i<6;i++){ const r=await q.evaluate(()=>({y:scrollY, bad:[...document.querySelectorAll('.rn')].map(x=>x.closest('#hPx .px .v,#tiles .tile > .v,.card .m > .v,.tok-total-n,.ph-now > b')).filter(Boolean)
      .filter(v=>{ const r=v.querySelector('.rn'); return r && !v.innerText.replace(/\s+/g,' ').includes(r.textContent.replace(/\s+/g,' ').trim()); }).length}));
    if(r.bad) clean=false; if(r.y>2) top=false; await q.waitForTimeout(200); }
  const wel=await q.evaluate(()=>!!document.querySelector('#rnWelcome.on'));
  await q.waitForTimeout(3500);
  const left=await q.evaluate(()=>({cols:document.querySelectorAll('.rn-col').length, rn:document.querySelectorAll('.rn').length, pend:document.querySelectorAll('[data-rn-pend]').length}));
  ((rolled>0&&clean&&top&&wel&&!left.cols&&!left.rn&&!e2.length)?OK:FAIL)('rolling numbers, a revisit 3 h later ('+nk+' figures remembered): '+(top?'opens at the top':'does NOT open at the top')+', '+(wel?'welcome-back strip shown':'NO welcome-back strip')
    +', '+rolled+' drum(s) rolling, figures\' text '+(clean?'stays the plain figure':'is BROKEN mid-roll')+', '+(left.cols||left.rn?'drums LEFT BEHIND':'nothing left behind')+', '+left.pend+' waiting below the screen'+(e2.length?', '+e2.length+' page error(s)':''));
  await ctx2.close();
}catch(e){ FAIL('rolling numbers: '+String(e.message||e).slice(0,60)); }
/* LIVE: from the top of the page, one tap lands the 60-minute clock on screen and the button
   steps aside; a fee arriving while the clock is off screen flashes it. Yes/no only. */
for(const w of [390,1300]){
  try{
    await pg.setViewportSize({width:w,height:w<500?844:900});
    await pg.evaluate(()=>scrollTo(0,0)); await pg.waitForTimeout(700);
    const before=await pg.evaluate(()=>{ const b=document.querySelector('#toLive'); return !!b&&!b.hidden&&b.classList.contains('show'); });
    await pg.evaluate(()=>{ const b=document.querySelector('#toLive'); if(b) b.click(); }); await pg.waitForTimeout(1800);
    const after=await pg.evaluate(()=>{ const d=document.querySelector('#fp60 .fpd-dw')||document.querySelector('#fp60'), b=document.querySelector('#toLive');
      if(!d) return {found:false}; const r=d.getBoundingClientRect(), vis=Math.max(0,Math.min(r.bottom,innerHeight)-Math.max(r.top,0))/Math.max(1,Math.min(r.height,innerHeight));
      return {found:true, dial:!!document.querySelector('#fp60 .fpd-dw'), vis, gone:!b.classList.contains('show')}; });
    await pg.evaluate(()=>scrollTo(0,0)); await pg.waitForTimeout(600);
    const flash=await pg.evaluate(()=>{ document.dispatchEvent(new CustomEvent('kt-fee',{detail:{col:'#35d6e8',usd:0.01}})); const b=document.querySelector('#toLive'); return b.classList.contains('hit'); });
    ((before&&after.found&&after.vis>=0.9&&after.gone&&flash)?OK:FAIL)('LIVE button at '+w+': '+(before?'shown at the top':'NOT shown at the top')+', one tap lands the '+(after.dial?'60-minute dial':'fee pulse block')
      +' '+(after.vis>=0.9?'fully on screen':'NOT fully on screen')+', button '+(after.gone?'steps aside':'stays')+', a new fee '+(flash?'flashes it':'does NOT flash it'));
  }catch(e){ FAIL('LIVE button at '+w+': '+String(e.message||e).slice(0,60)); }
}
await pg.setViewportSize({width:1440,height:900});
(relayAge>60?FAIL:OK)('relay data is '+relayAge.toFixed(0)+' min old');
/* the wallet list and the balances read from it, in counts per chain only */
try{ const cfg=openJ(await (await fetch(LIVE+'config.json?t='+Date.now())).json()), ws=(cfg.profiles||[]).flatMap(p=>p.wallets||[]), by={};
  for(const w of ws) by[w.chain]=(by[w.chain]||0)+1;
  OK('wallets in the sealed config by chain: '+JSON.stringify(by)+' · '+ws.filter(w=>w.role==='hold').length+' holdings-only');
  const idle=relay.idle;
  if(!idle) WARN('no wallet balances in the relay data');
  else { const rc={}, un={}; for(const r of idle.rows||[]){ rc[r.chain]=(rc[r.chain]||0)+1; if(r.usd==null) un[r.chain]=(un[r.chain]||0)+1; }
    const age=((Date.now()-(idle.t||0))/60000);
    (idle.stale||age>60?WARN:OK)('wallet balances '+(idle.stale?'HELD BACK ('+idle.staleWallets+' wallet(s) would not answer)':'complete')+', read '+age.toFixed(0)+' min ago · rows by chain '+JSON.stringify(rc)+' · unpriced '+JSON.stringify(un));
    for(const c of ['sui','tron']) if(by[c] && !rc[c]) WARN(c+' wallets listed but no '+c+' balance rows');
    const rs=idle.rows||[]; OK('staked rows '+rs.filter(r=>r.staked).length+' · lent rows '+rs.filter(r=>r.lent).length+' · owed rows '+rs.filter(r=>r.debt).length); }
  const N=relay.nfts;
  if(!N) WARN('no NFT summary in the relay data yet');
  else { const unread=Object.entries(N.read||{}).filter(([,v])=>v[0]<v[1]).map(([c,v])=>c+' '+v[0]+'/'+v[1]);
    (unread.length?WARN:OK)('NFTs: '+(N.cols||[]).length+' collections, '+(N.cols||[]).filter(c=>c.valueUsd!=null).length+' with a market floor, read '+(((Date.now()-N.t)/3600e3).toFixed(1))+'h ago'
      +(unread.length?' · not every wallet answered: '+unread.join(', '):''));
    // LP position receipts are valued as positions, never as NFTs
    const lpv=(N.cols||[]).filter(c=>(c.lp||/positions? nft|liquidity position|whirlpool position|concentrated liquidity/i.test(c.name||''))&&c.valueUsd!=null).length;
    (lpv?FAIL:OK)('LP position receipts given an NFT value: '+lpv+' (must be 0) · listed as receipts: '+(N.cols||[]).filter(c=>c.lp).length);
    // Sui floors from the daily TradePort read, and the floor history the trend lines and alerts use
    const sc=(N.cols||[]).filter(c=>c.chain==='sui'), age=N.suiT?(Date.now()-N.suiT)/3600e3:null;
    ((N.suiFrom==='tradeport'&&age<30)?OK:WARN)('Sui NFTs: '+sc.length+' collections, '+sc.filter(c=>c.valueUsd!=null).length+' priced · source '+(N.suiFrom||'chain')+(age!=null?' · read '+age.toFixed(0)+'h ago':''));
    const H=N.hist||{}; OK('NFT floor history: '+Object.keys(H).length+' collections · longest '+Math.max(0,...Object.values(H).map(h=>h.length))+' day(s)');
    // the unstake reminder watches the Ika-chan floor: it has to be found among the Sui collections
    (sc.some(c=>(/::ika_chan_nft::IkaChanNft/.test(c.type||'')||/ika[\s_-]*chan|squid[\s_-]*market/i.test(c.name||''))&&c.floor>0)?OK:WARN)('Ika-chan collection priced in the NFT list (the unstake reminder watches it): '+(sc.some(c=>(/::ika_chan_nft::IkaChanNft/.test(c.type||'')||/ika[\s_-]*chan|squid[\s_-]*market/i.test(c.name||''))&&c.floor>0)?'yes':'NO'));
    const I=relay.ink; (I&&Array.isArray(I.wallets)&&I.wallets.length&&(Date.now()-I.t)<30*3600e3?OK:WARN)('Ink Sack record: '+(I?I.wallets.length+' wallet(s), read '+((Date.now()-I.t)/3600e3).toFixed(0)+'h ago':'missing')); } }
catch(e){ WARN('wallet list / balances check failed'); }
// the relay's own errors this pass, by category only (the first word; the rest can name a wallet)
{ const cat={}; for(const e of relay.errors||[]){ const k=(String(e).match(/^[A-Za-z]+(?: (?:sui|tron|ethereum|solana))?/)||['other'])[0]; cat[k]=(cat[k]||0)+1; }
  OK('relay errors this pass by category: '+(Object.keys(cat).length?Object.entries(cat).map(([k,n])=>k+' ×'+n).join(', '):'none')); }
try{ const m=await (await fetch('https://kt-pulse.kereslek.workers.dev/m?n=5&t='+Date.now()+(TOK?'&k='+TOK:''))).json();
  const age=(Date.now()-m.last)/60000; (age>10?FAIL:OK)('minute recorder last read '+age.toFixed(1)+' min ago');
  // every pool the recorder reads gets a price, or its trades show no price line
  for(const [c,v] of Object.entries(m.pools||{})) if(v&&v[1]) (v[0]===v[1]?OK:FAIL)('recorder prices '+v[0]+' of '+v[1]+' '+c+' pools');
  if(!m.pools) WARN('recorder does not report its pool prices'); }
catch(e){ FAIL('minute recorder unreachable: '+e.message); }
/* trades recorded since prices were kept (5 Oct, 09:36 UTC) carry the price after the trade */
try{ const m=await (await fetch('https://kt-pulse.kereslek.workers.dev/m?n=180&t='+Date.now()+(TOK?'&k='+TOK:''))).json();
  /* counted per pool, per chain: one priced pool in a trade must not hide an unpriced one (Solana
     pools went unpriced until 5 Oct 13:30 UTC, behind Ethereum's priced ones) */
  const since={eth:Date.parse('2026-10-05T09:37:00Z'), sol:Date.parse('2026-10-05T13:30:00Z')}, n={eth:[0,0], sol:[0,0]};
  for(const t of m.trades||[]){ if(!t.x) continue;
    for(const k of Object.keys(t.pools||{})){ const sy=(m.pairs&&m.pairs[k])||[], c=sy.some(x=>/^W?ETH$/i.test(x))?'eth':'sol';
      if(!(t.t>since[c])) continue; n[c][1]++; if(t.px&&t.px[k]&&t.px[k][0]>0) n[c][0]++; } }
  for(const [c,lab] of [['eth','Ethereum'],['sol','Solana']])
    if(n[c][1]) (n[c][0]===n[c][1]?OK:WARN)(lab+' pool trades with a price: '+n[c][0]+' of '+n[c][1]);
    else OK(lab+': no pool trades since prices were kept, nothing to check yet'); }
catch(e){ WARN('could not read recent trades'); }
if(LOCKED){ try{ const r=await fetch('https://kt-pulse.kereslek.workers.dev/m?n=1&t='+Date.now()); (r.status===403?OK:FAIL)('minute recorder refuses a request without the token (HTTP '+r.status+')'); }
  catch(e){ WARN('could not ask the recorder without the token'); } }
if(LOCKED){ try{ const a=await (await fetch('https://kt-pulse.kereslek.workers.dev/auth/log?k='+TOK+'&t='+Date.now())).json(); (Array.isArray(a.ev)?OK:FAIL)('access log answers ('+a.ev.length+' events, '+a.live.length+' live)'); }
  catch(e){ FAIL('access log unreachable'); }
  try{ const r=await fetch('https://kt-pulse.kereslek.workers.dev/auth/log?t='+Date.now()); (r.status===403?OK:FAIL)('access log refuses a request without the token'); }catch(e){} }
for(const f of ['config.json','costs-main.json','ledger-main.json','fees-main.json','balances-main.json']){
  if(!LOCKED) break;
  try{ const j=await (await fetch(LIVE+f+'?t='+Date.now())).json(); (j&&j.lock===1?OK:FAIL)(f+' is published sealed'); }catch(e){ WARN(f+' unreadable'); } }

const R=new Map([...relay.eth,...relay.sol].map(p=>[String(p.id),p]));
const MONEY=['costUsd','feesEverUsd','feeAprPct','feesSelfUsd','lpVsHodlUsd'];
const live=await pg.evaluate(K=>[...state.positions.values()].map(p=>{ const o={id:String(p.id), lbl:p.pairLabel+' '+p.feeLabel, cached:!!p.cached, chain:p.chain, parity:p.parity||null};
  for(const k of [...K,'valueUsd','feesUsd','price','usd0','usd1','liq']) o[k]=p[k]; return o; }),MONEY);
const liveScan=live.some(l=>!l.cached);
(liveScan?OK:WARN)(liveScan?'live scan answered for '+live.filter(l=>!l.cached).length+' of '+live.length+' positions':'no live readings: the page is showing the relay copy only');
for(const id of R.keys()) if(!live.find(l=>l.id===id)) FAIL(LOCKED?'a relay position is missing from the page':'relay position '+id+' ('+R.get(id).pairLabel+') is missing from the page');
for(const [li,l] of live.entries()){
  const r=R.get(l.id), ref=LOCKED?'position '+(li+1):l.lbl+' '+l.id.slice(0,12);
  if(!r){ WARN(ref+' is on the page but not in the relay (new since its pass?)'); continue; }
  for(const k of MONEY){
    const want=k==='feesEverUsd'&&l.chain==='sol'&&r.feesLifeUsd!=null?r.feesLifeUsd:r[k];
    if(want==null) continue;
    if(l[k]==null || Math.abs(l[k]-want)>Math.max(0.01,Math.abs(want)*1e-6)) FAIL(ref+': '+k+' '+l[k]+' on the page, relay '+want+' (money figures must be the relay\'s)');
  }
  if(r.feesUsd>1 && !(l.feesUsd>=r.feesUsd*0.8)) (l.chain==='sol'?FAIL:WARN)(ref+': unclaimed '+money(l.feesUsd)+' vs relay '+money(r.feesUsd)
    +(l.chain==='sol'?'':' (a harvest since the relay pass reads this way)'));
  if(l.parity==='value') FAIL(ref+': the page\'s own check rejected the live value');
  else if(l.parity==='liq') WARN(ref+': liquidity changed since the relay pass (add/remove) — relay catches up next pass');
  else if(l.valueUsd>0 && r.valueUsd>0 && !l.cached){
    const allowed=lr(l.price/r.price)+lr(l.usd0/r.usd0)+lr(l.usd1/r.usd1)+0.03, dev=lr(l.valueUsd/r.valueUsd);
    if(dev>allowed) FAIL(ref+': value '+money(l.valueUsd)+' vs relay '+money(r.valueUsd)+' is more than prices moved');
  }
}

/* each panel renderer on its own: one that throws stops every panel after it, silently */
{ const bad=await pg.evaluate(()=>{ const out=[];
    for(const f of ['renderHeader','renderTiles','renderActions','renderIdle','renderSeismo','renderFeePulse','renderRank','renderFlow','renderOutlook','renderArch','renderCosmos','renderOps','renderGlobal','renderRadar','renderCompare','renderMatrix','renderSpark','renderTruth','renderPlaybook','renderCards','renderTokens','renderConcentration','renderCash'])
      if(typeof window[f]==='function'){ try{ window[f](); }catch(e){ out.push(f+': '+String(e&&e.message||e).replace(/0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{20,}|\d[\d.,]*/g,'…').slice(0,120)); } }
    return out; });
  (bad.length?FAIL:OK)('panel renderers: '+(bad.length?bad.join(' | '):'all render')); }
/* unclaimed fees by token, under the matrix: its total is the UNCLAIMED column's, its tokens add up
   to it, and it fits the screen at phone and laptop width (yes/no and counts only) */
for(const w of [390,1300]){
  await pg.setViewportSize({width:w, height:900}); await pg.waitForTimeout(400);
  const m=await pg.evaluate(()=>{ try{ renderMatrix(); }catch(e){}
    const h=document.querySelector('#mxMix'); if(!h) return {missing:true};
    const ps=ordered(), col=ps.reduce((s,p)=>s+(p.feesUsd>0?p.feesUsd:0),0);
    const head=Number((h.querySelector('.mm-h b')||{}).textContent?.replace(/[$,]/g,''));
    const items=[...h.querySelectorAll('.mm-leg span')], parts=items.map(x=>Number((x.title.match(/\$([\d,]+\.\d\d)/)||[])[1]?.replace(/,/g,'')||(x.textContent.match(/\$([\d,.]+)/)||[])[1]?.replace(/,/g,'')));
    const hr=h.getBoundingClientRect();
    return {shown:!h.hidden, n:items.length, headOk:Math.abs(head-col)<0.01, partsOk:Math.abs(parts.reduce((a,b)=>a+b,0)-col)<=Math.max(0.05,col*0.0005),
      fits:hr.right<=innerWidth+1 && items.every(x=>x.getBoundingClientRect().right<=hr.right+1) && document.documentElement.scrollWidth<=innerWidth+1, any:col>0}; });
  if(m.missing) FAIL('unclaimed-by-token strip missing under the matrix');
  else if(!m.any) OK('unclaimed-by-token strip: no unclaimed fees, hidden ('+(m.shown?'but shown':'ok')+')');
  else ((m.shown&&m.headOk&&m.partsOk&&m.fits)?OK:FAIL)('unclaimed-by-token strip at '+w+' px: '+m.n+' token(s) · total equals the UNCLAIMED column '+(m.headOk?'yes':'NO')
    +' · tokens add up to it '+(m.partsOk?'yes':'NO')+' · fits the screen '+(m.fits?'yes':'NO'));
}
await pg.setViewportSize({width:1440, height:900});
const sums=await pg.evaluate(()=>{ const ps=[...state.positions.values()], s=k=>ps.reduce((a,p)=>a+(p[k]||0),0);
  const tile=n=>{ const t=[...document.querySelectorAll('.tiles .tile')].find(t=>((t.querySelector('.k')||{}).textContent||'').trim().toUpperCase().startsWith(n));
    const v=t&&(t.querySelector('.v')||{}).textContent; const m=v&&v.replace(/,/g,'').match(/-?\$?([\d.]+)/); return m?+m[1]:null; };
  return {value:s('valueUsd'), unclaimed:s('feesUsd'), tTotal:tile('TOTAL POSITION VALUE'), tUnclaimed:tile('UNCLAIMED FEES'),
    tok:((document.querySelector('.tok-total-split')||{}).innerText||'').replace(/\n/g,' / '), idle:state.idle&&state.idle.totalUsd}; });
if(sums.tTotal!=null) (Math.abs(sums.tTotal-sums.value)>1.5?FAIL:OK)('TOTAL POSITION VALUE tile '+money(sums.tTotal)+' vs cards '+money(sums.value));
else WARN('TOTAL POSITION VALUE tile not found');
if(sums.tUnclaimed!=null) (Math.abs(sums.tUnclaimed-sums.unclaimed)>0.02?FAIL:OK)('UNCLAIMED FEES tile '+money(sums.tUnclaimed)+' vs cards '+money(sums.unclaimed));
else WARN('UNCLAIMED FEES tile not found');
const relayUnclaimed=[...R.values()].reduce((a,p)=>a+(p.feesUsd||0),0);
(sums.unclaimed<relayUnclaimed*0.9?WARN:OK)('unclaimed on the page '+money(sums.unclaimed)+', relay '+money(relayUnclaimed));
const relayIdle=(relay.idle&&relay.idle.rows||[]).reduce((a,r)=>a+(r.usd||0),0);
const inLps=(sums.tok.replace(/,/g,'').match(/\$([\d.]+) in LPs/)||[])[1];
if(inLps!=null) (Math.abs(+inLps-sums.value)>2?FAIL:OK)('TOKEN EXPOSURE in LPs $'+inLps+' vs cards '+money(sums.value));
if(relayIdle>100 && /\$0 idle/.test(sums.tok)) FAIL('TOKEN EXPOSURE reads "$0 idle" while the relay holds '+money(relayIdle)+' idle'); else OK('TOKEN EXPOSURE: '+sums.tok);
(errs.length?FAIL:OK)('page errors: '+(errs.join(' | ')||'none'));
const pxShown=await pg.evaluate(()=>document.querySelectorAll('.fpd-feed .pxl').length);
OK('price lines in LATEST FEES: '+pxShown);
const logLines=await pg.evaluate(()=>[...document.querySelectorAll('#logBody > *')].map(e=>e.innerText.replace(/\s+/g,' ').trim()).filter(t=>/Live\/relay check/.test(t)));
if(!LOCKED) for(const t of logLines) notes.push('event log: '+t); else if(logLines.length) notes.push(logLines.length+' live/relay check line(s) in the event log');
// close the page the way a person closing the tab would, so the access log ends this visit now
// instead of showing it live for a few minutes after the run
try{ await pg.close({runBeforeUnload:true}); await new Promise(r=>setTimeout(r,1500)); }catch(e){}
await b.close(); if(srv) srv.close();

const md=['# Daily audit '+new Date().toISOString().slice(0,16).replace('T',' ')+' UTC · '+build,
  fails.length?'**'+fails.length+' failed**':'**All checks passed**', '',
  ...fails.map(x=>'- ❌ '+x), ...warns.map(x=>'- ⚠️ '+x), ...notes.map(x=>'- ✅ '+x)].join('\n');
if(process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md+'\n');
console.log('\n'+fails.length+' fail, '+warns.length+' warn');
process.exit(fails.length?1:0);

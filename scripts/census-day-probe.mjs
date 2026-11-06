/* YESTERDAY vs 7-DAY AVG on the live deck: switch to it and say whether each part of the panel has a
   figure. The log is public: yes/no and counts only, never a figure, a name or the panel's text. */
import { chromium } from 'playwright';
import crypto from 'node:crypto';
const LIVE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const L=await (await fetch(LIVE+'lock.json?t='+Date.now())).json();
const BITS=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').toString('base64');
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1440,height:900}});
await ctx.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey',JSON.stringify({salt,bits})); }catch(e){} },[L.salt,BITS]);
const pg=await ctx.newPage(); let errs=0;
await pg.waitForTimeout(1); pg.on('pageerror',()=>errs++);
await pg.goto(LIVE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
await pg.waitForFunction(()=>!!document.querySelector('#censusBody .cz-bar'),null,{timeout:90000}).catch(()=>{});
await pg.waitForTimeout(3000);
const yn=x=>x?'yes':'no';
for(const w of ['w','d']){
  const r=await pg.evaluate(async w=>{ const btn=document.querySelector('#censusBody [data-cz="win"][data-v="'+w+'"]'); if(!btn) return null;
    btn.click(); await new Promise(r=>setTimeout(r,800));
    const h=document.querySelector('#censusBody'), C=state.census, W=czWins(w);
    const cards=[...h.querySelectorAll('.cz-tk')].map(c=>{ const v=[...c.querySelectorAll('.cz-big,.cz-q .n,.cz-k .v')]; return [v.filter(x=>x.textContent.trim()==='—').length, v.length]; });
    const rows=[...h.querySelectorAll('.cz-row .cz-ch')].map(x=>x.textContent.trim()==='—');
    const tok=C.tokens.map(T=>{ const t=czToken(T,(C.mine||[]).filter(m=>m.tok===T.key),W), mine=(C.mine||[]).filter(m=>m.tok===T.key&&!m.past), y=W.A[0];
      return {mkt:T.market[y]!=null, mktB:W.B.filter(d=>T.market[d]!=null).length, basis:!!t.basis, pieA:t.A.pie!=null, youA:t.A.you!=null, youB:t.B.you!=null,
        fee:mine.filter(M=>M.fees&&M.fees[y]!=null).length, share:mine.filter(M=>M.share&&M.share[y]).length, rep:mine.filter(M=>M.rep&&M.rep[y]&&M.rep[y].cov>=0.99).length, n:mine.length}; });
    const on=document.querySelector('#censusBody [data-cz="win"][data-v="'+w+'"]');
    return {pressed:!!on&&on.getAttribute('aria-pressed')==='true', namesYday:czIsY?czIsY():null, ageH:Math.round((Date.now()-C.t)/36e5), yIsLast:W.A[0]===new Date(Date.now()-864e5).toISOString().slice(0,10),
      censusHasY:new Date(C.t).toISOString().slice(0,10)>W.A[0], cards, rowsDash:rows.filter(Boolean).length, rows:rows.length, tok}; }, w);
  if(!r){ console.log(w+': no switch'); continue; }
  console.log('== '+(w==='d'?'YESTERDAY vs 7-DAY AVG':'THIS WEEK vs LAST')+' ==');
  console.log('switch on: '+yn(r.pressed)+(w==='d'?' · ends on yesterday: '+yn(r.namesYday)+' (else on the census’s last whole day, named)':'')+' · census '+r.ageH+' h old · census written after yesterday ended: '+yn(r.censusHasY));
  console.log('token cards, figures showing — : '+r.cards.map(c=>c[0]+' of '+c[1]).join(', ')+' · pool lines with — : '+r.rowsDash+' of '+r.rows);
  r.tok.forEach((t,i)=>console.log('token '+(i+1)+': market has the newest day '+yn(t.mkt)+', older days '+t.mktB+' · comparison source found '+yn(t.basis)+' · LPs’ fees newest '+yn(t.pieA)+' · yours newest '+yn(t.youA)+' older '+yn(t.youB)
    +' · of '+t.n+' pool(s) with the newest day: fee counters '+t.fee+', share '+t.share+', replay '+t.rep));
}
console.log('page errors: '+errs);
await b.close();

/* Why the daily Sui read stopped getting TradePort's answers (every run since 10 Oct reads "NOT READ"):
   one Sui wallet's page opened the way sui-daily.mjs opens it, and what came back described without
   naming anything — the document's status, whether the page is a bot check, which hosts answered and
   how often, the data service's operations and their statuses. Once with the daily job's browser
   settings and once with the browser as it is.

   Run inside a gh-pages checkout. The log is public: hosts, operation names, statuses, counts and
   yes/no only — never a wallet, a collection, a page title or an amount. */
import {chromium} from 'playwright';
import {initLock, readJ} from './lock.mjs';
const OUT='deck-r7k4x9';
initLock(OUT);
const cfg=readJ(OUT+'/config.json');
const wallets=cfg.profiles.flatMap(p=>[...(p.wallets||[]),...(p.altWallets||[])]).filter(w=>w.chain==='sui');
const hide=s=>String(s).replace(/0x[0-9a-fA-F]{8,}/g,'0x…').replace(/[1-9A-HJ-NP-Za-km-z]{25,}/g,'…');
const w=wallets[0];
if(!w){ console.log('no Sui wallet in the config'); process.exit(1); }
console.log('sui wallets: '+wallets.length+' · probing one');
const DAILY_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
for(const [label, opts] of [['the daily job’s settings', {userAgent:DAILY_UA}], ['the browser as it is', {}]]){
  const b=await chromium.launch(), ctx=await b.newContext({viewport:{width:1300,height:1000}, ...opts}), pg=await ctx.newPage();
  const hosts={}, ops={}, docs=[];
  pg.on('response', async r=>{ let h; try{ h=new URL(r.url()).host; }catch(e){ return; }
    hosts[h]=(hosts[h]||0)+1;
    const q=r.request();
    if(q.resourceType()==='document') docs.push(r.status()+' '+h);
    if(/graphql|indexer/.test(r.url())||/^api\./.test(h)){
      let op='(none)'; try{ op=(JSON.parse(q.postData()||'{}').operationName)||'(none)'; }catch(e){}
      let tail=''; try{ const j=await r.json(); if(j&&j.errors) tail=' errors '+[...new Set(j.errors.map(e=>(e.extensions&&e.extensions.code)||'?'))].join(','); else if(j&&j.data) tail=' data'; }catch(e){ tail=' not json'; }
      (ops[h+' '+op]=ops[h+' '+op]||[]).push(r.status()+tail); } });
  let nav='ok';
  try{ await pg.goto('https://www.tradeport.xyz/sui/'+w.address+'?tab=items',{waitUntil:'domcontentloaded',timeout:60000}); }
  catch(e){ nav=hide(String(e.message||e).split('\n')[0]).slice(0,120); }
  await pg.waitForTimeout(25000);
  const look=await pg.evaluate(()=>{ const txt=(document.title||'')+' '+((document.body&&document.body.innerText)||'').slice(0,4000), html=document.documentElement.innerHTML.slice(0,40000);
    return {check:/just a moment|verify you are human|attention required|access denied|checking your browser|captcha|are you a robot|request blocked|cf-chl|turnstile/i.test(txt+' '+html),
      cf:!!document.querySelector('#challenge-form,#cf-challenge-running,iframe[src*="challenges.cloudflare.com"]'), len:((document.body&&document.body.innerText)||'').length}; })
    .catch(e=>({check:null, cf:null, len:null}));
  console.log('== '+label+' (Chromium '+b.version()+'): navigation '+nav+' · documents '+(hide(docs.join(', '))||'none')+' · bot check '+(look.check==null?'—':look.check?'YES':'no')+(look.cf?' (Cloudflare challenge)':'')+' · page text '+(look.len==null?'—':look.len+' chars'));
  console.log('   hosts: '+hide(Object.entries(hosts).sort((a,c)=>c[1]-a[1]).slice(0,16).map(([h,n])=>h+' ×'+n).join(', ')));
  if(!Object.keys(ops).length) console.log('   data service: no request seen');
  for(const [k,v] of Object.entries(ops)) console.log('   data: '+hide(k)+' → '+v.slice(0,4).join(' | ')+(v.length>4?' … ('+v.length+' answers)':''));
  await b.close();
}

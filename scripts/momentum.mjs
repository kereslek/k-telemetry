/* Momentum: how fast your tokens and pools are moving, every hour.

   Read from the relay's own day records (deck-r7k4x9/daily-<slug>.json: what was held each day and
   at what prices), the tokens' daily prices for the last three years (DefiLlama, kept between runs
   in deck-r7k4x9/momentum-px-<slug>.json) and the last output, for the steady level. The arithmetic
   is scripts/momentum-core.mjs and is tested on made-up records by scripts/momentum.test.mjs.

   Written sealed into deck-r7k4x9/momentum-<slug>.json for the dashboard's MOMENTUM tile and panel;
   the price file is sealed too, because the tokens it lists are the ones held. The log is public:
   pass/fail and counts only — never an amount, a token, a level or a date of yours. */
import { initLock, readJ, writeJ, lockOn } from './lock.mjs';
import { analyze, canon, isStable, holdingsOf, dayStr, dayNum } from './momentum-core.mjs';

const OUT='deck-r7k4x9', SLUG=process.env.PROFILE||'main', YEARS=3, MAXTOK=12;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const say=(good,m)=>console.log((good?'ok    ':'FAIL  ')+m);

if(!String(process.env.DECK_PASSPHRASE||'').trim()){ console.log('DECK_PASSPHRASE is not set: nothing done'); process.exit(1); }
initLock(OUT);
if(!lockOn()){ console.log('the lock is off: nothing written'); process.exit(1); }
const rd=f=>{ try{ return readJ(OUT+'/'+f); }catch(e){ return null; } };
const recs=rd('daily-'+SLUG+'.json'), data=rd('data-'+SLUG+'.json'), prev=rd('momentum-'+SLUG+'.json');
const cache=rd('momentum-px-'+SLUG+'.json')||{v:1, px:{}};
if(!Array.isArray(recs)){ console.log('FAIL the relay’s day records could not be read: nothing done'); process.exit(1); }
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

/* ---------- each token's outside name: DefiLlama's chain:address, or a CoinGecko id for coins ---------- */
const LL={ethereum:'ethereum', arbitrum:'arbitrum', base:'base', optimism:'optimism', polygon:'polygon'};
const ids=new Map(); const setId=(k,id)=>{ if(k&&id&&!ids.has(k)) ids.set(k,id); };
setId('evm:native','coingecko:ethereum'); setId('sol:native','coingecko:solana'); setId('evm:pol','coingecko:polygon-ecosystem-token');
for(const r of data?.idle?.rows||[]){
  if(!r||!r.addr) continue;
  const k=canon((r.chain==='sol'?'sol':'evm')+':'+(r.native&&r.chain==='polygon'?'pol':String(r.addr).toLowerCase()));
  setId(k, r.llama || (r.native ? (r.chain==='sol'?'coingecko:solana':r.chain==='polygon'?'coingecko:polygon-ecosystem-token':'coingecko:ethereum')
    : r.chain==='sol' ? 'solana:'+r.addr : (LL[r.chain]||'ethereum')+':'+String(r.addr).toLowerCase()));
}
for(const p of [...(data?.eth||[]), ...(data?.sol||[])]) for(const w of [0,1]){
  const sol=p.chain==='sol', a=sol?(w?p.mint1:p.mint0):(w?p.token1:p.token0); if(!a) continue;
  setId(canon((sol?'sol':'evm')+':'+String(a).toLowerCase()), sol?'solana:'+a:(LL[p.chain]||'ethereum')+':'+String(a).toLowerCase());
}

/* ---------- which tokens: everything that was 1% of the value on any recorded day, dollars aside ---------- */
const share=new Map();
for(const r of recs.slice(-120)){ if(!Array.isArray(r.ps)&&!Array.isArray(r.w)) continue;
  const H=holdingsOf(r); let V=0; for(const e of H.values()) V+=e.a*e.u;
  for(const e of H.values()){ if(isStable(e.s,e.u)||!(V>0)) continue; share.set(e.k, Math.max(share.get(e.k)||0, e.a*e.u/V)); } }
const want=[...share.entries()].filter(([,w])=>w>=0.01).sort((a,b)=>b[1]-a[1]).slice(0,MAXTOK).map(([k])=>k);
const named=want.filter(k=>ids.has(k));

/* ---------- daily prices, three years, kept between runs; only the newest days are fetched again ---------- */
/* a token that moved to a new contract keeps the old contract's prices for the days before the move */
const BEFORE={'evm:0x8cd41041505885ef0ad3858181d66f17be8aae7e':'ethereum:0x037a54aab062628c9bbae1fdb1583c195585fe41'};   // LCX
const LLAMA='https://coins.llama.fi';
async function getJ(u){ for(let k=0;k<3;k++){ try{ const r=await fetch(u,{signal:AbortSignal.timeout(30000)}); if(r.ok) return await r.json(); if(r.status===429) await sleep(5000); }catch(e){} await sleep(1500*(k+1)); } return null; }
async function chart(id, from, span){
  const j=await getJ(LLAMA+'/chart/'+encodeURI(id)+'?start='+from+'&span='+span+'&period=1d&searchWidth=600');
  const c=j&&j.coins&&(j.coins[id]||Object.values(j.coins)[0]);
  return Array.isArray(c&&c.prices)?c.prices:null;
}
const now=Date.now(), end=Math.floor(now/864e5)*86400; let calls=0, fetched=0, kept=0, failedTok=0;
cache.px=cache.px||{};
for(const k of named){
  const id=ids.get(k), have=cache.px[k];
  const full=!have||have.id!==id||!(now-(have.full||0)<20*3600e3);
  const days=full?Math.round(YEARS*365.25)+3:12, from=end-days*86400, d=full?{}:{...have.d};
  let got=0, bad=false;
  for(let s=from; s<end; s+=365*86400){
    const span=Math.min(365, Math.ceil((end-s)/86400)+1), pts=await chart(id, s, span); calls++;
    if(!pts){ bad=true; continue; }
    for(const p of pts){ const t=+p.timestamp, v=+p.price; if(!(t>0&&v>0)) continue; d[dayStr(Math.round(t/86400))]=v; got++; }
    await sleep(400);
  }
  if(got&&full&&BEFORE[k]){ const first=Object.keys(d).sort()[0], old={};
    for(let s=from; s<end; s+=365*86400){ const pts=await chart(BEFORE[k], s, Math.min(365, Math.ceil((end-s)/86400)+1)); calls++;
      for(const p of pts||[]){ const t=+p.timestamp, v=+p.price; if(t>0&&v>0) old[dayStr(Math.round(t/86400))]=v; } await sleep(400); }
    const join=old[first]; if(join>0) for(const [dd,v] of Object.entries(old)) if(dd<first) d[dd]=v*d[first]/join; }
  if(got){ cache.px[k]={id, full:full&&!bad?now:(have?.full||0), d}; fetched++; }
  else if(have){ kept++; } else failedTok++;
}
// tokens no longer held are let go of after a while, so the file does not grow for ever
for(const k of Object.keys(cache.px)) if(!want.includes(k) && now-(cache.px[k].full||0)>14*864e5) delete cache.px[k];
const ext={}; for(const k of want) if(cache.px[k]) ext[k]=cache.px[k].d;

/* ---------- the reading ---------- */
const out=analyze({recs, ext, prev, today, mixYears:YEARS});
out.t=Date.now(); out.slug=SLUG;

/* ---------- what the run found, in counts only; a gap is noted, only a leak stops the write ---------- */
const note=m=>console.log('note  '+m);
const withH=recs.filter(r=>Array.isArray(r.ps)||Array.isArray(r.w)).length;
note('day records with holdings: '+withH+' of '+recs.length);
note('reading: '+(out.status==='ok'?'a level today':out.status==='short'?'waiting for history ('+out.need+' more day(s) of records)':'none yet'));
note('tokens with an outside price history: '+named.length+' of '+want.length+' · '+fetched+' refreshed, '+kept+' kept from the last run, '+failedTok+' not found ('+calls+' calls)');
if(out.status==='ok'){
  note('index: '+(out.days||[]).length+' days shown; share of the value priced at both ends of a day: '+(out.cov!=null?Math.round(out.cov*100)+'%':'—')+'; record prices replaced as misreads: '+out.misreads);
  note('long test: '+(out.test?out.test.years.toFixed(1)+' years, '+Math.round(out.test.cov*100)+'% of the tokens covered':'not run (no price histories)'));
}
const txt=JSON.stringify(out);
const clean=!/"a":|"u":|"V":|"H":|"P":|"addr"|"wallet"/.test(txt) && !/0x[0-9a-f]{40}/i.test(txt);
say(clean, 'the reading carries no amounts, addresses or token contracts');
if(!clean){ console.log('nothing written'); process.exit(1); }
writeJ(OUT+'/momentum-'+SLUG+'.json', out);
writeJ(OUT+'/momentum-px-'+SLUG+'.json', {v:1, t:Date.now(), px:cache.px});
console.log('sealed: the reading and its price file');

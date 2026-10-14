/* Where did the portfolio history fall and come back? The fifteen-minute history (hist-<slug>.json)
   is read whole: a point whose total sits well below the day around it is a candidate misread. For
   each run of them: when (Budapest), how many points, how far down, and which part fell — LP and
   fees, the wallets, the NFTs — and whether the wallet read called itself stale. Then the relay's own
   snapshot from that moment is set beside the last good one before it, token by token: which holding
   went missing, and whether its amount or its price did.

   Run inside a gh-pages checkout with its history (the archive of every snapshot). The log is public:
   times, counts, ratios and token tickers only — never an amount, an address or an id. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initLock, readJ } from './lock.mjs';

const OUT='deck-r7k4x9', SLUG=process.env.PROFILE||'main', PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const FROM=Date.parse(process.env.FROM||'')||Date.now()-4*864e5, DROP=+(process.env.DROP||0.8);
if(!PASS){ console.log('DECK_PASSPHRASE is not set: nothing read'); process.exit(1); }
initLock(OUT);
const H=3600e3;
const bud=ms=>new Date(ms).toLocaleString('sv-SE',{timeZone:'Europe/Budapest'}).slice(0,16);
const med=a=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const rx=x=>x==null||!isFinite(x)?'—':x.toFixed(2)+'x';

/* ---------- 1. the fifteen-minute history ---------- */
const hist=(readJ(OUT+'/hist-'+SLUG+'.json')||[]).filter(h=>h&&h.t&&h.v!=null).sort((a,b)=>a.t-b.t);
const tot=h=>h.i!=null?(h.v+(h.f||0)+h.i+(h.n||0)):null;
const pts=hist.filter(h=>tot(h)!=null);
console.log('history: '+hist.length+' points, '+pts.length+' with the wallets in them · '+(pts.length?bud(pts[0].t)+' → '+bud(pts[pts.length-1].t):'none'));
// each point against the median of the day around it (±12 hours): a misread is short beside a day
const base=(h,f)=>{ const v=pts.filter(q=>q!==h&&Math.abs(q.t-h.t)<=12*H).map(f).filter(x=>x!=null); return v.length>=8?med(v):null; };
const runs=[]; let cur=null;
for(const h of pts){ if(h.t<FROM) continue;
  const b=base(h,tot), r=b>0?tot(h)/b:null;
  if(r!=null&&r<DROP){ if(!cur){ cur={a:h.t, b:h.t, n:0, worst:h, wr:r}; runs.push(cur); } cur.b=h.t; cur.n++; if(r<cur.wr){ cur.wr=r; cur.worst=h; } }
  else cur=null; }
console.log('points below '+Math.round(DROP*100)+'% of the day around them, since '+bud(FROM)+': '+runs.reduce((s,r)=>s+r.n,0)+' in '+runs.length+' run(s)');
for(const r of runs){ const h=r.worst;
  const parts=[['LP + fees',x=>x.v+(x.f||0)],['wallets',x=>x.i],['NFTs',x=>x.n!=null?x.n:null]].map(([l,f])=>{ const b=base(h,f); return l+' '+(b>0&&f(h)!=null?rx(f(h)/b):'—'); });
  console.log('  '+bud(r.a)+(r.n>1?' → '+bud(r.b):'')+' Budapest · '+r.n+' point(s) · lowest '+rx(r.wr)+' the day around it · at the lowest: '+parts.join(', ')+(h.is?' · the wallet read called itself stale':'')); }

/* ---------- 2. the relay's snapshots at those moments, beside the last good one ---------- */
if(runs.length){
  const keys=new Map(), keyFor=L=>{ const k=L.salt+'|'+L.iter; if(!keys.has(k)) keys.set(k, crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').subarray(0,32)); return keys.get(k); };
  const openWith=(key,e)=>{ const all=Buffer.from(e.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv,'base64')); d.setAuthTag(all.subarray(all.length-16)); return Buffer.concat([d.update(all.subarray(0,all.length-16)), d.final()]).toString('utf8'); };
  const show=(c,p)=>{ try{ return execFileSync('git',['show',c+':'+p],{maxBuffer:512<<20, stdio:['ignore','pipe','ignore']}).toString('utf8'); }catch(e){ return null; } };
  let headLock=null; try{ headLock=JSON.parse(fs.readFileSync(OUT+'/lock.json','utf8')); }catch(e){}
  const decode=(c,txt)=>{ const j=JSON.parse(txt); if(!(j&&j.lock===1)) return j; const tries=[headLock]; try{ tries.push(JSON.parse(show(c,OUT+'/lock.json'))); }catch(e){}
    for(const L of tries.filter(Boolean)){ try{ return JSON.parse(openWith(keyFor(L), j)); }catch(e){} } return null; };
  const path=OUT+'/data-'+SLUG+'.json';
  let commits=[]; try{ commits=execFileSync('git',['log','--format=%H %ct','--since='+Math.floor((FROM-24*H)/1000),'--',path],{maxBuffer:64<<20, stdio:['ignore','pipe','ignore']}).toString().trim().split('\n').filter(Boolean).map(l=>{ const [h,ct]=l.split(' '); return {h, ct:+ct*1000}; }).sort((a,b)=>a.ct-b.ct); }catch(e){ console.log('the archive could not be read here'); }
  console.log('snapshots in the archive since a day before: '+commits.length);
  const snapAt=t=>{ let best=null; for(const c of commits){ if(Math.abs(c.ct-t)<=10*60e3&&(!best||Math.abs(c.ct-t)<Math.abs(best.ct-t))) best=c; } return best; };
  const book=d=>{ const o={}; const rows=d&&d.idle&&Array.isArray(d.idle.rows)?d.idle.rows:[];
    for(const r of rows){ const k=(r.chain||'?')+':'+(r.native||r.addr==='native'?'native':String(r.addr||'').toLowerCase());
      const e=o[k]||(o[k]={s:r.native||r.addr==='native'?(r.chain==='sol'?'SOL':r.chain==='polygon'?'POL':'ETH'):(r.symbol||'?'), ch:r.chain||'?', a:0, usd:0, px:null, rows:0});
      e.a+=+r.amount||0; e.usd+=+r.usd||0; if(e.px==null&&r.px!=null) e.px=+r.px; e.rows++; }
    return {o, rows:rows.length, wallets:new Set(rows.map(r=>String(r.wallet||'').toLowerCase()).filter(Boolean)).size, stale:!!(d&&d.idle&&d.idle.stale), cs:(d&&d.chainStatus)||{}, nPos:[...(d&&d.eth||[]),...(d&&d.sol||[])].length}; };
  for(const r of runs.slice(0,6)){
    const bad=snapAt(r.worst.t); if(!bad){ console.log('  '+bud(r.worst.t)+': no snapshot within ten minutes'); continue; }
    const good=pts.filter(h=>h.t<r.a).slice(-1)[0], gc=good?snapAt(good.t):null;
    const B=book(decode(bad.h, show(bad.h,path)||'null')), G=gc?book(decode(gc.h, show(gc.h,path)||'null')):null;
    console.log('  '+bud(r.worst.t)+' beside '+(good?bud(good.t):'—')+': wallet rows '+B.rows+' vs '+(G?G.rows:'—')+' · wallets with rows '+B.wallets+' vs '+(G?G.wallets:'—')+' · positions '+B.nPos+' vs '+(G?G.nPos:'—')
      +' · stale '+(B.stale?'yes':'no')+' · chains '+Object.entries(B.cs).map(([c,s])=>c+' '+s).join(', '));
    if(G){ const ks=new Set([...Object.keys(B.o),...Object.keys(G.o)]), diff=[];
      for(const k of ks){ const b=B.o[k], g=G.o[k]; const gu=g?g.usd:0, bu=b?b.usd:0; if(Math.abs(gu-bu)<Math.max(50,0.02*Math.abs(gu))) continue;
        diff.push({k, s:(b||g).s, ch:(b||g).ch, share:gu>0?(gu-bu)/gu:null, aR:g&&g.a?(b?b.a/g.a:0):null, pR:g&&g.px&&b&&b.px?b.px/g.px:null, gone:!b, noPx:!!b&&b.px==null, w:Math.abs(gu-bu)}); }
      diff.sort((x,y)=>y.w-x.w);
      for(const x of diff.slice(0,6)) console.log('     '+x.s+' ('+x.ch+', wallet): '+(x.gone?'missing from the read':'amount '+rx(x.aR)+', price '+(x.noPx?'none':rx(x.pR))));
      if(!diff.length) console.log('     no wallet holding moved much: the drop is elsewhere'); } }
}

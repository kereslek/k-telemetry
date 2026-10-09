/* Reconcile the whole portfolio history from the relay's own archive.

   Every relay pass since July committed its snapshot (data-<slug>.json) to gh-pages, so the
   repository's history holds every figure the dashboard ever drew. This replays all of them and
   rebuilds the total — LP value, unclaimed fees, every wallet on every chain, NFTs at floor — the
   way each panel computed it at the time, then again with the reads that were wrong taken out:

     · a wallet token priced far from its own market (3x either way against the median of its
       own prices in the 36 hours around the read) is re-priced at that median — the LP side is
       taken as recorded, its value being the pools' own math;
     · Polygon's native coin is POL, and the relay priced it as ETH — it is re-priced as POL;
     · an NFT that is an LP position's receipt was valued at a floor before 7 Oct — it is not;
     · a read where a chain was down, or a total that jumps and comes straight back within a few
       reads (the shape of a misread, not of a market), is left out rather than charted.

   The result is sealed into <out>/recon-<slug>.json for the page. The log is public: dates,
   counts, ratios, token tickers and market prices only — never an amount, address or ID. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { initLock, readJ, writeJ, lockOn } from './lock.mjs';

const OUT=process.env.OUT||'deck-r7k4x9', SLUG=process.env.PROFILE||'main', REF=process.env.REF||'HEAD';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
const WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', WSOL='So11111111111111111111111111111111111111112';
const LPK=/^0x(c36442b4a4522e871399cd717abdd847ab11fe88|bd216513d74c8cf14cf4747e6aaa6420ff64ee9e|46a15b0b27311cedf172ab29e4f4766fbe7f4364|2214a42d8e2a1d20635c2cb0664422c528b6a432)$/i;
const LPN=/positions? nft|liquidity position|lp position|whirlpool position|concentrated liquidity|clmm position|dlmm position/i;
const isLpNft=c=>!!(c&&(c.lp||LPK.test(String(c.key||''))||LPN.test(String(c.name||''))));
const H=3600e3, DAY=24*H;
const tokKey=(chain,addr)=>{
  const ch=chain==='sol'?'sol':(chain||'ethereum');
  if(ch==='sol') return 'sol:'+(addr===WSOL?'native':addr);
  const a=String(addr||'').toLowerCase();
  return ch+':'+(a===WETH?'native':a);
};
const chainOfKey=k=>k.split(':')[0];
const chainName=c=>({sol:'Solana',ethereum:'Ethereum',arbitrum:'Arbitrum',base:'Base',optimism:'Optimism',polygon:'Polygon',sui:'Sui',tron:'Tron'}[c]||c);
const bud=ms=>new Date(ms).toLocaleString('sv-SE',{timeZone:'Europe/Budapest'}).slice(0,16);
const budDay=ms=>bud(ms).slice(0,10);
const pct=x=>(x*100).toFixed(1)+'%';
const rx=x=>x>=10?x.toFixed(0)+'x':x.toFixed(2)+'x';
const med=a=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const r2=x=>x==null?null:Math.round(x*100)/100;

if(!PASS){ console.log('DECK_PASSPHRASE is not set: the archive is sealed and cannot be read. Nothing done.'); process.exit(1); }
initLock(OUT);                     // the current key, for sealing the result

/* Every key the archive was ever sealed under: one per lock.json salt. */
const keys=new Map();
const keyFor=L=>{ const k=L.salt+'|'+L.iter; if(!keys.has(k)) keys.set(k, crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').subarray(0,32)); return keys.get(k); };
const openWith=(key,e)=>{ const iv=Buffer.from(e.iv,'base64'), all=Buffer.from(e.ct,'base64');
  const d=crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(all.subarray(all.length-16));
  return Buffer.concat([d.update(all.subarray(0,all.length-16)), d.final()]).toString('utf8'); };
const sealed=j=>!!(j&&typeof j==='object'&&j.lock===1&&j.iv&&j.ct);
const show=(c,p)=>{ try{ return execFileSync('git',['show',c+':'+p],{maxBuffer:512<<20, stdio:['ignore','pipe','ignore']}).toString('utf8'); }catch(e){ return null; } };
let headLock=null; try{ headLock=JSON.parse(fs.readFileSync(OUT+'/lock.json','utf8')); }catch(e){}
const lockAt=new Map();
function decode(c, txt){
  const j=JSON.parse(txt);
  if(!sealed(j)) return {d:j, sealed:false};
  const tries=[];
  if(headLock) tries.push(headLock);
  if(!lockAt.has(c)){ try{ lockAt.set(c, JSON.parse(show(c, OUT+'/lock.json'))); }catch(e){ lockAt.set(c,null); } }
  if(lockAt.get(c)) tries.push(lockAt.get(c));
  for(const L of tries){ try{ return {d:JSON.parse(openWith(keyFor(L), j)), sealed:true}; }catch(e){} }
  throw new Error('no key opens it');
}

/* ---------------- 1. replay every snapshot ---------------- */
const path=OUT+'/data-'+SLUG+'.json';
const commits=execFileSync('git',['log','--format=%H %ct','--reverse',REF,'--',path],{maxBuffer:64<<20}).toString().trim().split('\n')
  .filter(Boolean).map(l=>{ const [h,ct]=l.split(' '); return {h, ct:+ct*1000}; });
console.log('archive: '+commits.length+' committed snapshots of the relay\'s data');

const snaps=[]; let nSealed=0, nPlain=0, nFail=0, seenT=new Set();
for(const c of commits){
  const txt=show(c.h, path); if(!txt){ nFail++; continue; }
  let d; try{ const o=decode(c.h, txt); d=o.d; o.sealed?nSealed++:nPlain++; }catch(e){ nFail++; continue; }
  const t=+d.t||c.ct; if(seenT.has(t)) continue; seenT.add(t);   // a rebase can commit one pass twice
  snaps.push(extract(d, t));
}
snaps.sort((a,b)=>a.t-b.t);
console.log('read: '+snaps.length+' distinct passes, '+(snaps.length?budDay(snaps[0].t)+' → '+budDay(snaps[snaps.length-1].t):'none')+' ('+nSealed+' sealed, '+nPlain+' from before the lock, '+nFail+' unreadable)');

function extract(d, t){
  const cs=d.chainStatus||{};
  const ok=Object.values(cs).every(v=>v==='ok');
  const pos=[...(Array.isArray(d.eth)?d.eth:[]), ...(Array.isArray(d.sol)?d.sol:[]), ...(Array.isArray(d.positions)?d.positions:[])];
  let lp=0, f=0; const legs=[];
  for(const p of pos){
    const v=+p.valueUsd||0; lp+=v; f+=+p.feesUsd||0;
    const ch=p.chain==='sol'?'sol':(p.chain||'ethereum');
    const L=Number(p.liq), live=L>0&&p.priceLower>0&&p.priceUpper>p.priceLower;
    if(!(v>0)&&!live) continue;
    legs.push({k0:tokKey(ch, ch==='sol'?p.mint0:p.token0), k1:tokKey(ch, ch==='sol'?p.mint1:p.token1),
      s0:(p.m0||{}).symbol||p.sym0||null, s1:(p.m1||{}).symbol||p.sym1||null,
      a0:+p.amt0||0, a1:+p.amt1||0, u0:p.usd0!=null?+p.usd0:null, u1:p.usd1!=null?+p.usd1:null, v, live});
  }
  const idle=d.idle&&Array.isArray(d.idle.rows)?d.idle:null;
  const agg={}; let wn=0, dupUsd=0, small=0;
  if(idle){
    const wallets=new Set(), sig=new Set();
    for(const r of idle.rows){
      if(r.wallet) wallets.add(String(r.wallet).toLowerCase());
      const s=(r.wallet||'')+'|'+r.chain+'|'+r.addr+'|'+r.amount+'|'+(r.name||'')+'|'+(r.staked?1:0)+(r.lent?1:0)+(r.debt?1:0);
      if(sig.has(s)){ dupUsd+=+r.usd||0; continue; } sig.add(s);
      const native=r.native||r.addr==='native';
      const k=tokKey(r.chain, native?(r.chain==='sol'?WSOL:WETH):r.addr);
      const px=r.px!=null?+r.px:(r.usd!=null&&r.amount?Math.abs(r.usd/r.amount):null);
      if(r.usd!=null && Math.abs(r.usd)<1){ small+=+r.usd; continue; }
      const e=agg[k]||(agg[k]={s:native?(r.chain==='sol'?'SOL':(r.chain==='polygon'?'POL':'ETH')):(r.symbol||'?'), a:0, d:0, usd:0, px:null, unp:0, nat:native?1:0});
      if(r.amount>0) e.a+=r.amount; else e.d+=r.amount;
      if(r.usd!=null){ e.usd+=+r.usd; if(e.px==null&&px!=null) e.px=px; } else e.unp++;
    }
    wn=wallets.size;
  }
  const nf=d.nfts&&Array.isArray(d.nfts.cols)?d.nfts:null;
  let nC=null, nLp=0;
  if(nf){ nC=0; for(const c of nf.cols){ const v=+c.valueUsd||0; if(isLpNft(c)) nLp+=v; else nC+=v; } }
  return { t, ok, lp, f, legs, agg, small, dupUsd, wn,
    iT:idle?(idle.totalUsd!=null?+idle.totalUsd:Object.values(agg).reduce((s,e)=>s+e.usd,0)+small):null,
    iS:!!(d.idle&&d.idle.stale), nT:nf?(nf.totalUsd!=null?+nf.totalUsd:nC+nLp):null, nC, nLp };
}

/* ---------------- 2. each token's own market, read back from the archive ---------------- */
const hourly=new Map();   // key -> Map(hourIndex -> [prices])
const addPx=(k,t,px)=>{ if(!(px>0)||!isFinite(px)) return; let m=hourly.get(k); if(!m) hourly.set(k,m=new Map()); const h=Math.floor(t/H); (m.get(h)||m.set(h,[]).get(h)).push(px); };
for(const s of snaps){
  for(const [k,e] of Object.entries(s.agg)) if(k!=='polygon:native') addPx(k,s.t,e.px);
  for(const l of s.legs){ addPx(l.k0,s.t,l.u0); addPx(l.k1,s.t,l.u1); }
}
const hourMed=new Map();
for(const [k,m] of hourly){ const arr=[...m.entries()].map(([h,a])=>[h,med(a)]).sort((x,y)=>x[0]-y[0]); hourMed.set(k,arr); }
const refCache=new Map();
function refPx(k,t){
  const arr=hourMed.get(k); if(!arr||arr.length<6) return null;
  const h=Math.floor(t/H), ck=k+'|'+h; if(refCache.has(ck)) return refCache.get(ck);
  let lo=0, hi=arr.length; while(lo<hi){ const m=(lo+hi)>>1; if(arr[m][0]<h-36) lo=m+1; else hi=m; }
  const w=[]; for(let i=lo;i<arr.length&&arr[i][0]<=h+36;i++) w.push(arr[i][1]);
  /* A window whose own prices span more than 20x is not one market: the field changed units at
     some point (early snapshots stored some prices per raw unit). No reference there. */
  let r=null; if(w.length>=6){ const sw=[...w].sort((a,b)=>a-b), q=i=>sw[Math.min(sw.length-1,Math.floor(i*sw.length))];
    if(q(0.9)/q(0.1)<=20) r=med(w); }
  refCache.set(ck,r); return r;
}

/* POL, for Polygon's native coin: the relay priced it as ETH. Hourly POL prices from DefiLlama. */
const polRows=snaps.filter(s=>s.agg['polygon:native']&&s.agg['polygon:native'].a>0);
const polPx=new Map();
if(polRows.length){
  const t0=Math.floor(polRows[0].t/1000)-7200, t1=Math.floor(polRows[polRows.length-1].t/1000)+7200;
  for(let s=t0; s<t1; s+=500*3600){
    try{ const r=await fetch('https://coins.llama.fi/chart/coingecko:polygon-ecosystem-token?start='+s+'&span=500&period=1h',{signal:AbortSignal.timeout(20000)});
      const j=await r.json(); for(const p of (j.coins&&j.coins['coingecko:polygon-ecosystem-token']&&j.coins['coingecko:polygon-ecosystem-token'].prices)||[]) polPx.set(Math.floor(p.timestamp*1000/H), p.price);
    }catch(e){ console.log('POL price history: not reached ('+String(e.message||e).slice(0,40).replace(/[^\w .:-]/g,'')+')'); }
  }
}
const polAt=t=>{ const h=Math.floor(t/H); for(let d=0; d<48; d++){ if(polPx.has(h-d)) return polPx.get(h-d); if(polPx.has(h+d)) return polPx.get(h+d); } return null; };

/* ---------------- 3. every pass, as shown and as corrected ---------------- */
const BAD=3, MINUSD=50;
const ep=new Map();   // open episodes: kind|key -> episode
const episodes=[];
const flagEp=(kind,k,s,ch,t,ratio,dUsd,share)=>{
  const id=kind+'|'+k; let e=ep.get(id);
  if(e && t-e.t1>3*H){ episodes.push(e); e=null; }
  if(!e){ e={kind, k, s, ch, t0:t, t1:t, n:0, ratio, d:0, share:0}; ep.set(id,e); }
  e.t1=t; e.n++; if(Math.abs(Math.log(ratio))>Math.abs(Math.log(e.ratio))) e.ratio=ratio;
  if(Math.abs(dUsd)>Math.abs(e.d)) e.d=dUsd; if(share>e.share) e.share=share;
};
for(const s of snaps){
  /* TOKEN EXPOSURE's "TOTAL ACROSS EVERY TOKEN", as the page computes it (buildTokenBook) */
  const mark={}, pooled={}, live=s.legs.filter(l=>l.live);
  for(const [k,e] of Object.entries(s.agg)) if(e.a>0 && e.px!=null) mark[k]=e.px;
  for(const l of live){ if(l.u0!=null) mark[l.k0]=l.u0; if(l.u1!=null) mark[l.k1]=l.u1; }
  let tb=0, tbOk=true;
  for(const l of live){ const u0=l.u0!=null?l.u0:mark[l.k0], u1=l.u1!=null?l.u1:mark[l.k1];
    if(u0==null||u1==null){ tbOk=false; continue; } tb+=l.a0*u0+l.a1*u1; pooled[l.k0]=1; pooled[l.k1]=1; }
  for(const [k,e] of Object.entries(s.agg)) if(e.a>0 && mark[k]!=null) tb+=e.a*mark[k];
  s.tb=tbOk||tb>0?tb:null;

  /* as recorded: LP + fees + the wallet read's own total + NFTs as valued then */
  s.raw=s.iT!=null ? s.lp+s.f+s.iT+(s.nT||0) : null;

  /* corrected */
  /* The LP side is taken as recorded. Its value comes from the pools' own math, audited on its
     own; re-pricing legs from the archive misfired where early snapshots stored a price per raw
     unit (cbBTC on Solana in August) and turned a correct value into one a hundred times too big. */
  const lpC=s.lp;
  let iC=null;
  if(s.iT!=null){
    iC=s.small;
    for(const [k,e] of Object.entries(s.agg)){
      let usd=e.usd;
      if(k==='polygon:native' && e.a>0){
        const pp=polAt(s.t), now=pp!=null?(e.a+e.d)*pp:0;
        if(Math.abs(usd-now)>=1) s._pend=(s._pend||[]).concat([['pol-as-eth',k,'POL','polygon',e.px&&pp?e.px/pp:99,now-usd]]);
        usd=now;
      }else if(e.px>0 && e.d===0 && e.a>0 && Math.abs(e.a*e.px-e.usd)<=Math.max(1,0.03*Math.abs(e.usd))){
        const r=refPx(k,s.t);
        if(r>0 && (e.px/r>BAD||r/e.px>BAD)){
          const now=usd*(r/e.px);
          if(Math.abs(usd-now)>=MINUSD){ s._pend=(s._pend||[]).concat([['price',k,e.s,chainOfKey(k),e.px/r,now-usd]]); usd=now; }
        }
      }
      iC+=usd;
    }
    if(s.dupUsd>=1) s._pend=(s._pend||[]).concat([['double-read','dup','—','all',2,-s.dupUsd]]);
  }
  s.lpC=lpC; s.iC=iC;
  if(s.nLp>0) s._pend=(s._pend||[]).concat([['lp-receipt-nft','nft','LP receipt','ethereum',99,-s.nLp]]);
  s.cor=iC!=null ? lpC+s.f+iC+(s.nC||0) : null;
}
/* A misread is a total that leaves and comes straight back; a market does not do that inside
   twenty minutes. Each pass is held against the median of the three before and three after. */
const tot=snaps.filter(s=>s.cor!=null);
for(let i=0;i<tot.length;i++){
  const s=tot[i];
  if(!s.ok){ s.out='chain down'; continue; }
  const nb=[]; for(let j=Math.max(0,i-3); j<=Math.min(tot.length-1,i+3); j++) if(j!==i&&tot[j].ok) nb.push(tot[j].cor);
  const m=med(nb);
  if(m>0 && Math.abs(s.cor-m)/m>0.12 && nb.length>=4) s.out='spike';
}
for(const s of snaps){
  const share=x=>{ const T=s.raw>0?s.raw:s.cor; return T>0?Math.min(1,Math.abs(x)/T):0; };
  for(const [kind,k,sym,ch,ratio,d] of (s._pend||[])) flagEp(kind,k,sym,ch,s.t,ratio,d,share(d));
  if(s.out==='spike') flagEp('spike','total','—','all',s.t,s.raw&&s.cor?s.raw/s.cor:1,0,0);
  if(s.out==='chain down') flagEp('chain-down','total','—','all',s.t,1,0,0);
  delete s._pend;
}
for(const e of ep.values()) episodes.push(e);
episodes.sort((a,b)=>Math.abs(b.d)-Math.abs(a.d));

/* ---------------- 4. the daily records the TOTAL chart drew before 7 Oct ---------------- */
let daily=[]; try{ daily=readJ(OUT+'/daily-'+SLUG+'.json'); }catch(e){}
const dayRows=[];
for(const x of (Array.isArray(daily)?daily:[])){
  if(!Array.isArray(x.w)) continue;
  const lpf=(x.v||0)+(x.f||0), w=x.w.reduce((a,e)=>a+(e.a||0)*(e.u||0),0);
  // the corrected total nearest the record's own time (same day, within 2 h)
  let best=null; for(const s of tot){ if(s.out) continue; if(Math.abs(s.t-x.t)<=2*H && (!best||Math.abs(s.t-x.t)<Math.abs(best.t-x.t))) best=s; }
  /* the record keys wallet tokens by contract alone ('evm:native' for every EVM chain's coin) and
     prices the sum at the first row's price: harmless for ETH on its rollups, wrong for POL */
  const pol=best&&best.agg['polygon:native']&&best.agg['polygon:native'].a>0;
  dayRows.push({d:x.d, t:x.t, lp:r2(lpf), w:r2(w), c:best?r2(best.cor):null, cw:best?r2(best.iC+(best.nC||0)):null,
    merged:pol&&x.w.some(e=>e.k==='evm:native')?1:0});
}

/* ---------------- 5. peaks ---------------- */
const top3=s=>{ const rows=[];
  for(const [k,e] of Object.entries(s.agg)) if(Math.abs(e.usd)>0) rows.push({s:e.s, ch:chainOfKey(k), usd:e.usd, r:(k==='polygon:native'?(polAt(s.t)&&e.px?e.px/polAt(s.t):null):(refPx(k,s.t)&&e.px?e.px/refPx(k,s.t):null)), where:'wallet'});
  const lpBy={}; for(const l of s.legs){ for(const [k,a,u,sy] of [[l.k0,l.a0,l.u0,l.s0],[l.k1,l.a1,l.u1,l.s1]]){ if(u==null) continue; const e=lpBy[k]||(lpBy[k]={s:sy||'?', ch:chainOfKey(k), usd:0, r:refPx(k,s.t)?u/refPx(k,s.t):null, where:'LP'}); e.usd+=a*u; } }
  rows.push(...Object.values(lpBy));
  return rows.sort((a,b)=>Math.abs(b.usd)-Math.abs(a.usd)).slice(0,5); };
const peakOf=(arr,get)=>{ let b=null; for(const s of arr){ const v=get(s); if(v!=null&&isFinite(v)&&(!b||v>b.v)) b={s,v}; } return b; };
const peaks={
  tb:  peakOf(snaps, s=>s.tb),
  raw: peakOf(snaps, s=>s.raw),
  cor: peakOf(tot.filter(s=>!s.out), s=>s.cor),
  lp:  peakOf(snaps, s=>s.ok?s.lp+s.f:null),
};
const dPeak=peakOf(dayRows, x=>x.lp+x.w);

/* ---------------- 6. wallets joining the read ---------------- */
const steps=[]; { let prev=null;
  for(const s of tot){ if(s.out||!s.wn) continue;
    if(prev && s.wn!==prev.wn && Math.abs(s.wn-prev.wn)>=1){
      steps.push({t:s.t, w0:prev.wn, w1:s.wn, d:r2(s.iC-prev.iC), r:prev.cor>0?s.cor/prev.cor:null}); }
    prev=s; } }

/* ---------------- 6b. month by month: from the month's first read to its last ----------------
   The total at each end, and what prices alone did to what was held at the start: every wallet
   token and every LP's two tokens, held unchanged and revalued at the end's prices. The page adds
   the pools' fee income and the costs from their own ledgers (own swaps already out), and what is
   left is money moved in or out, wallets added to the read, NFTs first counted, and the LPs'
   rebalancing against simply holding. The running month carries its starting holdings so the
   page can price them live. */
const tzOff=ms=>{ const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})
  .formatToParts(new Date(ms)).map(x=>[x.type,x.value])); return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(ms/1000)*1000; };
const budMid=(y,m,d)=>{ const g=Date.UTC(y,m-1,d); return g-tzOff(g+12*H); };
const good=tot.filter(s=>!s.out);
/* a leg whose own fields do not reproduce its value carries prices in another unit (early cbBTC) */
const legOk=l=>l.v>0&&l.u0!=null&&l.u1!=null&&Math.abs(l.a0*l.u0+l.a1*l.u1-l.v)/l.v<0.03;
const holdOf=s=>{ const h={};
  for(const [k,e] of Object.entries(s.agg)){ const a=(e.a||0)+(e.d||0); if(a) (h[k]=h[k]||{s:e.s,a:0}).a+=a; }
  for(const l of s.legs){ if(!legOk(l)) continue; for(const [k,a,sy] of [[l.k0,l.a0,l.s0],[l.k1,l.a1,l.s1]]) if(a) (h[k]=h[k]||{s:sy||'?',a:0}).a+=a; }
  return h; };
const markOf=s=>{ const m={};
  for(const [k,e] of Object.entries(s.agg)) if(e.px>0) m[k]=k==='polygon:native'?polAt(s.t):e.px;
  for(const l of s.legs){ if(!legOk(l)) continue; if(l.u0>0) m[l.k0]=l.u0; if(l.u1>0) m[l.k1]=l.u1; }
  return m; };
const marketOf=(a,b)=>{ const h=holdOf(a), m0=markOf(a), m1=markOf(b); let mkt=0, val=0, cov=0;
  for(const [k,x] of Object.entries(h)){ const p0=m0[k]; if(!(p0>0)) continue; val+=Math.abs(x.a*p0);
    let p1=m1[k]; if(!(p1>0)) p1=refPx(k,b.t); if(!(p1>0)||p1/p0>20||p0/p1>20) continue;
    mkt+=x.a*(p1-p0); cov+=Math.abs(x.a*p0); }
  return {mkt, cov:val>0?cov/val:1}; };
const months=[];
if(good.length){
  const first=good[0].t, last=good[good.length-1].t;
  let [y,mo]=budDay(first).slice(0,7).split('-').map(Number);
  for(let guard=0; guard<60; guard++){
    const M0=budMid(y,mo,1), ny=mo===12?y+1:y, nm=mo===12?1:mo+1, M1=budMid(ny,nm,1);
    if(M0>last) break;
    /* a month the record starts inside begins at a day's start, so the day fee closes line up */
    let B0=M0;
    if(first>M0){ const [fy,fm,fd]=budDay(first).split('-').map(Number), dm=budMid(fy,fm,fd); B0=first-dm<=2*H?dm:budMid(fy,fm,fd+1); }
    const a=good.find(x=>x.t>=B0&&x.t<M1); let b=null; for(const x of good) if(x.t>=B0&&x.t<M1) b=x;
    if(a&&b&&b.t>a.t){
      const {mkt,cov}=marketOf(a,b), mk=y+'-'+String(mo).padStart(2,'0');
      const nf=a.nC==null?good.find(x=>x.t>a.t&&x.t<=b.t&&x.nC!=null):null;
      const row={m:mk, t0:a.t, t1:b.t, d0:budDay(a.t), s:r2(a.cor), e:r2(b.cor), mkt:r2(mkt), cov:+cov.toFixed(3), part:B0>M0?1:0,
        steps:steps.filter(x=>x.t>a.t&&x.t<=b.t).map(x=>({t:x.t, w0:x.w0, w1:x.w1, d:x.d})), ...(nf?{nft:{t:nf.t, d:r2(nf.nC)}}:{})};
      /* every month keeps what it started with: once the snapshots behind it are gone (the history
         can be pruned), a later run still prices that start against the month's end */
      { const h=holdOf(a), m0=markOf(a);
        row.hold=Object.entries(h).filter(([k,x])=>m0[k]>0&&Math.abs(x.a*m0[k])>=5).map(([k,x])=>({k, s:x.s, a:+x.a.toPrecision(10), p:+m0[k].toPrecision(10)})); }
      if(M1>last) row.cur=1;
      row._b=b;
      months.push(row);
    }
    y=ny; mo=nm;
  }
}

/* A month whose start this archive no longer holds keeps the start an earlier run saw: its first
   total, its starting holdings, the changes in the wallets read before; its prices are then
   measured from those holdings to this run's end of the month. */
function mergeMonths(prev, now){
  const out=prev.filter(x=>!now.some(y=>y.m===x.m));   // a month this run cannot rebuild stays as last seen
  for(const r of now){
    const p=prev.find(x=>x.m===r.m);
    if(p && p.t0<r.t0 && Array.isArray(p.hold)){
      const m1=markOf(r._b); let mkt=0, val=0, cov=0;
      for(const h of p.hold){ val+=Math.abs(h.a*h.p); let p1=m1[h.k]; if(!(p1>0)) p1=refPx(h.k, r._b.t); if(!(p1>0)||p1/h.p>20||h.p/p1>20) continue; mkt+=h.a*(p1-h.p); cov+=Math.abs(h.a*h.p); }
      out.push({...r, t0:p.t0, d0:p.d0, s:p.s, part:p.part, hold:p.hold, mkt:r2(mkt), cov:val>0?+(cov/val).toFixed(3):1,
        steps:[...(p.steps||[]).filter(x=>x.t<r.t0), ...(r.steps||[])], ...(p.nft&&!r.nft?{nft:p.nft}:{})});
    } else out.push(r);
  }
  return out.sort((a,b)=>a.m<b.m?-1:1).map(({_b,...x})=>x);
}

/* ---------------- 7. publish (sealed) ---------------- */
let prevOut=null; try{ prevOut=readJ(OUT+'/recon-'+SLUG+'.json'); }catch(e){}
const firstT=snaps.length?snaps[0].t:Infinity;
const kept=(prevOut&&Array.isArray(prevOut.pts)?prevOut.pts:[]).filter(p=>p[0]<firstT);   // older than the archive now holds
/* One point an hour (the hour's last read), except that a peak and a flagged read always keep
   their own point: thinning must never replace the high with the read after it. */
const pts=[]; { let lastH=null, keep=false;
  for(const s of snaps){
    const h=Math.floor(s.t/H), flag=s.out?1:0, isPeak=[peaks.tb,peaks.raw,peaks.cor].some(p=>p&&p.s===s);
    const row=[s.t, r2(s.lpC+s.f), s.iC!=null?r2(s.iC):null, s.nC!=null?r2(s.nC):null, s.raw!=null?r2(s.raw):null, s.tb!=null?r2(s.tb):null, flag, s.ok?r2(s.lp+s.f):null];
    if(isPeak || flag || keep || h!==lastH){ pts.push(row); lastH=h; keep=isPeak||!!flag; } else pts[pts.length-1]=row;
  } }
const pk=p=>p?{t:p.s.t, v:r2(p.v), lp:r2(p.s.lp+p.s.f), lpC:r2(p.s.lpC+p.s.f), i:r2(p.s.iT), iC:r2(p.s.iC), n:r2(p.s.nT), nC:r2(p.s.nC), tb:r2(p.s.tb), raw:r2(p.s.raw), cor:r2(p.s.cor), wn:p.s.wn,
  top:top3(p.s).map(x=>({s:x.s, ch:x.ch, usd:r2(x.usd), r:x.r!=null?+x.r.toPrecision(4):null, where:x.where}))}:null;
/* What an earlier run saw in history this archive no longer holds stays in the record. */
const po=prevOut&&prevOut.peaks||{};
const older=(a,b)=>a&&a.t<firstT&&(!b||a.v>b.v)?a:b;
const result={ v:1, t:Date.now(), slug:SLUG, n:snaps.length, nKept:kept.length, from:kept.length?kept[0][0]:(snaps.length?snaps[0].t:null), to:snaps.length?snaps[snaps.length-1].t:null,
  rule:{bad:BAD, minUsd:MINUSD, window:'±36h', spike:'12% vs ±3 reads'},
  pts:[...kept, ...pts], peaks:{tb:older(po.tb,pk(peaks.tb)), raw:older(po.raw,pk(peaks.raw)), cor:older(po.cor,pk(peaks.cor)), lp:older(po.lp,pk(peaks.lp)),
    daily:dPeak?{t:dPeak.s.t, d:dPeak.s.d, v:r2(dPeak.v), lp:dPeak.s.lp, w:dPeak.s.w, c:dPeak.s.c, merged:dPeak.s.merged}:null},
  adj:[...((prevOut&&prevOut.adj)||[]).filter(e=>e.t1<firstT),
       ...episodes.slice(0,80).map(e=>({kind:e.kind, s:e.s, ch:e.ch, t0:e.t0, t1:e.t1, n:e.n, r:+Number(e.ratio).toPrecision(4), d:r2(e.d), share:+e.share.toFixed(4)}))]
       .sort((a,b)=>Math.abs(b.d)-Math.abs(a.d)).slice(0,80),
  steps:[...((prevOut&&prevOut.steps)||[]).filter(x=>x.t<firstT), ...steps],
  /* a day whose snapshots are gone (all or some) keeps the corrected total an earlier run found for it */
  days:dayRows.map(x=>{ const p=x.t-2*H<firstT&&((prevOut&&prevOut.days)||[]).find(y=>y.d===x.d&&y.t===x.t);
    return p&&p.c!=null?{...x, c:p.c, cw:p.cw, merged:p.merged}:x; }),
  months:mergeMonths(((prevOut&&prevOut.months)||[]), months) };
{ const C=result.peaks.cor, top=Math.max(...result.pts.filter(p=>!p[6]&&p[2]!=null).map(p=>p[1]+p[2]+(p[3]||0)));
  if(C && Math.abs(top-C.v)>1) { console.log('self-check FAILED: the published series does not carry the corrected high'); process.exitCode=1; }
  else console.log('self-check: the published series carries the corrected high exactly'); }
writeJ(OUT+'/recon-'+SLUG+'.json', result);

/* ---------------- 8. the public log: dates, counts, ratios, tickers ---------------- */
const line=(name,p,base,corrected)=>{
  if(!p){ console.log('  '+name+': nothing to read'); return; }
  const s=p.s, parts=[], T=p.v||1;
  const lpf=corrected?s.lpC+s.f:s.lp+s.f, w=corrected?s.iC:s.iT, n=corrected?s.nC:s.nT;
  parts.push('LP+fees '+pct(lpf/T));
  if(w!=null) parts.push('wallets '+pct(w/T));
  if(n!=null) parts.push('NFTs '+pct(n/T));
  console.log('  '+name+': '+bud(s.t)+' Budapest'+(base&&base.v?' · '+rx(p.v/base.v)+' the corrected all-time high':'')
    +(!corrected&&s.cor?' · '+rx(p.v/s.cor)+' the corrected total at that moment':'')+(corrected!=='lp'?' · '+parts.join(', '):''));
};
console.log('\nHIGHEST READS');
line('TOKEN EXPOSURE total (pooled + idle)', peaks.tb, peaks.cor);
line('as recorded (LP + fees + wallet read + NFTs)', peaks.raw, peaks.cor);
line('corrected', peaks.cor, null, true);
line('LP + fees only', peaks.lp, peaks.cor, 'lp');
if(dPeak) console.log('  daily records (the TOTAL chart before 7 Oct): '+dPeak.s.d+(peaks.cor?' · '+rx(dPeak.v/peaks.cor.v)+' the corrected all-time high':'')+(dPeak.s.c?' · '+rx(dPeak.v/dPeak.s.c)+' the corrected total that day':'')+(dPeak.s.merged?' · POL merged into ETH in that record':''));
if(peaks.raw){
  const P=peaks.raw.v, byDay={};
  for(const s of snaps){ if(s.raw==null||s.out) continue; const d=budDay(s.t); if(!byDay[d]||s.raw>byDay[d]) byDay[d]=s.raw; }
  console.log('  highest days, as recorded (each day\'s own high vs the all-time high): '+Object.entries(byDay).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([d,v])=>d+' '+rx(v/P)).join(' · '));
  if(peaks.cor){ const C=peaks.cor.v, cd={}; for(const s of tot){ if(s.out) continue; const d=budDay(s.t); if(!cd[d]||s.cor>cd[d]) cd[d]=s.cor; }
    console.log('  highest days, corrected (vs the corrected all-time high): '+Object.entries(cd).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([d,v])=>d+' '+rx(v/C)).join(' · ')); }
  const pd=budDay(peaks.raw.s.t), rec=dayRows.find(x=>x.d===pd);
  if(rec) console.log('  that day\'s daily record (one point, its last read) is '+rx((rec.lp+rec.w)/P)+' the high: the TOTAL chart drew days from these records, so an intraday high never reached it');
  const chartHi=Math.max(...dayRows.map(x=>x.lp+x.w));
  console.log('  the TOTAL chart\'s own high before this (daily records) was '+rx(chartHi/P)+' the recorded high');
  const last=[...snaps].reverse().find(s=>s.raw!=null&&!s.out);
  if(last) console.log('  latest pass ('+bud(last.t)+') is '+rx(last.raw/P)+' the recorded high');
}
if(peaks.raw){
  const t=peaks.raw.s.t, hp=(k,tt)=>{ const arr=hourMed.get(k); if(!arr) return null; const h=Math.floor(tt/H); let b=null; for(const [hh,v] of arr){ if(Math.abs(hh-h)<=2&&(!b||Math.abs(hh-h)<Math.abs(b[0]-h))) b=[hh,v]; } return b?b[1]:null; };
  const fp=x=>x==null?'—':x>=100?'$'+x.toFixed(0):x>=1?'$'+x.toFixed(2):'$'+x.toPrecision(3);
  for(const x of top3(peaks.raw.s).slice(0,3)){
    const k=Object.keys(peaks.raw.s.agg).find(kk=>peaks.raw.s.agg[kk].s===x.s&&chainOfKey(kk)===x.ch)||[...hourMed.keys()].find(kk=>chainOfKey(kk)===x.ch&&peaks.raw.s.legs.some(l=>(l.k0===kk&&l.s0===x.s)||(l.k1===kk&&l.s1===x.s)));
    if(!k) continue;
    console.log('  market price of '+x.s+' ('+chainName(x.ch)+'): 24 h before '+fp(hp(k,t-DAY))+' · at the high '+fp(hp(k,t))+' · 24 h after '+fp(hp(k,t+DAY))+' · now '+fp(hp(k,snaps[snaps.length-1].t)));
  }
}
/* An exchange's own candles for the biggest holdings at the high: whether the move the relay
   priced was the market's, or only its price feed's. */
if(peaks.raw){
  const t=peaks.raw.s.t, seen=new Set();
  for(const x of top3(peaks.raw.s)){
    const sym=String(x.s||'').replace(/^W(ETH|BTC|SOL)$/,'$1').toUpperCase(); if(seen.has(sym)||!/^[A-Z0-9]{2,10}$/.test(sym)) continue; seen.add(sym);
    try{
      const iso=ms=>new Date(ms).toISOString().replace(/\.\d+Z$/,'Z');
      const r=await fetch('https://api.exchange.coinbase.com/products/'+sym+'-USD/candles?granularity=3600&start='+iso(t-30*H)+'&end='+iso(t+6*H),{headers:{'user-agent':'kt-reconcile'},signal:AbortSignal.timeout(15000)});
      if(!r.ok){ console.log('  Coinbase '+sym+'-USD: HTTP '+r.status); continue; }
      const c=await r.json(); if(!Array.isArray(c)||!c.length){ console.log('  Coinbase '+sym+'-USD: no candles'); continue; }
      const near=c.filter(k=>Math.abs(k[0]*1000-t)<=3*H), before=c.filter(k=>Math.abs(k[0]*1000-(t-DAY))<=H);
      const hi=Math.max(...near.map(k=>k[2])), lo=Math.min(...near.map(k=>k[1])), b=before.length?before[0][4]:null;
      const fp=x=>x==null||!isFinite(x)?'—':x>=100?'$'+x.toFixed(0):x>=1?'$'+x.toFixed(2):'$'+x.toPrecision(3);
      console.log('  Coinbase '+sym+'-USD: 24 h before '+fp(b)+' · within 3 h of the high: low '+fp(lo)+', high '+fp(hi));
    }catch(e){ console.log('  Coinbase '+sym+'-USD: not reached'); }
  }
}
for(const [name,p] of [['TOKEN EXPOSURE peak',peaks.tb],['as-recorded peak',peaks.raw]]){
  if(!p) continue; const t=top3(p.s);
  console.log('  biggest holdings at the '+name+': '+t.map(x=>x.s+' ('+chainName(x.ch)+', '+x.where+') '+pct(Math.abs(x.usd)/p.v)+(x.r!=null&&(x.r>1.5||x.r<0.67)?' at '+rx(x.r)+' its own market':'')).join(' · '));
}
console.log('\nWHAT THE CORRECTION TOOK OUT ('+episodes.length+' episodes)');
const byKind={}; for(const e of episodes){ byKind[e.kind]=(byKind[e.kind]||0)+1; }
console.log('  by kind: '+Object.entries(byKind).map(([k,n])=>k+' ×'+n).join(', '));
for(const e of episodes.filter(e=>e.kind!=='spike'&&e.kind!=='chain-down').slice(0,14))
  console.log('  '+bud(e.t0)+(e.t1-e.t0>H?' → '+bud(e.t1):'')+' · '+e.kind+' · '+e.s+' ('+chainName(e.ch)+') · '+e.n+' read(s)'
    +(e.kind==='pol-as-eth'?' · priced as ETH'+(polPx.size?'':' (no POL price reached: counted at 0)'):e.kind==='price'||e.kind==='lp-price'?' · priced '+rx(e.ratio)+' its market':'')+' · up to '+pct(e.share)+' of the total as recorded');
const sp=episodes.filter(e=>e.kind==='spike'), cd=episodes.filter(e=>e.kind==='chain-down');
console.log('  spikes left out: '+sp.length+' episode(s), '+sp.reduce((a,e)=>a+e.n,0)+' read(s); chain-down reads left out: '+cd.reduce((a,e)=>a+e.n,0));
console.log('\nWALLETS JOINING THE READ');
for(const s of steps.filter(x=>Math.abs(x.w1-x.w0)>=2||(x.r&&Math.abs(x.r-1)>0.05)).slice(0,20))
  console.log('  '+bud(s.t)+' · '+s.w0+' → '+s.w1+' wallets'+(s.r?' · total '+(s.r>=1?'+':'')+pct(s.r-1)+' across the step':''));
console.log('\nMONTH BY MONTH (first read → last read; ratios to the month\'s start)');
for(const m of months) console.log('  '+m.m+(m.part?' from '+m.d0:'')+(m.cur?' (running)':'')+' · end '+rx(m.e/m.s)+' the start · prices on the starting holdings '
  +(m.mkt>=0?'+':'−')+pct(Math.abs(m.mkt)/m.s)+' of the start · '+pct(m.cov)+' of the start priced at both ends'
  +(m.steps.length?' · '+m.steps.length+' change(s) in the wallets read':'')+(m.nft?' · NFTs first counted '+bud(m.nft.t):''));
console.log('\nDAILY RECORDS vs SNAPSHOTS');
const off=dayRows.filter(x=>x.c&&Math.abs((x.lp+x.w)/x.c-1)>0.1);
console.log('  '+dayRows.length+' day(s); '+off.length+' differ from the corrected snapshot by more than 10%'+(off.length?': '+off.slice(0,12).map(x=>x.d+' '+rx((x.lp+x.w)/x.c)+(x.merged?'*':'')).join(', '):''));
console.log('  (* = Polygon\'s POL is merged into the ETH line of that record, at the ETH price)');
console.log('\nsealed into '+OUT+'/recon-'+SLUG+'.json: '+result.pts.length+' points ('+kept.length+' kept from an earlier run), '+result.adj.length+' adjustments'+(lockOn()?'':' — NOT sealed: lock off'));

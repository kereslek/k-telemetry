/* Where did the positions' value go? The relay's positions now (the store's copy) against the same positions at
   moments yesterday (git's copies), split into what prices did, what changed in the positions themselves, and what
   is no longer read or priced. The log is public: ratios, shares, counts and times only. Tokens are lettered by
   their weight in the positions at the reference moment, never named.
   Run: DECK_PASSPHRASE=… GITHUB_TOKEN=… node scripts/value-drop-probe.mjs */
import {storeText} from './store.mjs';
import {open} from './lock.mjs';

const REPO='kereslek/k-telemetry', PATH='deck-r7k4x9/data-main.json', H=3600e3;
const TARGETS=(process.env.TARGETS||'2026-11-19T22:00Z,2026-11-20T06:00Z,2026-11-20T12:00Z,2026-11-20T18:00Z,2026-11-20T20:00Z,2026-11-20T21:00Z,2026-11-20T22:00Z')
  .split(',').map(s=>Date.parse(s.trim()));
const gh=async u=>{ const r=await fetch('https://api.github.com'+u,{headers:{authorization:'Bearer '+process.env.GITHUB_TOKEN, accept:'application/vnd.github+json'}}); if(!r.ok) throw new Error('GitHub '+r.status); return r.json(); };
const hm=t=>new Date(t).toISOString().slice(5,16).replace('T',' ')+' UTC';
const rx=x=>x==null||!isFinite(x)?'—':x.toFixed(3)+'x';
const pc=x=>x==null||!isFinite(x)?'—':(x>=0?'+':'−')+Math.abs(x*100).toFixed(1)+'%';
const openD=j=>{ try{ return j&&j.lock===1?JSON.parse(open(j)):j; }catch(e){ return null; } };

// now: the store's copy (this also sets up the lock, from the published lock.json when the checkout has none)
const s=await storeText('data-main.json'); if(!s){ console.log('the store did not serve the relay file'); process.exit(1); }
const NOW=openD(JSON.parse(s.text)); if(!NOW){ console.log('the relay file could not be opened'); process.exit(1); }

// then: git's copy nearest each moment
let commits=[]; for(let pg=1;pg<=4;pg++){ const c=await gh(`/repos/${REPO}/commits?sha=gh-pages&path=${PATH}&since=${new Date(Math.min(...TARGETS)-2*H).toISOString()}&until=${new Date(Math.max(...TARGETS)+2*H).toISOString()}&per_page=100&page=${pg}`);
  commits.push(...c.map(x=>({sha:x.sha, t:Date.parse(x.commit.committer.date)}))); if(c.length<100) break; }
const moments=[];
for(const T of TARGETS){ const c=commits.reduce((b,x)=>!b||Math.abs(x.t-T)<Math.abs(b.t-T)?x:b,null); if(!c||Math.abs(c.t-T)>90*60e3){ moments.push({T, miss:1}); continue; }
  const r=await fetch(`https://raw.githubusercontent.com/${REPO}/${c.sha}/${PATH}`); const d=r.ok?openD(await r.json()):null;
  moments.push({T, t:d&&d.t||c.t, d}); }
moments.push({T:NOW.t, t:NOW.t, d:NOW, now:1});

const posOf=d=>[...(d.eth||[]),...(d.sol||[])].map(p=>({id:String(p.id), ch:p.chain==='sol'?'sol':'eth', s0:p.m0&&p.m0.symbol, s1:p.m1&&p.m1.symbol,
  a0:+p.amt0||0, a1:+p.amt1||0, u0:p.usd0, u1:p.usd1, v:p.valueUsd, f:p.feesUsd, liq:p.liq!=null?Number(p.liq):null, inR:!!p.inRange}));
const tot=ps=>ps.reduce((a,p)=>a+(p.v||0),0);
const ref=moments.filter(m=>m.d&&!m.now).slice(-1)[0];   // the last copy git kept (the evening's)
if(!ref){ console.log('no copy from yesterday could be opened'); process.exit(1); }
const V0=tot(posOf(ref.d));

console.log('LP VALUE (the relay’s positions, fees aside) at each moment, against '+hm(ref.t)+':');
for(const m of moments){ if(m.miss||!m.d){ console.log('  '+hm(m.T)+': no copy'); continue; }
  const ps=posOf(m.d), e=ps.filter(p=>p.ch==='eth'), so=ps.filter(p=>p.ch==='sol');
  console.log('  '+hm(m.t)+(m.now?' (now)':'')+' · '+rx(tot(ps)/V0)+' · positions '+ps.length+' ('+e.length+' Ethereum, '+so.length+' Solana) · unpriced '+ps.filter(p=>p.v==null).length+' · in range '+ps.filter(p=>p.inR).length); }

// the rest of the portfolio beside the positions: wallets (idle, staked, lent, less owed) and NFTs at floor
const parts0=d=>{ const ps=posOf(d), lp=tot(ps), f=ps.reduce((a,p)=>a+(p.f||0),0), w=d.idle&&d.idle.totalUsd!=null?+d.idle.totalUsd:null, n=d.nfts&&d.nfts.totalUsd!=null?+d.nfts.totalUsd:null;
  return {lp, f, w, n, all:lp+f+(w||0)+(n||0), stale:!!(d.idle&&d.idle.stale)}; };
const R0=parts0(ref.d);
console.log('\nTHE WHOLE PORTFOLIO (positions, their unclaimed fees, wallets, NFTs), against '+hm(ref.t)+':');
for(const m of moments){ if(m.miss||!m.d) continue; const P=parts0(m.d);
  console.log('  '+hm(m.t)+(m.now?' (now)':'')+' · whole '+rx(P.all/R0.all)+' · positions '+rx(P.lp/R0.lp)+' · fees '+rx(R0.f?P.f/R0.f:null)+' · wallets '+rx(P.w!=null&&R0.w?P.w/R0.w:null)+(P.stale?' (wallet read stale)':'')
    +' · NFTs '+rx(P.n!=null&&R0.n?P.n/R0.n:null)+' · positions are '+(P.all?(P.lp/P.all*100).toFixed(1):'—')+'% of the whole'); }

// the relay's own 15-minute history, hourly, to see when it moved
const hist=(NOW.history||[]).filter(h=>h&&h.t&&h.v!=null&&h.t>=ref.t-30*H).sort((a,b)=>a.t-b.t);
const hv=t=>{ const h=hist.reduce((b,x)=>!b||Math.abs(x.t-t)<Math.abs(b.t-t)?x:b,null); return h&&Math.abs(h.t-t)<40*60e3?h.v:null; };
const v0h=hv(ref.t);
if(v0h){ const out=[]; for(let t=Math.ceil((ref.t-24*H)/H)*H;t<=NOW.t;t+=H){ const v=hv(t); out.push(new Date(t).toISOString().slice(8,13).replace('T',' ')+'h '+rx(v!=null?v/v0h:null)); }
  console.log('\nHOURLY, from the relay’s history (day hour UTC, against '+hm(ref.t)+'):'); for(let i=0;i<out.length;i+=6) console.log('  '+out.slice(i,i+6).join(' · ')); }

// what made the change between the evening's copy and now
const A=new Map(posOf(ref.d).map(p=>[p.id,p])), B=new Map(posOf(NOW).map(p=>[p.id,p]));
const weight={}; for(const p of A.values()){ if(p.u0!=null) weight[p.s0]=(weight[p.s0]||0)+p.a0*p.u0; if(p.u1!=null) weight[p.s1]=(weight[p.s1]||0)+p.a1*p.u1; }
const letters=Object.keys(weight).sort((x,y)=>weight[y]-weight[x]), L=s=>'token '+String.fromCharCode(65+letters.indexOf(s));
const px={}, b={price:{}, same:0, less:0, more:0, gone:0, fresh:0, unpriced:0}; let nLess=0, nMore=0, nGone=0, nNew=0, nUnp=0;
for(const [id,a] of A){ const n=B.get(id);
  if(!n){ b.gone-=a.v||0; nGone++; continue; }
  if(n.v==null&&a.v!=null){ b.unpriced-=a.v; nUnp++; continue; }
  for(const [k,s,amA,amB,pA,pB] of [[0,a.s0,a.a0,n.a0,a.u0,n.u0],[1,a.s1,a.a1,n.a1,a.u1,n.u1]]){
    if(pA!=null&&pB!=null){ b.price[s]=(b.price[s]||0)+amA*(pB-pA); (px[s]=px[s]||[]).push(pB/pA); }
    const dq=(amB-amA)*(pB??0); const lr=a.liq&&n.liq!=null?n.liq/a.liq:1;
    if(lr<0.99) b.less+=dq; else if(lr>1.01) b.more+=dq; else b.same+=dq; }
  const lr=a.liq&&n.liq!=null?n.liq/a.liq:1; if(lr<0.99) nLess++; else if(lr>1.01) nMore++; }
for(const [id,n] of B) if(!A.has(id)){ b.fresh+=n.v||0; nNew++; }
const V1=tot(posOf(NOW)), sumP=Object.values(b.price).reduce((x,y)=>x+y,0);
console.log('\nWHAT MADE THE CHANGE, '+hm(ref.t)+' → now ('+hm(NOW.t)+'): '+pc(V1/V0-1)+' of the value then');
console.log('  prices: '+pc(sumP/V0)+(letters.length?' · by token (largest in the positions first): '+letters.map(s=>L(s)+' price '+rx(px[s]&&px[s].length?px[s].reduce((x,y)=>x+y,0)/px[s].length:null)+' → '+pc((b.price[s]||0)/V0)).join(' · '):''));
console.log('  amounts inside positions whose liquidity did not change (the pool trading the tokens against each other): '+pc(b.same/V0));
console.log('  positions whose liquidity went down: '+nLess+' → '+pc(b.less/V0)+' · went up: '+nMore+' → '+pc(b.more/V0));
console.log('  positions no longer in the relay file: '+nGone+' → '+pc(b.gone/V0)+' · new ones: '+nNew+' → '+pc(b.fresh/V0)+' · left without a price now: '+nUnp+' → '+pc(b.unpriced/V0));
const parts=sumP+b.same+b.less+b.more+b.gone+b.fresh+b.unpriced;
console.log('  the parts add up to '+pc(parts/V0)+' (the change itself '+pc((V1-V0)/V0)+')');

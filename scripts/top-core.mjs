/* TOP 100 FEES EARNED: the trades that paid the deck most, since the swap replay's first day.

   Pure, and tested on made-up swaps (top-core.test.mjs). The swap replay (pool-replay.mjs) calls topSwap for
   every swap it books, pool by pool. Each pool keeps its own hundred best, ranked in the pool's own first token
   (its size times the deck's share of the liquidity at the price), so no price is needed while reading. Only at
   the end are they valued in dollars (each day's dollars per unit of the pool's first token: the census's volume
   that day over the replay's own volume that day), merged across pools and cut to the hundred best. The best of
   every pool is in its own hundred, so the merged hundred is exact.

   The deck's own swaps through its own pools are never counted: what it paid itself is not income. A trade
   also carries what the deck earned in the 30 minutes after it (the "echo": traders bringing the price back). */
export const TOPK=100, ECHO=30*60e3;
const r4=x=>x==null||!isFinite(x)?null:Math.round(x*1e4)/1e4, r2=x=>x==null||!isFinite(x)?null:Math.round(x*100)/100;

/* the deck's positions in range at a tick, each with its part of the deck's liquidity there, largest first */
export function posShares(pos, tick){
  if(tick==null) return [];
  const xs=Object.entries(pos||{}).filter(([,p])=>p&&p.L>0&&p.lo!=null&&p.lo<=tick&&tick<p.hi), tot=xs.reduce((s,[,p])=>s+p.L,0);
  return tot>0?xs.map(([k,p])=>[k,r4(p.L/tot)]).sort((a,b)=>b[1]-a[1]).slice(0,3):[]; }

/* one swap: add it to the echo of the hundred's recent ones, then keep it if it is among the pool's hundred best.
   st.top must already be an array (a pool tracked from the first day); otherwise nothing is kept. */
export function topSwap(st, {t, x, w, s, zin, k0, k1, own, pos}){
  if(!st||!Array.isArray(st.top)) return false;
  if(!own&&s>0&&w>0) for(const c of st.top) if(t>c.t&&t-c.t<=ECHO) c.e=(c.e||0)+w*s;
  if(own||!(s>0)||!(w>0)||!isFinite(w)) return false;
  const fs=w*s, last=st.top[st.top.length-1];
  if(st.top.length>=TOPK&&last&&fs<=last.fs) return false;
  st.top.push({t, x:x||null, w, s:r4(s), fs, z:zin?1:0, k0:k0??null, k1:k1??null, p:pos||[], e:0});
  st.top.sort((a,b)=>b.fs-a.fs||a.t-b.t); if(st.top.length>TOPK) st.top.length=TOPK;
  return true; }

/* dollars per unit of a pool's first token on a day: the census's volume over the replay's own volume that
   day (the day's average price, as the replay's other dollar figures use it); otherwise today's price */
function perUnit(R, P, d, px){
  const v=P&&P.vol?P.vol[d]:null, wd=R.state&&R.state.raw&&R.state.raw[d]?R.state.raw[d].w:null;
  if(v>0&&wd>0) return {k:v/wd, est:false};
  return px&&px.u0>0&&px.d0!=null?{k:px.u0/10**px.d0, est:true}:{k:null, est:true}; }

/* the hundred best across pools, in dollars. pools: the replay's out.pools (state with top, raw and syms; days);
   census: the pool census (its pools' daily volume); px: Map pool id → {u0, d0} (today's price, the fallback). */
export function topRows({pools, census, px, k=TOPK}){
  const day=t=>new Date(t).toISOString().slice(0,10), cP=new Map();
  for(const T of (census&&census.tokens)||[]) for(const P of T.pools||[]) cP.set(String(P.id).toLowerCase(), P);
  // what the deck earned each day across its pools, for "that day" and for the share of all its fees
  const dayUsd={}; let allUsd=0;
  for(const R of pools){ if(!R.days||R.fee==null) continue; const P=cP.get(String(R.id).toLowerCase());
    for(const [d,a] of Object.entries(R.days)){ const v=P&&P.vol?P.vol[d]:null; if(v==null||a.s==null) continue;
      const u=v*R.fee*(R.lpCut??1)*a.s; dayUsd[d]=(dayUsd[d]||0)+u; allUsd+=u; } }
  const rows=[];
  for(const R of pools){ const st=R.state; if(!st||!Array.isArray(st.top)||R.fee==null) continue;
    const P=cP.get(String(R.id).toLowerCase()), q=px&&px.get(String(R.id).toLowerCase()), cut=R.fee*(R.lpCut??1), sy=st.syms||[];
    for(const c of st.top){ const d=day(c.t), {k,est}=perUnit(R,P,d,q); if(!(k>0)) continue;
      // the price the trade left: of the token it bought, against the one it sold
      const r=c.k0!=null&&c.k1!=null?Math.pow(1.0001,c.k1-c.k0):null, move=r==null?null:(c.z?1/r-1:r-1);
      rows.push({t:c.t, x:c.x, pool:R.id, chain:R.chain, venue:R.venue, name:R.name||null, fee:R.fee,
        sold:c.z?sy[0]||null:sy[1]||null, bought:c.z?sy[1]||null:sy[0]||null,
        usd:r2(c.fs*cut*k), size:r2(c.w*k), lps:r2(c.w*cut*k), share:c.s, move:r4(move), echo:r2((c.e||0)*cut*k),
        pos:c.p||[], day:d, dayUsd:dayUsd[d]!=null?r2(dayUsd[d]):null, est}); } }
  rows.sort((a,b)=>b.usd-a.usd||a.t-b.t);
  const top=rows.slice(0,k), sum=top.reduce((s,x)=>s+x.usd,0);
  return {rows:top, sum:r2(sum), allUsd:r2(allUsd), part:allUsd>0?r4(sum/allUsd):null}; }

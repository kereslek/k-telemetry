/* ARBITRAGE STUDY — the pure part: pool maths, accounting, classes, gap episodes, scenarios.
   No I/O here, so every rule can be tested on made-up records (arb-core.test.mjs).

   Units. A Raydium CLMM pool holds token0/token1; its price is P = token1 per token0 in raw units, kept
   as sqrtP (√P, a float). CPOOL can be either token. Everything the study reports is in US dollars,
   valued at the market price of the minute (exchanges, not the pools themselves).

   The accounting identity everything rests on. For one swap leg, at market prices:
     trader  = value out − value in
     all LPs = value in × (1 − fee × (1 − lpCut)) − value out          (the protocol keeps fee × (1 − lpCut))
     trader + all LPs = − protocol's cut
   Your result from a trade is your share of the LPs' side. If your own bot made a trade, your result is
   the bot's side plus your share of the LPs' side: on a pool where you are all the liquidity at the price
   that is only the protocol's cut and the transaction cost. Replacing an outside bot's trade with your
   own therefore gains what that bot made, less any difference in costs. */

export const D=864e5, MIN=60e3;
export const SOL_MINT='So11111111111111111111111111111111111111112';
export const STABLES=new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);   // USDC, USDT
export const JITO_TIPS=new Set(['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5','HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe','Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49','DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh','ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL','3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT']);
export const PROGRAMS={JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4:'Jupiter', CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK:'Raydium CLMM',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':'Raydium AMM', CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C:'Raydium CPMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc:'Orca', LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo:'Meteora DLMM', 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB':'Meteora',
  '6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma':'OKX', 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS':'Raydium router'};
// programs every transaction carries and that say nothing about who is trading
export const PLUMBING=new Set(['ComputeBudget111111111111111111111111111111','11111111111111111111111111111111','TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb','MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr']);

export const med=a=>{ const v=a.filter(x=>x!=null&&isFinite(x)).sort((x,y)=>x-y); if(!v.length) return null; const m=v.length>>1; return v.length%2?v[m]:(v[m-1]+v[m])/2; };
export const q=(a,p)=>{ const v=a.filter(x=>x!=null&&isFinite(x)).sort((x,y)=>x-y); if(!v.length) return null; const i=Math.min(v.length-1,Math.max(0,Math.round(p*(v.length-1)))); return v[i]; };
export const sum=a=>a.reduce((s,x)=>s+(x||0),0);
export const r2=x=>x==null||!isFinite(x)?null:Math.round(x*100)/100, r4=x=>x==null||!isFinite(x)?null:Math.round(x*1e4)/1e4;
export const day=ms=>new Date(ms).toISOString().slice(0,10);

/* ---------- the pool: constant liquidity inside the price's current range ----------
   Between ticks a CLMM pool is x·y=L² on its virtual reserves, so a swap of `in` (after the fee) moves
   √P by in/L (token1 in) or 1/√P by in/L (token0 in). A swap large enough to leave the current range
   would meet different liquidity; the study's simulated trades are small next to the pool, and the
   report says the maths holds liquidity constant. */
export function swapRaw(st, zfo, amountIn, fee){
  const inEff=amountIn*(1-fee), L=st.L, sp=st.sp;
  if(!(L>0&&sp>0&&amountIn>0)) return {out:0, sp};
  if(zfo){ const sp2=1/(1/sp+inEff/L); return {out:L*(sp-sp2), sp:sp2}; }
  const sp2=sp+inEff/L; return {out:L*(1/sp-1/sp2), sp:sp2}; }
/* CPOOL's price in the pool's other token (human units). pl: {c0: CPOOL is token0, d0, d1} */
export function cpoolPx(pl, sp){ const Ph=sp*sp*10**(pl.d0-pl.d1); return pl.c0?Ph:(Ph>0?1/Ph:null); }
/* buying CPOOL with the quote token (raw amount of quote in), and selling CPOOL (raw amount of CPOOL in) */
export function buyCpool(pl, st, quoteIn, fee){ return swapRaw(st, !pl.c0, quoteIn, fee); }
export function sellCpool(pl, st, cpoolIn, fee){ return swapRaw(st, pl.c0, cpoolIn, fee); }
const qDec=pl=>pl.c0?pl.d1:pl.d0, cDec=pl=>pl.c0?pl.d0:pl.d1;

/* ---------- one leg, valued at the market ----------
   leg: {pl (pool meta), zfo, a0, a1} with raw amounts; m: {cpool, quote} USD prices of the minute.
   Returns USD values in and out from the trader's side, and what the LPs and the protocol got. */
export function legValue(pl, leg, m){
  const inIs0=leg.zfo, ain=Number(inIs0?leg.a0:leg.a1), aout=Number(inIs0?leg.a1:leg.a0);
  const d=i=>i===0?pl.d0:pl.d1, px=i=>((i===0)===pl.c0)?m.cpool:m.quote;
  const vin=ain/10**d(inIs0?0:1)*px(inIs0?0:1), vout=aout/10**d(inIs0?1:0)*px(inIs0?1:0);
  if(!(isFinite(vin)&&isFinite(vout))) return null;
  const prot=vin*pl.fee*(1-pl.lpCut);
  return {vin, vout, trader:vout-vin, lps:vin-prot-vout, prot, fees:vin*pl.fee*pl.lpCut, cpoolIn:(inIs0===pl.c0)};
}

/* ---------- who is trading ----------
   A transaction is ATOMIC arbitrage when the trader ends it holding about the CPOOL it began with while
   CPOOL went through a pool: bought and sold in one go, profit taken in the other token. Per trader, over
   the window: YOU (a wallet of the deck), BRIDGE (a party to a bridge crossing), ATOMIC (most of its trades
   atomic), MARKET (a bot working the pools against the exchanges: its trades take the pool back toward the
   exchanges' price, three in four times or more, from gaps of a percent or more; or it pays block builders
   a tip on most trades), PERSON (the rest: people trade both ways too, but not toward the market). */
export function txFlags(rec, cpoolMint){
  const legs=rec.legs||[], cp=legs.reduce((s,l)=>s+Math.abs(l.cpoolAmt||0),0);
  const dC=(rec.d&&rec.d[cpoolMint])||0;
  const atomic=legs.length>0&&cp>0&&Math.abs(dC)<=0.02*cp/Math.max(1,legs.length)+1e-9&&legs.some(l=>l.cpoolAmt!=null);
  return {atomic, jito:(rec.tip||0)>0, multi:legs.length>=2};
}
export function classify(tr){
  if(tr.you) return 'you';
  if(tr.bridge) return 'bridge';
  if(tr.n>=2&&tr.atomic/tr.n>=0.5) return 'atomic';
  if(tr.n===1&&tr.atomic===1) return 'atomic';
  if(tr.legsN>=5&&tr.toward/tr.legsN>=0.75&&(tr.gapMed??0)>=0.01) return 'market';
  if(tr.n>=3&&tr.jito/tr.n>=0.6) return 'market';
  return 'person'; }
export const CLASS_NAME={you:'you', atomic:'atomic arbitrage bot', market:'market-making bot', bridge:'bridge trader', person:'people'};

/* ---------- gap episodes ----------
   pts: [{t, g, by}] in time order: g the gap after the event (log of one price over the other), by what
   caused it (a trade's id, or 'market' for the exchanges moving). An episode runs while |g| ≥ θ: the event
   that took it over θ opened it, the one that brought it back under closed it. */
export function episodes(pts, th){
  const out=[]; let cur=null;
  for(const p of pts){ const a=Math.abs(p.g);
    if(!cur&&a>=th){ cur={t0:p.t, open:p.by, peak:a, sign:Math.sign(p.g), ids:[p.by]}; continue; }
    if(cur){ cur.ids.push(p.by); if(a>cur.peak) cur.peak=a;
      if(a<th){ cur.t1=p.t; cur.close=p.by; out.push(cur); cur=null; } } }
  if(cur){ cur.t1=null; cur.close=null; out.push(cur); }
  return out; }

/* ---------- a self-correction between two pools of the same pair ----------
   A: the cheaper pool (CPOOL bought there), B: the dearer (sold there). The size is the one that would be
   best for a trader paying `cost` per leg instead of the fee: for us that is the fee less what comes back
   (our share of the LPs' part), so the pools end about two such costs apart, not two fees. Then the trade
   is booked with the real fee, and valued as the study values everything. */
export function bestArb(A, stA, B, stB, costA, costB, conv=null){
  /* conv: for pools quoted in different tokens, {rate: USD of B's quote ÷ USD of A's quote, cx: the cost of
     changing one quote for the other at the market (a deep SOL/USDC pool)}. Same quote: none. */
  const rate=conv?conv.rate:1, cx=conv?conv.cx:0, k2=10**(qDec(A)-qDec(B))*rate*(1-cx);
  const prof=qin=>{ const b=buyCpool(A,stA,qin,costA); const s=sellCpool(B,stB,b.out,costB); return s.out*k2-qin; };
  const pa=cpoolPx(A,stA.sp), pb=cpoolPx(B,stB.sp)*rate; if(!(pa>0&&pb>0)||pb<=pa) return null;
  // the most quote one could ever want in: what takes A's price to B's with no fee at all
  const k=10**(A.d0-A.d1);
  let hi=A.c0 ? stA.L*(Math.sqrt(pb/k)-stA.sp)              // CPOOL is token0: quote (token1) in raises √P
             : stA.L*(Math.sqrt(pb*k)-1/stA.sp);            // CPOOL is token1: quote (token0) in lowers √P, 1/√P rises to √(pb·k)
  if(!(hi>0)||!isFinite(hi)) return null;
  let lo=0; for(let i=0;i<90;i++){ const m1=lo+(hi-lo)/3, m2=hi-(hi-lo)/3; if(prof(m1)<prof(m2)) lo=m1; else hi=m2; }
  const qin=(lo+hi)/2; if(!(prof(qin)>0)) return null;
  const b=buyCpool(A,stA,qin,A.fee), s=sellCpool(B,stB,b.out,B.fee);
  return {qin, cpool:b.out, qout:s.out, spA:b.sp, spB:s.sp, cx}; }
/* what a correction leaves you with, valued at the market: your bot's side plus your share of each pool's
   LPs' side, less the transaction's cost (USD) and, between quotes, the cost of changing one for the other.
   sA, sB: your share of each pool's LP fees that day; mA, mB: {cpool, quote} USD prices for each pool. */
export function bookArb(A, B, r, mA, sA, sB, txUsd, mB=mA){
  const legA=legValue(A,{zfo:!A.c0, a0:A.c0?r.cpool:r.qin, a1:A.c0?r.qin:r.cpool},mA);
  const legB=legValue(B,{zfo:B.c0, a0:B.c0?r.cpool:r.qout, a1:B.c0?r.qout:r.cpool},mB);
  if(!legA||!legB) return null;
  const ext=(r.cx||0)*legB.vout, bot=legA.trader+legB.trader-txUsd-ext, lp=sA*legA.lps+sB*legB.lps;
  return {bot, lp, total:bot+lp, notional:legA.vin, prot:legA.prot+legB.prot, leak:(1-sA)*legA.lps+(1-sB)*legB.lps, ext}; }

/* ---------- selling smarter: one sale split across sibling pools ----------
   The CPOOL sold, put through whichever pool pays most for the next bit, a slice at a time: the split
   that ends both pools at about the same price. Returns quote received per pool (raw). */
export function splitSell(pools, sts, cpoolIn, n=60){
  const st=sts.map(s=>({...s})), got=pools.map(()=>0), used=pools.map(()=>0), step=cpoolIn/n;
  for(let k=0;k<n;k++){ let best=-1, bv=-1, br=null;
    pools.forEach((P,i)=>{ const r=sellCpool(P,st[i],step,P.fee); const v=r.out/10**qDec(P)*(P.qUsd||1); if(v>bv){ bv=v; best=i; br=r; } });
    if(best<0) break; got[best]+=br.out; used[best]+=step; st[best].sp=br.sp; }
  return {got, used, sts:st}; }
export { qDec, cDec };

/* ---------- robustness ---------- */
/* A correction capped so neither pool's price moves more than `cap` (log): past a few percent the pool's
   liquidity is no longer the one read at the price, so a larger simulated trade would claim depth that may
   not be there. Returns the trade scaled down (or as it was), and whether it was capped. */
export function capArb(A, stA, B, stB, r, cap, conv=null){
  if(!r) return null;
  const k2=conv?10**(qDec(A)-qDec(B))*conv.rate*(1-conv.cx):1;
  const move=qin=>{ const b=buyCpool(A,stA,qin,A.fee), s=sellCpool(B,stB,b.out,B.fee);
    return {b, s, m:Math.max(Math.abs(2*Math.log(b.sp/stA.sp)), Math.abs(2*Math.log(s.sp/stB.sp)))}; };
  const full=move(r.qin); if(full.m<=cap) return {...r, capped:false};
  let lo=0, hi=r.qin; for(let i=0;i<60;i++){ const mid=(lo+hi)/2; if(move(mid).m<=cap) lo=mid; else hi=mid; }
  const x=move(lo); if(!(lo>0)||!(x.s.out*k2>lo)) return null;   // capped down to nothing worth doing
  return {qin:lo, cpool:x.b.out, qout:x.s.out, spA:x.b.sp, spB:x.s.sp, cx:r.cx, capped:true}; }
/* A seeded random source, so a resampled range is the same every run on the same data. */
export const rng=seed=>{ let s=seed>>>0||1; return ()=>{ s^=s<<13; s>>>=0; s^=s>>>17; s^=s<<5; s>>>=0; return s/4294967296; }; };
/* The 28 days resampled with replacement: the range a total over that many days could have come out at.
   vals: one number per day. Returns the 10th, 50th and 90th percentiles of the total, the share of draws
   above zero, and the total without its single best day. */
export function bootstrap(vals, n=1000, seed=7){
  const R=rng(seed), k=vals.length; if(!k) return {p10:null, p50:null, p90:null, pPos:null, noBest:null};
  const tot=[]; for(let i=0;i<n;i++){ let s=0; for(let j=0;j<k;j++) s+=vals[Math.floor(R()*k)]; tot.push(s); }
  tot.sort((a,b)=>a-b); const at=p=>tot[Math.min(n-1,Math.max(0,Math.round(p*(n-1))))];
  return {p10:at(0.1), p50:at(0.5), p90:at(0.9), pPos:tot.filter(x=>x>0).length/n, noBest:vals.reduce((a,b)=>a+b,0)-Math.max(...vals)}; }
/* The verdict on one part of the plan, by fixed rules (never by eye):
   ROBUST — it paid in the half it was not tuned on, at least four times in five resampled months, and it
   still pays at the slower reaction time; PROMISING — it paid over the whole window and either in the untuned
   half or in three resampled months in five; else NOT PROVEN. */
export function verdict({full, oos, pPos, slow}){
  if(full>0&&oos>0&&pPos>=0.8&&(slow==null||slow>0)) return 'robust';
  if(full>0&&(oos>0||pPos>=0.6)) return 'promising';
  return 'not proven'; }

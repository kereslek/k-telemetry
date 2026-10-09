/* ---------- Solana position history ----------

   What a Raydium CLMM position was opened with, what has been taken back out of it, and what
   it has paid in fees — read from the position's own transactions, once, and kept.

   The chain does not publish a cost basis for a Raydium position the way a Uniswap v3 position
   carries one in its mint and increase events, and for a long time the page simply had none:
   every Solana row's DEPOSITED, P&L and FEES / $1K / DAY read blank or approximate. The history
   is all there, though. Every change to a position is a transaction that names the position's
   state account, and every such transaction carries an event the program emitted describing
   exactly what moved:

     CreatePersonalPositionEvent  — the opening deposit
     IncreaseLiquidityEvent       — a later deposit
     DecreaseLiquidityEvent       — principal returned AND fees paid, split out
     CollectPersonalFeeEvent      — fees paid without touching principal

   Reading the event rather than the token transfers matters for two reasons. It splits a
   withdrawal into principal and fees, which the transfers cannot — both arrive in the same
   account in the same instruction. And it carries the liquidity alongside the amounts, which
   with the position's range gives the pool's exact price at that moment: a1 = L(√P − √Pa) is
   one equation in one unknown. That is a historical price for a token no price feed covers,
   taken from the only market it had.

   The transfers are still read, as a fallback and as a check: a decode that disagrees with the
   money that actually moved is a decode that is wrong.

   Nothing here fetches anything on its own. The caller supplies the RPC and the price lookup,
   so the same code runs in the relay and in the probe that validated it. */
import crypto from 'node:crypto';

const disc=name=>crypto.createHash('sha256').update('event:'+name).digest().subarray(0,8);
export const DISC={
  create:  disc('CreatePersonalPositionEvent'),
  inc:     disc('IncreaseLiquidityEvent'),
  dec:     disc('DecreaseLiquidityEvent'),
  collect: disc('CollectPersonalFeeEvent'),
};

const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58enc(bytes){
  let n=0n; for(const x of bytes) n=n*256n+BigInt(x);
  let s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; }
  for(const x of bytes){ if(x===0) s='1'+s; else break; }
  return s;
}

/* Every CLMM event in a transaction, decoded. Fields are read in declaration order and only the
   leading ones are required, because later program versions append fields (transfer fees,
   rewards) and a decoder that insisted on the newest length would reject the older history. */
export function decodeClmmEvents(logs){
  const out=[];
  for(const line of logs||[]){
    if(typeof line!=='string' || !line.startsWith('Program data: ')) continue;
    let b; try{ b=Buffer.from(line.slice(14).trim(),'base64'); }catch(e){ continue; }
    if(b.length<8) continue;
    const d=b.subarray(0,8); let o=8;
    const pk=()=>{ const v=b58enc(b.subarray(o,o+32)); o+=32; return v; };
    const u64=()=>{ const v=b.readBigUInt64LE(o); o+=8; return v; };
    const u128=()=>{ const lo=b.readBigUInt64LE(o), hi=b.readBigUInt64LE(o+8); o+=16; return lo+(hi<<64n); };
    const i32=()=>{ const v=b.readInt32LE(o); o+=4; return v; };
    try{
      if(d.equals(DISC.inc) && b.length>=8+32+16+16){
        const nft=pk(), liq=u128(), a0=u64(), a1=u64();
        out.push({kind:'inc', nft, liq, a0, a1});
      }else if(d.equals(DISC.dec) && b.length>=8+32+16+32){
        const nft=pk(), liq=u128(), a0=u64(), a1=u64(), f0=u64(), f1=u64();
        out.push({kind:'dec', nft, liq, a0, a1, f0, f1});
      }else if(d.equals(DISC.create) && b.length>=8+96+8+16+16){
        const pool=pk(), minter=pk(), owner=pk(), tl=i32(), tu=i32(), liq=u128(), a0=u64(), a1=u64();
        out.push({kind:'create', pool, minter, owner, tl, tu, liq, a0, a1});
      }else if(d.equals(DISC.collect) && b.length>=8+96+16){
        const nft=pk(); pk(); pk(); const f0=u64(), f1=u64();
        out.push({kind:'collect', nft, f0, f1});
      }
    }catch(e){}
  }
  return out;
}

/* Token movements between the owner and anybody else, for the mints of one position, read from
   the transfers the program actually made. Ownership of a token account comes from the balance
   table where the account survives the transaction, and from the instructions that created it
   where it does not — the wrapped-SOL account a deposit or withdrawal of SOL passes through is
   opened and closed inside the same transaction and appears in neither balance table. */
export function transferFlows(tx, owner, mints){
  const msg=tx&&tx.transaction&&tx.transaction.message; if(!msg) return null;
  const keys=(msg.accountKeys||[]).map(k=>typeof k==='string'?k:(k&&k.pubkey));
  const ownerOf={}, mintOf={}, decOf={};
  for(const bl of [...(tx.meta.preTokenBalances||[]),...(tx.meta.postTokenBalances||[])]){
    const a=keys[bl.accountIndex];
    if(a&&bl.owner) ownerOf[a]=bl.owner;
    if(a&&bl.mint) mintOf[a]=bl.mint;
    if(bl.mint&&bl.uiTokenAmount&&bl.uiTokenAmount.decimals!=null) decOf[bl.mint]=bl.uiTokenAmount.decimals;
  }
  const all=[...(msg.instructions||[])];
  for(const g of (tx.meta.innerInstructions||[])) all.push(...(g.instructions||[]));
  for(const ins of all){
    const p=ins&&ins.parsed; if(!p||typeof p!=='object') continue;
    const i=p.info||{};
    if(/^initializeAccount/.test(p.type||'') && i.account && i.owner){ ownerOf[i.account]=i.owner; if(i.mint) mintOf[i.account]=i.mint; }
    if((p.type==='create'||p.type==='createIdempotent') && i.account && i.wallet){ ownerOf[i.account]=i.wallet; if(i.mint) mintOf[i.account]=i.mint; }
  }
  const out={}, inn={};
  for(const ins of all){
    const p=ins&&ins.parsed; if(!p||typeof p!=='object') continue;
    if(p.type!=='transfer' && p.type!=='transferChecked') continue;
    const i=p.info||{};
    const mint=i.mint||mintOf[i.source]||mintOf[i.destination];
    if(!mint || (mints.length && !mints.includes(mint))) continue;
    let raw=null;
    if(i.tokenAmount&&i.tokenAmount.amount!=null) raw=BigInt(i.tokenAmount.amount);
    else if(i.amount!=null) raw=BigInt(i.amount);
    if(raw==null||raw<=0n) continue;
    const fromMe = ownerOf[i.source]===owner || i.authority===owner || i.multisigAuthority===owner;
    const toMe   = ownerOf[i.destination]===owner;
    if(fromMe && !toMe) out[mint]=(out[mint]||0n)+raw;
    else if(toMe && !fromMe) inn[mint]=(inn[mint]||0n)+raw;
  }
  return {out, inn, decOf};
}

const tickSqrt=t=>Math.pow(1.0001,t/2);

/* The pool's price at the moment of a liquidity change, from the change itself.
   a1 = L(√P − √Pa) and a0 = L(1/√P − 1/√Pb) each give √P on their own when the position was in
   range, which is exactly when both amounts are non-zero. One-sided amounts only bound the price
   and are not used. Raw units throughout; the caller scales by decimals. */
export function impliedSqrt(liq, a0, a1, tl, tu){
  const L=Number(liq); if(!(L>0) || !(a0>0n) || !(a1>0n)) return null;
  const sa=tickSqrt(tl), sb=tickSqrt(tu);
  const s1=Number(a1)/L+sa;
  const s0=1/(Number(a0)/L+1/sb);
  if(!(s1>sa&&s1<sb)) return null;
  /* Both roads should arrive at the same place. Rounding in the program's favour moves them
     apart by a hair; anything more is a decode that is reading the wrong field. */
  if(Math.abs(s1/s0-1)>0.01) return null;
  return (s0+s1)/2;
}

/* One transaction's effect on one position, in raw units. Events first; transfers when the
   events are missing or cannot be matched to this position. */
export function positionEffect(tx, pos){
  const t=tx.blockTime||null, sig=(tx.transaction&&tx.transaction.signatures&&tx.transaction.signatures[0])||null;
  const ev=decodeClmmEvents(tx.meta&&tx.meta.logMessages);
  const mine=ev.filter(e=>(e.nft&&e.nft===pos.nftMint) ||
    (e.kind==='create' && e.pool===pos.poolId && e.tl===pos.tl && e.tu===pos.tu && e.owner===pos.owner));
  const r={sig, t, dep:[0n,0n], wd:[0n,0n], fee:[0n,0n], dL:0n, sqrt:null, src:null, kinds:[]};
  const hasInc=mine.some(e=>e.kind==='inc');
  for(const e of mine){
    r.kinds.push(e.kind);
    /* An opening can emit both the creation and an increase describing the same deposit. Count
       the increase when there is one, the creation only when it stands alone. */
    if(e.kind==='create' && hasInc) continue;
    if(e.kind==='inc'||e.kind==='create'){
      r.dep[0]+=e.a0; r.dep[1]+=e.a1; r.dL+=e.liq;
      r.sqrt=r.sqrt ?? impliedSqrt(e.liq,e.a0,e.a1,pos.tl,pos.tu);
    }else if(e.kind==='dec'){
      r.wd[0]+=e.a0; r.wd[1]+=e.a1; r.fee[0]+=e.f0; r.fee[1]+=e.f1; r.dL-=e.liq;
      r.sqrt=r.sqrt ?? impliedSqrt(e.liq,e.a0,e.a1,pos.tl,pos.tu);
    }else if(e.kind==='collect'){
      r.fee[0]+=e.f0; r.fee[1]+=e.f1;
    }
  }
  if(mine.length){ r.src='event'; }
  const tf=transferFlows(tx, pos.owner, [pos.mint0,pos.mint1]);
  if(tf){
    r.xfer={out:[tf.out[pos.mint0]||0n, tf.out[pos.mint1]||0n], inn:[tf.inn[pos.mint0]||0n, tf.inn[pos.mint1]||0n]};
    if(!mine.length && pos.soleInTx){
      /* No event could be tied to this position. Fall back to what moved, but only when no
         other position of ours was touched by the same transaction — otherwise the money
         cannot be divided between them honestly. Principal and fees cannot be told apart this
         way, so a withdrawal read like this is all principal and says so. */
      r.dep=r.xfer.out; r.wd=r.xfer.inn; r.src='transfer';
    }
  }
  return r;
}

/* Walk a position's signature history. New signatures from the top, and — until the beginning
   has been reached — older ones from the bottom, a bounded number of pages per call. The state
   is the caller's to persist; what has been read never has to be read again. */
export async function syncSignatures(rpc, addr, st, maxPages=2){
  st.sigs=st.sigs||[];
  let calls=0;
  // newer than what we hold
  if(st.sigs.length){
    const q={limit:1000, until:st.sigs[0].s};
    const got=await rpc('getSignaturesForAddress',[addr,q]); calls++;
    if(Array.isArray(got)&&got.length) st.sigs=[...got.map(x=>({s:x.signature,t:x.blockTime||null,e:!!x.err})), ...st.sigs];
  }
  // older, until the start is reached
  let pages=0;
  while(!st.complete && pages<maxPages){
    const q={limit:1000}; if(st.sigs.length) q.before=st.sigs[st.sigs.length-1].s;
    const got=await rpc('getSignaturesForAddress',[addr,q]); calls++; pages++;
    if(!Array.isArray(got)) break;
    st.sigs.push(...got.map(x=>({s:x.signature,t:x.blockTime||null,e:!!x.err})));
    if(got.length<1000){ st.complete=true; break; }
  }
  return calls;
}

/* ---------- a Solana RPC client that survives the free endpoints ----------

   The public endpoints fail in three different ways and the old client treated them as one:
   an error of any kind moved straight on to the next URL, and when all three said no the call
   was lost. Rate limiting is not failure — it is an instruction to wait — and a history walk of
   several hundred transactions from a GitHub runner, whose IP is shared with everybody else's
   jobs, will be throttled as a matter of course.

   So: an endpoint that answers 429 is benched for a while rather than hammered, a call that
   meets only throttled endpoints waits and tries again instead of giving up, and anything that
   is a genuine refusal (a method the endpoint does not serve, history it does not keep) moves
   on at once. A keyed endpoint, if one is configured, goes first; the public ones stay behind
   it as a fallback, so a key that expires or runs out degrades the page to slower rather than
   to broken.

   Every call is counted, per endpoint and per method, so the cost of a run is a measured number
   rather than an estimate. */
export function makeRpc(urls, {timeout=20000, log=()=>{}, nullIsMiss=false}={}){
  const stats={calls:0, byUrl:{}, byMethod:{}, throttled:0, failed:0, retries:0};
  const bench={};             // url -> epoch ms until which it is skipped
  let id=1;
  const label=u=>{ try{ const x=new URL(u); return x.host+(x.search?'?…':''); }catch(e){ return u.slice(0,24); } };
  async function once(url, method, params){
    const ctrl=new AbortController(); const tm=setTimeout(()=>ctrl.abort(),timeout);
    try{
      const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:id++,method,params}),signal:ctrl.signal});
      if(r.status===429) return {throttle:true};
      if(!r.ok) return {err:'HTTP '+r.status};
      const js=await r.json();
      if(js.error){
        const m=String(js.error.message||JSON.stringify(js.error));
        if(js.error.code===429 || /rate|too many|limit exceeded/i.test(m)) return {throttle:true};
        return {err:m.slice(0,120), rpcErr:js.error.code};
      }
      return {ok:true, result:js.result};
    }catch(e){ return {err:String(e&&e.name==='AbortError'?'timeout':(e&&e.message)||e).slice(0,80)}; }
    finally{ clearTimeout(tm); }
  }
  async function rpc(method, params){
    stats.byMethod[method]=(stats.byMethod[method]||0)+1;
    let lastErr='no endpoint', sawThrottle=false;
    for(let round=0; round<4; round++){
      let anyTried=false;
      for(const url of urls){
        if(bench[url] && bench[url]>Date.now()) continue;
        anyTried=true;
        const L=label(url);
        const s=stats.byUrl[L]=stats.byUrl[L]||{calls:0,throttled:0,errors:0};
        s.calls++; stats.calls++;
        const r=await once(url, method, params);
        /* A transaction the node does not keep comes back as null, which is indistinguishable
           from a transaction that does not exist. The probe caught a short-history endpoint
           answering null for 36 of one position's 44 transactions, and the history reading as
           if they had never happened. On an archive client a null is a miss: ask the next. */
        if(r.ok && r.result===null && nullIsMiss && method==='getTransaction' && url!==urls[urls.length-1]){ s.misses=(s.misses||0)+1; continue; }
        if(r.ok) return r.result;
        if(r.throttle){ s.throttled++; stats.throttled++; sawThrottle=true; bench[url]=Date.now()+4000*(round+1); continue; }
        s.errors++; lastErr=L+': '+r.err;
      }
      /* Everybody was benched or throttled. Wait for the earliest to come back rather than
         reporting a rate limit as though the data did not exist. */
      const soonest=Math.min(...urls.map(u=>bench[u]||0));
      const wait=Math.max(1500, soonest-Date.now());
      /* Waiting is only worth it when this call was told to wait. A genuine refusal from every
         endpoint is not going to change in fifteen seconds. */
      if(!anyTried || sawThrottle){ stats.retries++; await new Promise(r=>setTimeout(r, Math.min(wait,15000))); continue; }
      break;
    }
    stats.failed++;
    throw new Error(lastErr);
  }
  rpc.stats=stats;
  rpc.label=label;
  return rpc;
}

/* ---------- the ledger, kept per position ----------

   State lives in the relay's block cache between runs:
     top / bot  newest and oldest signature already listed
     done       the listing has reached the position's opening
     todo       signatures listed but not yet read, oldest last
     ev         the liquidity and fee events found, amounts in raw units as strings
     openT      block time of the opening transaction
   A transaction is read once. What it said is a fact about the past and is never read again,
   so after the first backfill a pass costs one listing call per position and nothing more. */
/* Bumped when what an event records changes. A ledger written by an older version is rebuilt
   rather than trusted: v2 added the liquidity each event moved, which is what makes the ledger
   checkable against the chain at all. */
export const LEDGER_V=2;
export async function syncPositionLedger(rpc, pos, st, {ourPdas, maxTx=40, maxPages=2}={}){
  if(st.v!==LEDGER_V){ for(const k of Object.keys(st)) if(k!=='seen') delete st[k]; st.v=LEDGER_V; }
  st.ev=st.ev||[]; st.todo=st.todo||[]; st.miss=st.miss||{};
  let calls=0, read=0;
  if(st.top){
    const got=await rpc('getSignaturesForAddress',[pos.pda,{limit:1000, until:st.top}]); calls++;
    if(Array.isArray(got)&&got.length){
      st.todo.unshift(...got.filter(x=>!x.err).map(x=>x.signature));
      st.top=got[0].signature;
    }
  }
  let pages=0;
  while(!st.done && pages<maxPages){
    const q={limit:1000}; if(st.bot) q.before=st.bot;
    const got=await rpc('getSignaturesForAddress',[pos.pda,q]); calls++; pages++;
    if(!Array.isArray(got)) break;
    if(!st.top && got.length) st.top=got[0].signature;
    st.todo.push(...got.filter(x=>!x.err).map(x=>x.signature));
    if(got.length){ st.bot=got[got.length-1].signature; if(got[got.length-1].blockTime) st.openT=got[got.length-1].blockTime; }
    if(got.length<1000) st.done=true;
  }
  while(st.todo.length && read<maxTx){
    const sig=st.todo[st.todo.length-1];
    const tx=await rpc('getTransaction',[sig,{maxSupportedTransactionVersion:0,encoding:'jsonParsed'}]); calls++; read++;
    if(!tx||!tx.meta){
      /* Not served this time. Left queued; after enough refusals it is dropped and the ledger
         is marked as having a hole, so it can never present itself as complete. */
      st.miss[sig]=(st.miss[sig]||0)+1;
      if(st.miss[sig]>=6){ st.todo.pop(); st.lost=(st.lost||0)+1; delete st.miss[sig]; continue; }
      break;
    }
    st.todo.pop(); delete st.miss[sig];
    if(st.ev.some(e=>e.s===sig)) continue;
    const keys=((tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys)||[]).map(k=>typeof k==='string'?k:(k&&k.pubkey));
    pos.soleInTx=!ourPdas || keys.filter(k=>ourPdas.has(k)).length<=1;
    const r=positionEffect(tx,pos);
    const nz=a=>a.some(x=>x>0n);
    if(nz(r.dep)||nz(r.wd)||nz(r.fee)){
      st.ev.push({s:sig, t:r.t, src:r.src, sq:r.sqrt, l:String(r.dL),
        d:r.dep.map(String), w:r.wd.map(String), f:r.fee.map(String)});
    }
  }
  st.ev.sort((a,b)=>(a.t||0)-(b.t||0));
  st.complete=!!st.done && !st.todo.length && !st.lost;
  return {calls, read};
}

/* Dollar value of every deposit at the moment it was made.

   The anchor leg is priced from a feed that can be trusted for it — SOL from its historical
   price, a stablecoin at a dollar. The other leg is priced from the pool: each event that moved
   both tokens fixes the pool's exact price at that instant, and every such event across every
   position is one point on a price history for the token no feed covers correctly. (DefiLlama
   maps the Solana CPOOL mint to the Ethereum token's price, identical to fifteen digits; on the
   day the bridge was shut the two were 123% apart.)

   A deposit is priced from its own event when it can be, otherwise from the nearest pool
   reading within three days, otherwise from the relay's own daily record for that date. One
   that none of those can price is left unpriced, and a position with an unpriced deposit has no
   cost basis rather than a wrong one. Values are cached on the event: computed once, never
   again. */
export async function valueDeposits(items, {anchorUsd, dailyUsd, isAnchor}){
  const H=(x,d)=>Number(BigInt(x))/10**d;
  const tl={};                                  // mint -> [{t,usd}]
  const hp=(e,pos)=>e.sq?e.sq*e.sq*10**(pos.d0-pos.d1):null;
  for(const {pos,st} of items){
    for(const e of st.ev){
      const px=hp(e,pos); if(!px||!e.t) continue;
      if(e.a==null){
        const a0=isAnchor(pos.mint0)?await anchorUsd(pos.mint0,e.t):null;
        const a1=isAnchor(pos.mint1)?await anchorUsd(pos.mint1,e.t):null;
        let u0=a0, u1=a1;
        if(u0==null&&u1!=null) u0=px*u1;
        if(u1==null&&u0!=null) u1=u0/px;
        e.a=(u0!=null&&u1!=null)?[u0,u1]:0;       // 0 = tried and could not
      }
      if(e.a){ (tl[pos.mint0]=tl[pos.mint0]||[]).push({t:e.t,usd:e.a[0]}); (tl[pos.mint1]=tl[pos.mint1]||[]).push({t:e.t,usd:e.a[1]}); }
    }
  }
  const near=(mint,t)=>{
    let best=null;
    for(const x of tl[mint]||[]){ const dt=Math.abs(x.t-t); if(dt<=3*86400 && (!best||dt<best.dt)) best={usd:x.usd,dt}; }
    return best?best.usd:null;
  };
  const priceLeg=async(mint,t,own)=>{
    if(own!=null) return {usd:own, src:'event'};
    if(isAnchor(mint)){ const v=await anchorUsd(mint,t); if(v!=null) return {usd:v, src:'feed'}; }
    const n=near(mint,t); if(n!=null) return {usd:n, src:'pool'};
    const dly=dailyUsd(mint,t); if(dly!=null) return {usd:dly, src:'daily'};
    return null;
  };
  for(const {pos,st} of items){
    for(const e of st.ev){
      const d0=H(e.d[0],pos.d0), d1=H(e.d[1],pos.d1);
      if(!(d0>0||d1>0) || e.du!=null) continue;
      const own=e.a||null;
      const p0=d0>0?await priceLeg(pos.mint0,e.t,own?own[0]:null):{usd:0,src:'-'};
      const p1=d1>0?await priceLeg(pos.mint1,e.t,own?own[1]:null):{usd:0,src:'-'};
      if(p0&&p1){ e.du=d0*p0.usd+d1*p1.usd; e.ds=[p0.src,p1.src].filter(x=>x!=='-').join('+'); }
    }
  }
}

/* What the history says, in token units and — for deposits — dollars at the time. */
export function summarizeLedger(st, pos){
  const H=(x,d)=>Number(BigInt(x))/10**d;
  const o={dep:[0,0], wd:[0,0], fee:[0,0], costUsd:0, unpriced:0, n:st.ev.length, first:null, src:{}, liq:0n, liqKnown:true};
  for(const e of st.ev){
    if(e.l==null) o.liqKnown=false; else o.liq+=BigInt(e.l);
    const d=[H(e.d[0],pos.d0),H(e.d[1],pos.d1)];
    o.dep[0]+=d[0]; o.dep[1]+=d[1];
    o.wd[0]+=H(e.w[0],pos.d0); o.wd[1]+=H(e.w[1],pos.d1);
    o.fee[0]+=H(e.f[0],pos.d0); o.fee[1]+=H(e.f[1],pos.d1);
    if(d[0]>0||d[1]>0){
      if(e.du==null) o.unpriced++; else { o.costUsd+=e.du; if(e.ds) o.src[e.ds]=(o.src[e.ds]||0)+1; }
      if(o.first==null || e.t<o.first) o.first=e.t;
    }
  }
  o.complete=!!st.complete;
  /* The audit. Every liquidity change a position has ever had is in its history, so for a
     complete history the net of them is the liquidity the position holds right now — exactly,
     to the unit, because both sides are the program's own integers. A deposit or withdrawal the
     reader missed, a fee-only event misread as principal, a transaction attributed to the wrong
     position: any of them breaks the equality. Only a ledger that balances is allowed to state
     a cost basis. A withdrawal the fallback read from transfers carries no liquidity, so a
     history that needed the fallback for principal cannot balance and says so. */
  o.liqNow = pos.liq!=null ? BigInt(pos.liq) : null;
  o.balanced = o.complete && o.liqKnown && o.liqNow!=null && o.liq===o.liqNow;
  if(o.unpriced) o.costUsd=null;
  return o;
}

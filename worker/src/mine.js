/* Your own swaps, kept to be shown beside the trades and never as income. The fee a swap of yours
   pays into your own pool is already kept out of the record (index.js, ownShare); this is the swap
   itself, as a cause: what it did to your pool's price, and the trades that came after it (an
   arbitrage bot answering it, often within seconds). Any swap a wallet of yours makes in a token of
   your pools, through any venue: on Ethereum found from that token's transfers to or from your
   wallets, on Solana from your wallets' own signatures. Each is kept for a day with when it was
   made (its block's time), what you sold and what you bought, its size in dollars, and where it
   went through. A plain transfer, a harvest or a deposit moves tokens too but swaps nothing, and is
   left out. */
import {one, EVM_RPCS} from './sampler.js';

const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SWAP_V3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const SWAP_V2='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
const SWAP_V4='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
// the other side of a pool: what a token of yours is traded against, never watched itself
const BASE_EVM={'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2':'ETH','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48':'USDC',
  '0xdac17f958d2ee523a2206206994597c13d831ec7':'USDT','0x6b175474e89094c44da98b954eedeac495271d0f':'DAI'};
const WSOL='So11111111111111111111111111111111111111112';
const BASE_SOL={[WSOL]:'SOL','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v':'USDC','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':'USDT'};
const SOL_VENUES={'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4':'Jupiter','CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK':'Raydium CLMM',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':'Raydium AMM','CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C':'Raydium CPMM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':'Orca','LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':'Meteora DLMM','Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB':'Meteora'};
const DAY=86400000;
const SWAP_LOG=/Instruction: (Swap|SwapV2|SwapBaseIn|SwapBaseOut|SwapBaseInput|SwapBaseOutput|Route|RouteV2|SharedAccountsRoute|ExactOutRoute|SharedAccountsExactOutRoute)\b/i;

/* The tokens of your pools worth watching (each side that is not ETH, SOL or a dollar), with what
   the pool knows of them: symbol, decimals and dollar price. And your own pools, by address. */
export function tracked(ps){
  const eth=new Map(), sol=new Map(), pools={eth:new Map(), sol:new Map()};
  for(const p of ps||[]){
    const c=p.chain==='eth'?'eth':'sol', base=c==='eth'?BASE_EVM:BASE_SOL, T=c==='eth'?eth:sol;
    pools[c].set(c==='eth'?String(p.pool).toLowerCase():p.pool, p.lbl);
    for(const [a,s,d,u] of [[c==='eth'?p.t0:p.m0,p.s0,p.d0,p.usd0],[c==='eth'?p.t1:p.m1,p.s1,p.d1,p.usd1]]){
      if(!a) continue; const k=c==='eth'?String(a).toLowerCase():String(a);
      if(!base[k]&&!T.has(k)) T.set(k,{sym:s||'?', dec:Number(d)||0, usd:Number(u)||0}); } }
  return {eth, sol, pools};
}

/* One Ethereum transaction, for the deck's wallets: the tokens they gained and gave (Transfer logs;
   ether paid in or got back sends none, and is what the other side is when no token went that
   way), and the pools it swapped through. Null unless it swapped and moved a token of yours. */
export function evmSwapOf(rc, tx, wallets, T, ownPools){
  const logs=(rc&&rc.logs)||[], sw=logs.filter(l=>l.topics&&[SWAP_V3,SWAP_V2,SWAP_V4].includes(l.topics[0]));
  if(!sw.length) return null;
  const W=new Set((wallets||[]).map(x=>String(x).toLowerCase())), d={};
  for(const l of logs){ if(!l.topics||l.topics[0]!==TRANSFER||l.topics.length<3) continue;
    const a=String(l.address).toLowerCase(), from='0x'+String(l.topics[1]).slice(26).toLowerCase(), to='0x'+String(l.topics[2]).slice(26).toLowerCase();
    let v; try{ v=BigInt(l.data); }catch(e){ continue; }
    if(W.has(to)) d[a]=(d[a]||0n)+v; if(W.has(from)) d[a]=(d[a]||0n)-v; }
  const mine=Object.keys(d).filter(k=>T.has(k)&&d[k]!==0n); if(!mine.length) return null;
  const amt=k=>Math.abs(Number(d[k]))/10**T.get(k).dec;
  const k=mine.sort((a,b)=>amt(b)*T.get(b).usd-amt(a)*T.get(a).usd)[0], tk=T.get(k), bought=d[k]>0n;
  // the other side: a token that went the other way, else the ether paid in (a buy) or got back (a sale, unwrapped by the router)
  const other=Object.keys(d).filter(x=>x!==k&&(d[x]>0n)!==bought&&d[x]!==0n).map(x=>BASE_EVM[x]||(T.get(x)||{}).sym||'token')[0]||'ETH';
  const own=sw.map(l=>ownPools.get(String(l.address).toLowerCase())).find(Boolean)||null;
  const venues=[...new Set(sw.map(l=>own&&ownPools.get(String(l.address).toLowerCase())?'your pool':l.topics[0]===SWAP_V4?'Uniswap v4':l.topics[0]===SWAP_V2?'a v2-style pool':'Uniswap v3'))];
  return {chain:'eth', tok:tk.sym, side:bought?'bought':'sold', other, usd:Math.round(amt(k)*tk.usd*100)/100,
          venue:venues.join(' + '), own, pool:own?sw.map(l=>String(l.address).toLowerCase()).find(a=>ownPools.has(a)):null};
}

/* One Solana transaction, for one wallet of yours: its token changes (by mint, from the token
   accounts it owns) and its SOL change (the fee given back), when the transaction swapped. Null
   unless it swapped and moved a token of yours. */
export function solSwapOf(tx, w, T, ownPools){
  const m=tx&&tx.meta; if(!m||m.err) return null;
  if(!(m.logMessages||[]).some(l=>SWAP_LOG.test(l))) return null;
  const msg=(tx.transaction&&tx.transaction.message)||{};
  const keys=[...(msg.accountKeys||msg.staticAccountKeys||[]),...((m.loadedAddresses&&m.loadedAddresses.writable)||[]),...((m.loadedAddresses&&m.loadedAddresses.readonly)||[])].map(x=>String(x&&x.pubkey||x));
  const d={}, ui=x=>Number((x&&x.uiTokenAmount&&(x.uiTokenAmount.uiAmountString??x.uiTokenAmount.uiAmount))||0);
  for(const x of m.preTokenBalances||[]) if(x.owner===w) d[x.mint]=(d[x.mint]||0)-ui(x);
  for(const x of m.postTokenBalances||[]) if(x.owner===w) d[x.mint]=(d[x.mint]||0)+ui(x);
  const i=keys.indexOf(w);
  if(i>=0&&Array.isArray(m.preBalances)&&Array.isArray(m.postBalances)){ const sol=((m.postBalances[i]||0)-(m.preBalances[i]||0)+(i===0?(m.fee||0):0))/1e9;
    if(Math.abs(sol)>1e-6) d[WSOL]=(d[WSOL]||0)+sol; }
  const mine=Object.keys(d).filter(k=>T.has(k)&&Math.abs(d[k])>1e-12); if(!mine.length) return null;
  const k=mine.sort((a,b)=>Math.abs(d[b])*T.get(b).usd-Math.abs(d[a])*T.get(a).usd)[0], tk=T.get(k), bought=d[k]>0;
  const ot=Object.keys(d).filter(x=>x!==k&&Math.sign(d[x])===(bought?-1:1)).sort((a,b)=>Math.abs(d[b])-Math.abs(d[a]))[0];
  const ownId=keys.find(x=>ownPools.has(x))||null;
  const venue=ownId?'your pool':(keys.includes('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')?'Jupiter':(Object.entries(SOL_VENUES).find(([p])=>keys.includes(p))||[,'a Solana DEX'])[1]);
  return {chain:'sol', tok:tk.sym, side:bought?'bought':'sold', other:ot?(BASE_SOL[ot]||(T.get(ot)||{}).sym||'token'):'SOL',
          usd:Math.round(Math.abs(d[k])*tk.usd*100)/100, venue, own:ownId?ownPools.get(ownId):null, pool:ownId};
}

/* Look for new swaps of yours, a little at a time. Each look asks the chains at most `budget`
   times a chain (a request to this recorder may only make so many), carries on where the last look
   stopped, and keeps every swap it found even when a later ask fails: a transaction is marked as
   looked at only once it has been read in full. `st` is kept between looks: the last Ethereum
   block looked through, the transactions still to open, those already opened (a day), and what
   each chain's last look did, in counts only (`st.diag`, which /m and the daily audit show).
   Returns the new swaps, each with its block's time and its transaction (`id`, never shown), so
   the day's list holds each swap once. `call` is the chain ask (one, from sampler.js), handed one
   endpoint at a time so that every endpoint tried counts against the budget; the endpoint that
   last answered a method is tried first. */
const BUDGET=18, MARGIN=3, CHUNK=1000, OUT=new Error('budget'), good=new Map();
const kind=e=>{ const s=String(e&&e.message||e); return /too many subrequests/i.test(s)?'request limit':/429|rate.?limit|too many requests/i.test(s)?'rate limit'
  :/timed? ?out|timeout|abort/i.test(s)?'timeout':'rpc error'; };
export async function scanMine(st, {ps, wallets, solRpcs, chains=['eth','sol'], now=Date.now(), budget=BUDGET, call=one}){
  const T=tracked(ps), out=[]; st.seen=st.seen||{}; st.diag=st.diag||{};
  const W={eth:((wallets&&wallets.eth)||[]).map(x=>String(x).toLowerCase()), sol:(wallets&&wallets.sol)||[]};
  for(const c of ['eth','sol']){ if(!chains.includes(c)) continue;
    const D=st.diag[c]={at:now, tok:T[c].size, w:W[c].length, asks:0, found:0, q:0, err:null};
    if(!T[c].size||!W[c].length) continue;
    let n=0; const ask=async(rpcs,method,params)=>{ const errs=[], g=good.get(c+method), order=g&&rpcs.includes(g)?[g,...rpcs.filter(u=>u!==g)]:rpcs;
      for(const u of order){ if(n>=budget) throw OUT; n++;
        try{ const r=await call([u],method,params); good.set(c+method,u); return r; }catch(e){ errs.push(String(e&&e.message||e)); } }
      throw new Error(errs.join(' | ')||'no rpc'); };
    try{ await (c==='eth'?ethLook(st,T,W.eth,ask,out,now):solLook(st,T,W.sol,solRpcs,ask,out,now,budget)); }
    catch(e){ if(e!==OUT) D.err=kind(e); }
    D.asks=n; D.found=out.filter(x=>x.chain===c).length; D.q=((c==='eth'?st.qe:st.qs)||[]).length;
    if(c==='eth') D.behind=st.top!=null&&st.ethBlock!=null?Math.max(0,st.top-st.ethBlock):null; }
  for(const k of Object.keys(st.seen)) if(now-st.seen[k]>DAY+3600e3) delete st.seen[k];
  return out;
}
/* Ethereum: the transactions found earlier are opened first, then the blocks since the last look,
   a thousand at a time, for transfers of your pools' tokens to or from your wallets. Blocks are
   looked through up to three short of the newest, so a node a block or two behind still has them. */
async function ethLook(st,T,W,ask,out,now){
  const q=st.qe=st.qe||[], pad=a=>'0x'+a.slice(2).padStart(64,'0'), tw=W.map(pad), toks=[...T.eth.keys()], hex=v=>'0x'+v.toString(16);
  const open=async()=>{ while(q.length){ const x=q[0];
    if(st.seen[x.h]){ q.shift(); continue; }
    const rc=await ask(EVM_RPCS,'eth_getTransactionReceipt',[x.h]);
    // not there yet (the node answering is behind): tried again on a later look, given up after five
    if(!rc){ q.shift(); if(++x.n<5) q.push(x); else st.seen[x.h]=now; return; }
    const r=rc.status==='0x1'?evmSwapOf(rc,null,W,T.eth,T.pools.eth):null;
    if(r){ const b=await ask(EVM_RPCS,'eth_getBlockByNumber',[rc.blockNumber,false]); r.t=b&&b.timestamp?parseInt(b.timestamp,16)*1000:now; r.id=x.h; out.push(r); }
    st.seen[x.h]=now; q.shift(); } };
  await open();
  const top=parseInt(await ask(EVM_RPCS,'eth_blockNumber',[]),16)-MARGIN; if(!(top>0)) throw new Error('no block number');
  st.top=top;
  if(st.ethBlock==null||top-st.ethBlock>7200) st.ethBlock=top-7200;          // the first look, or one after a day asleep, reaches back a day
  while(st.ethBlock<top){ const a=st.ethBlock+1, z=Math.min(top,a+CHUNK-1), f={address:toks, fromBlock:hex(a), toBlock:hex(z)}, hs=new Set();
    for(const topics of [[TRANSFER,tw],[TRANSFER,null,tw]]) for(const l of (await ask(EVM_RPCS,'eth_getLogs',[{...f,topics}]))||[]) hs.add(l.transactionHash);
    st.ethBlock=z;
    for(const h of hs) if(!st.seen[h]&&!q.some(x=>x.h===h)) q.push({h, n:0});
    await open(); }
}
/* Solana: each wallet's latest signatures (a day's worth, up to a hundred, its first time; then
   the last 25), a few wallets a look when there are many, then their transactions. */
async function solLook(st,T,W,rpcs,ask,out,now,budget){
  const q=st.qs=st.qs||[], first=st.first=st.first||{};
  for(let i=0, k=Math.min(W.length,Math.ceil(budget/2)); i<k; i++){ const w=W[(st.wi||0)%W.length];
    const sigs=await ask(rpcs,'getSignaturesForAddress',[w,{limit:first[w]?25:100, commitment:'confirmed'}]);
    first[w]=1; st.wi=((st.wi||0)+1)%W.length;
    for(const g of sigs||[]){ const ts=(g.blockTime||0)*1000;
      if(st.seen[g.signature]||q.some(x=>x.s===g.signature)) continue;
      if(g.err||!ts||now-ts>DAY){ st.seen[g.signature]=now; continue; }
      q.push({s:g.signature, w, ts, n:0}); } }
  while(q.length){ const x=q[0];
    if(st.seen[x.s]){ q.shift(); continue; }
    const tx=await ask(rpcs,'getTransaction',[x.s,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
    if(!tx){ q.shift(); if(++x.n<5) q.push(x); else st.seen[x.s]=now; break; }
    const r=solSwapOf(tx,x.w,T.sol,T.pools.sol); if(r){ r.t=x.ts; r.id=x.s; out.push(r); }
    st.seen[x.s]=now; q.shift(); }
}

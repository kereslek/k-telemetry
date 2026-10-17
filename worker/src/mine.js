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
const DAY=86400000, EVERY=20000;
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

/* Look for new swaps of yours on the chains being read, at most every 20 seconds a chain. `st` is
   kept between readings: the last Ethereum block looked at and the transactions already looked at
   (a day). Returns the new swaps, each with its block's time. */
export async function scanMine(st, {ps, wallets, solRpcs, chains, now=Date.now()}){
  const T=tracked(ps), out=[]; st.seen=st.seen||{}; st.at=st.at||{};
  const W={eth:((wallets&&wallets.eth)||[]).map(x=>String(x).toLowerCase()), sol:(wallets&&wallets.sol)||[]};
  if(chains.includes('eth') && T.eth.size && W.eth.length && now-(st.at.eth||0)>=EVERY){ st.at.eth=now;
    const latest=parseInt(await one(EVM_RPCS,'eth_blockNumber',[]),16);
    let from=st.ethBlock!=null?st.ethBlock+1:latest-7200;                 // the first look reaches back a day
    if(st.ethBlock!=null&&latest-from>2000) from=latest-2000;              // after a long sleep, the last few hours
    const pad=a=>'0x'+a.slice(2).padStart(64,'0'), tw=W.eth.map(pad), toks=[...T.eth.keys()], hashes=new Set();
    for(let a=from;a<=latest;a+=1000){ const q={address:toks, fromBlock:'0x'+a.toString(16), toBlock:'0x'+Math.min(latest,a+999).toString(16)};
      for(const topics of [[TRANSFER,tw],[TRANSFER,null,tw]]) for(const l of (await one(EVM_RPCS,'eth_getLogs',[{...q,topics}]))||[]) hashes.add(l.transactionHash); }
    st.ethBlock=latest;
    for(const h of hashes){ if(st.seen[h]) continue;
      const rc=await one(EVM_RPCS,'eth_getTransactionReceipt',[h]);
      if(!rc) continue; st.seen[h]=now; if(rc.status!=='0x1') continue;
      const r=evmSwapOf(rc,null,W.eth,T.eth,T.pools.eth); if(!r) continue;
      const b=await one(EVM_RPCS,'eth_getBlockByNumber',[rc.blockNumber,false]); r.t=b&&b.timestamp?parseInt(b.timestamp,16)*1000:now;
      out.push(r); } }
  if(chains.includes('sol') && T.sol.size && W.sol.length && now-(st.at.sol||0)>=EVERY){ st.at.sol=now;
    for(const w of W.sol){
      const sigs=await one(solRpcs,'getSignaturesForAddress',[w,{limit:st.solOnce?15:40, commitment:'confirmed'}]);
      for(const g of sigs||[]){ if(st.seen[g.signature]) continue; const ts=(g.blockTime||0)*1000;
        if(g.err||!ts||now-ts>DAY){ st.seen[g.signature]=now; continue; }
        const tx=await one(solRpcs,'getTransaction',[g.signature,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
        if(!tx) continue; st.seen[g.signature]=now;
        const r=solSwapOf(tx,w,T.sol,T.pools.sol); if(r){ r.t=ts; out.push(r); } } }
    st.solOnce=true; }
  for(const k of Object.keys(st.seen)) if(now-st.seen[k]>DAY+3600e3) delete st.seen[k];
  return out;
}

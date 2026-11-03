/* Which trades through the deck's own CPOOL pools came with a crossing of CPOOL's bridge, either way,
   on either chain: the ⇄ marks in LATEST FEES.

   A trade is linked to a crossing only when the same wallet did both, in the order that makes a trip:
     - on the chain the CPOOL left from, a swap BEFORE it left (bought here, then bridged out);
     - on the chain it arrived on, a swap AFTER it arrived (came over, then sold or bought here);
   and no more than LINK_WIN apart. A trade merely near a crossing is not linked, and a bot that
   bridges with one wallet and trades with another is missed rather than guessed at.

   Wallets are compared as one-way hashes and never kept: a crossing's wallets are read from its own
   two transactions, a swap's from its own transaction, and only the hashes are carried between runs
   (in the sealed block cache). What the page gets has no wallet at all: when, which pool, which way,
   how long apart, how much crossed and what the trade did, plus the two transaction ids an audit
   needs to check it independently.

   A swap is told from adding or removing liquidity by the wallet's own balances: a swap moves CPOOL
   one way and something else the other; adding or removing moves both the same way.

   io = { eth(method, params), sol(method, params), get(url) }: each may throw or return null.
   Tested on made-up chains by bridge-links.test.mjs. */
import crypto from 'node:crypto';

export const LINK_WIN=2*3600e3;          // how far apart a crossing and its trade may be
export const LINK_SPAN=24*3600e3;        // how far back trades are linked (the box's 24 h)
const KEEP=LINK_SPAN+LINK_WIN+2*3600e3;  // crossings and swaps older than this are dropped from the cache
const SWAP_V3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const T_SENT='0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a', T_RECV='0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c';
const LAMPORTS_NOISE=0.002*1e9;          // rent for a token account and fees: not a side of a swap

export const hashOf=a=>a?crypto.createHash('sha256').update('kt-bridge-link:'+String(a)).digest('hex').slice(0,16):null;
const safe=async f=>{ try{ const v=await f(); return v===undefined?null:v; }catch(e){ return null; } };
const word=(h,i)=>{ const s=String(h||'').replace(/^0x/,'').slice(64*i,64*(i+1)); return s.length===64?BigInt('0x'+s):null; };
const sword=(h,i)=>{ const w=word(h,i); return w==null?null:(w>=(1n<<255n)?w-(1n<<256n):w); };
const topicAddr=t=>t&&String(t).length>=66?'0x'+String(t).slice(-40).toLowerCase():null;
const isEvmHash=s=>/^0x[0-9a-f]{64}$/i.test(s||''), isSolSig=s=>/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s||'');

/* LayerZero Scan's message, the fields used here (its names are not documented in full: found by shape) */
function strings(o,path='',out=[]){ if(o==null) return out;
  if(typeof o==='string') out.push([path.toLowerCase(),o]); else if(typeof o==='object') for(const [k,v] of Object.entries(o)) strings(v,path+'.'+k,out); return out; }
export function msgOf(m){
  const S=strings(m), at=(re,test)=>(S.find(([p,v])=>re.test(p)&&test(v))||[])[1]||null;
  const num=k=>{ const v=k.split('.').reduce((a,b)=>a&&a[b],m); return v==null?null:Number(v); };
  const src=num('pathway.srcEid')??num('srcEid'), dst=num('pathway.dstEid')??num('dstEid');
  const guid=(at(/(^|\.)guid$/,isEvmHash)||'').toLowerCase()||null;
  const st=String((m.status&&(m.status.name||m.status))||'').toUpperCase();
  const txh=side=>{ for(const re of [new RegExp(side+'.*\\.txhash$'), new RegExp(side+'.*\\.tx\\.hash$'), new RegExp(side+'.*(?<!block|payload|message)hash$')]){
      const v=at(re,s=>(isEvmHash(s)&&s.toLowerCase()!==guid)||isSolSig(s)); if(v) return v; } return at(new RegExp(side),isSolSig); };
  return {src, dst, guid, st, created:Date.parse(m.created||m.createdAt||'')||null, srcTx:txh('source'), dstTx:txh('destination')};
}

/* A Solana transaction: each owner's change in each token (and the fee payer's SOL, its fee given
   back), so a swap can be told from a deposit and its wallets hashed. */
export function solDeltas(tx){
  const by=new Map(), add=(o,m,d)=>{ if(!o||!d) return; const x=by.get(o)||{}; x[m]=(x[m]||0)+d; by.set(o,x); };
  const meta=tx&&tx.meta; if(!meta) return by;
  const amt=b=>Number(b&&b.uiTokenAmount&&b.uiTokenAmount.amount||0)/10**Number(b&&b.uiTokenAmount&&b.uiTokenAmount.decimals||0);
  const pre=new Map((meta.preTokenBalances||[]).map(b=>[b.accountIndex,b])), post=new Map((meta.postTokenBalances||[]).map(b=>[b.accountIndex,b]));
  for(const i of new Set([...pre.keys(),...post.keys()])){ const a=pre.get(i), b=post.get(i), o=(b||a).owner, m=(b||a).mint;
    add(o, m, amt(b)-amt(a)); }
  const keys=((tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys)||[]).map(k=>k&&(k.pubkey||k));
  (meta.preBalances||[]).forEach((p,i)=>{ let d=(meta.postBalances[i]||0)-p; if(i===0) d+=meta.fee||0;
    if(Math.abs(d)>LAMPORTS_NOISE) add(keys[i], 'SOL', d/1e9); });
  return by;
}
/* a wallet's swap of CPOOL in these deltas: 'sold' or 'bought', or null (a deposit, a withdrawal, nothing) */
export function swapSide(d, mint){
  const c=d&&d[mint]; if(!c||Math.abs(c)<1e-9) return null;
  const other=Object.entries(d).some(([m,v])=>m!==mint&&Math.sign(v)===-Math.sign(c)&&Math.abs(v)>1e-9);
  return other?(c<0?'sold':'bought'):null;
}

/* one crossing, from its two transactions: when it left and arrived on each chain, how much, and the
   hashes of the wallets on each side: the Ethereum event's own wallet, and on Solana the wallet whose
   CPOOL was minted or burnt; on the side it left from also the transaction's sender (fee payer) */
async function readCrossing(io, R, m){
  const way=m.src===R.eidFrom&&m.dst===R.eidTo?'in':m.src===R.eidTo&&m.dst===R.eidFrom?'out':null;
  if(!way||!m.guid) return null;
  const evmTx=way==='in'?m.srcTx:m.dstTx, solTx=way==='in'?m.dstTx:m.srcTx;
  if(!isEvmHash(evmTx)||!isSolSig(solTx)) return null;
  const rc=await safe(()=>io.eth('eth_getTransactionReceipt',[evmTx]));
  const lg=((rc&&rc.logs)||[]).find(l=>String(l.address).toLowerCase()===R.adapter&&l.topics&&String(l.topics[1]).toLowerCase()===m.guid
    &&String(l.topics[0]).toLowerCase()===(way==='in'?T_SENT:T_RECV));
  if(!lg) return null;
  const amtW=word(lg.data,way==='in'?2:1), amt=amtW!=null?Number(amtW/10n**12n)/1e6:null;
  const blk=rc.blockNumber?await safe(()=>io.eth('eth_getBlockByNumber',[rc.blockNumber,false])):null;
  const tx=await safe(()=>io.sol('getTransaction',[solTx,{encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized'}]));
  if(!blk||!tx||!tx.blockTime) return null;
  const d=solDeltas(tx), keys=((tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys)||[]).map(k=>k&&(k.pubkey||k));
  const moved=[...d.entries()].filter(([,x])=>x[R.mint]&&(way==='in'?x[R.mint]>0:x[R.mint]<0)).map(([o])=>o);
  return {way, amt, tEth:parseInt(blk.timestamp,16)*1000, tSol:tx.blockTime*1000,
          // the sending side's transaction is the wallet's own; the arriving side's is paid by LayerZero's executor, never a party
          pe:[...new Set([topicAddr(lg.topics[2]), way==='in'?String(rc.from||'').toLowerCase():null].filter(Boolean))].map(hashOf),
          ps:[...new Set([...moved, way==='out'?keys[0]:null].filter(Boolean))].map(hashOf)};
}

/* the windows a crossing opens on each chain: [from, to] in ms */
export function windowsOf(c){
  return { sol: c.way==='in'?[c.tSol, c.tSol+LINK_WIN]:[c.tSol-LINK_WIN, c.tSol],
           eth: c.way==='in'?[c.tEth-LINK_WIN, c.tEth]:[c.tEth, c.tEth+LINK_WIN] };
}

/* Pure: crossings {guid: c} and swaps {id: s} (s.chain, s.pool, s.t, s.w: [[hash, side]]) to links.
   Each swap goes with the nearest crossing it fits; a swap no crossing fits is not a link. */
export function linkUp(cx, sw, now, own=new Set()){
  const out=[];
  for(const [id,s] of Object.entries(sw||{})){
    if(!s||!(s.t>=now-LINK_SPAN)) continue;
    let best=null;
    for(const [guid,c] of Object.entries(cx||{})){ if(!c) continue;
      const [a,b]=windowsOf(c)[s.chain], hs=new Set(s.chain==='sol'?c.ps:c.pe);
      if(!(s.t>=a&&s.t<=b)) continue;
      const hit=(s.w||[]).find(([h])=>hs.has(h)); if(!hit) continue;
      const ct=s.chain==='sol'?c.tSol:c.tEth, gap=Math.abs(s.t-ct);
      if(!best||gap<best.gap) best={gap, guid, c, ct, side:hit[1], h:hit[0]}; }
    if(best) out.push({t:s.t, chain:s.chain, pool:s.pool, way:best.c.way, lag:Math.round((s.t-best.ct)/60000), amt:best.c.amt, side:best.side, own:own.has(best.h), tx:id.split('#')[0], guid:best.guid});
  }
  return out.sort((x,y)=>y.t-x.t);
}

/* R: the bridge route (bridge.mjs ROUTES[0]); pools: [{chain:'sol'|'eth', id, mints:[a,b]}] the deck's pools
   that hold CPOOL; prev: the last run's state. Returns {t, links, cx, sw, n:{...}}: links for the page,
   cx/sw (hashes only) for the next run. A run that cannot finish keeps what it had and adds to it. */
/* own: the deck's wallets, hashed here like the rest, so a link can say the trade was yours (never which wallet) */
export async function readLinks({io, R, pools, prev, now=Date.now(), budgetMs=40000, maxTx=60, own=[]}){
  const t0=Date.now(), over=()=>Date.now()-t0>budgetMs;
  const cx=Object.fromEntries(Object.entries((prev&&prev.cx)||{}).filter(([,c])=>c&&Math.max(c.tSol,c.tEth)>=now-KEEP));
  const sw=Object.fromEntries(Object.entries((prev&&prev.sw)||{}).filter(([,s])=>s&&s.t>=now-KEEP));
  const n={msgs:null, crossings:0, read:0, unread:0, sigs:0, txRead:0, swaps:0, capped:false};
  /* the crossings of the last day and two hours (a trade 24 h old may follow one two hours before it) */
  const base='https://scan.layerzero-api.com/v1/messages/oapp/'+R.eidFrom+'/'+R.adapter+'?limit=100';
  let items=[], more=null, ok=false;
  for(let pg=0;pg<3;pg++){ const lz=await safe(()=>io.get(base+(more?'&nextToken='+encodeURIComponent(more):'')));
    const got=lz&&(Array.isArray(lz.data)?lz.data:Array.isArray(lz.messages)?lz.messages:null); if(!got) break; ok=true;
    items=items.concat(got); more=lz.nextToken||(lz.pagination&&lz.pagination.nextToken)||null;
    if(!more||got.length<100||Math.min(...got.map(x=>Date.parse(x.created||'')||now))<now-KEEP) break; }
  n.msgs=ok?items.length:null;
  const M=items.map(msgOf).filter(m=>/DELIVERED/.test(m.st)&&m.created&&m.created>=now-KEEP);
  n.crossings=M.length;
  for(const m of M){ if(over()) break; if(cx[m.guid]) continue;
    const c=await readCrossing(io,R,m); if(c){ cx[m.guid]=c; n.read++; } else n.unread++; }
  /* the swaps through the deck's pools inside the crossings' windows */
  const C=Object.values(cx);
  let txLeft=maxTx;
  for(const P of pools||[]){
    const W=C.map(c=>windowsOf(c)[P.chain]).filter(([a,b])=>b>=now-LINK_SPAN&&a<=now);
    if(!W.length||over()) continue;
    const lo=Math.max(now-LINK_SPAN, Math.min(...W.map(w=>w[0]))), inW=t=>W.some(([a,b])=>t>=a&&t<=b);
    if(P.chain==='sol'){
      let before=null;
      for(let pg=0;pg<4&&!over();pg++){
        const L=await safe(()=>io.sol('getSignaturesForAddress',[P.id,{limit:200,...(before?{before}:{})}])); if(!L||!L.length) break;
        n.sigs+=L.length;
        for(const x of L){ const t=(x.blockTime||0)*1000; if(x.err||!t||!inW(t)) continue;
          const id=x.signature+'#'+P.id; if(sw[id]) continue;
          if(txLeft<=0||over()){ n.capped=true; break; }
          txLeft--; const tx=await safe(()=>io.sol('getTransaction',[x.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized'}]));
          if(!tx) continue; n.txRead++;
          const w=[...solDeltas(tx).entries()].map(([o,d])=>[hashOf(o), swapSide(d,R.mint)]).filter(([,s])=>s);
          sw[id]={chain:'sol', pool:P.id, t, w}; if(w.length) n.swaps++; }
        const oldest=(L[L.length-1].blockTime||0)*1000; if(n.capped||L.length<200||oldest<lo) break; before=L[L.length-1].signature; }
    } else {
      const tip=await safe(()=>io.eth('eth_blockNumber',[])); if(!tip) continue;
      const tipN=parseInt(tip,16), fromB=Math.max(0, tipN-Math.ceil((now-lo)/12000)-50);
      const logs=await safe(()=>io.eth('eth_getLogs',[{address:P.id, topics:[SWAP_V3], fromBlock:'0x'+fromB.toString(16), toBlock:'0x'+tipN.toString(16)}]));
      const cpoolIs0=String(P.mints&&P.mints[0]||'').toLowerCase()===String(R.tokenEth).toLowerCase();
      const bt=new Map();
      for(const l of logs||[]){ if(over()) break; const id=l.transactionHash+'#'+P.id+'#'+parseInt(l.logIndex,16); if(sw[id]) continue;
        let t=bt.get(l.blockNumber); if(t==null){ const b=await safe(()=>io.eth('eth_getBlockByNumber',[l.blockNumber,false])); t=b?parseInt(b.timestamp,16)*1000:null; bt.set(l.blockNumber,t); }
        if(!t||!inW(t)) continue;
        const into=sword(l.data,cpoolIs0?0:1); if(into==null||into===0n) continue;   // into the pool: the trader sold CPOOL
        const side=into>0n?'sold':'bought';
        if(txLeft<=0){ n.capped=true; break; } txLeft--;
        const tx=await safe(()=>io.eth('eth_getTransactionByHash',[l.transactionHash])); n.txRead++;
        const who=[topicAddr(l.topics[1]), topicAddr(l.topics[2]), tx&&String(tx.from||'').toLowerCase()].filter(Boolean);
        sw[id]={chain:'eth', pool:P.id, t, w:[...new Set(who)].map(a=>[hashOf(a), side])}; n.swaps++; }
    }
  }
  const links=linkUp(cx, sw, now, new Set(own.map(a=>hashOf(/^0x/i.test(a)?a.toLowerCase():a))));
  return {t:now, links, cx, sw, n};
}

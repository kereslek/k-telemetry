/* Today's activity, checked: every swap the deck's wallets made since midnight Budapest that went through
   one of the deck's own pools — whose fee came back to the deck and is not income — and whether the
   relay booked it as an own-swap fee; and that the month's fees never stepped down (a harvest moves
   fees from unclaimed to collected, it does not lose them). The deck is locked and this log is
   public: only counts and yes/no are printed, never a wallet, a transaction, a pool or an amount. */
import crypto from 'node:crypto';
import { positionsFrom } from '../worker/src/sampler.js';
import { tracked, solSwapOf } from '../worker/src/mine.js';
import { ownSwapLines } from './own-swap-check.mjs';
const SITE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/', PASS=String(process.env.DECK_PASSPHRASE||'').trim();
/* from START, or else from midnight Budapest today */
const budMidnight=()=>{ const now=Date.now(), d=new Date(now).toLocaleString('sv-SE',{timeZone:'Europe/Budapest'}).slice(0,10);
  for(const off of [1,2]){ const t=Date.parse(d+'T00:00:00+0'+off+':00'); if(new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Budapest'}).slice(11,16)==='00:00') return t; } return now-24*3600e3; };
const START=Date.parse(process.env.START||'')||budMidnight();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt){ for(let k=0;k<4;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(30000)}); if(r.ok) return await r.json(); }catch(e){} await sleep(1200*(k+1)); } return null; }
const L=await j(SITE+'lock.json?t='+Date.now());
// the deck key and, from the same derivation, the minute recorder's access token (never printed)
const BITS=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256'), KEY=BITS.subarray(0,32), TOKEN=BITS.subarray(32).toString('hex');
const PULSE='https://kt-pulse.kereslek.workers.dev';
const open=e=>{ if(!(e&&e.lock===1)) return e; const all=Buffer.from(e.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(e.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); };
const t=Date.now();
const [cfg,data,fees,costs,ledger,replay]=(await Promise.all(['config.json','data-main.json','fees-main.json','costs-main.json','ledger-main.json','pools-replay-main.json'].map(f=>j(SITE+f+'?t='+t)))).map(x=>x?open(x):null);
const W=cfg.profiles.flatMap(p=>p.wallets||[]), WE=W.filter(x=>x.chain==='ethereum').map(x=>x.address.toLowerCase()), WS=W.filter(x=>x.chain==='solana').map(x=>x.address);
// holdings-only wallets: the relay watches what they hold and does not sweep them for swaps
const HOLD=new Set(W.filter(x=>x.role==='hold').map(x=>String(x.address).toLowerCase()));
// the owner's exchange deposit addresses (sealed beside the wallets): a send there is the owner's money moving, not leaving
const CX=cfg.profiles.flatMap(p=>p.cex||[]), CXE=new Set(CX.filter(x=>x.chain==='ethereum').map(x=>String(x.address).toLowerCase())), CXS=new Set(CX.filter(x=>x.chain==='solana').map(x=>x.address));
// the relay writes an Ethereum log index in hex (…:0x12f), this audit in decimal (…:303)
const normId=id=>String(id).replace(/:0x([0-9a-f]+)$/i,(_,h)=>':'+parseInt(h,16));
const booked=new Set([...(fees.selfDone||[]), ...((costs.selfPend||[]).map(x=>x.id))].map(normId));
const pendBack=new Map((costs.selfPend||[]).map(x=>[normId(x.id),x.back]));
console.log('since',new Date(START).toISOString(),'· wallets: '+WE.length+' Ethereum, '+WS.length+' Solana · exchange deposit addresses: '+CX.length+' · own-swap ids the relay has booked this month: '+booked.size);
// ---- own pools: open now, plus Ethereum positions closed this month (read back from the position manager)
const ETH_RPC=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth'];
async function ecall(to,data){ for(const u of ETH_RPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']})}); if(r&&r.result) return r.result; } return null; }
const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88', FACT='0x1f98431c8ad98523631ae4a59f267346ea31f984';
/* the EVM chains the relay reads positions on (its CHAINS): a position is checked on its own chain,
   with that chain's position manager; the same token id on another chain is a different position */
const CH={ethereum:{rpcs:ETH_RPC, npm:NPM, bph:300},
  arbitrum:{rpcs:['https://arbitrum-one-rpc.publicnode.com','https://arb1.arbitrum.io/rpc','https://arbitrum.drpc.org'], npm:NPM, bph:14400},
  base:{rpcs:['https://base-rpc.publicnode.com','https://mainnet.base.org','https://base.drpc.org'], npm:'0x03a520b32c04bf3beef7beb72e919cf822ed34f1', bph:1800},
  optimism:{rpcs:['https://optimism-rpc.publicnode.com','https://mainnet.optimism.io','https://optimism.drpc.org'], npm:NPM, bph:1800},
  polygon:{rpcs:['https://polygon-bor-rpc.publicnode.com','https://polygon-rpc.com','https://polygon.drpc.org'], npm:NPM, bph:1700}};
const rpcOn=async(ch,method,params)=>{ for(const u of CH[ch].rpcs){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); if(r&&r.result!==undefined) return r.result; } return null; };
const EV={collect:'0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01', increase:'0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f', decrease:'0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4'};
const idTopic=id=>'0x'+BigInt(id).toString(16).padStart(64,'0');
// a position's harvests, top-ups and withdrawals since START, from its chain's position manager; null when a stretch could not be read
async function npmEvents(ch,id){
  const C=CH[ch]; if(!C) return null; const tip=parseInt(await rpcOn(ch,'eth_blockNumber',[]),16); if(!(tip>0)) return null;
  const from=Math.max(0,tip-Math.ceil((Date.now()-START)/3600e3*C.bph)-50), step=ch==='ethereum'?9000:10000, out={collect:[],increase:[],decrease:[]};
  for(let a=from;a<=tip;a+=step){
    const r=await rpcOn(ch,'eth_getLogs',[{address:C.npm,fromBlock:'0x'+a.toString(16),toBlock:'0x'+Math.min(tip,a+step-1).toString(16),topics:[[EV.collect,EV.increase,EV.decrease],idTopic(id)]}]);
    if(!Array.isArray(r)) return null;
    for(const l of r){ const k=Object.keys(EV).find(k=>EV[k]===l.topics[0]); if(k) out[k].push(l); } }
  return out;
}
/* A request from the owner, sealed to the deck's inbox: the positions they say they touched. Only the
   passphrase opens it (the same key pair as lock.mjs's inbox), and the positions are never printed. */
const X_PKCS8=Buffer.from('302e020100300506032b656e04220420','hex'), X_SPKI=Buffer.from('302a300506032b656e032100','hex');
function inboxOpen(env){
  const seed=Buffer.from(crypto.hkdfSync('sha256', KEY, Buffer.alloc(0), Buffer.from('kt-inbox-x25519'), 32));
  const priv=crypto.createPrivateKey({key:Buffer.concat([X_PKCS8, seed]), format:'der', type:'pkcs8'});
  const epk=Buffer.from(env.epk,'base64'), pub=crypto.createPublicKey({key:Buffer.concat([X_SPKI, epk]), format:'der', type:'spki'});
  const k=Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({privateKey:priv, publicKey:pub}), epk, Buffer.from('kt-inbox'), 32));
  const all=Buffer.from(env.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
  return Buffer.concat([d.update(all.subarray(0,all.length-16)), d.final()]).toString('utf8');
}
const ownEth=new Map((data.eth||[]).map(p=>[String(p.pool).toLowerCase(),'#'+p.id+' '+(p.pairLabel||'')]));
for(const id of Object.keys(fees.closedPos||{}).filter(x=>/^\d+$/.test(x))){
  const r=await ecall(NPM,'0x99fbab88'+BigInt(id).toString(16).padStart(64,'0')); if(!r) continue;
  const w=i=>r.slice(2+64*i,2+64*(i+1)), t0='0x'+w(2).slice(24), t1='0x'+w(3).slice(24), fee=parseInt(w(4),16);
  const pr=await ecall(FACT,'0x1698ee82'+w(2)+w(3)+fee.toString(16).padStart(64,'0'));
  if(pr) ownEth.set(('0x'+pr.slice(26)).toLowerCase(),'#'+id+' (closed this month)'); }
const ownSol=new Map((data.sol||[]).map(p=>[p.poolId,p.id.slice(0,12)+' '+(p.pairLabel||'')+' '+(p.feeLabel||'')]));
console.log('own pools: '+ownEth.size+' Ethereum, '+(data.sol||[]).length+' Solana positions');

const found=[], elsewhere=[], solTx=new Map(), other={eth:0,sol:0}, kinds={v3:0,v4:0,v2:0,transfer:0,other:0}, coin={out:0,own:0,cex:0,in:0}; let ethSent=0, ethIn=0, extOut=0, intMove=0, cexOut=0, lastTx=0;
const SWAP_V4='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', SWAP_V2='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', XFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; let solSeen=0, solMine=0;
// ---- Ethereum
const lcx={n:0, tx:new Set(), last:0};   // LCX arriving in the deck's wallets today (counts and venues only)
const BS='https://eth.blockscout.com/api/v2', SWAP_V3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
for(const w of WE){
  let url=BS+'/addresses/'+w+'/transactions', n=0;
  while(url && n<10){ n++;
    const r=await j(url); if(!r) break; let older=false;
    for(const tx of r.items||[]){
      if(Date.parse(tx.timestamp)<START){ older=true; continue; }
      const from=String(tx.from&&tx.from.hash).toLowerCase(), to=String(tx.to&&tx.to.hash).toLowerCase(), val=tx.value&&BigInt(tx.value)>0n;
      // ETH itself, as opposed to tokens: leaving for an outside address, moving between the deck's wallets, or arriving from outside
      if(val&&tx.status==='ok'&&from!==w&&to===w&&!WE.includes(from)) coin.in++;
      if(from!==w || tx.status!=='ok') continue;
      const lg=await j(BS+'/transactions/'+tx.hash+'/logs'); await sleep(150);
      ethSent++; const tops=new Set(((lg&&lg.items)||[]).map(x=>x.topics&&x.topics[0]));
      if(tops.has(SWAP_V3)) kinds.v3++; else if(tops.has(SWAP_V4)) kinds.v4++; else if(tops.has(SWAP_V2)) kinds.v2++; else if(tops.has(XFER)) kinds.transfer++; else kinds.other++;
      // ETH itself sent, not paid into a swap: a card top-up, an exchange deposit, a move between the deck's wallets
      if(val&&!tops.has(SWAP_V3)&&!tops.has(SWAP_V4)&&!tops.has(SWAP_V2)) (WE.includes(to)?coin.own++:CXE.has(to)?coin.cex++:coin.out++);
      lastTx=Math.max(lastTx, Date.parse(tx.timestamp)||0);
      // tokens sent to an address that is not one of the deck's: leaving the tracked wallets
      if(!tops.has(SWAP_V3)&&!tops.has(SWAP_V4)&&!tops.has(SWAP_V2))
        for(const x of ((lg&&lg.items)||[]).filter(x=>x.topics&&x.topics[0]===XFER&&x.topics[2]&&!x.topics[3])){
          const from='0x'+String(x.topics[1]).slice(26).toLowerCase(), to='0x'+String(x.topics[2]).slice(26).toLowerCase();
          if(from===w && CXE.has(to)) cexOut++; else if(from===w && !WE.includes(to)) extOut++; else if(from===w) intMove++; }
      const sw=((lg&&lg.items)||[]).filter(x=>x.topics&&x.topics[0]===SWAP_V3);
      for(const s of sw){ const pool=String(s.address.hash).toLowerCase();
        if(!ownEth.has(pool)) { other.eth++; elsewhere.push({chain:'eth', t:Date.parse(tx.timestamp), k:tx.hash}); continue; }
        const id='eth:'+tx.hash+':'+s.index; found.push({chain:'eth',t:tx.timestamp,id,addr:pool,pool:ownEth.get(pool),booked:booked.has(id),back:pendBack.get(id),data:s.data,tx:tx.hash,hold:HOLD.has(w)});
      } }
    url=(!older&&r.next_page_params)?BS+'/addresses/'+w+'/transactions?'+new URLSearchParams(r.next_page_params):null;
  }
  /* A swap filled by someone else for this wallet (UniswapX, CoW, 1inch Fusion) is sent by the filler,
     so it never shows as the wallet's own transaction — only as tokens arriving. Every such arrival
     this month is checked for a Swap at an own pool in the same transaction. */
  let tu=BS+'/addresses/'+w+'/token-transfers', m=0; const seenTx=new Set();
  while(tu && m<10){ m++;
    const r=await j(tu); if(!r) break; let older=false;
    for(const x of r.items||[]){
      if(Date.parse(x.timestamp)<START){ older=true; continue; }
      if(x.token&&String(x.token.symbol).toUpperCase()==='LCX'&&String(x.to&&x.to.hash).toLowerCase()===w){ lcx.n++; lcx.tx.add(x.transaction_hash); lcx.last=Math.max(lcx.last,Date.parse(x.timestamp)||0); }
      const h=x.transaction_hash; if(seenTx.has(h)) continue; seenTx.add(h); ethIn++;
      const tx=await j(BS+'/transactions/'+h); if(!tx||String(tx.from&&tx.from.hash).toLowerCase()===w) continue;
      const lg=await j(BS+'/transactions/'+h+'/logs'); await sleep(150);
      for(const s of ((lg&&lg.items)||[]).filter(y=>y.topics&&y.topics[0]===SWAP_V3)){ const pool=String(s.address.hash).toLowerCase();
        if(!ownEth.has(pool)) continue;
        const id='eth:'+h+':'+s.index;
        found.push({chain:'eth',t:x.timestamp,id,addr:pool,pool:ownEth.get(pool),booked:booked.has(id),back:pendBack.get(id),filled:1,data:s.data,tx:h}); }
    }
    tu=(!older&&r.next_page_params)?BS+'/addresses/'+w+'/token-transfers?'+new URLSearchParams(r.next_page_params):null;
  }
}
// ---- Solana
// history-serving endpoints first: publicnode answers with only the last few hours of signatures
const SR=[process.env.SOL_RPC_URL,'https://api.mainnet-beta.solana.com','https://rpc.solanatracker.io/public','https://solana.leorpc.com/?api_key=FREE','https://solana-rpc.publicnode.com'].filter(Boolean);
async function srpc(method,params){ for(let k=0;k<3;k++) for(const u of SR){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); if(r&&r.result!==undefined) return r.result; await sleep(600);} return null; }
const solPos=new Map(), solMove={own:0,cex:0,out:0,other:0};
for(const w of WS){
  let before=null, done=false, seen=0, mine=0;
  while(!done){
    const sigs=await srpc('getSignaturesForAddress',[w,{limit:100,commitment:'confirmed',...(before?{before}:{})}]); if(!sigs||!sigs.length) break;
    for(const s of sigs){ before=s.signature; if(!s.blockTime) continue; if(s.blockTime*1000<START){ done=true; break; } if(s.err) continue; seen++;
      const tx=await srpc('getTransaction',[s.signature,{encoding:'json',maxSupportedTransactionVersion:1}]); await sleep(120); if(!tx) continue;
      const keys=[...tx.transaction.message.accountKeys,...((tx.meta.loadedAddresses&&tx.meta.loadedAddresses.writable)||[]),...((tx.meta.loadedAddresses&&tx.meta.loadedAddresses.readonly)||[])];
      if(keys[0]!==w) continue; mine++;                               // spam is paid for by someone else
      lastTx=Math.max(lastTx, s.blockTime*1000);
      const logs=tx.meta.logMessages||[];
      /* a harvest, a withdrawal or a top-up of one of the deck's own positions (its position account is in the transaction) */
      const ownPos=(data.sol||[]).filter(p=>p.pda&&keys.includes(p.pda));
      if(ownPos.length){
        const kind=logs.some(l=>/Instruction: (CollectFees|CollectReward|CollectFeesV2|CollectRewardV2|ClaimFee|ClaimReward)/i.test(l))?'harvest'
          :logs.some(l=>/Instruction: DecreaseLiquidity/i.test(l))?'decrease':logs.some(l=>/Instruction: IncreaseLiquidity/i.test(l))?'increase':'other';
        for(const p of ownPos){ const e=solPos.get(p.id)||{harvest:0,decrease:0,increase:0,other:0}; e[kind]++; solPos.set(p.id,e); } }
      /* a transfer (whatever else rides along: wallets add their own guard and memo programs):
         where each top-level transfer went is read from the parsed instructions, a token
         account's owner from the token balances */
      if(!ownPos.length&&!logs.some(l=>/Instruction: Swap/i.test(l))){
        const px=await srpc('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:1}]); await sleep(120);
        const owners=new Map(); const ak=px?px.transaction.message.accountKeys.map(k=>k.pubkey||k):[];
        for(const tb of [...((px&&px.meta.preTokenBalances)||[]),...((px&&px.meta.postTokenBalances)||[])]) if(tb.owner) owners.set(ak[tb.accountIndex],tb.owner);
        let own=0, cx=0, out=0;
        for(const ins of (px?px.transaction.message.instructions:[])){ const pi=ins.parsed; if(!pi||!pi.info) continue;
          if(!/^(transfer|transferChecked|transferWithSeed)$/.test(pi.type)) continue;
          const dest=pi.info.destination, to=ins.program==='system'?dest:(owners.get(dest)||null);
          if(to&&WS.includes(to)) own++; else if(to&&CXS.has(to)) cx++; else out++; }
        if(own&&!cx&&!out) solMove.own++; else if(cx&&!out) solMove.cex++; else if(out) solMove.out++; else if(!px) solMove.other++; }
      if(!logs.some(l=>/Instruction: Swap/i.test(l))) continue;
      const pools=[...ownSol.keys()].filter(p=>keys.includes(p));
      if(!pools.length){ other.sol++; elsewhere.push({chain:'sol', t:s.blockTime*1000, k:s.signature}); continue; }
      solTx.set(s.signature, {tx, w});
      for(const p of pools){ const id='sol:'+s.signature+':'+p; found.push({chain:'sol',t:new Date(s.blockTime*1000).toISOString(),id,addr:p,pool:ownSol.get(p),booked:booked.has(id),back:pendBack.get(id),who:w}); }
    }
    if(sigs.length<100) break;
  }
  solSeen+=seen; solMine+=mine;
}
console.log('ethereum transactions sent by the deck\u2019s wallets: '+ethSent+' (Uniswap v3 swap '+kinds.v3+', v4 swap '+kinds.v4+', v2-style swap '+kinds.v2+', token transfer only '+kinds.transfer+', other '+kinds.other+') · token arrivals: '+ethIn);
console.log('solana transactions today: '+solSeen+' ('+solMine+' paid by the deck’s wallets)');
console.log('swaps today through someone else’s pool (not own-pool, correctly not touched): eth '+other.eth+', sol '+other.sol);
for(const c of ['eth','sol']){ const f=found.filter(x=>x.chain===c);
  console.log((f.every(x=>x.booked)?'ok   ':'MISS ')+c+' swaps through an own pool today: '+f.length+' · booked as own-swap fees: '+f.filter(x=>x.booked).length+(f.some(x=>x.filled)?' · filled by a third party: '+f.filter(x=>x.filled).length:''));
  /* why one is not booked (yes/no and minutes only): too recent for the relay, not yet seen by it,
     or seen with nothing coming back because none of the deck's liquidity in that pool was in range */
  /* An Ethereum one: the relay books what came back to the deck, which is nothing when none of its
     liquidity in that pool was in range at the tick the swap left behind (read from the swap's own
     event, as the relay reads it). Yes/no and minutes only: never the share. */
  if(c==='eth') for(const x of f.filter(x=>!x.booked)){
    const age=(Date.now()-Date.parse(x.t))/60000, seen=(costs.txs||{})[x.tx]||(costs.txs||{})[String(x.tx).toLowerCase()];
    let inR=null; try{ const d=String(x.data||'').replace(/^0x/,''), wd=i=>BigInt('0x'+d.slice(64*i,64*(i+1)));
      let tk=wd(4); if(tk>=(1n<<255n)) tk-=(1n<<256n); const tick=Number(tk);
      const mine=(data.eth||[]).filter(q=>String(q.pool).toLowerCase()===String(x.addr).toLowerCase());
      inR=mine.some(q=>{ const sc=10**((q.d0||18)-(q.d1||18)), lo=Math.round(Math.log(q.priceLower/sc)/Math.log(1.0001)), hi=Math.round(Math.log(q.priceUpper/sc)/Math.log(1.0001)); return lo<=tick&&tick<hi&&BigInt(q.liq||0)>0n; }); }catch(e){}
    console.log('     not booked: made '+age.toFixed(0)+' min ago · relay data '+((Date.now()-(data.t||0))/60000).toFixed(0)+' min old, '+((data.t||0)>Date.parse(x.t)?'newer':'older')+' than the swap'
      +' · the relay has '+(seen===1?'counted this transaction':seen===2?'filed it as a plain transfer':'not seen it')+' · deck liquidity in range at the price the swap left: '+(inR==null?'not readable':inR?'yes':'NO, so nothing came back to book')
      +' · sent from a holdings-only wallet (one the relay does not sweep for swaps): '+(x.hold?'YES':'no')); }
  if(c==='sol') for(const x of f.filter(x=>!x.booked)){
    const sig=x.id.split(':')[1], pool=x.id.split(':')[2], age=(Date.now()-Date.parse(x.t))/60000;
    const seen=!!((costs.solTxs||{})[sig]||(costs.prevSolTxs||{})[sig]), pend=!!((costs.solWalletTx||{})[sig]);
    const mine=(data.sol||[]).filter(p=>p.poolId===pool), inr=mine.filter(p=>p.inRange!==false&&p.inRange!==0).length;
    console.log('     not booked: made '+age.toFixed(0)+' min ago · relay data '+((Date.now()-(data.t||0))/60000).toFixed(0)+' min old, '+((data.t||0)>Date.parse(x.t)?'newer':'older')+' than the swap'
      +' · the relay has '+(seen?'counted this transaction':pend?'queued it, not yet counted':'not seen it')+' · deck positions in that pool: '+mine.length+', in range now: '+inr); }
}
/* The swap replay leaves the deck's own trading out of "your share of the pools' trading", so the share
   counts other traders only: each own-pool swap above, once the replay has read past it, must show as
   own trading in that pool's day (UTC). Pools the replay does not rebuild (only LCX and CPOOL pools
   are) are counted apart. */
{ const R=new Map(((replay&&replay.pools)||[]).map(p=>[String(p.id).toLowerCase(),p])), c={read:0,own:0,waiting:0,notIn:0};
  for(const x of found){ const P=R.get(String(x.addr||'').toLowerCase()), at=Date.parse(x.t);
    if(!P||!P.state){ c.notIn++; continue; }
    if(!(P.state.t>=at)){ c.waiting++; continue; }
    c.read++; const dd=P.days&&P.days[new Date(at).toISOString().slice(0,10)];
    if(dd&&((dd.ownW||0)>0||(dd.own||0)>0)) c.own++; }
  console.log((c.read===c.own?'ok   ':'MISS ')+'own-pool swaps in the swap replay (your share leaves them out): read past '+c.read+', set aside as your own '+c.own
    +' · not read yet '+c.waiting+' · in pools it does not rebuild '+c.notIn+' · replay '+(replay&&replay.t?((Date.now()-replay.t)/3600e3).toFixed(1)+' h old':'not readable')); }
/* A position's running fee total goes down for one reason only: the fee one of the deck's own swaps
   paid into it, taken back out once the relay has applied it (it was the wallet's own money going
   round, not income). So the falls in a pool are checked against the own-swap fees applied there in
   this window: equal (to a few cents) is the bookkeeping working; more is fees lost. */
const doneSet=new Set((fees.selfDone||[]).map(normId)), takenBy=new Map();
for(const x of found){ if(!doneSet.has(normId(x.id))) continue; const b=pendBack.get(normId(x.id)); if(!(b>0)) continue;
  const k=String(x.addr||'').toLowerCase(); takenBy.set(k,(takenBy.get(k)||0)+b); }
const takenAll=[...takenBy.values()].reduce((a,b)=>a+b,0);
const fellBy=series=>{ let s=0; for(let i=1;i<series.length;i++) if(series[i]<series[i-1]) s+=series[i-1]-series[i]; return s; };
const poolFalls=new Map();   // pool → [sum of falls, positions that fell]
/* A total that fell: back to where it stood before the fall, and how many readings that took (a
   harvest read on the chain one pass before the relay's scan books what it collected dips for a
   pass and comes back; one that never comes back lost fees) */
function recovery(series){
  let worst=null; for(let i=1;i<series.length;i++){ if(!(series[i]<series[i-1]-0.01)) continue; const was=series[i-1];
    let k=i; while(k<series.length&&series[k]<was-0.01) k++;
    const r={n:k-i, back:k<series.length, now:series[series.length-1]/Math.max(1e-9,was)}; if(!worst||!r.back||r.n>worst.n) worst=r; if(!r.back) break; }
  return !worst?'':worst.back?' and came back after '+worst.n+' reading(s)':' and has NOT come back (now '+(worst.now*100).toFixed(1)+'% of where it stood)'; }
// the month's fees only ever rise: a harvest moves them from unclaimed to collected
const ticks=(fees.ticks||[]).filter(x=>x[0]>=START);
let drops=0, worst=0; for(let i=1;i<ticks.length;i++){ const d=ticks[i][1]-ticks[i-1][1]; if(d< -0.01){ drops++; worst=Math.min(worst,d/Math.max(1,ticks[i-1][1])); } }
{ const fellT=fellBy(ticks.map(x=>x[1])), own=drops&&fellT<=takenAll+0.02;
  console.log((drops&&!own?'WARN ':'ok   ')+'month-to-date fee readings today: '+ticks.length+' · steps down: '+drops+(drops?' (largest '+(worst*100).toFixed(2)+'% of the total'+recovery(ticks.map(x=>x[1]))+')'
    +(own?' · no more than the own-swap fees taken out of income, as it should':' · MORE than the own-swap fees taken out'):'')); }
console.log('token transfers out of the deck\u2019s Ethereum wallets: '+extOut+' to outside addresses, '+intMove+' between its own wallets, '+cexOut+' to your exchange deposit addresses');
console.log('ETH itself sent from the deck\u2019s wallets: '+coin.out+' to outside addresses, '+coin.own+' between its own wallets, '+coin.cex+' to your exchange deposit addresses · arrived from outside: '+coin.in);
console.log('solana transfers sent by the deck\u2019s wallets: '+solMove.own+' to its own wallets, '+solMove.cex+' to your exchange deposit addresses, '+solMove.out+' to outside addresses'+(solMove.other?', '+solMove.other+' unclear':''));
/* Solana positions the deck's wallets touched today: a harvest (or a withdrawal, which collects the
   fees with it) moves fees from unclaimed to collected, so the position's booked fee total must
   never fall, and the relay's harvest scan must have read past it without an error. */
{ const hist=(fees.posHist||[]).filter(x=>x[0]>=START-3600e3);
  for(const [id,e] of solPos){ const L=(ledger||{})[id]||{}, p=(data.sol||[]).find(q=>q.id===id)||{};
    const series=hist.map(x=>x[1][id]).filter(v=>v!=null); let fell=0; for(let i=1;i<series.length;i++) if(series[i]<series[i-1]-0.01) fell++;
    const back=fell?recovery(series):'', ownOnly=fell&&takenBy.has(String(p.poolId||'').toLowerCase());
    const after=series.length>1&&hist.length&&hist[hist.length-1][0]>lastTx;
    console.log(((fell&&!ownOnly)||L.txErr?'WARN ':'ok   ')+'a Solana position: harvests '+e.harvest+', collected through DecreaseLiquidity (Raydium\u2019s harvest, or a withdrawal) '+e.decrease+', added '+e.increase+(e.other?', other '+e.other:'')
      +' · booked fee total fell: '+(fell?fell+' time(s)'+back+(ownOnly?' (an own swap went through its pool: checked below)':''):'never')+' ('+series.length+' readings) · harvest scan '+(L.txErr?'reported an error':'clean')+(L.harvestGap?' · a harvest only partly read, filled from the owed balance':'')
      +' · fees owed now '+((p.feesUsd||0)>0?'above zero':'zero')+' · read after today\u2019s last transaction: '+(after?'yes':'not yet')); }
  if(!solPos.size) console.log('Solana positions touched today: 0'); }
{ const it=data.idle&&data.idle.t; console.log((lastTx&&it&&it<lastTx?'WARN ':'ok   ')+'wallet balances read after the latest of these transactions: '+(lastTx?(it&&it>=lastTx?'yes':'no'):'n/a')); }
/* every Solana wallet in the config read by the relay: its holdings carry the wallet they came from,
   so a wallet with nothing in the relay's file was never read or holds nothing at all (counts only) */
{ const rows=(data.idle&&data.idle.rows)||[], has=new Set(rows.map(r=>String(r.wallet||'')));
  const nS=WS.filter(w=>has.has(w)).length;
  console.log((nS===WS.length?'ok   ':'note ')+'Solana wallets with holdings in the relay\u2019s file: '+nS+' of '+WS.length+(data.idle&&data.idle.stale?' (a held-back read: some wallets did not answer)':'')); }
/* Ethereum positions: harvests, tokens added and withdrawn since START (from the position manager's
   own events), and whether each position's booked fee total ever fell — a harvest moves fees from
   unclaimed to collected, a top-up adds principal; neither may take fees away. */
{ const hist=(fees.posHist||[]).filter(x=>x[0]>=START-3600e3);
  let quiet=0;
  for(const p of data.eth||[]){ const id=String(p.id); if(!/^\d+$/.test(id)) continue;
    const ev=await npmEvents(CH[p.chain]?p.chain:'ethereum', id);
    if(!ev){ console.log('note an Ethereum position: its position-manager events today could not be read'); continue; }
    const n={collect:ev.collect.length, increase:ev.increase.length, decrease:ev.decrease.length};
    const series=hist.map(x=>x[1][id]).filter(v=>v!=null); let fell=0; for(let i=1;i<series.length;i++) if(series[i]<series[i-1]-0.01) fell++;
    const ownOnly=fell&&takenBy.has(String(p.pool||'').toLowerCase());
    if(!(n.collect||n.increase||n.decrease)){ quiet++; continue; }
    console.log((fell&&!ownOnly?'WARN ':'ok   ')+'an Ethereum position: harvests '+n.collect+', tokens added '+n.increase+', tokens withdrawn '+n.decrease+' · its booked fee total fell: '+(fell?fell+' time(s)'+recovery(series)+(ownOnly?' (an own swap went through its pool: checked below)':''):'never')+' ('+series.length+' readings)'); }
  console.log('Ethereum positions with no harvest, top-up or withdrawal: '+quiet); }
/* each pool whose positions' fee totals fell, every position in it counted (an own-swap fee is taken
   out of whichever of them had liquidity in range, touched today or not): the falls against the
   own-swap fees applied there */
{ const hist=(fees.posHist||[]).filter(x=>x[0]>=START-3600e3);
  for(const [id,pool] of [...(data.sol||[]).map(q=>[q.id,q.poolId]), ...(data.eth||[]).map(q=>[String(q.id),q.pool])]){
    const f=fellBy(hist.map(x=>x[1][id]).filter(v=>v!=null)); if(!(f>0.005)) continue;
    const k=String(pool||'').toLowerCase(), e2=poolFalls.get(k)||[0,0]; e2[0]+=f; e2[1]++; poolFalls.set(k,e2); } }
// a pool with own swaps is checked with the recorder below; a fall anywhere else is fees lost
for(const [pool,[fallSum,nPos]] of poolFalls){ if((takenBy.get(pool)||0)>0) continue;
  console.log('WARN a pool where '+nPos+' position(s)\u2019 fee totals fell with no own swap there: fees lost'); }
/* Own swaps through the deck's own pools, checked with the minute recorder (own-swap-check.mjs): over
   readings from before each swap to the one that took its fee back out, what the recorder measured
   landing in the positions less how much their booked total rose is what was taken out, and it must
   equal what the swaps paid in. The dips alone cannot say that on a busy day: other traders' fees land
   in the same readings and fill them. The recorder's own position list and labels are used, and a
   minute counts as read only when every one of its positions was read in it. */
{ const P=await j(PULSE+'/m?n=1440&k='+TOKEN);
  for(const l of ownSwapLines({posHist:fees.posHist, selfDone:fees.selfDone, selfPend:costs&&costs.selfPend, rec:positionsFrom(data),
    rows:(P&&Array.isArray(P.mins))?P.mins:[], start:START, now:Date.now(), normId})) console.log(l);
  /* Every swap of yours today, found here from your wallets' own transactions, must be on LATEST FEES as
     YOU (the recorder's list), each once: through your own pools with your pool named, elsewhere as a swap
     elsewhere. Matched by chain and time (two minutes either way); one transaction through two of your
     pools is one swap. Counts and minutes only. */
  if(P&&P.pools) console.log('recorder pools priced at its last reading: '+Object.entries(P.pools).map(([c,v])=>c+' '+(v&&v[0])+' of '+(v&&v[1])).join(', ')
    +' · its read errors now: '+(Array.isArray(P.err)&&P.err.length?P.err.map(e=>{ const priv=(()=>{ try{ return new URL(process.env.SOL_RPC_URL||'').host; }catch(x){ return ''; } })();
      return String(e).split(' | ').map(part=>{ const kind=/\b401\b/.test(part)?'refused: not authorised (401)':/\b403\b/.test(part)?'refused: forbidden (403)':/\b429\b|rate.?limit|too many/i.test(part)?'rate limited':/time.?out|abort/i.test(part)?'timed out':'other error';
        return (priv&&part.includes(priv)?'your private Solana node':'a public node')+' '+kind; }).join(', '); }).join(' | '):'none')
    +(P.mineScan&&P.mineScan.sol?' · own-swap scan, Solana: asks '+P.mineScan.sol.asks+', waiting '+P.mineScan.sol.q+', '+(P.mineScan.sol.err||'no failure'):''));
  if(!P||!Array.isArray(P.mine)) console.log('note the recorder’s list of your swaps could not be read');
  else { const seen=new Set(), mine=[];
    for(const x of found){ const k=x.id.split(':')[1]; if(seen.has(k)) continue; seen.add(k); mine.push({chain:x.chain, t:Date.parse(x.t), own:true}); }
    for(const x of elsewhere){ if(seen.has(x.k)) continue; seen.add(x.k); mine.push({chain:x.chain, t:x.t, own:false}); }
    /* each swap with its nearest row: every pair within two minutes, closest first (two swaps of yours in the same
       second must not take each other's rows, as a first-come pairing would) */
    const used=new Set(), took=new Set(), miss=[]; let ownOk=0; mine.sort((a,b)=>a.t-b.t);
    const pairs=[]; mine.forEach((x,i)=>P.mine.forEach((y,j)=>{ if(y.chain===x.chain&&Math.abs(y.t-x.t)<=120000) pairs.push([Math.abs(y.t-x.t)+(x.own===!!y.own?0:0.5),i,j]); }));
    for(const [,i,j] of pairs.sort((a,b)=>a[0]-b[0])){ if(took.has(i)||used.has(j)) continue; took.add(i); used.add(j); if(mine[i].own&&P.mine[j].own) ownOk++; }
    mine.forEach((x,i)=>{ if(!took.has(i)) miss.push(x); });
    const nOwn=mine.filter(x=>x.own).length, ok=!miss.length&&ownOk===nOwn;
    /* for each one missing, the recorder's own rule (worker/src/mine.js) on that transaction: what it saw, yes/no only */
    const why=[]; { const T=tracked(positionsFrom(data));
      for(const x of miss) for(const [sig,v] of solTx){ if(Math.abs((v.tx.blockTime||0)*1000-x.t)>1000) continue;
        const m=v.tx.meta||{}, keys=[...v.tx.transaction.message.accountKeys,...((m.loadedAddresses&&m.loadedAddresses.writable)||[]),...((m.loadedAddresses&&m.loadedAddresses.readonly)||[])].map(String);
        const r=solSwapOf(v.tx, v.w, T.sol, T.pools.sol);
        why.push('the recorder’s rule now '+(r?'takes it as your '+r.side+(r.own?' through your pool':''):'does NOT take it')+' · swap in its logs '+(/Instruction: (Swap\w*|\w*Route\w*)\b/i.test((m.logMessages||[]).join('\n'))?'yes':'no')
          +' · logs cut short '+((m.logMessages||[]).some(l=>/truncated/i.test(l))?'yes':'no')+' · one of your pools in it '+(keys.some(k=>T.pools.sol.has(k))?'yes':'no')
          +' · your token in its balances for the paying wallet '+([...(m.preTokenBalances||[]),...(m.postTokenBalances||[])].some(b=>b.owner===v.w&&T.sol.has(b.mint))?'yes':'no')
          +' · made in the newer format '+(v.tx.version===1?'yes':v.tx.version===0?'v0':'legacy')); } }
    console.log((ok?'ok   ':miss.every(x=>Date.now()-x.t<5*60000)?'note ':'MISS ')+'your swaps today shown as YOU in LATEST FEES: '+(mine.length-miss.length)+' of '+mine.length
      +' · through your own pools, with your pool named: '+ownOk+' of '+nOwn+(miss.length?' · not listed: made '+miss.map(x=>Math.round((Date.now()-x.t)/60000)+' min ago ('+x.chain+')').join(', '):''));
    /* and the other way round: a YOU row today with no swap of yours behind it (liquidity added or taken out must
       never be listed as a swap) */
    const extra=P.mine.filter((y,j)=>y.t>=START&&!used.has(j)).length;
    console.log((extra?'MISS ':'ok   ')+'YOU rows today with no swap of yours behind them: '+extra);
    for(const l of why) console.log('     '+l);
    for(const x of miss){ const near=P.mine.filter(y=>y.chain===x.chain).map(y=>({d:Math.round((y.t-x.t)/1000), own:!!y.own, side:y.side, used:used.has(P.mine.indexOf(y))})).sort((a,b)=>Math.abs(a.d)-Math.abs(b.d))[0];
      console.log('     the nearest YOU row on that chain: '+(near?(near.d>0?'+':'')+near.d+' s from it, '+(near.own?'through your pool':'elsewhere')+', '+near.side+', '+(near.used?'already matched to another swap of yours':'matched to nothing else'):'none')
        +' · YOU rows today on that chain: '+P.mine.filter(y=>y.chain===x.chain&&y.t>=START).length); } }
  /* the bridge marks: which of them are your own trades (a mark says "you" then) */
  { const L=(data.bridgeLinks&&data.bridgeLinks.links)||[];
    console.log('bridge marks the relay holds (last 24 h): '+L.length+(L.length?' · on your own trades: '+L.filter(l=>l.own).length+' · on other traders’ '+L.filter(l=>l.own===false).length+(L.some(l=>l.own==null)?' · from before marks said whose: '+L.filter(l=>l.own==null).length:''):'')); } }
/* What the owner said they did, checked position by position (the sealed request): whether the deck
   tracks it and where it is, today's harvests, top-ups and withdrawals on its own chain, whether its
   booked fee total ever fell, and whether the relay read it after; for a withdrawal, the liquidity left
   as a share of what was there, whether the deck shows that, and where the tokens went. */
if(process.env.ASK){ let q=null; try{ q=JSON.parse(inboxOpen(JSON.parse(process.env.ASK))); }catch(e){}
  if(!q||!Array.isArray(q.pos)) console.log('note the sealed request could not be opened');
  else { console.log('— what you said you did (the positions you named stay sealed) —');
    const evmW=new Set(W.filter(x=>!['solana','sui','tron'].includes(x.chain)).map(x=>String(x.address).toLowerCase()));
    const hist=(fees.posHist||[]).filter(x=>x[0]>=START-3600e3);
    /* A restake: a position closed and one opened in its place (it.from), usually with a tighter range.
       Ranges are said as how many times wide they are (upper price over lower, a ratio), never a price,
       an amount or a position. The closed one's range comes from the pool's own Burn in its withdrawal
       (found even when the NFT was burned); the new one's from the position manager now. */
    const BURN='0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c';
    const s24=h=>{ const v=Number(BigInt('0x'+h)&0xffffffn); return v>=0x800000?v-0x1000000:v; };
    const wideOf=(tl,tu)=>Math.pow(1.0001,tu-tl);
    const rcAny=async(ch,h)=>{ for(const u of CH[ch].rpcs){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getTransactionReceipt',params:[h]})}); if(r&&r.result) return r.result; } return null; };
    const posNow=async(ch,id)=>{ const r=await rpcOn(ch,'eth_call',[{to:CH[ch].npm,data:'0x99fbab88'+idTopic(id).slice(2)},'latest']);
      if(typeof r!=='string'||r.length<2+64*8) return null; const w=i=>r.slice(2+64*i,2+64*(i+1));
      return {t0:'0x'+w(2).slice(24), t1:'0x'+w(3).slice(24), fee:parseInt(w(4),16), tl:s24(w(5).slice(58)), tu:s24(w(6).slice(58)), liq:BigInt('0x'+w(7))}; };
    const whereIs=async id=>{ const p=(data.eth||[]).find(x=>String(x.id)===id); if(p) return {p, ch:CH[p.chain]?p.chain:'ethereum', owner:String(p.owner||'').toLowerCase()};
      for(const c of Object.keys(CH)){ const r=await rpcOn(c,'eth_call',[{to:CH[c].npm,data:'0x6352211e'+idTopic(id).slice(2)},'latest']);
        const o=typeof r==='string'&&r.length>=66?'0x'+r.slice(26,66).toLowerCase():null; if(o&&evmW.has(o)) return {p:null, ch:c, owner:o}; }
      return {p:null, ch:null, owner:null}; };
    /* the pool a position is in, from the factory, while the deck does not track it yet (Ethereum's v3 factory) */
    const poolOf=async(ch,q)=>{ if(ch!=='ethereum'||!q) return null; const a=x=>x.replace(/^0x/,'').padStart(64,'0');
      const r=await rpcOn(ch,'eth_call',[{to:FACT,data:'0x1698ee82'+a(q.t0)+a(q.t1)+q.fee.toString(16).padStart(64,'0')},'latest']);
      return typeof r==='string'&&r.length>=66?'0x'+r.slice(26,66).toLowerCase():null; };
    /* the closed one's pool and range, from the pool's Burn (owner: the position manager) in its withdrawal today */
    const burnOf=async(ch,ev)=>{ for(const l of (ev&&ev.decrease)||[]){ const rc=await rcAny(ch,l.transactionHash);
        const b=((rc&&rc.logs)||[]).find(x=>x.topics&&x.topics[0]===BURN&&('0x'+String(x.topics[1]).slice(26)).toLowerCase()===String(CH[ch].npm).toLowerCase());
        if(b) return {pool:String(b.address).toLowerCase(), tl:s24(String(b.topics[2]).slice(-6)), tu:s24(String(b.topics[3]).slice(-6))}; }
      return null; };
    const restake={};                                         // the closed position's pool and range, for the one that replaced it
    async function closedLine(id){
      const {p,ch:c0}=await whereIs(id), ch=c0||'ethereum', ev=await npmEvents(ch,id), q=await posNow(ch,id), parts=[], bad=[];
      parts.push(ev?'today: harvests '+ev.collect.length+', tokens added '+ev.increase.length+', tokens withdrawn '+ev.decrease.length:'its events today could not be read');
      if(!ev||!ev.decrease.length) bad.push(1);
      parts.push('liquidity left: '+(q?(q.liq===0n?'none':'SOME'):'none (the position is gone from the chain)')); if(q&&q.liq!==0n) bad.push(1);
      const shut=!!(fees.closedPos&&fees.closedPos[id])||!!(p&&String(p.liq)==='0');
      parts.push('the deck shows it closed: '+(shut?'yes':'NOT YET')); if(!shut) bad.push(1);
      if(ev&&ev.collect.length){ let lost=0;
        for(const l of ev.collect){ const to='0x'+String(l.data).slice(26,66).toLowerCase(); if(evmW.has(to)) continue;
          const mgr=String(CH[ch].npm).toLowerCase(); if(to!==mgr){ lost++; continue; }
          const rc=await rcAny(ch,l.transactionHash), logs=(rc&&rc.logs)||[], caller=String(rc&&rc.from||'').toLowerCase();
          const sent=logs.filter(x=>x.topics&&x.topics[0]===XFER&&x.topics.length===3&&('0x'+x.topics[1].slice(26)).toLowerCase()===mgr).map(x=>('0x'+x.topics[2].slice(26)).toLowerCase());
          if(!(sent.every(a=>evmW.has(a))&&evmW.has(caller))) lost++; }
        parts.push('the withdrawn tokens went to your wallets: '+(lost?'NO':'yes')); if(lost) bad.push(1); }
      const b=await burnOf(ch,ev); if(b) restake[id]={...b, ch};
      parts.push('its range: '+(b?wideOf(b.tl,b.tu).toFixed(2)+'× wide':(q&&q.tu>q.tl?wideOf(q.tl,q.tu).toFixed(2)+'× wide':'could not be read')));
      if(!b&&q) restake[id]={pool:null, tl:q.tl, tu:q.tu, ch, t0:q.t0, t1:q.t1, fee:q.fee};
      return (bad.length?'WARN ':'ok   ')+'the position you closed: '+parts.join(' · '); }
    async function openedLine(it,id){
      const {p,ch,owner}=await whereIs(id), parts=['tracked by the deck: '+(p?'yes':'NOT YET')+(ch?' · on '+ch:'')], bad=[];
      if(!ch) return 'WARN the position you opened: not held by any of your wallets on the chains the deck reads';
      if(!p){ bad.push(1); parts.push(HOLD.has(owner)?'held by a holdings-only wallet (the deck reads what those hold, not their positions)':'held by a wallet the deck sweeps for positions'); }
      const ev=await npmEvents(ch,id), q=await posNow(ch,id);
      parts.push(ev?'today: tokens added '+ev.increase.length+', withdrawn '+ev.decrease.length:'its events today could not be read');
      if(q){ parts.push('its range: '+wideOf(q.tl,q.tu).toFixed(2)+'× wide');
        if(p){ const sc=Math.pow(10,(p.d0||0)-(p.d1||0)), lo=Math.pow(1.0001,q.tl)*sc, hi=Math.pow(1.0001,q.tu)*sc;
          const rOk=Math.abs(p.priceLower/lo-1)<1e-6&&Math.abs(p.priceUpper/hi-1)<1e-6, lOk=String(p.liq)===q.liq.toString();
          parts.push('the deck shows its range: '+(rOk?'yes':'NO')+' · its liquidity: '+(lOk?'yes':'NO')); if(!rOk||!lOk) bad.push(1);
          const series=hist.map(x=>x[1][id]).filter(v=>v!=null); let fell=0; for(let i=1;i<series.length;i++) if(series[i]<series[i-1]-0.01) fell++;
          // as for every position: a fall is fine when an own swap went through its pool (its fee is taken back out of income: checked by the own-swap check)
          const own=fell&&takenBy.has(String(p.pool||'').toLowerCase());
          parts.push('its booked fee total fell: '+(fell?fell+' time(s)'+(own?' (an own swap went through its pool: its fee taken back out of income)':''):'never')+' ('+series.length+' readings)'); if(fell&&!own) bad.push(1);
          parts.push('in range now: '+(p.inRange?'yes':'no')); }
        const o=it.from&&restake[String(it.from)];
        if(o){ const pool=p&&p.pool?String(p.pool).toLowerCase():await poolOf(ch,q), same=o.pool?(pool?pool===o.pool:null):(o.t0===q.t0&&o.t1===q.t1&&o.fee===q.fee);
          const ow=wideOf(o.tl,o.tu), nw=wideOf(q.tl,q.tu);
          parts.push('the same pool as the one you closed: '+(same==null?'unknown':same?'yes':'NO')+' · tighter than it: '+(nw<ow?'yes':'NO')+' ('+nw.toFixed(2)+'× against '+ow.toFixed(2)+'×)'); }
        else if(it.from) parts.push('the one it replaced: not read (name it as closed in the same request)'); }
      else { parts.push('its range could not be read'); bad.push(1); }
      return (bad.length?'WARN ':'ok   ')+'the position you opened: '+parts.join(' · '); }
    for(const it of q.pos.filter(x=>x.did==='close')){ const id=String(it.id); if(!/^\d+$/.test(id)) continue;
      try{ console.log(await closedLine(id)); }catch(e){ console.log('WARN the position you closed: could not be checked this time'); } }
    for(const it of q.pos.filter(x=>x.did==='open')){ const id=String(it.id); if(!/^\d+$/.test(id)) continue;
      try{ console.log(await openedLine(it,id)); }catch(e){ console.log('WARN the position you opened: could not be checked this time'); } }
    for(const it of q.pos.filter(x=>x.did!=='close'&&x.did!=='open')){ const id=String(it.id); if(!/^\d+$/.test(id)) continue;
      const lab=it.did==='harvest'?'the position you harvested':it.did==='withdraw'?'the position you partly withdrew':'a position you named';
      const p=(data.eth||[]).find(x=>String(x.id)===id); let ch=p?(CH[p.chain]?p.chain:'ethereum'):null, owner=null;
      if(!p) for(const c of Object.keys(CH)){ const r=await rpcOn(c,'eth_call',[{to:CH[c].npm,data:'0x6352211e'+idTopic(id).slice(2)},'latest']);
        const o=typeof r==='string'&&r.length>=66?'0x'+r.slice(26,66).toLowerCase():null; if(o&&evmW.has(o)){ ch=c; owner=o; break; } }
      const ev=ch?await npmEvents(ch,id):null, parts=['tracked by the deck: '+(p?'yes':'NO')+(ch?' · on '+ch:'')];
      if(!p) parts.push(ch?'held by one of your wallets'+(HOLD.has(owner)?', a holdings-only one (the deck reads what those hold, not their positions)':''):'not held by any of your wallets on the chains the deck reads');
      parts.push(ev?'today: harvests '+ev.collect.length+', tokens added '+ev.increase.length+', tokens withdrawn '+ev.decrease.length:'its events today could not be read');
      if(p){ const series=hist.map(x=>x[1][id]).filter(v=>v!=null); let fell=0; for(let i=1;i<series.length;i++) if(series[i]<series[i-1]-0.01) fell++;
        parts.push('its booked fee total fell: '+(fell?fell+' time(s)':'never')+' ('+series.length+' readings)');
        const last=ev?Math.max(0,...[...ev.collect,...ev.decrease,...ev.increase].map(l=>parseInt(l.blockNumber,16))):0;
        if(last){ const bk=await rpcOn(ch,'eth_getBlockByNumber',['0x'+last.toString(16),false]), ts=bk?parseInt(bk.timestamp,16)*1000:0;
          parts.push('the relay read it after your transaction: '+(ts?((data.t||0)>ts?'yes':'not yet'):'unknown')); }
        if(it.did==='harvest'&&p.feesEverUsd>0) parts.push('unclaimed now: '+Math.round((p.feesUsd||0)/p.feesEverUsd*100)+'% of its lifetime fees'); }
      if(it.did==='withdraw'&&ev&&ev.decrease.length){
        const first=Math.min(...ev.decrease.map(l=>parseInt(l.blockNumber,16)));
        const liqAt=async tag=>{ const r=await rpcOn(ch,'eth_call',[{to:CH[ch].npm,data:'0x99fbab88'+idTopic(id).slice(2)},tag]); return typeof r==='string'&&r.length>=2+64*8?BigInt('0x'+r.slice(2+64*7,2+64*8)):null; };
        const before=await liqAt('0x'+(first-1).toString(16)), now=await liqAt('latest');
        if(before&&now!=null) parts.push('liquidity now: '+(Number(now*10000n/before)/100).toFixed(1)+'% of what it was before');
        if(p&&now!=null) parts.push('the deck shows that liquidity: '+(String(p.liq)===now.toString()?'yes':'NO'));
        /* where the tokens went: straight to a wallet, or (the Uniswap app's way with an ETH pair) to the
           position manager itself, which in the same transaction unwraps the ETH for the caller and sends
           the other token on: followed through the receipt */
        const ZERO='0x'+'0'.repeat(40), mgr=CH[ch].npm, WITHDRAWAL='0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
        let direct=0, via=0, lost=0;
        for(const l of ev.collect){ const to='0x'+String(l.data).slice(26,66).toLowerCase();
          if(evmW.has(to)){ direct++; continue; }
          if(to!==mgr&&to!==ZERO){ lost++; continue; }
          const rc=await rpcOn(ch,'eth_getTransactionReceipt',[l.transactionHash]), logs=(rc&&rc.logs)||[], caller=String(rc&&rc.from||'').toLowerCase();
          const sent=logs.filter(x=>x.topics&&x.topics[0]===XFER&&x.topics.length===3&&('0x'+x.topics[1].slice(26)).toLowerCase()===mgr).map(x=>('0x'+x.topics[2].slice(26)).toLowerCase());
          const unwrapped=logs.some(x=>x.topics&&x.topics[0]===WITHDRAWAL&&('0x'+String(x.topics[1]).slice(26)).toLowerCase()===mgr);
          if((sent.length||unwrapped)&&sent.every(a=>evmW.has(a))&&(!unwrapped||evmW.has(caller))) via++; else lost++; }
        if(ev.collect.length) parts.push('the withdrawn tokens went to one of your wallets: '+(lost?'NO':'yes')+(via?' (through the position manager, which unwrapped the ETH and sent both on)':''));
        /* the portfolio total across it: positions, wallets and NFTs, from the readings either side (a
           withdrawal moves value from a position to a wallet; it should not dip). Wallet reads held back
           (is) are passed over. */
        { const tsW=await (async()=>{ const bk=await rpcOn(ch,'eth_getBlockByNumber',['0x'+first.toString(16),false]); return bk?parseInt(bk.timestamp,16)*1000:0; })();
          const H=(data.history||[]).filter(x=>x&&x.v!=null&&x.i!=null&&!x.is), tot=x=>(x.v||0)+(x.i||0)+(x.n||0);
          const b0=[...H].reverse().find(x=>x.t<tsW), a0=H.find(x=>x.t>tsW);
          if(tsW&&b0&&a0) parts.push('the portfolio total across it: '+((tot(a0)/tot(b0)-1)*100).toFixed(1)+'% (readings '+Math.round((a0.t-b0.t)/60e3)+' min apart) · dipped: '+(tot(a0)<0.98*tot(b0)?'YES':'no')); } }
      console.log((p&&ev?'ok   ':'WARN ')+lab+': '+parts.join(' · ')); } } }
/* LCX that arrived today, by the kind of venue it came through (never which pool or wallet), and
   whether the relay's wallet balances were read after the last of it */
if(lcx.n){ const v={pos:0,own:0,v3:0,v4:0,v2:0,other:0};
  for(const h of lcx.tx){ const lg=await j(BS+'/transactions/'+h+'/logs'); await sleep(150); const items=(lg&&lg.items)||[];
    const sw=items.filter(x=>x.topics&&x.topics[0]===SWAP_V3);
    if(items.some(x=>x.topics&&x.topics[0]===EV.collect)) v.pos++;   // paid out of one of your positions: a harvest or a withdrawal, not a swap
    else if(sw.some(x=>ownEth.has(String(x.address&&x.address.hash).toLowerCase()))) v.own++;
    else if(sw.length) v.v3++; else if(items.some(x=>x.topics&&x.topics[0]===SWAP_V4)) v.v4++; else if(items.some(x=>x.topics&&x.topics[0]===SWAP_V2)) v.v2++; else v.other++; }
  const it=data.idle&&data.idle.t, held=!!(data.idle&&(data.idle.rows||[]).some(r=>String(r.symbol).toUpperCase()==='LCX'&&r.amount>0));
  console.log(((it&&it>=lcx.last)?'ok   ':'WARN ')+'LCX arriving in your Ethereum wallets today: '+lcx.n+' transfer(s) in '+lcx.tx.size+' transaction(s) · paid out of one of your positions (a harvest or a withdrawal) '+v.pos+' · swapped through one of your own pools '+v.own
    +', another Uniswap v3 pool '+v.v3+', Uniswap v4 '+v.v4+', a v2-style pool '+v.v2+', another venue (an aggregator or a filled order) '+v.other
    +' · the relay\u2019s wallet balances read after the last of it: '+(it?(it>=lcx.last?'yes':'not yet'):'n/a')+' · LCX among them: '+(held?'yes':'no')); }
else console.log('LCX arriving in your Ethereum wallets today: 0');
// the relay's errors by kind: the first word of each, letters only, as the relay's own log counts them
{ const kinds={}; for(const e of data.errors||[]){ const k=(String(e).match(/^[A-Za-z]+/)||['other'])[0]; kinds[k]=(kinds[k]||0)+1; }
  console.log('positions now: '+(data.eth||[]).length+' Ethereum, '+(data.sol||[]).length+' Solana · relay errors: '+((data.errors||[]).length)
    +(Object.keys(kinds).length?' ('+Object.entries(kinds).map(([k,n])=>k+' \u00d7'+n).join(', ')+')':'')); }

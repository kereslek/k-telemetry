/* Today's activity, checked: every swap the deck's wallets made since midnight Budapest that went through
   one of the deck's own pools — whose fee came back to the deck and is not income — and whether the
   relay booked it as an own-swap fee; and that the month's fees never stepped down (a harvest moves
   fees from unclaimed to collected, it does not lose them). The deck is locked and this log is
   public: only counts and yes/no are printed, never a wallet, a transaction, a pool or an amount. */
import crypto from 'node:crypto';
const SITE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/', PASS=String(process.env.DECK_PASSPHRASE||'').trim();
/* from START, or else from midnight Budapest today */
const budMidnight=()=>{ const now=Date.now(), d=new Date(now).toLocaleString('sv-SE',{timeZone:'Europe/Budapest'}).slice(0,10);
  for(const off of [1,2]){ const t=Date.parse(d+'T00:00:00+0'+off+':00'); if(new Date(t).toLocaleString('sv-SE',{timeZone:'Europe/Budapest'}).slice(11,16)==='00:00') return t; } return now-24*3600e3; };
const START=Date.parse(process.env.START||'')||budMidnight();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(u,opt){ for(let k=0;k<4;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(30000)}); if(r.ok) return await r.json(); }catch(e){} await sleep(1200*(k+1)); } return null; }
const L=await j(SITE+'lock.json?t='+Date.now());
const KEY=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256').subarray(0,32);
const open=e=>{ if(!(e&&e.lock===1)) return e; const all=Buffer.from(e.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(e.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); };
const t=Date.now();
const [cfg,data,fees,costs,ledger]=(await Promise.all(['config.json','data-main.json','fees-main.json','costs-main.json','ledger-main.json'].map(f=>j(SITE+f+'?t='+t)))).map(x=>x?open(x):null);
const W=cfg.profiles.flatMap(p=>p.wallets||[]), WE=W.filter(x=>x.chain==='ethereum').map(x=>x.address.toLowerCase()), WS=W.filter(x=>x.chain==='solana').map(x=>x.address);
// the relay writes an Ethereum log index in hex (…:0x12f), this audit in decimal (…:303)
const normId=id=>String(id).replace(/:0x([0-9a-f]+)$/i,(_,h)=>':'+parseInt(h,16));
const booked=new Set([...(fees.selfDone||[]), ...((costs.selfPend||[]).map(x=>x.id))].map(normId));
const pendBack=new Map((costs.selfPend||[]).map(x=>[normId(x.id),x.back]));
console.log('since',new Date(START).toISOString(),'· wallets: '+WE.length+' Ethereum, '+WS.length+' Solana · own-swap ids the relay has booked this month: '+booked.size);
// ---- own pools: open now, plus Ethereum positions closed this month (read back from the position manager)
const ETH_RPC=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth'];
async function ecall(to,data){ for(const u of ETH_RPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']})}); if(r&&r.result) return r.result; } return null; }
const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88', FACT='0x1f98431c8ad98523631ae4a59f267346ea31f984';
const ownEth=new Map((data.eth||[]).map(p=>[String(p.pool).toLowerCase(),'#'+p.id+' '+(p.pairLabel||'')]));
for(const id of Object.keys(fees.closedPos||{}).filter(x=>/^\d+$/.test(x))){
  const r=await ecall(NPM,'0x99fbab88'+BigInt(id).toString(16).padStart(64,'0')); if(!r) continue;
  const w=i=>r.slice(2+64*i,2+64*(i+1)), t0='0x'+w(2).slice(24), t1='0x'+w(3).slice(24), fee=parseInt(w(4),16);
  const pr=await ecall(FACT,'0x1698ee82'+w(2)+w(3)+fee.toString(16).padStart(64,'0'));
  if(pr) ownEth.set(('0x'+pr.slice(26)).toLowerCase(),'#'+id+' (closed this month)'); }
const ownSol=new Map((data.sol||[]).map(p=>[p.poolId,p.id.slice(0,12)+' '+(p.pairLabel||'')+' '+(p.feeLabel||'')]));
console.log('own pools: '+ownEth.size+' Ethereum, '+(data.sol||[]).length+' Solana positions');

const found=[], other={eth:0,sol:0}, kinds={v3:0,v4:0,v2:0,transfer:0,other:0}; let ethSent=0, ethIn=0, extOut=0, intMove=0, lastTx=0;
const SWAP_V4='0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', SWAP_V2='0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', XFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; let solSeen=0, solMine=0;
// ---- Ethereum
const BS='https://eth.blockscout.com/api/v2', SWAP_V3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
for(const w of WE){
  let url=BS+'/addresses/'+w+'/transactions', n=0;
  while(url && n<10){ n++;
    const r=await j(url); if(!r) break; let older=false;
    for(const tx of r.items||[]){
      if(Date.parse(tx.timestamp)<START){ older=true; continue; }
      if(String(tx.from&&tx.from.hash).toLowerCase()!==w || tx.status!=='ok') continue;
      const lg=await j(BS+'/transactions/'+tx.hash+'/logs'); await sleep(150);
      ethSent++; const tops=new Set(((lg&&lg.items)||[]).map(x=>x.topics&&x.topics[0]));
      if(tops.has(SWAP_V3)) kinds.v3++; else if(tops.has(SWAP_V4)) kinds.v4++; else if(tops.has(SWAP_V2)) kinds.v2++; else if(tops.has(XFER)) kinds.transfer++; else kinds.other++;
      lastTx=Math.max(lastTx, Date.parse(tx.timestamp)||0);
      // tokens sent to an address that is not one of the deck's: leaving the tracked wallets
      if(!tops.has(SWAP_V3)&&!tops.has(SWAP_V4)&&!tops.has(SWAP_V2))
        for(const x of ((lg&&lg.items)||[]).filter(x=>x.topics&&x.topics[0]===XFER&&x.topics[2]&&!x.topics[3])){
          const from='0x'+String(x.topics[1]).slice(26).toLowerCase(), to='0x'+String(x.topics[2]).slice(26).toLowerCase();
          if(from===w && !WE.includes(to)) extOut++; else if(from===w) intMove++; }
      const sw=((lg&&lg.items)||[]).filter(x=>x.topics&&x.topics[0]===SWAP_V3);
      for(const s of sw){ const pool=String(s.address.hash).toLowerCase();
        if(!ownEth.has(pool)) { other.eth++; continue; }
        const id='eth:'+tx.hash+':'+s.index; found.push({chain:'eth',t:tx.timestamp,id,pool:ownEth.get(pool),booked:booked.has(id),back:pendBack.get(id)});
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
      const h=x.transaction_hash; if(seenTx.has(h)) continue; seenTx.add(h); ethIn++;
      const tx=await j(BS+'/transactions/'+h); if(!tx||String(tx.from&&tx.from.hash).toLowerCase()===w) continue;
      const lg=await j(BS+'/transactions/'+h+'/logs'); await sleep(150);
      for(const s of ((lg&&lg.items)||[]).filter(y=>y.topics&&y.topics[0]===SWAP_V3)){ const pool=String(s.address.hash).toLowerCase();
        if(!ownEth.has(pool)) continue;
        const id='eth:'+h+':'+s.index;
        found.push({chain:'eth',t:x.timestamp,id,pool:ownEth.get(pool),booked:booked.has(id),back:pendBack.get(id),filled:1}); }
    }
    tu=(!older&&r.next_page_params)?BS+'/addresses/'+w+'/token-transfers?'+new URLSearchParams(r.next_page_params):null;
  }
}
// ---- Solana
// history-serving endpoints first: publicnode answers with only the last few hours of signatures
const SR=[process.env.SOL_RPC_URL,'https://api.mainnet-beta.solana.com','https://rpc.solanatracker.io/public','https://solana.leorpc.com/?api_key=FREE','https://solana-rpc.publicnode.com'].filter(Boolean);
async function srpc(method,params){ for(let k=0;k<3;k++) for(const u of SR){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); if(r&&r.result!==undefined) return r.result; await sleep(600);} return null; }
const solPos=new Map(), solMove={own:0,out:0,other:0};
for(const w of WS){
  let before=null, done=false, seen=0, mine=0;
  while(!done){
    const sigs=await srpc('getSignaturesForAddress',[w,{limit:100,commitment:'confirmed',...(before?{before}:{})}]); if(!sigs||!sigs.length) break;
    for(const s of sigs){ before=s.signature; if(!s.blockTime) continue; if(s.blockTime*1000<START){ done=true; break; } if(s.err) continue; seen++;
      const tx=await srpc('getTransaction',[s.signature,{encoding:'json',maxSupportedTransactionVersion:0}]); await sleep(120); if(!tx) continue;
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
        const px=await srpc('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]); await sleep(120);
        const owners=new Map(); const ak=px?px.transaction.message.accountKeys.map(k=>k.pubkey||k):[];
        for(const tb of [...((px&&px.meta.preTokenBalances)||[]),...((px&&px.meta.postTokenBalances)||[])]) if(tb.owner) owners.set(ak[tb.accountIndex],tb.owner);
        let own=0, out=0;
        for(const ins of (px?px.transaction.message.instructions:[])){ const pi=ins.parsed; if(!pi||!pi.info) continue;
          if(!/^(transfer|transferChecked|transferWithSeed)$/.test(pi.type)) continue;
          const dest=pi.info.destination, to=ins.program==='system'?dest:(owners.get(dest)||null);
          if(to&&WS.includes(to)) own++; else out++; }
        if(own&&!out) solMove.own++; else if(out) solMove.out++; else if(!px) solMove.other++; }
      if(!logs.some(l=>/Instruction: Swap/i.test(l))) continue;
      const pools=[...ownSol.keys()].filter(p=>keys.includes(p));
      if(!pools.length){ other.sol++; continue; }
      for(const p of pools){ const id='sol:'+s.signature+':'+p; found.push({chain:'sol',t:new Date(s.blockTime*1000).toISOString(),id,pool:ownSol.get(p),booked:booked.has(id),back:pendBack.get(id),who:w}); }
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
  if(c==='sol') for(const x of f.filter(x=>!x.booked)){
    const sig=x.id.split(':')[1], pool=x.id.split(':')[2], age=(Date.now()-Date.parse(x.t))/60000;
    const seen=!!((costs.solTxs||{})[sig]||(costs.prevSolTxs||{})[sig]), pend=!!((costs.solWalletTx||{})[sig]);
    const mine=(data.sol||[]).filter(p=>p.poolId===pool), inr=mine.filter(p=>p.inRange!==false&&p.inRange!==0).length;
    console.log('     not booked: made '+age.toFixed(0)+' min ago · relay data '+((Date.now()-(data.t||0))/60000).toFixed(0)+' min old, '+((data.t||0)>Date.parse(x.t)?'newer':'older')+' than the swap'
      +' · the relay has '+(seen?'counted this transaction':pend?'queued it, not yet counted':'not seen it')+' · deck positions in that pool: '+mine.length+', in range now: '+inr); }
}
// the month's fees only ever rise: a harvest moves them from unclaimed to collected
const ticks=(fees.ticks||[]).filter(x=>x[0]>=START);
let drops=0, worst=0; for(let i=1;i<ticks.length;i++){ const d=ticks[i][1]-ticks[i-1][1]; if(d< -0.01){ drops++; worst=Math.min(worst,d/Math.max(1,ticks[i-1][1])); } }
console.log((drops?'WARN ':'ok   ')+'month-to-date fee readings today: '+ticks.length+' · steps down: '+drops+(drops?' (largest '+(worst*100).toFixed(2)+'% of the total)':''));
console.log('token transfers out of the deck\u2019s Ethereum wallets: '+extOut+' to outside addresses, '+intMove+' between its own wallets');
console.log('solana transfers sent by the deck\u2019s wallets: '+solMove.own+' to its own wallets, '+solMove.out+' to outside addresses'+(solMove.other?', '+solMove.other+' unclear':''));
/* Solana positions the deck's wallets touched today: a harvest (or a withdrawal, which collects the
   fees with it) moves fees from unclaimed to collected, so the position's booked fee total must
   never fall, and the relay's harvest scan must have read past it without an error. */
{ const hist=(fees.posHist||[]).filter(x=>x[0]>=START-3600e3);
  for(const [id,e] of solPos){ const L=(ledger||{})[id]||{}, p=(data.sol||[]).find(q=>q.id===id)||{};
    const series=hist.map(x=>x[1][id]).filter(v=>v!=null); let fell=0; for(let i=1;i<series.length;i++) if(series[i]<series[i-1]-0.01) fell++;
    const after=series.length>1&&hist.length&&hist[hist.length-1][0]>lastTx;
    console.log((fell||L.txErr?'WARN ':'ok   ')+'a Solana position: harvests '+e.harvest+', collected through DecreaseLiquidity (Raydium\u2019s harvest, or a withdrawal) '+e.decrease+', added '+e.increase+(e.other?', other '+e.other:'')
      +' · booked fee total fell: '+(fell?fell+' time(s)':'never')+' ('+series.length+' readings) · harvest scan '+(L.txErr?'reported an error':'clean')+(L.harvestGap?' · a harvest only partly read, filled from the owed balance':'')
      +' · fees owed now '+((p.feesUsd||0)>0?'above zero':'zero')+' · read after today\u2019s last transaction: '+(after?'yes':'not yet')); }
  if(!solPos.size) console.log('Solana positions touched today: 0'); }
{ const it=data.idle&&data.idle.t; console.log((lastTx&&it&&it<lastTx?'WARN ':'ok   ')+'wallet balances read after the latest of these transactions: '+(lastTx?(it&&it>=lastTx?'yes':'no'):'n/a')); }
/* Ethereum positions: harvests, tokens added and withdrawn since START (from the position manager's
   own events), and whether each position's booked fee total ever fell — a harvest moves fees from
   unclaimed to collected, a top-up adds principal; neither may take fees away. */
{ const EV={collect:'0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01', increase:'0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f', decrease:'0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4'};
  const erpc=async(method,params)=>{ for(const u of ETH_RPC){ const r=await j(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); if(r&&r.result!==undefined) return r.result; } return null; };
  const tip=parseInt(await erpc('eth_blockNumber',[]),16), from=tip-Math.ceil((Date.now()-START)/12000)-50;
  const hist=(fees.posHist||[]).filter(x=>x[0]>=START-3600e3);
  let quiet=0;
  for(const p of data.eth||[]){ const id=String(p.id); if(!/^\d+$/.test(id)) continue;
    const topic='0x'+BigInt(id).toString(16).padStart(64,'0'), n={};
    for(const [name,t0] of Object.entries(EV)){ let c=0; for(let a=from;a<=tip;a+=9000){ const r=await erpc('eth_getLogs',[{address:NPM,fromBlock:'0x'+a.toString(16),toBlock:'0x'+Math.min(tip,a+8999).toString(16),topics:[t0,topic]}]); if(Array.isArray(r)) c+=r.length; } n[name]=c; }
    const series=hist.map(x=>x[1][id]).filter(v=>v!=null); let fell=0; for(let i=1;i<series.length;i++) if(series[i]<series[i-1]-0.01) fell++;
    if(!(n.collect||n.increase||n.decrease)){ quiet++; continue; }
    console.log((fell?'WARN ':'ok   ')+'an Ethereum position: harvests '+n.collect+', tokens added '+n.increase+', tokens withdrawn '+n.decrease+' · its booked fee total fell: '+(fell?fell+' time(s)':'never')+' ('+series.length+' readings)'); }
  console.log('Ethereum positions with no harvest, top-up or withdrawal: '+quiet); }
console.log('positions now: '+(data.eth||[]).length+' Ethereum, '+(data.sol||[]).length+' Solana · relay errors: '+((data.errors||[]).length));

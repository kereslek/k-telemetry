/* Everything that ever arrived at the owner's exchange deposit addresses (sealed in config.json beside the wallets),
   kept for good: when, chain, token, amount, its value at the time, the transaction, and which of the deck's wallets
   sent it (or that another address did). The deck shows it where the total moves ("sent to your exchange"), and a
   later reconciliation with the exchange's own balances and ledger starts from it.

   Read from the deposit address's side: a deposit address is the owner's alone, so all it receives is theirs. On
   Solana a token arrives in one of the address's token accounts, which a transfer into an existing one does not
   name the address itself in, so those accounts are read too. What the exchange sweeps out again is not a transfer
   of the owner's and is left out. Each run reads what is new, and one more stretch of the past until it reaches the
   address's first transaction; a run that runs out of time carries on from where it stopped.

   io: sol(method, params) · getJson(url, ms) · usdAt(chain, token, tSec) -> price then, or null · sym(chain, token)
   st: the persisted state (the relay's blockCache.cex), changed in place. */
const LAMPORTS=1e9, SOLK='native';

export async function exchLedger({cex, wallets, io, st, now=Date.now(), budgetMs=40000, pages=3}){
  st.rows=st.rows||[]; st.addr=st.addr||{};
  const t0=Date.now(), late=()=>Date.now()-t0>budgetMs, err=[];
  const have=new Set(st.rows.map(r=>r.k)), own=new Set((wallets||[]).map(w=>String(w.address).toLowerCase()));
  const add=r=>{ if(have.has(r.k)) return; have.add(r.k); st.rows.push(r); };

  for(const x of (cex||[])){
    try{
      if(x.chain==='solana') await solana(x.address);
      else if(x.chain==='ethereum') await ethereum(String(x.address).toLowerCase());
    }catch(e){ err.push(x.chain+': '+String(e&&e.message||e).slice(0,80)); }
    if(late()) break;
  }

  /* Solana: the address itself (SOL, and a token account being opened) and each token account it holds */
  async function solana(owner){
    const accts=new Set([owner]);
    for(const prog of ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']){
      const r=await io.sol('getTokenAccountsByOwner',[owner,{programId:prog},{encoding:'jsonParsed'}]);
      for(const a of (r&&r.value)||[]) accts.add(a.pubkey); }
    for(const a of accts){ if(late()) return;
      const S=st.addr['sol:'+a]=st.addr['sol:'+a]||{};
      // what is new since the newest seen (all of it, the first time, as far as `pages` reach)
      const fresh=[]; let before=null, full=false;
      for(let p=0;p<(S.newest?10:pages);p++){ const sigs=await io.sol('getSignaturesForAddress',[a,{limit:100,...(S.newest?{until:S.newest}:{}),...(before?{before}:{})}]);
        if(!Array.isArray(sigs)){ full=true; break; } if(!sigs.length) break; fresh.push(...sigs); before=sigs[sigs.length-1].signature; full=sigs.length===100; if(!full) break; }
      if(!S.newest){ if(fresh.length){ S.oldest=fresh[fresh.length-1].signature; } if(!full) S.done=1; }
      // then one more stretch of the past, from the oldest seen
      const old=[];
      if(!S.done&&S.oldest) for(let p=0;p<pages&&!late();p++){ const sigs=await io.sol('getSignaturesForAddress',[a,{limit:100,before:S.oldest}]);
        if(!Array.isArray(sigs)) break; old.push(...sigs); if(sigs.length) S.oldest=sigs[sigs.length-1].signature; if(sigs.length<100){ S.done=1; break; } }
      st.seen=st.seen||{};
      for(const s of [...fresh,...old]){ if(late()) return;
        if(s.err||st.seen[s.signature]) continue;
        const tx=await io.sol('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]); if(!tx||!tx.meta) continue;
        for(const r of solIn(tx, owner, s.signature)) add({...r, from:own.has(String(r.from).toLowerCase())?r.from:r.from?'other':null});
        st.seen[s.signature]=1; }
      if(fresh.length) S.newest=fresh[0].signature;
    }
  }

  /* Ethereum: tokens (ERC-20) and ETH itself sent to the address, from Blockscout's pages, newest first */
  async function ethereum(addr){
    for(const [kind,path] of [['tok','/token-transfers?type=ERC-20&filter=to'],['eth','/transactions?filter=to']]){
      const S=st.addr['eth:'+kind+':'+addr]=st.addr['eth:'+kind+':'+addr]||{};
      const base='https://eth.blockscout.com/api/v2/addresses/'+addr+path, nextOf=j=>j.next_page_params?base+'&'+new URLSearchParams(j.next_page_params):null;
      const take=items=>{ let known=false; for(const it of items){ const r=ethRow(kind,it,addr); if(!r) continue; if(have.has(r.k)){ known=true; continue; } add({...r, from:own.has(r.from)?r.from:'other'}); } return known; };
      if(!S.started){
        // the first run: from the newest, as far as `pages` reach; the rest is the past still to read
        let url=base;
        for(let p=0;p<pages&&url&&!late();p++){ const j=await io.getJson(url,20000); if(!j||!Array.isArray(j.items)){ url=null; break; } take(j.items); url=nextOf(j); }
        S.started=1; S.next=url; if(!url) S.done=1;
      } else {
        // new ones: from the newest page until one already kept
        let url=base;
        for(let p=0;p<10&&url&&!late();p++){ const j=await io.getJson(url,20000); if(!j||!Array.isArray(j.items)) break; if(take(j.items)) break; url=nextOf(j); }
      }
      // the past, a stretch per run from where the last one stopped
      for(let p=0;p<pages&&!S.done&&S.next&&!late();p++){ const j=await io.getJson(S.next,20000); if(!j||!Array.isArray(j.items)) break;
        take(j.items); S.next=nextOf(j); if(!S.next) S.done=1; }
    }
  }

  // a value for each, at its own time (a price at a moment never changes, so it is asked once)
  // one failed ask is not an answer (a price feed refusing a burst of asks on the first run): a transfer is left
  // unvalued for good only after six tries, and only once it is three days old
  for(const r of st.rows){ if(late()) break; if(r.usd!=null||(r.px===false&&(r.tries||0)>=6)) continue;
    const p=await io.usdAt(r.ch, r.tok, Math.floor(r.t/1000)); r.tries=(r.tries||0)+1;
    if(p>0){ r.px=p; r.usd=Math.round(p*r.amt*100)/100; } else if(r.tries>=6&&now-r.t>3*864e5) r.px=false; }
  for(const r of st.rows) if(!r.sym) r.sym=io.sym(r.ch, r.tok)||null;
  st.rows.sort((a,b)=>b.t-a.t);
  st.at=now;
  return {...exchView(st, (cex||[]).length), err};
}
/* the kept record as the deck reads it, without reading anything new (the relay's passes in between) */
export function exchView(st, n){
  const rows=(st.rows||[]).map(({k,t,ch,tok,sym,amt,usd,from,tx})=>({k,t,ch,tok,sym,amt,usd,from,tx}));
  return {t:st.at||null, n, rows, whole:Object.keys(st.addr||{}).length>0&&Object.values(st.addr).every(v=>v.done)};
}

/* what one Solana transaction brought into the owner's address and token accounts (never what left them) */
export function solIn(tx, owner, sig){
  const out=[], t=(tx.blockTime||0)*1000, keys=(tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys||[]).map(k=>k.pubkey||k);
  const payer=keys[0]||null;
  // SOL itself: the address's balance up, when the address did not pay for the transaction (its own sweeps)
  const i=keys.indexOf(owner);
  if(i>0){ const d=(tx.meta.postBalances[i]-tx.meta.preBalances[i])/LAMPORTS; if(d>0) out.push({k:'sol:'+sig+':'+SOLK, t, ch:'sol', tok:SOLK, amt:d, from:payer, tx:sig}); }
  // tokens: each token account of the owner's whose balance went up; the sender is the owner whose balance of it fell most
  const pre=new Map((tx.meta.preTokenBalances||[]).map(b=>[b.accountIndex,b])), post=tx.meta.postTokenBalances||[];
  const amt=b=>b?Number(b.uiTokenAmount&&b.uiTokenAmount.uiAmountString||b.uiTokenAmount&&b.uiTokenAmount.uiAmount||0):0;
  const byMint={};
  for(const b of post){ const d=amt(b)-amt(pre.get(b.accountIndex)); (byMint[b.mint]=byMint[b.mint]||[]).push({owner:b.owner, d}); }
  for(const b of (tx.meta.preTokenBalances||[])) if(!post.some(p=>p.accountIndex===b.accountIndex)) (byMint[b.mint]=byMint[b.mint]||[]).push({owner:b.owner, d:-amt(b)});
  for(const [mint,L] of Object.entries(byMint)){
    const inn=L.filter(x=>x.owner===owner).reduce((a,x)=>a+x.d,0); if(!(inn>0)) continue;
    const src=L.filter(x=>x.owner!==owner&&x.d<0).sort((a,b)=>a.d-b.d)[0];
    out.push({k:'sol:'+sig+':'+mint, t, ch:'sol', tok:mint, amt:inn, from:src?src.owner:payer, tx:sig}); }
  return out;
}

/* one Blockscout item as a transfer into the address, or null */
function ethRow(kind, it, addr){
  const t=Date.parse(it.timestamp); if(!(t>0)) return null;
  if(kind==='tok'){ if(String(it.to&&it.to.hash).toLowerCase()!==addr) return null;
    const dec=Number(it.total&&it.total.decimals!=null?it.total.decimals:it.token&&it.token.decimals)||0, v=it.total&&it.total.value;
    if(v==null) return null; const amt=Number(v)/10**dec; if(!(amt>0)) return null;
    return {k:'eth:'+it.transaction_hash+':'+(it.log_index??''), t, ch:'eth', tok:String(it.token&&it.token.address_hash||it.token&&it.token.address||'').toLowerCase(), sym:it.token&&it.token.symbol||null, amt, from:String(it.from&&it.from.hash).toLowerCase(), tx:it.transaction_hash}; }
  if(String(it.to&&it.to.hash).toLowerCase()!==addr||it.status&&it.status!=='ok') return null;
  const amt=Number(it.value||0)/1e18; if(!(amt>0)) return null;
  return {k:'eth:'+it.hash+':native', t, ch:'eth', tok:'native', sym:'ETH', amt, from:String(it.from&&it.from.hash).toLowerCase(), tx:it.hash};
}

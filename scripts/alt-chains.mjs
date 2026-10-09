/* Wallet holdings on Sui and Tron, as rows for the idle-balance list.

   Each row is {addr, symbol, name, decimals, amount, llama, staked?}: `llama` is the DefiLlama coin
   key the relay prices it with (the same feed as the EVM side). Staked balances are their own rows
   with the token's address, so the token exposure counts them as the token and the wallet list
   can still tell them apart. A read that fails throws: an unanswered wallet is not an empty one. */

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJ(url, opt={}){
  let last;
  for(let i=0;i<3;i++){
    try{ const r=await fetch(url,{...opt, signal:AbortSignal.timeout(20000)});
      if(r.status===429){ last=new Error('HTTP 429'); await sleep(2500*(i+1)); continue; }
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json(); }
    catch(e){ last=e; await sleep(700*(i+1)); }
  }
  throw last;
}

/* ---------- Sui ---------- */
// Sui's own public fullnode stopped answering JSON-RPC (it serves gRPC/GraphQL now); these still do
const SUI_RPCS=['https://sui-mainnet.blockvision.org','https://sui-mainnet-endpoint.blockvision.org','https://sui-rpc.publicnode.com'];
export async function sui(method, params){
  let last;
  for(const u of SUI_RPCS){
    try{ const j=await getJ(u,{method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      if(j.error) throw new Error(j.error.message||'rpc error');
      return j.result; }
    catch(e){ last=e; }
  }
  throw last;
}
const SUI_TYPE='0x2::sui::SUI';
const suiMeta={};
const fullType=t=>t.replace(/^0x0*2::/,'0x2::');
export async function suiHoldings(owner){
  const rows=[];
  const bal=await sui('suix_getAllBalances',[owner]);
  for(const b of bal||[]){
    const type=fullType(b.coinType), raw=BigInt(b.totalBalance||'0'); if(raw<=0n) continue;
    if(!(type in suiMeta)){ try{ suiMeta[type]=await sui('suix_getCoinMetadata',[b.coinType]); }catch(e){ suiMeta[type]=null; } }
    const m=suiMeta[type], dec=m&&m.decimals!=null?m.decimals:(type===SUI_TYPE?9:null);
    rows.push({addr:type, symbol:m&&m.symbol||(type===SUI_TYPE?'SUI':null), name:m&&m.name||null, decimals:dec,
      amount:dec!=null?Number(raw)/10**dec:null, llama:type===SUI_TYPE?'coingecko:sui':'sui:'+type});
  }
  /* native staking: principal plus the reward earned so far, per validator; a pending stake counts */
  const st=await sui('suix_getStakes',[owner]);
  let mist=0n;
  for(const v of st||[]) for(const s of v.stakes||[]) mist+=BigInt(s.principal||'0')+BigInt(s.estimatedReward||'0');
  if(mist>0n) rows.push({addr:SUI_TYPE, symbol:'SUI', name:'SUI staked with validators', decimals:9, amount:Number(mist)/1e9, llama:'coingecko:sui', staked:true});
  rows.push(...await suiLockedRows(owner));
  return rows.filter(r=>r.amount==null||r.amount>0);
}

/* Value held as receipts rather than coins: IKA staked with Ika's validators (a StakedIka object),
   and what is locked in Ika's Ink Sack tasks (LockedStakedIka wraps a StakedIka; LockedISUI holds
   an iSUI balance). Each is a staked row of the token it holds. iSUI is Ika's staked SUI and is
   valued as SUI, which it redeems for at no less than one to one. */
export const IKA_TYPE='0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA';
const INK='0x7de6bc92a5b7e07d09faecbff30f4c0ef751b97cafbd29fef8898a822a325d27';
export const INK_LOCKS={1:'1 day',7:'7 days',30:'30 days'};
export async function suiOwned(owner){
  const out=[]; let cursor=null;
  for(let i=0;i<40;i++){
    const r=await sui('suix_getOwnedObjects',[owner,{options:{showType:true,showContent:true}},cursor,50]);
    for(const o of r.data||[]) if(o.data) out.push(o.data);
    if(!r.hasNextPage) break; cursor=r.nextCursor;
  }
  return out;
}
async function suiLockedRows(owner){
  const rows=[]; let ika=0, inkIka=0, inkIsui=0;
  for(const o of await suiOwned(owner)){
    const t=String(o.type||''), f=(o.content&&o.content.fields)||{};
    if(/::staked_ika::StakedIka$/.test(t)) ika+=Number(f.principal||0)/1e9;
    else if(t===INK+'::tasks::LockedStakedIka'){ const sf=(f.staked_ika&&f.staked_ika.fields)||{}; inkIka+=Number(sf.principal||0)/1e9; }
    else if(t===INK+'::tasks::LockedISUI') inkIsui+=Number(f.current_balance||0)/1e9;
  }
  if(ika>0) rows.push({addr:IKA_TYPE, symbol:'IKA', name:'IKA staked with validators', decimals:9, amount:ika, llama:'sui:'+IKA_TYPE, staked:true});
  if(inkIka>0) rows.push({addr:IKA_TYPE, symbol:'IKA', name:'IKA staked, locked in Ink Sack', decimals:9, amount:inkIka, llama:'sui:'+IKA_TYPE, staked:true});
  if(inkIsui>0) rows.push({addr:SUI_TYPE, symbol:'iSUI', name:'iSUI locked in Ink Sack (valued as SUI)', decimals:9, amount:inkIsui, llama:'coingecko:sui', staked:true});
  return rows;
}

/* The Ink Sack (Ika's tasks) record of one wallet: drizzlets, what is staked or locked there and
   for how long, and the IKA drop. Read once a day; null when the wallet never took part. */
const INK_USERS='0x158d0859a940c2ef3b09fbb0b77ccbececcb01fa0142c5fac67bc4581c5fbe7f';
export async function inkSack(owner){
  let rec=null;
  try{ const r=await sui('suix_getDynamicFieldObject',[INK_USERS,{type:'address',value:owner}]); rec=r&&r.data&&r.data.content&&r.data.content.fields; }catch(e){}
  const objs=await suiOwned(owner);
  const out={drizzlets:null, nftsStaked:0, isui:[], ika:[], drop:null};
  if(rec){ const v=rec.value&&rec.value.fields?rec.value.fields:rec; out.drizzlets=v.drizzlets_earned!=null?Number(v.drizzlets_earned):null; }
  for(const o of objs){
    const t=String(o.type||''), f=(o.content&&o.content.fields)||{};
    if(t===INK+'::tasks::StakedIkaChanNft') out.nftsStaked++;
    else if(t===INK+'::tasks::LockedISUI') out.isui.push({amount:Number(f.current_balance||0)/1e9, since:Number(f.start_time_ts)||null});
    else if(t===INK+'::tasks::LockedStakedIka'){ const sf=(f.staked_ika&&f.staked_ika.fields)||{}, d=Number(f.stake_period);
      out.ika.push({amount:Number(sf.principal||0)/1e9, period:INK_LOCKS[d]||'until the season ends', days:d, since:Number(f.start_time_ts)||null}); }
    else if(/::distribution::IKADrop$/.test(t)){
      const h=(f.claim_history||[]).map(x=>x.fields||x);
      out.drop={left:Number(f.amount||0)/1e9, claimed:Number(f.claimed||0)/1e9, lastClaim:h.length?Number(h[h.length-1].timestamp_ms)||null:null, humanId:!!f.human_id_required}; }
  }
  return rec||out.nftsStaked||out.isui.length||out.ika.length||out.drop?out:null;
}

/* ---------- Tron ---------- */
const TRONGRID='https://api.trongrid.io';
const USDT_TRON='TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const trcMeta={};
async function trc20Meta(contract){
  if(contract in trcMeta) return trcMeta[contract];
  let m=null;
  try{ const j=await getJ('https://coins.llama.fi/prices/current/tron:'+contract); const c=j.coins&&j.coins['tron:'+contract];
    if(c) m={symbol:c.symbol||null, decimals:c.decimals!=null?c.decimals:null}; }catch(e){}
  if(!m&&contract===USDT_TRON) m={symbol:'USDT', decimals:6};
  return trcMeta[contract]=m;
}
export async function tronHoldings(addr){
  const j=await getJ(TRONGRID+'/v1/accounts/'+addr);
  const a=(j.data||[])[0]; if(!a) return [];          // an account never activated holds nothing
  const rows=[];
  const trx=Number(a.balance||0)/1e6;
  if(trx>0) rows.push({addr:'TRX', symbol:'TRX', name:'TRX', decimals:6, amount:trx, llama:'coingecko:tron'});
  /* Stake 2.0: frozen for bandwidth/energy, delegated to others (still owned), and unstaking
     (waiting out the 14 days) — all still the wallet's TRX */
  let sun=0;
  for(const f of a.frozenV2||[]) sun+=Number(f.amount||0);
  for(const u of a.unfrozenV2||[]) sun+=Number(u.unfreeze_amount||0);
  sun+=Number(a.delegated_frozenV2_balance_for_bandwidth||0);
  sun+=Number((a.account_resource&&a.account_resource.delegated_frozenV2_balance_for_energy)||0);
  for(const f of a.frozen||[]) sun+=Number(f.frozen_balance||0);            // Stake 1.0, if any is left
  if(a.account_resource&&a.account_resource.frozen_balance_for_energy) sun+=Number(a.account_resource.frozen_balance_for_energy.frozen_balance||0);
  if(sun>0) rows.push({addr:'TRX', symbol:'TRX', name:'TRX staked', decimals:6, amount:sun/1e6, llama:'coingecko:tron', staked:true});
  for(const o of a.trc20||[]) for(const [contract, rawS] of Object.entries(o)){
    const raw=BigInt(rawS||'0'); if(raw<=0n) continue;
    const m=await trc20Meta(contract);
    rows.push({addr:contract, symbol:m&&m.symbol||null, name:null, decimals:m&&m.decimals!=null?m.decimals:null,
      amount:m&&m.decimals!=null?Number(raw)/10**m.decimals:null, llama:'tron:'+contract});
  }
  return rows;
}

/* NFTs held by the deck's wallets, and what the market would pay for them.

   Solana: Magic Eden lists a wallet's NFTs with their collection, and its collection stats give the
   floor (the cheapest listing), in SOL. Ethereum: Magic Eden's EVM API lists a wallet's tokens with
   the collection's floor in dollars. Sui: the chain itself lists every object a wallet owns, and an
   object with a display (a name and an image) is an NFT; Sui's marketplace data (TradePort) needs
   an API key, so a Sui NFT is listed without a floor until one is set (TRADEPORT_KEY/USER).
   A collection without a floor is shown without a value — most of those are airdropped spam,
   and "no market" is not the same as "worth nothing" or "worth something". */

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getJ(url, opt={}, tries=3){
  let last;
  for(let i=0;i<tries;i++){
    try{ const r=await fetch(url,{...opt, signal:AbortSignal.timeout(20000)});
      if(r.status===429){ await sleep(3000*(i+1)); last=new Error('HTTP 429'); continue; }
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json(); }
    catch(e){ last=e; await sleep(800*(i+1)); }
  }
  throw last;
}
const ME='https://api-mainnet.magiceden.dev';
const SUI_RPC='https://fullnode.mainnet.sui.io:443';

/* ---------- Solana ---------- */
async function solNfts(wallet){
  const out=[];
  for(let off=0; off<5000; off+=500){
    const page=await getJ(ME+'/v2/wallets/'+wallet+'/tokens?offset='+off+'&limit=500');
    if(!Array.isArray(page)) throw new Error('unexpected answer');
    for(const t of page) out.push({id:t.mintAddress, name:t.name||null, col:t.collection||null, colName:t.collectionName||null, image:t.image||null});
    if(page.length<500) break;
    await sleep(600);
  }
  return out;
}
const solFloorCache={};
async function solFloor(symbol){
  if(symbol in solFloorCache) return solFloorCache[symbol];
  let v=null;
  try{ const s=await getJ(ME+'/v2/collections/'+encodeURIComponent(symbol)+'/stats');
    v={floor:s.floorPrice!=null?s.floorPrice/1e9:null, listed:s.listedCount??null}; }catch(e){ v={err:String(e.message||e)}; }
  await sleep(600);
  return solFloorCache[symbol]=v;
}

/* ---------- Ethereum ----------
   Blockscout lists what a wallet holds (ERC-721 and ERC-1155) with each contract's reputation, free
   and without a key. It has no floor price; Ethereum NFTs are listed without one until a market
   source with a key is set. */
const BLOCKSCOUT='https://eth.blockscout.com/api/v2';
async function ethNfts(wallet){
  const out=[]; let next=null;
  for(let i=0;i<20;i++){
    const q=next?'&'+new URLSearchParams(next).toString():'';
    const j=await getJ(BLOCKSCOUT+'/addresses/'+wallet+'/nft?type=ERC-721,ERC-1155'+q);
    for(const x of j.items||[]){ const t=x.token||{};
      out.push({id:(t.address_hash||t.address)+':'+x.id, name:(x.metadata&&x.metadata.name)||null, col:String(t.address_hash||t.address||'').toLowerCase(),
        colName:t.name||t.symbol||null, n:Number(x.value||1)||1, floorUsd:null, floorNative:null, spam:t.reputation!=null&&t.reputation!=='ok'}); }
    next=j.next_page_params; if(!next) break; await sleep(400);
  }
  return out;
}

/* Ethereum floors from OpenSea, when an API key is set (the OPENSEA_API_KEY secret): the contract
   names its collection, and the collection's stats give the floor in ETH. */
const OS_KEY=String(process.env.OPENSEA_API_KEY||'').trim();
const osSlug={}, osFloor={};
async function openseaFloor(contract){
  if(!OS_KEY) return null;
  const h={headers:{'x-api-key':OS_KEY, accept:'application/json'}};
  if(!(contract in osSlug)){ try{ const j=await getJ('https://api.opensea.io/api/v2/chain/ethereum/contract/'+contract,h); osSlug[contract]=j.collection||null; }catch(e){ osSlug[contract]=null; } await sleep(300); }
  const slug=osSlug[contract]; if(!slug) return null;
  if(!(slug in osFloor)){ try{ const j=await getJ('https://api.opensea.io/api/v2/collections/'+encodeURIComponent(slug)+'/stats',h);
      const t=j.total||{}; osFloor[slug]=t.floor_price!=null&&/^W?ETH$/i.test(t.floor_price_symbol||'ETH')?Number(t.floor_price):null; }catch(e){ osFloor[slug]=null; } await sleep(300); }
  return osFloor[slug];
}
export const openseaOn=()=>!!OS_KEY;

/* ---------- Sui ---------- */
// Sui's own fullnode no longer answers JSON-RPC; these do
const SUI_RPCS=['https://sui-mainnet.blockvision.org','https://sui-mainnet-endpoint.blockvision.org','https://sui-rpc.publicnode.com'];
async function suiRpc(method, params){
  let last;
  for(const u of SUI_RPCS){
    try{ const j=await getJ(u,{method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      if(j.error) throw new Error(j.error.message||'rpc error');
      return j.result; }
    catch(e){ last=e; }
  }
  throw last;
}
// what a wallet owns that is not a plain coin balance; staking and pool positions are counted apart
const SUI_NOT_NFT=/::staking_pool::StakedSui$|::coin::Coin<|::position::Position$|::pool::Position$|::kiosk::KioskOwnerCap$|::obligation::|::lending::|::account::/;
async function suiObjects(wallet){
  const out=[], kiosks=[]; let cursor=null;
  for(let i=0;i<40;i++){
    // no server-side filter (nodes differ on what they accept): coins are skipped here instead
    const r=await suiRpc('suix_getOwnedObjects',[wallet,{options:{showType:true,showDisplay:true,showContent:true}},cursor,50]);
    for(const o of r.data||[]){ const d=o.data||{}, disp=d.display&&d.display.data;
      if(/^0x0*2::coin::Coin</.test(d.type||'')) continue;
      // a kiosk is where most Sui NFTs live: its owner holds only the cap, the NFTs sit in the kiosk
      if(/::kiosk::KioskOwnerCap$|::personal_kiosk::PersonalKioskCap$/.test(d.type||'')){ const f=(d.content&&d.content.fields)||{};
        const k=f.for||(f.cap&&f.cap.fields&&f.cap.fields.for); if(k) kiosks.push(k); continue; }
      out.push({id:d.objectId, type:d.type||'', name:disp&&disp.name||null, image:disp&&(disp.image_url||disp.img_url)||null, display:!!disp}); }
    if(!r.hasNextPage) break; cursor=r.nextCursor;
  }
  for(const k of kiosks){ let c=null;
    for(let i=0;i<40;i++){ const r=await suiRpc('suix_getDynamicFields',[k,c,50]);
      for(const f of r.data||[]) if(/::kiosk::Item$/.test(String(f.name&&f.name.type||''))&&f.objectType)
        out.push({id:f.objectId, type:f.objectType, name:null, display:true, kiosk:true});
      if(!r.hasNextPage) break; c=r.nextCursor; } }
  // one name per kiosk collection, from the first item's display
  const named=new Set(out.filter(o=>o.name).map(o=>o.type));
  for(const o of out) if(o.kiosk&&!named.has(o.type)){ named.add(o.type);
    try{ const g=await suiRpc('sui_getObject',[o.id,{showDisplay:true}]); const disp=g&&g.data&&g.data.display&&g.data.display.data; if(disp&&disp.name) o.name=disp.name; }catch(e){} }
  return out;
}
export function suiKind(o){
  if(/::staking_pool::StakedSui$/.test(o.type)) return 'stake';
  if(SUI_NOT_NFT.test(o.type)) return 'defi';
  return o.display?'nft':'other';
}

/* LP position receipts: the NFT a DEX mints for each liquidity position (Uniswap, Raydium, Orca and
   the like). What one is worth is the liquidity and fees inside it, which POSITION MODULES already
   counts; a collection "floor" for them is the price of somebody's random position, often an empty
   one, and adding it here would count the same money twice. They are listed, never valued. */
const LP_CONTRACTS=new Set([
  '0xc36442b4a4522e871399cd717abdd847ab11fe88',   // Uniswap V3 positions
  '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',   // Uniswap V4 positions
  '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',   // PancakeSwap V3 positions
  '0x2214a42d8e2a1d20635c2cb0664422c528b6a432',   // SushiSwap V3 positions
]);
const LP_NAME=/positions? nft|liquidity position|lp position|whirlpool position|concentrated liquidity|clmm position|dlmm position/i;
export const isLpReceipt=c=>LP_CONTRACTS.has(String(c.key||'').toLowerCase())||LP_NAME.test(String(c.name||''));

/* ---------- all wallets ---------- */
export async function scanNfts(wallets, px={}){
  const res={t:Date.now(), wallets:[], errors:[]};
  for(const w of wallets){
    const row={chain:w.chain, address:w.address, items:[], cols:{}, ok:true};
    try{
      if(w.chain==='solana'){
        const items=await solNfts(w.address);
        for(const it of items){ const k=it.col||'(none)';
          const c=row.cols[k]||(row.cols[k]={key:k, name:it.colName||it.col||null, n:0, floor:null, unit:'SOL'}); c.n++; }
        for(const c of Object.values(row.cols)) if(isLpReceipt(c)) c.lp=true;
        for(const c of Object.values(row.cols)) if(c.key!=='(none)'&&!c.lp){ const f=await solFloor(c.key);
          if(f&&f.floor!=null){ c.floor=f.floor; c.floorUsd=px.sol!=null?f.floor*px.sol:null; c.listed=f.listed; } }
        row.items=items;
      } else if(w.chain==='ethereum'){
        const items=await ethNfts(w.address.startsWith('0x')?w.address:'0x'+w.address);
        for(const it of items){ const c=row.cols[it.col]||(row.cols[it.col]={key:it.col, name:it.colName, n:0, floor:it.floorNative, floorUsd:it.floorUsd, unit:'ETH', spam:it.spam}); c.n+=it.n; }
        for(const c of Object.values(row.cols)) if(isLpReceipt(c)) c.lp=true;
        for(const c of Object.values(row.cols)) if(!c.spam&&!c.lp){ const f=await openseaFloor(c.key);
          if(f!=null&&f>0){ c.floor=f; c.floorUsd=px.eth!=null?f*px.eth:null; } }
        row.items=items;
      } else if(w.chain==='sui'){
        const objs=await suiObjects(w.address);
        row.sui={stake:0, defi:0, other:0};
        for(const o of objs){ const k=suiKind(o); if(k!=='nft'){ row.sui[k]++; continue; }
          const col=o.type.replace(/<.*$/,'');
          const c=row.cols[col]||(row.cols[col]={key:col, name:null, n:0, floor:null, unit:'SUI'}); c.n++;
          if(!c.name&&o.name) c.name=String(o.name).replace(/\s*#?\d+$/,'');
          row.items.push(o); }
      } else { row.skipped=true; }
    }catch(e){ row.ok=false; res.errors.push(w.chain+': '+String(e.message||e).slice(0,80)); }
    for(const c of Object.values(row.cols)){ if(c.lp||isLpReceipt(c)){ c.lp=true; c.floor=null; c.floorUsd=null; } c.valueUsd=c.floorUsd!=null?c.floorUsd*c.n:null; }
    res.wallets.push(row);
  }
  return res;
}

/* What the page shows: collections across all wallets, with counts and floors, and how many wallets
   of each chain could be read. No wallet address and no single item travels. */
export function nftSummary(res){
  const cols=new Map(), read={};
  for(const w of res.wallets){
    const r=read[w.chain]||(read[w.chain]=[0,0]); r[1]++; if(w.ok) r[0]++;
    for(const c of Object.values(w.cols)){
      const k=w.chain+':'+c.key, e=cols.get(k)||{chain:w.chain, key:c.key, name:c.name||null, n:0, floor:c.floor??null, unit:c.unit, floorUsd:c.floorUsd??null, listed:c.listed??null, spam:!!c.spam, lp:!!c.lp, wallets:0};
      e.n+=c.n; e.wallets++; cols.set(k,e);
    }
  }
  const list=[...cols.values()].map(c=>({...c, valueUsd:c.floorUsd!=null?Math.round(c.floorUsd*c.n*100)/100:null}))
    .sort((a,b)=>(b.valueUsd??-1)-(a.valueUsd??-1)||b.n-a.n);
  return {v:3, t:res.t, cols:list, read, totalUsd:Math.round(list.reduce((s,c)=>s+(c.valueUsd||0),0)*100)/100,
          errors:res.errors.map(e=>String(e).split(':')[0])};
}

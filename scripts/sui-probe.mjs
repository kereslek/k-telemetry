/* What TradePort's wallet page asks for, wallet by wallet, so the daily Sui read can tell a wallet it
   read from one it could not: which operations answered and how many collections and NFTs each
   counted (the wallet stats, the visible inventory, the owned collections, the items' collections,
   the hidden count). Wallets go by their place in the list.

   Run inside a gh-pages checkout. The log is public: operation names, counts and yes/no only — never
   a wallet, a collection, an id or an amount. */
import {chromium} from 'playwright';
import {initLock, readJ} from './lock.mjs';
const OUT='deck-r7k4x9';
initLock(OUT);
const cfg=readJ(OUT+'/config.json');
const wallets=cfg.profiles.flatMap(p=>[...(p.wallets||[]),...(p.altWallets||[])]).filter(w=>w.chain==='sui');
const opName=s=>String(s||'(none)').replace(/_sui_.*$/,'_sui_…').replace(/[0-9a-f]{8}[-_][0-9a-f]{4}[-_].*$/i,'…');
const sui=x=>(x&&x.data&&x.data.sui)||{};
const num=v=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<1e6?v:null;   // a count, nothing that could be an id or an amount
const b=await chromium.launch(), ctx=await b.newContext({viewport:{width:1300,height:1000}});
for(const [i,w] of wallets.entries()){
  const got={}, pg=await ctx.newPage();
  pg.on('response',async r=>{ if(!/graphql\.tradeport/.test(r.url())) return;
    try{ const op=(JSON.parse(r.request().postData()||'{}').operationName)||'(none)'; const j=await r.json(); (got[op]=got[op]||[]).push(j); }catch(e){} });
  try{ await pg.goto('https://www.tradeport.xyz/sui/'+w.address+'?tab=items',{waitUntil:'domcontentloaded',timeout:60000}); }catch(e){}
  await pg.waitForTimeout(25000);
  await pg.close();
  const ops=[...new Set(Object.keys(got).map(opName))].sort();
  const st=sui((got.fetchWalletStats||[])[0]).new_wallet_stats, cs=(st&&st.collection_stats)||[];
  const held=cs.filter(c=>Number(c&&c.wallet_stats&&c.wallet_stats.holdings_count)>0);
  const inv=(got.fetchWalletInventoryWithListings||[]).flatMap(j=>sui(j).nfts||[]).filter(Boolean);
  const invCols=new Set(inv.map(x=>x.collection&&x.collection.id).filter(Boolean));
  const owned=new Set((got.fetchWalletOwnedCollections||[]).flatMap(j=>sui(j).collections||[]).map(c=>c&&c.id).filter(Boolean));
  const items=new Set((got.fetchWalletItemsCollections||[]).flatMap(j=>sui(j).collections||[]).map(c=>c&&c.id).filter(Boolean));
  // how many held collections each other answer covers, and how many NFTs sit in the ones it leaves out
  const cover=set=>held.filter(c=>set.has(c.collection_id)).length, outside=set=>held.filter(c=>!set.has(c.collection_id)).reduce((a,c)=>a+Number(c.wallet_stats.holdings_count),0);
  const hidden=(got.fetchHiddenNftsCount||[]).map(j=>{ const s=sui(j); for(const v of Object.values(s)){ const n=num(v&&v.aggregate&&v.aggregate.count)??num(v&&v.count)??num(v); if(n!=null) return n; } return null; })[0];
  console.log('wallet '+(i+1)+' of '+wallets.length+': operations '+(ops.join(', ')||'none'));
  console.log('   stats: '+(st?'yes · held collections '+held.length+' · NFTs '+held.reduce((a,c)=>a+Number(c.wallet_stats.holdings_count),0)+' · holdings_count (wallet) '+(st.holdings_count??'—'):'NO')
    +' · inventory: '+(got.fetchWalletInventoryWithListings?inv.length+' NFTs in '+invCols.size+' collections over '+got.fetchWalletInventoryWithListings.length+' page(s)':'NO')
    +' · owned collections: '+(got.fetchWalletOwnedCollections?owned.size:'NO')+' · items’ collections: '+(got.fetchWalletItemsCollections?items.size:'NO')
    +' · hidden: '+(hidden==null?'—':hidden));
  if(held.length) console.log('   held collections covered by the owned list '+cover(owned)+' (NFTs outside it '+outside(owned)+') · by the inventory '+cover(invCols)+' (outside '+outside(invCols)+') · by the items’ list '+cover(items)+' (outside '+outside(items)+')');
}
await b.close();

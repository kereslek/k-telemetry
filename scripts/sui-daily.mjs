/* Once a day: the Sui wallets' NFTs as TradePort prices them, and their Ink Sack (Ika tasks) record.

   TradePort has no open API, but its own wallet page loads everything it shows from its data
   service: the collections a wallet holds with each one's floor, which NFT belongs to which, the
   wallet's value and the SUI/USD rate. A browser opens each wallet's page the way a person would,
   once a day, and keeps those answers. The Ink Sack record is read from the chain (alt-chains.mjs).

   Output: deck-r7k4x9/sui-daily.json, sealed like every other data file. This log is public:
   counts, ratios and yes/no only — never a wallet, a collection or an amount. */
import {chromium} from 'playwright';
import {initLock, readJ, writeJ} from './lock.mjs';
import {inkSack} from './alt-chains.mjs';
const OUT='deck-r7k4x9';
initLock(OUT);
const cfg=readJ(OUT+'/config.json');
const wallets=cfg.profiles.flatMap(p=>[...(p.wallets||[]),...(p.altWallets||[])]).filter(w=>w.chain==='sui');
const tail=a=>String(a).slice(-4);
const res={t:Date.now(), tp:{ok:false, rate:null, wallets:[]}, ink:[]};
console.log('sui wallets: '+wallets.length);

const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1300,height:1000}, userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'});
for(const w of wallets){
  const got={}, pg=await ctx.newPage();
  pg.on('response',async r=>{ if(!/graphql\.tradeport/.test(r.url())) return;
    try{ const op=(JSON.parse(r.request().postData()||'{}').operationName)||''; const j=await r.json(); (got[op]=got[op]||[]).push(j); }catch(e){} });
  let ok=false;
  for(let k=0;k<2&&!ok;k++){
    try{ await pg.goto('https://www.tradeport.xyz/sui/'+w.address+'?tab=items',{waitUntil:'domcontentloaded',timeout:60000}); }catch(e){}
    for(let s=0;s<30&&!(got.fetchWalletItemsCollections&&got.fetchOwnedCollectionAndNftIds&&got.fetchWalletStats);s++) await pg.waitForTimeout(1000);
    ok=!!(got.fetchOwnedCollectionAndNftIds);
  }
  await pg.close();
  const row={tail:tail(w.address), ok, n:0, value:null, usd:null, cols:[]};
  if(ok){
    const sui=x=>(x&&x.data&&x.data.sui)||{};
    const held={}, ntype={}; for(const j of got.fetchOwnedCollectionAndNftIds||[]) for(const h of sui(j).wallet_holdings||[]) if(!(h.nft&&h.nft.burned)){ held[h.collection_id]=(held[h.collection_id]||0)+1;
      const t=h.collection&&h.collection.chain_state&&h.collection.chain_state.nft_type; if(t&&!ntype[h.collection_id]) ntype[h.collection_id]=String(t); }
    const cols={}; for(const j of got.fetchWalletItemsCollections||[]) for(const c of sui(j).collections||[]) cols[c.id]=c;
    for(const [id,n] of Object.entries(held)){ const c=cols[id]||{};
      // floors come in MIST (1e-9 SUI); a floor already in SUI would be far below a million
      const f=c.floor!=null?Number(c.floor):null;
      row.cols.push({id, slug:c.slug||null, title:c.title||null, type:ntype[id]||null, n, floor:f==null?null:(f>1e5?f/1e9:f)}); row.n+=n; }
    const st=sui((got.fetchWalletStats||[])[0]).new_wallet_stats;
    if(st){ row.value=st.value!=null?Number(st.value)/1e9:null; row.usd=st.usd_value!=null?Number(st.usd_value):null; }
    for(const j of got.cached_fetchCryptoUSDRates||[]) for(const r of sui(j).crypto_rates||[]) if(/^sui$/i.test(r.crypto)&&/usd/i.test(r.fiat)) res.tp.rate=Number(r.rate);
  }
  res.tp.wallets.push(row);
  const fl=row.cols.reduce((a,c)=>a+(c.floor||0)*c.n,0);
  console.log('a wallet on TradePort: '+(ok?'read':'NOT READ')+' · NFTs '+row.n+' · collections '+row.cols.length+' · with a floor '+row.cols.filter(c=>c.floor>0).length
    +(row.value>0?' · sum of floors vs TradePort’s wallet value: '+(fl/row.value).toFixed(2):''));
}
await b.close();
res.tp.ok=res.tp.wallets.some(x=>x.ok);
console.log('SUI/USD rate from TradePort: '+(res.tp.rate>0?'yes':'no'));

for(const w of wallets){
  try{ const r=await inkSack(w.address); if(r){ res.ink.push({tail:tail(w.address), ...r});
      console.log('a wallet in Ink Sack: drizzlets '+(r.drizzlets!=null?'yes':'no')+' · NFTs staked '+r.nftsStaked+' · iSUI locks '+r.isui.length+' · IKA locks '+r.ika.length+' · IKA drop '+(r.drop?'yes':'no')); } }
  catch(e){ console.log('Ink Sack read failed for a wallet: '+String(e.message||e).slice(0,60)); res.inkErr=true; }
}
writeJ(OUT+'/sui-daily.json', res);
if(!res.tp.ok) { console.log('TradePort could not be read for any wallet'); process.exitCode=1; }

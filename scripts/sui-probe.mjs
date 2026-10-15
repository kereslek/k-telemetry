/* Why the daily Sui read stopped getting TradePort's answers (every run since 10 Oct reads "NOT READ"):
   TradePort's wallet page no longer asks its data service for fetchOwnedCollectionAndNftIds, the
   answer the daily job waits for. This opens one Sui wallet's page the way sui-daily.mjs does and
   prints the SHAPE of the answers the page now gets: field names, types and list lengths.

   Run inside a gh-pages checkout. The log is public: field names, types and counts only — never a
   value, a wallet, a collection, an id or an amount. A field name that looks like an id prints as <id>. */
import {chromium} from 'playwright';
import {initLock, readJ} from './lock.mjs';
const OUT='deck-r7k4x9';
initLock(OUT);
const cfg=readJ(OUT+'/config.json');
const wallets=cfg.profiles.flatMap(p=>[...(p.wallets||[]),...(p.altWallets||[])]).filter(w=>w.chain==='sui');
const w=wallets[0];
if(!w){ console.log('no Sui wallet in the config'); process.exit(1); }
console.log('sui wallets: '+wallets.length+' · probing one');
const WANT=/^(fetchWalletOwnedCollections|fetchWalletInventoryWithListings|fetchWalletItemsCollections|fetchWalletStats|cached_fetchCryptoUSDRates)$/;
// an operation name keeps its plain part only (some carry a collection's id after it)
const opName=s=>String(s||'(none)').replace(/_sui_.*$/,'_sui_…').replace(/[0-9a-f]{8}[-_][0-9a-f]{4}[-_].*$/i,'…');
const keyName=k=>/^\d+$/.test(k)||/[0-9a-f]{8}[-_]?[0-9a-f]{4}/i.test(k)||/0x[0-9a-f]{6,}/i.test(k)||/\d{5,}/.test(k)||k.length>40||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)?'<id>':k;
// the shape of a value: types, field names and list lengths, never the values themselves
function shape(v, d=0){
  if(v===null) return 'null';
  if(Array.isArray(v)){ if(!v.length) return '[0]';
    const merged={}; for(const x of v.slice(0,50)) if(x&&typeof x==='object'&&!Array.isArray(x)) Object.assign(merged, x);
    return '['+v.length+']'+(Object.keys(merged).length?shape(merged,d+1):typeof v[0]); }
  if(typeof v==='object'){ if(d>6) return '{…}';
    const ks=Object.keys(v); return '{'+ks.slice(0,30).map(k=>keyName(k)+':'+shape(v[k],d+1)).join(', ')+(ks.length>30?', …'+(ks.length-30)+' more':'')+'}'; }
  return typeof v;
}
const b=await chromium.launch(), ctx=await b.newContext({viewport:{width:1300,height:1000}}), pg=await ctx.newPage();
const seen={}, others={};
pg.on('response', async r=>{ if(!/graphql\.tradeport/.test(r.url())) return;
  let op='(none)'; try{ op=JSON.parse(r.request().postData()||'{}').operationName||'(none)'; }catch(e){}
  if(!WANT.test(op)){ const o=opName(op); others[o]=(others[o]||0)+1; return; }
  try{ const j=await r.json(); (seen[op]=seen[op]||[]).push(shape(j)); }catch(e){ (seen[op]=seen[op]||[]).push('not json'); } });
try{ await pg.goto('https://www.tradeport.xyz/sui/'+w.address+'?tab=items',{waitUntil:'domcontentloaded',timeout:60000}); }catch(e){ console.log('navigation failed'); }
await pg.waitForTimeout(25000);
await b.close();
console.log('other operations: '+Object.entries(others).map(([k,n])=>k+' ×'+n).join(', '));
for(const [op,ss] of Object.entries(seen)) for(const [i,s] of ss.entries()) console.log('== '+op+(ss.length>1?' #'+(i+1):'')+'\n   '+s);
for(const op of ['fetchWalletOwnedCollections','fetchWalletInventoryWithListings','fetchWalletItemsCollections','fetchWalletStats','cached_fetchCryptoUSDRates'])
  if(!seen[op]) console.log('== '+op+': not asked for');

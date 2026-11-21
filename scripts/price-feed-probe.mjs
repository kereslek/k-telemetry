/* Do the Solana price feeds answer? Jupiter (price v3) and DefiLlama, for SOL itself and for the tokens of the
   relay's Solana positions (read from the store's relay file, never printed). The log is public: answer codes,
   counts and the first words of an error only. Run: DECK_PASSPHRASE=… node scripts/price-feed-probe.mjs */
import {storeText} from './store.mjs';
import {open} from './lock.mjs';

const SOL='So11111111111111111111111111111111111111112', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const scrub=s=>String(s).replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g,'…').replace(/0x[0-9a-fA-F]{6,}/g,'0x…').slice(0,160);
async function ask(url){ try{ const r=await fetch(url,{signal:AbortSignal.timeout(20000), headers:{accept:'application/json'}}); const t=await r.text(); let j=null; try{ j=JSON.parse(t); }catch(e){}
  return {st:r.status, j, t}; }catch(e){ return {st:'no answer ('+scrub(e.message||e)+')', j:null, t:''}; } }

const s=await storeText('data-main.json'); const d=s?JSON.parse(open(JSON.parse(s.text))):null;
const mints=d?[...new Set((d.sol||[]).flatMap(p=>[p.mint0,p.mint1]).filter(Boolean))]:[];
console.log('relay file: '+(d?'read, pass '+Math.round((Date.now()-d.t)/60000)+' min old · Solana positions '+(d.sol||[]).length+' · priced '+(d.sol||[]).filter(p=>p.valueUsd!=null).length+' · tokens in them '+mints.length:'NOT read'));
if(d){ const Q=Array.isArray(d.quotes)?d.quotes:[], c=Q.find(q=>q.label==='CPOOL / USD (SOL)');
  console.log('price tiles in the relay file: '+Q.length+' · CPOOL / USD (SOL): '+(c?'yes, from '+c.src:'MISSING')); }
if(d&&d.exch&&d.exch.rows){ const U=d.exch.rows.filter(r=>r.usd==null&&r.kind!=='exchange'); console.log('  exchange record, the exchange\u2019s own (gas, rent): '+d.exch.rows.filter(r=>r.kind==='exchange').length); if(U.length) console.log('  exchange record, unvalued: '+U.length+' ('+U.filter(r=>r.tok==='native').length+' native coin, '+U.filter(r=>r.tok!=='native').length+' token) · on '+[...new Set(U.map(r=>r.ch))].join(', ')); }
if(d&&d.exch&&d.exch.rows){ const by=k=>d.exch.rows.filter(r=>r.kind===k), nat=a=>a.filter(r=>r.tok==='native').length;
  console.log('  exchange record by sender: your wallets '+by('wallet').length+' ('+nat(by('wallet'))+' native coin) · others '+by('other').length+' ('+nat(by('other'))+' native coin, '+new Set(by('other').map(r=>r.src)).size+' senders) · the exchange\u2019s own '+by('exchange').length); }
// the relay's kept record (sealed blockcache): how many addresses the exchange sweeps to are known; counts only
try{ const bc=await storeText('blockcache.json'); const B=bc?JSON.parse(open(JSON.parse(bc.text))):null, C=B&&B.cex?Object.values(B.cex):[];
  for(const [i,st] of C.entries()){ const sw=st&&st.sweep?Object.keys(st.sweep):[];
    console.log('  exchange record '+(i+1)+' kept: version '+(st&&st.v)+' · rows '+((st&&st.rows)||[]).length+' · sweep addresses known '+sw.length+' · accounts read to their start '+Object.values((st&&st.addr)||{}).filter(v=>v.done).length+' of '+Object.keys((st&&st.addr)||{}).length+' · transactions looked at '+Object.keys((st&&st.seen)||{}).length); }
  if(!C.length) console.log('  exchange record kept: none in blockcache'); }catch(e){ console.log('  exchange record kept: not read ('+scrub(e.message||e).slice(0,60)+')'); }
if(d&&d.exch!==undefined){ const X=d.exch; console.log('exchange record: '+(!X?'none':'read '+Math.round((Date.now()-(X.t||0))/60000)+' min ago · addresses '+X.n+' · history read to its start: '+(X.whole?'yes':'not yet')+' · every transfer valued: '+(X.rows.filter(r=>r.kind!=='exchange').every(r=>r.usd!=null)?'yes':'not all'))); }
/* the page cuts every token symbol to letters, digits, currency signs and . _ + - … ? (v40.52): how many of the relay's
   own symbols that changes (a changed one would read differently on the page). Counts only. */
if(d){ const clean=s=>{ const t=String(s==null?'':s).normalize('NFKC').replace(/[^\p{L}\p{N}\p{Sc} ._+\-…?]/gu,'').trim().slice(0,24); return t||'?'; };
  const syms=[...new Set([...(d.eth||[]),...(d.sol||[])].flatMap(p=>[p.m0&&p.m0.symbol, p.m1&&p.m1.symbol]).concat(((d.idle&&d.idle.rows)||[]).map(r=>r&&r.symbol)).filter(x=>x!=null).map(String))];
  console.log('symbols the page\u2019s cleaning would change: '+syms.filter(x=>clean(x)!==x).length+' of '+syms.length);
  // each changed one by kind only, never the symbol: where it sits, whether it carries value, what kind of characters go
  const P=new Set([...(d.eth||[]),...(d.sol||[])].flatMap(p=>[p.m0&&p.m0.symbol, p.m1&&p.m1.symbol]).map(String)), R=((d.idle&&d.idle.rows)||[]);
  syms.filter(x=>clean(x)!==x).forEach((x,i)=>{ const rows=R.filter(r=>String(r.symbol)===x), gone=[...x.normalize('NFKC')].filter(c=>!/[\p{L}\p{N}\p{Sc} ._+\-…?]/u.test(c));
    const kinds=[...new Set(gone.map(c=>/\p{Extended_Pictographic}/u.test(c)?'emoji':/[<>"'&]/.test(c)?'markup':/\s/.test(c)?'space':/\p{P}/u.test(c)?'punctuation':/\p{S}/u.test(c)?'symbol':'other'))];
    console.log('  changed '+(i+1)+': in a position: '+(P.has(x)?'yes':'no')+' · wallet rows: '+rows.length+' · valued: '+(rows.some(r=>(r.usd||0)>0)?'yes':'no')+' · characters cut: '+gone.length+' ('+kinds.join(', ')+')'+(x.length>24?' · longer than 24':'')); }); }
if(d) console.log('relay errors this pass (first word, count): '+Object.entries((d.errors||[]).reduce((a,e)=>{ const k=scrub(typeof e==='string'?e:(e&&(e.k||e.where||e.msg))||'?').split(/[\s:]/)[0].slice(0,24); a[k]=(a[k]||0)+1; return a; },{})).map(([k,n])=>k+' ×'+n).join(', '));

for(const [name,ids] of [['SOL and USDC',[SOL,USDC]],['the positions’ tokens',mints]]){
  if(!ids.length) continue;
  const J=await ask('https://lite-api.jup.ag/price/v3?ids='+ids.join(','));
  const jn=J.j&&typeof J.j==='object'?ids.filter(m=>J.j[m]&&J.j[m].usdPrice!=null).length:0;
  console.log('Jupiter lite-api price v3, '+name+': HTTP '+J.st+' · priced '+jn+' of '+ids.length+(jn<ids.length?' · says: '+scrub(J.t):''));
  const L=await ask('https://coins.llama.fi/prices/current/'+ids.map(m=>'solana:'+m).join(','));
  const ln=L.j&&L.j.coins?ids.filter(m=>L.j.coins['solana:'+m]&&L.j.coins['solana:'+m].price>0).length:0;
  console.log('DefiLlama coins, '+name+': HTTP '+L.st+' · priced '+ln+' of '+ids.length+(ln<ids.length?' · says: '+scrub(L.t):''));
  if(L.j&&L.j.coins) console.log('  DefiLlama confidence and age, each token: '+ids.map(m=>{ const c=L.j.coins['solana:'+m]; return c?(c.confidence!=null?c.confidence.toFixed(2):'—')+' / '+Math.round((Date.now()-c.timestamp*1000)/60000)+' min':'none'; }).join(' · '));
}
// the relay's own Jupiter errors this pass, identifiers taken out
if(d) for(const e of (d.errors||[]).filter(e=>/jup|price/i.test(typeof e==='string'?e:JSON.stringify(e))).slice(0,4)) console.log('  relay said: '+scrub(typeof e==='string'?e:JSON.stringify(e)));
// what a browser on the deck's site is allowed to read (CORS): the page asks these from the visitor's browser
for(const u of ['https://lite-api.jup.ag/price/v3?ids='+SOL, 'https://lite-api.jup.ag/tokens/v2/search?query='+SOL, 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd']){
  try{ const r=await fetch(u,{headers:{origin:'https://kereslek.github.io', accept:'application/json'}, signal:AbortSignal.timeout(20000)});
    console.log('from the deck\u2019s site, '+new URL(u).host+new URL(u).pathname+': HTTP '+r.status+' · browsers allowed: '+(r.headers.get('access-control-allow-origin')||'NO (no allow-origin header)')); }
  catch(e){ console.log('from the deck\u2019s site, '+new URL(u).host+': no answer'); } }
// the Jupiter endpoint that needs a key, to see whether the free one moved there
const P=await ask('https://api.jup.ag/price/v3?ids='+SOL);
console.log('Jupiter api.jup.ag price v3 (no key), SOL: HTTP '+P.st+' · '+scrub(P.t));

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
if(d) console.log('relay errors this pass (first word, count): '+Object.entries((d.errors||[]).reduce((a,e)=>{ const k=scrub(typeof e==='string'?e:(e&&(e.k||e.where||e.msg))||'?').split(/[\s:]/)[0].slice(0,24); a[k]=(a[k]||0)+1; return a; },{})).map(([k,n])=>k+' ×'+n).join(', '));

for(const [name,ids] of [['SOL and USDC',[SOL,USDC]],['the positions’ tokens',mints]]){
  if(!ids.length) continue;
  const J=await ask('https://lite-api.jup.ag/price/v3?ids='+ids.join(','));
  const jn=J.j&&typeof J.j==='object'?ids.filter(m=>J.j[m]&&J.j[m].usdPrice!=null).length:0;
  console.log('Jupiter lite-api price v3, '+name+': HTTP '+J.st+' · priced '+jn+' of '+ids.length+(jn<ids.length?' · says: '+scrub(J.t):''));
  const L=await ask('https://coins.llama.fi/prices/current/'+ids.map(m=>'solana:'+m).join(','));
  const ln=L.j&&L.j.coins?ids.filter(m=>L.j.coins['solana:'+m]&&L.j.coins['solana:'+m].price>0).length:0;
  console.log('DefiLlama coins, '+name+': HTTP '+L.st+' · priced '+ln+' of '+ids.length+(ln<ids.length?' · says: '+scrub(L.t):''));
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

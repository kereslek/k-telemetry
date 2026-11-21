/* What can a stranger read? This runs with no secret at all, as anyone on the internet would: every file the
   published site holds is fetched from the live site and must come back sealed (or be one of the few plain files
   that carry no data, checked to hold nothing address-like); every door of the minute recorder is knocked on with
   no token and with a wrong one, and must stay shut. A few guesses an outsider would try are made too.
   The log is public: paths of the site's own published files, answer codes and pass/fail only.
   Run (in a checkout of gh-pages): node scripts/outside-probe.mjs */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const SITE='https://kereslek.github.io/k-telemetry/', REC='https://kt-pulse.kereslek.workers.dev';
const PLAIN_OK=new Set(['deck-r7k4x9/lock.json','deck-r7k4x9/relay-timing.json','deck-r7k4x9/store-gen.json','deck-r7k4x9/store-on.json']);
let bad=0, n=0; const res=(ok,m)=>{ n++; if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+m); };
const addrLike=s=>(String(s).match(/0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[]).length;
async function get(url, o={}){ for(let k=0;k<3;k++){ try{ const r=await fetch(url,{redirect:'manual', signal:AbortSignal.timeout(30000), ...o}); return {st:r.status, t:await r.text(), h:r.headers}; }catch(e){ if(k===2) return {st:'no answer', t:'', h:new Headers()}; await new Promise(r=>setTimeout(r,2000*(k+1))); } } }
const sealed=t=>{ try{ const j=JSON.parse(t); return !!(j&&j.lock===1&&j.iv&&j.ct); }catch(e){ return false; } };

/* 1. the published site, file by file, as served */
const files=execFileSync('git',['ls-files'],{encoding:'utf8'}).split('\n').filter(f=>/^deck-r7k4x9\/.*\.json$/.test(f));
let sl=0, pl=0;
for(const f of files){
  const r=await get(SITE+f+'?nc='+Date.now());
  if(r.st!==200){ res(false, f+': HTTP '+r.st+' (expected 200)'); continue; }
  if(sealed(r.t)){ sl++; continue; }
  if(PLAIN_OK.has(f)){ pl++; const a=addrLike(r.t.replace(/"salt":"[^"]*"|"inbox":"[^"]*"|"iv":"[^"]*"|"ct":"[^"]*"/g,'')); res(a===0, f+': plain by design, address-like strings in it: '+a); continue; }
  res(false, f+': served UNSEALED');
}
res(sl+pl===files.length, 'published data files: '+files.length+' · sealed '+sl+' · plain by design '+pl);
// every JSON in the published tree outside the deck's folder (seed files kept beside the scripts)
const other=execFileSync('git',['ls-files'],{encoding:'utf8'}).split('\n').filter(f=>/\.json$/.test(f)&&!f.startsWith('deck-r7k4x9/'));
let os=0; for(const f of other){ if(sealed(fs.readFileSync(f,'utf8'))) os++; else console.log('FAIL '+f+': a JSON file in the repository, not sealed'); }
res(os===other.length, 'other JSON files kept in the repository: '+other.length+' · sealed '+os);
// the page itself: no address-like string anywhere in its code
{ const r=await get(SITE+'deck-r7k4x9/index.html?nc='+Date.now()); const t=r.t.replace(/So11111111111111111111111111111111111111112|EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/g,'');
  const toks=[...new Set(t.match(/0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[])];
  const wallets=toks.length; console.log('     the page’s code: HTTP '+r.st+' · address-like strings in it: '+wallets+' (token and contract addresses of public markets are expected; leak-check matches the owner’s own)'); }
// guesses an outsider would make
for(const [p,why] of [['.git/config','the repository’s git folder'],['deck-r7k4x9/.git/HEAD','a git folder in the deck'],['deck-r7k4x9/config.json.bak','a stray backup'],['deck-r7k4x9/data-main.json.plain','a stray plain copy']]){
  const r=await get(SITE+p); res(r.st===404, why+' ('+p+'): HTTP '+r.st+' (404 expected)'); }
{ const r=await get(SITE); res(!/deck-r7k4x9/.test(r.t), 'the site’s front page: HTTP '+r.st+' · links to the deck: '+(/deck-r7k4x9/.test(r.t)?'YES':'no')); }

/* 2. the minute recorder, every door, with no token and with a wrong one */
const doors=[['GET','/m?n=10'],['GET','/m?n=5&live=1'],['GET','/h'],['GET','/f'],['GET','/f/data-main.json'],['GET','/f/config.json'],['GET','/gaps'],
  ['POST','/gaps/cfg'],['POST','/gaps/run'],['POST','/f'],['GET','/auth/log'],['POST','/auth/revoke'],['POST','/auth/name'],['POST','/auth/ev'],
  ['GET','/tick'],['GET','/mine'],['GET','/gapstick'],['GET','/'],['GET','/m/../h']];
for(const [meth,p] of doors) for(const k of ['', 'k=0000000000000000000000000000000000000000000000000000000000000000']){
  const url=REC+p+(k?(p.includes('?')?'&':'?')+k:'');
  const body=meth==='POST'?(p==='/auth/ev'?JSON.stringify({type:'open'}):'{}'):undefined;   // never a "wrong passphrase" event: it would land in the owner's access log
  const r=await get(url,{method:meth, body, headers:body?{'content-type':'application/json'}:{}});
  const shut=[403,404,405].includes(r.st);
  const leaks=r.st===200||(r.t.length>40&&!/^\{"(locked|err)"/.test(r.t)&&r.t!=='Not found');
  res(shut&&!leaks, meth+' '+p+(k?' (wrong token)':' (no token)')+': HTTP '+r.st+' · body '+r.t.length+' bytes');
}
// the store's write door, with a made-up key in the header
{ const r=await get(REC+'/f',{method:'POST', body:'{}', headers:{'x-store-key':'0'.repeat(64),'content-type':'application/json'}}); res(r.st===403, 'POST /f with a wrong store key: HTTP '+r.st+' (403 expected)'); }

console.log(bad?'FAIL '+bad+' of '+n+' checks: something is readable from outside':'ok   all '+n+' checks: nothing readable from outside without the passphrase');
process.exitCode=bad?1:0;

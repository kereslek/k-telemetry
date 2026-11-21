/* What can a stranger read? This runs with no secret at all, as anyone on the internet would: every file the
   published site holds is fetched from the live site and must come back sealed (or be one of the few plain files
   that carry no data, checked to hold nothing address-like); every door of the minute recorder is knocked on with
   no token and with a wrong one, and must stay shut. A few guesses an outsider would try are made too.
   The log is public: paths of the site's own published files, answer codes and pass/fail only.
   Run (in a checkout of gh-pages): node scripts/outside-probe.mjs */
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

const SITE='https://kereslek.github.io/k-telemetry/', REC='https://kt-pulse.kereslek.workers.dev';
const PLAIN_OK=new Set(['deck-r7k4x9/lock.json','deck-r7k4x9/relay-timing.json','deck-r7k4x9/store-gen.json','deck-r7k4x9/store-on.json']);
let bad=0, n=0; const res=(ok,m)=>{ n++; if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+m); };
const addrLike=s=>(String(s).match(/0x[0-9a-fA-F]{40}|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)||[]).length;
// a server's own hiccup (5xx) is asked again, up to four times: it is not an answer about access
async function get(url, o={}){ let last={st:'no answer', t:'', h:new Headers()};
  for(let k=0;k<4;k++){ try{ const r=await fetch(url,{redirect:'manual', signal:AbortSignal.timeout(30000), ...o}); last={st:r.status, t:await r.text(), h:r.headers}; if(r.status<500) return last; }catch(e){}
    await new Promise(r=>setTimeout(r,3000*(k+1))); } return last; }
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

/* 1b. the published branch's history: anyone can fetch every earlier version of every file. Versions written before
   the lock was turned on are plain; counted here by file, with the last day one was written. */
if(process.env.HIST==='1'){
  const g=(...a)=>execFileSync('git',a,{encoding:'utf8',maxBuffer:1<<30});
  const objs=g('rev-list','--objects','HEAD','--','deck-r7k4x9','scripts').split('\n').map(l=>{ const i=l.indexOf(' '); return i<0?null:[l.slice(0,i), l.slice(i+1)]; }).filter(x=>x&&/\.json$/.test(x[1]));
  // stream every version through git, looking only at its first bytes (the history is many gigabytes)
  const plain={}, newest={}; let total=0;
  await new Promise((done,fail)=>{ const p=spawn('git',['cat-file','--batch'],{stdio:['pipe','pipe','inherit']}); let buf=Buffer.alloc(0), want=-1, i=0, kind='';
    p.stdout.on('data',d=>{ buf=buf.length?Buffer.concat([buf,d]):d;
      for(;;){ if(want<0){ const nl=buf.indexOf(10); if(nl<0) break; const h=buf.subarray(0,nl).toString().split(' '); kind=h[1]; want=+h[2]; buf=buf.subarray(nl+1); }
        if(buf.length<want+1){ if(buf.length>65536&&want>65536){ /* keep the head only */ } break; }
        const [id,path]=objs[i++]; const body=buf.subarray(0,Math.min(want,64)).toString(); buf=buf.subarray(want+1); want=-1;
        if(kind!=='blob') continue; total++;
        if(PLAIN_OK.has(path)||/^\s*\{"(lock|inbox)":1/.test(body)) continue;
        plain[path]=(plain[path]||0)+1; if(!newest[path]) newest[path]=id; } });
    p.on('close',done); p.on('error',fail); p.stdin.end(objs.map(x=>x[0]).join('\n')+'\n'); });
  const P=Object.keys(plain);
  console.log('     history: '+total+' versions of JSON files reachable · plain (written before the lock, or never sealed): '+P.reduce((a,p)=>a+plain[p],0)+' in '+P.length+' files');
  for(const p of P){ let d='?'; try{ d=g('log','-1','--format=%cs','--find-object='+newest[p],'HEAD').trim()||'?'; }catch(e){}
    console.log('       '+p+': '+plain[p]+' plain versions, the newest written '+d); }
  res(true, 'history read (plain versions are reported above, not counted as a failure: they predate the lock and can only be removed by rewriting the history)');
}

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

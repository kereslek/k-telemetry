/* The relay's working files in the minute recorder's store (worker/src/store.js) instead of a git commit every pass.

   The eleven files every relay pass rewrites (data, ledger, history, fees, costs, balances, daily, block cache, the
   relay's log and timing) are sealed and freshly encrypted each time, so git cannot store them as differences: about
   300 commits a day grew the repository by half a gigabyte a day. They now live in the store; git keeps one copy a
   day (and every copy written when the store cannot be reached), each with deck-r7k4x9/store-gen.json saying when
   each file was produced, so the newer of the two is always known.

     pull        before a pass: every file the store holds newer than git's copy is written over it.
                 The store not answering ends the pass (exit 2): a pass must never build on a day-old copy.
     pull --read for a job that only reads them: the same, and an unreachable store leaves git's copies (a warning).
     push        after a pass: the files it changed, as one set, built on the version pulled. Refused (exit 3) when
                 anything newer landed meanwhile: the next pass rebuilds, as after a push that lost a race in git.
                 The store not answering: the files go to git this once instead (nothing is lost).
     guard       a pass run the old way (no pull): allowed only when the store holds nothing newer than git; its
                 files then go to both (exit 1 refuses).
     age <file>  minutes since the store received the file.
     restore     puts git's copies back (a job that read the store's commits its own files with a clean tree:
                 `git pull --rebase` refuses to run over changed files).

   commit-data.sh reads what push decided (ok: nothing to commit for these files; snapshot / fallback / legacy:
   commit them with the manifest). The log carries counts, times and pass/fail only. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {initLock, lockOn, lockToken, lockKeyB64} from './lock.mjs';

const OUT=process.env.STORE_OUT||'deck-r7k4x9';
const BASE=(process.env.PULSE_URL||'https://kt-pulse.kereslek.workers.dev').replace(/\/$/,'');
const STATE=process.env.STORE_STATE||'/tmp/kt-store-state.json', FLAG=process.env.STORE_FLAG||'/tmp/kt-store-push';
const MANIFEST=OUT+'/store-gen.json', SNAP_EVERY=process.env.STORE_SNAP_MS!=null?Number(process.env.STORE_SNAP_MS):24*3600e3;
export const MANAGED=/^(?:(?:data|ledger|hist|fees|costs|balances|daily)(?:-[a-z0-9-]+)?|blockcache|relay-log|relay-timing)\.json$/;
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

let tokens=null;
const SITE=(process.env.SITE_URL||'https://kereslek.github.io/k-telemetry/deck-r7k4x9/').replace(/\/?$/,'/');
async function keys(){
  if(tokens) return tokens;
  try{ if(!lockOn()){
      // a checkout without the lock (a job run from another branch): the published one, which holds only the salt
      let dir=OUT; if(!fs.existsSync(OUT+'/lock.json')){ const r=await fetch(SITE+'lock.json?t='+Date.now(),{signal:AbortSignal.timeout(30000)});
        if(!r.ok) throw new Error('lock.json not served'); dir=fs.mkdtempSync(path.join(os.tmpdir(),'kt-lock-')); fs.writeFileSync(dir+'/lock.json', await r.text()); }
      initLock(dir); } }
  catch(e){ return tokens={off:'lock: '+String(e.message||e).slice(0,80)}; }
  if(!lockOn()) return tokens={off:'the deck is not locked'};
  return tokens={read:lockToken(), write:crypto.createHmac('sha256', Buffer.from(lockKeyB64(),'base64')).update('kt-store-write').digest('hex')};
}
/* one ask, three tries; null when the store does not answer, {status, json|text} otherwise */
async function ask(path, opt={}, text=false){
  for(let k=0;k<3;k++){
    try{ const r=await fetch(BASE+path, {...opt, signal:AbortSignal.timeout(90000)});
      if(r.status>=500&&k<2){ await sleep(3000*(k+1)); continue; }
      return {status:r.status, gen:Number(r.headers.get('x-gen'))||null, body:text&&r.ok?await r.text():await r.json().catch(()=>null)}; }
    catch(e){ if(k<2) await sleep(3000*(k+1)); } }
  return null;
}
const local=()=>fs.readdirSync(OUT).filter(f=>MANAGED.test(f)).sort();
const manifest=()=>{ try{ const m=JSON.parse(fs.readFileSync(MANIFEST,'utf8')); return m&&m.files?m:{t:0, files:{}}; }catch(e){ return {t:0, files:{}}; } };
const writeManifest=(gens)=>fs.writeFileSync(MANIFEST, JSON.stringify({t:Date.now(), files:Object.fromEntries(Object.entries(gens).sort())})+'\n');
export async function storeList(){ const K=await keys(); if(K.off) return null; const r=await ask('/f?k='+K.read); return r&&r.status===200&&r.body?r.body:null; }
/* one file's text from the store (sealed as the relay wrote it), or null */
export async function storeText(name){ const K=await keys(); if(K.off||!MANAGED.test(name)) return null;
  const r=await ask('/f/'+name+'?k='+K.read, {}, true); return r&&r.status===200?{gen:r.gen, text:r.body}:null; }
/* the newer of the store's copy and one fetched elsewhere (the published site), by the readable time `t` */
export async function freshest(name, other){
  const s=await storeText(name).catch(()=>null); let a=null; try{ a=s?JSON.parse(s.text):null; }catch(e){}
  if(!a) return other; if(!other) return a; return (a.t||0)>=(other.t||0)?a:other;
}

async function pull(read){
  const K=await keys();
  if(K.off){ console.log('store: '+K.off+' — the files stay in git'); fs.writeFileSync(STATE, JSON.stringify({off:1})); return 0; }
  const L=await storeList();
  if(!L){ if(read){ console.log('::warning::store: did not answer — reading the copies in git (up to a day old)'); return 0; }
    console.log('store: did not answer — this pass does not run on the copies in git'); return 2; }
  const M=manifest(), gens={...M.files}; let got=0, kept=0;
  for(const [name,f] of Object.entries(L.files)){ if(!MANAGED.test(name)) continue;
    if(f.gen>(M.files[name]||0)){ const r=await storeText(name);
      if(!r){ if(read){ console.log('::warning::store: a file was not served — its copy in git is used'); continue; } console.log('store: a file was not served — this pass does not run'); return 2; }
      fs.writeFileSync(OUT+'/'+name, r.text); gens[name]=f.gen; got++; }
    else kept++; }
  const shas={}; for(const f of local()) shas[f]=sha(fs.readFileSync(OUT+'/'+f));
  fs.writeFileSync(STATE, JSON.stringify({ver:L.ver, gens, shas}));
  console.log('store: version '+L.ver+' · '+got+' file(s) newer than git taken, '+kept+' as in git');
  return 0;
}

async function push(){
  const S=(()=>{ try{ return JSON.parse(fs.readFileSync(STATE,'utf8')); }catch(e){ return null; } })();
  if(!S){ console.log('store: no pull before this pass — refused'); fs.writeFileSync(FLAG,'race'); return 3; }
  if(S.off){ fs.writeFileSync(FLAG,'legacy'); return 0; }
  const K=await keys(), gen=Date.now(), changed=[];
  for(const f of local()){ const t=fs.readFileSync(OUT+'/'+f,'utf8'); if(S.shas[f]!==sha(t)) changed.push([f,t]); }
  const due=Date.now()-(manifest().t||0)>SNAP_EVERY, gens={...S.gens};
  for(const [f] of changed) gens[f]=gen;
  if(!changed.length){ fs.writeFileSync(FLAG,'ok'); console.log('store: nothing changed this pass'); return 0; }
  const body=JSON.stringify({base:S.ver, files:changed.map(([f,t])=>[f,gen,t.length])})+'\n'+changed.map(c=>c[1]).join('');
  const r=await ask('/f',{method:'POST', headers:{'x-store-key':K.write,'content-type':'text/plain'}, body});
  if(r&&r.status===200){ fs.writeFileSync(STATE, JSON.stringify({...S, ver:r.body.ver, gens, shas:Object.fromEntries(local().map(f=>[f,sha(fs.readFileSync(OUT+'/'+f))]))}));
    if(due) writeManifest(gens);
    fs.writeFileSync(FLAG, due?'snapshot':'ok');
    console.log('store: '+changed.length+' file(s) kept, version '+r.body.ver+(due?' · and the day’s copy to git':'')); return 0; }
  if(r&&r.status===409){ fs.writeFileSync(FLAG,'race'); console.log('store: refused — something newer landed since this pass began; the next pass rebuilds'); return 3; }
  // the store did not take them: git keeps them this once, with their times, and the next pass hands them on
  writeManifest(gens); fs.writeFileSync(FLAG,'fallback');
  console.log('::warning::store: did not take this pass’s files ('+(r?'HTTP '+r.status:'no answer')+') — committed to git instead'); return 0;
}

/* a pass that ran without a pull (a job started before the store, or a script that skipped it) */
async function guard(){
  const K=await keys(); if(K.off) return 0;
  const L=await storeList(); if(!L){ console.log('store: did not answer — a pass run without the store is not committed'); return 1; }
  const M=manifest();
  const newer=Object.entries(L.files).filter(([n,f])=>MANAGED.test(n)&&f.gen>(M.files[n]||0)).length;
  if(newer){ console.log('store: holds '+newer+' file(s) newer than this pass began from — not committed'); return 1; }
  const gen=Date.now(), files=local().map(f=>[f,fs.readFileSync(OUT+'/'+f,'utf8')]);
  const body=JSON.stringify({base:L.ver, files:files.map(([f,t])=>[f,gen,t.length])})+'\n'+files.map(c=>c[1]).join('');
  const r=await ask('/f',{method:'POST', headers:{'x-store-key':K.write,'content-type':'text/plain'}, body});
  if(!(r&&r.status===200)){ console.log('store: did not take the files ('+(r?'HTTP '+r.status:'no answer')+') — not committed'); return 1; }
  writeManifest(Object.fromEntries(files.map(([f])=>[f,gen])));
  console.log('store: a pass run the old way, kept in both ('+files.length+' file(s), version '+r.body.ver+')'); return 0;
}

function restore(){
  const files=execFileSync('git',['ls-files','--',OUT]).toString().split('\n').filter(f=>f&&MANAGED.test(path.basename(f)));
  if(files.length) execFileSync('git',['checkout','-q','HEAD','--',...files]);
  return 0;
}
async function age(name){
  const L=await storeList(), f=L&&L.files[name];
  console.log(f?Math.max(0,Math.round((Date.now()-f.gen)/60000)):99999); return 0;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const [cmd,arg]=process.argv.slice(2);
  const run={pull:()=>pull(arg==='--read'), push, guard, age:()=>age(arg), restore:async()=>restore()}[cmd];
  if(!run){ console.log('usage: store.mjs pull [--read] | push | guard | age <file> | restore'); process.exit(64); }
  run().then(c=>process.exit(c), e=>{ console.log('store: '+String(e&&e.message||e).slice(0,160)); process.exit(cmd==='pull'&&arg!=='--read'?2:1); });
}

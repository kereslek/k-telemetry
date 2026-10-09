/* Does any copy the repository keeps still hold one of the deck's wallet addresses?

   The wallet list is opened from the sealed config.json with the deck's passphrase, and every
   file on every branch, every version of every file in the branches' history, every commit
   message, and (with LOGS=1) the logs of every Actions run still kept, are searched for each
   address: Ethereum ones in either case, with or without 0x; Solana ones exactly. The log is
   public: only counts are printed, never an address, a file name, a commit or a run. */
import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { initLock, readJ } from './lock.mjs';

const OUT='deck-r7k4x9';
if(!String(process.env.DECK_PASSPHRASE||'').trim()){ console.log('DECK_PASSPHRASE is not set: nothing checked'); process.exit(1); }
initLock(OUT);
const cfg=readJ(OUT+'/config.json');
const W=(cfg.profiles||[]).flatMap(p=>p.wallets||[]).map(w=>String(w.address||'').trim()).filter(a=>a.length>=26);
const hex=[...new Set(W.filter(a=>/^0x[0-9a-f]{40}$/i.test(a)).map(a=>a.slice(2).toLowerCase()))];
const other=[...new Set(W.filter(a=>!/^0x[0-9a-f]{40}$/i.test(a)))];
console.log('wallet addresses searched for: '+(hex.length+other.length)+' ('+hex.length+' Ethereum-style, '+other.length+' other)');
if(!hex.length&&!other.length){ console.log('FAIL the wallet list opened empty'); process.exit(1); }
const hits=s=>{ let n=0; const lo=s.toLowerCase(); for(const a of hex) if(lo.includes(a)) n++; for(const a of other) if(s.includes(a)) n++; return n; };
const git=(...a)=>execFileSync('git',a,{maxBuffer:1<<30}).toString('utf8');

/* 1. every branch as it is now */
const refs=git('for-each-ref','--format=%(refname)','refs/remotes/origin').split('\n').filter(r=>r&&!r.endsWith('/HEAD'));
let bad=0;
for(const [i,ref] of refs.entries()){
  const files=git('ls-tree','-r','--name-only',ref).split('\n').filter(Boolean);
  let n=0; for(const f of files){ let s=''; try{ s=git('cat-file','-p',ref+':'+f); }catch(e){ continue; } if(hits(s)) n++; }
  const commits=+git('rev-list','--count',ref).trim();
  console.log((n?'FAIL':'ok  ')+' branch '+(i+1)+' of '+refs.length+': '+files.length+' files now, '+n+' with a wallet address · '+commits+' commits of history');
  bad+=n;
}

/* 2. every version of every file the branches' history still reaches, and every commit message */
const objs=git('rev-list','--objects','--all').split('\n').map(l=>l.split(' ')[0]).filter(Boolean);
const blobs=[]; { const out=execFileSync('git',['cat-file','--batch-check=%(objecttype) %(objectname)'],{input:objs.join('\n'),maxBuffer:1<<30}).toString('utf8');
  for(const l of out.split('\n')){ const [t,id]=l.split(' '); if(t==='blob') blobs.push(id); } }
let blobHits=0; await new Promise((res,rej)=>{
  const p=spawn('git',['cat-file','--batch'],{stdio:['pipe','pipe','inherit']}); let buf=Buffer.alloc(0), want=-1;
  p.stdout.on('data',d=>{ buf=Buffer.concat([buf,d]);
    for(;;){ if(want<0){ const nl=buf.indexOf(10); if(nl<0) break; const h=buf.subarray(0,nl).toString().split(' '); want=+h[2]; buf=buf.subarray(nl+1); }
      if(buf.length<want+1) break; if(hits(buf.subarray(0,want).toString('utf8'))) blobHits++; buf=buf.subarray(want+1); want=-1; } });
  p.on('close',res); p.on('error',rej); p.stdin.end(blobs.join('\n')+'\n'); });
const msgs=git('log','--all','--format=%B%x00').split('\0'); let msgHits=0; for(const m of msgs) if(hits(m)) msgHits++;
console.log((blobHits?'FAIL':'ok  ')+' file versions in history: '+blobs.length+', '+blobHits+' with a wallet address');
console.log((msgHits?'FAIL':'ok  ')+' commit messages: '+(msgs.length-1)+', '+msgHits+' with a wallet address');
bad+=blobHits+msgHits;

/* 3. the logs of every Actions run GitHub still keeps (Pages' own build-and-deploy runs aside:
      GitHub writes those, nothing of the deck's is printed in them) */
if(process.env.LOGS==='1'){
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const api=async(u,raw)=>{ for(let k=0;k<6;k++){ let r=null; try{ r=await fetch('https://api.github.com/repos/'+process.env.GITHUB_REPOSITORY+u,{headers:{authorization:'Bearer '+process.env.GH_TOKEN,accept:'application/vnd.github+json'},redirect:'follow'}); }catch(e){}
      if(r&&r.ok) return {ok:true, v:raw?Buffer.from(await r.arrayBuffer()):await r.json()};
      if(r&&(r.status===404||r.status===410)) return {ok:false, gone:true};
      if(r&&(r.status===403||r.status===429)&&r.headers.get('x-ratelimit-remaining')==='0'){ const w=(+r.headers.get('x-ratelimit-reset'))*1000-Date.now(); await sleep(Math.max(1000,w)+2000); k--; continue; }
      await sleep(1500*(k+1)); } return {ok:false}; };
  const ids=[]; let runs=0, pages=0;
  for(let page=1; page<200; page++){ const r=await api('/actions/runs?per_page=100&page='+page); const a=(r.ok&&r.v.workflow_runs)||[]; runs+=a.length;
    for(const x of a){ if(x.status!=='completed'||x.id==+process.env.GITHUB_RUN_ID) continue; if(x.name==='pages build and deployment'){ pages++; continue; } ids.push(x.id); }
    if(a.length<100) break; }
  let read=0, gone=0, unread=0, empty=0, logHits=0;
  fs.mkdirSync('/tmp/lc',{recursive:true});
  for(const id of ids){
    const r=await api('/actions/runs/'+id+'/logs',true);
    if(!r.ok){ if(r.gone) gone++; else unread++; continue; }
    if(r.v.length<=22){ empty++; continue; }                     // an empty archive: the run kept no log at all
    fs.writeFileSync('/tmp/lc/l.zip', r.v); let txt='';
    try{ txt=execFileSync('unzip',['-p','/tmp/lc/l.zip'],{maxBuffer:1<<30,stdio:['ignore','pipe','pipe']}).toString('utf8'); }
    catch(e){ if(/zipfile is empty/.test(String(e.stderr||''))) empty++; else unread++; continue; }
    read++; if(hits(txt)) logHits++; }
  console.log((logHits||unread?'FAIL':'ok  ')+' Actions runs kept: '+runs+' ('+pages+' are Pages builds) · run logs read: '+read+', expired: '+gone+', unreadable: '+unread+' · '+logHits+' with a wallet address');
  bad+=logHits+unread;
}
console.log(bad?'FAIL '+bad+' places still hold a wallet address':'ok   no copy the repository keeps holds a wallet address');
process.exitCode=bad?1:0;

/* Reconstruct per-position daily records from committed payloads.

   daily-*.json only starts carrying per-position detail from the day the recorder shipped, so
   attribution had nothing to compare against and every earlier day could show a change without a
   cause. But the refresh has been committing the full payload every fifteen minutes for weeks,
   and each of those commits holds exactly what a daily record needs. Walk that history, take the
   last payload of each UTC day, and build the record that day would have had.

   Records are built by dailyRecord() imported from the refresh itself — the same arithmetic the
   live path uses, so a reconstructed day and a live one are directly comparable.

   Run:  node scripts/backfill-daily.mjs [--profile main] [--branch origin/gh-pages] [--write]
   Without --write it reports what it would change and touches nothing. */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dailyRecord } from './fetch-data.mjs';

const arg=(k,d)=>{ const i=process.argv.indexOf('--'+k); return i>0?process.argv[i+1]:d; };
const PROFILE=arg('profile','main');
const BRANCH=arg('branch','origin/gh-pages');
const WRITE=process.argv.includes('--write');
const OUT='deck-r7k4x9';
const FILE=OUT+'/data-'+PROFILE+'.json';
const DAILY=OUT+'/daily-'+PROFILE+'.json';

const git=(...a)=>execFileSync('git',a,{encoding:'utf8',maxBuffer:1<<28});

const commits=git('rev-list',BRANCH,'--',FILE).trim().split('\n').filter(Boolean);
console.log(commits.length+' commits touch '+FILE);

/* Last payload of each UTC day wins: it is the closest thing to that day's close, and it is what
   the live recorder converges on too, since it rewrites the day in place until the day ends. */
const today=new Date().toISOString().slice(0,10);
const best=new Map();
let unreadable=0;
for(const c of commits){
  let d;
  try{ d=JSON.parse(git('show',c+':'+FILE)); }catch(e){ unreadable++; continue; }
  if(!d || !d.t) continue;
  const day=new Date(d.t).toISOString().slice(0,10);
  if(day===today) continue;                       // the live recorder owns today
  const cur=best.get(day);
  if(!cur || d.t>cur.t) best.set(day,d);
}
if(unreadable) console.log(unreadable+' commit(s) had no readable payload — skipped');

const rebuilt=[];
for(const [day,d] of [...best].sort((a,b)=>a[0]<b[0]?-1:1)){
  /* A payload written while a chain was down describes a portfolio that never existed. Building a
     day from it would show every position on that chain closing and reopening the next morning. */
  const cs=d.chainStatus||{};
  const bad=Object.entries(cs).filter(([,v])=>v!=='ok').map(([k])=>k);
  if(bad.length){ console.log('  skip '+day+' — chainStatus '+bad.join(',')+' not ok'); continue; }
  const rec=dailyRecord(d.eth||[], d.sol||[], d.idle||null, d.t);
  if(!rec.ps.length){ console.log('  skip '+day+' — no positions in payload'); continue; }
  rebuilt.push(rec);
}

let daily=[];
try{ daily=JSON.parse(fs.readFileSync(DAILY,'utf8')); }catch(e){}
const byDay=new Map(daily.map(r=>[r.d,r]));
let filled=0, kept=0;
for(const r of rebuilt){
  const cur=byDay.get(r.d);
  /* Never overwrite a record that already carries detail — a live one was written from the same
     data with more of it in hand, and rewriting it would only churn the file. */
  if(cur && cur.ps){ kept++; continue; }
  byDay.set(r.d, r); filled++;
}
const merged=[...byDay.values()].sort((a,b)=>a.d<b.d?-1:1).slice(-120);

console.log('\nreconstructed '+rebuilt.length+' day(s); filled '+filled+', left '+kept+' existing detailed day(s) alone');
console.log('daily file: '+daily.length+' -> '+merged.length+' records, '
  +merged.filter(r=>r.ps).length+' with per-position detail');
console.log('  range: '+(merged[0]||{}).d+' … '+(merged[merged.length-1]||{}).d);

if(!WRITE){ console.log('\n(dry run — pass --write to save)'); process.exit(0); }
fs.writeFileSync(DAILY, '[\n'+merged.map(r=>JSON.stringify(r)).join(',\n')+'\n]\n');
console.log('\nwrote '+DAILY);

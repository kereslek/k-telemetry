/* A daily copy of the minute recorder's long memory (worker/src/hist.js), sealed into git: the one part of the
   recorder's SQL storage that has no copy anywhere else. One file per UTC day, deck-r7k4x9/backup/minutes-<day>.json,
   holding the day's minutes and readings exactly as GET /h returns them.

   Each run writes the last two complete days: the older is final by then (a correction reaches a reading at most a
   day after it), the newer is written now and again tomorrow. Any day since the history began that has no file yet
   is written too. The log is public: days, counts and coverage only.
   Run: DECK_PASSPHRASE=… node scripts/hist-backup.mjs */
import fs from 'node:fs';
import {initLock, lockOn, lockToken, writeJ} from './lock.mjs';

const OUT='deck-r7k4x9', DIR=OUT+'/backup', BASE=(process.env.PULSE_URL||'https://kt-pulse.kereslek.workers.dev').replace(/\/$/,'');
const FIRST=Date.parse(process.env.HIST_FIRST||'2026-11-20T00:00:00Z'), DAY=864e5;
initLock(OUT);
if(!lockOn()){ console.log('the deck is not locked here: nothing written (a backup is only ever kept sealed)'); process.exit(1); }
fs.mkdirSync(DIR,{recursive:true});
const dayOf=t=>new Date(t).toISOString().slice(0,10), file=d=>DIR+'/minutes-'+d+'.json';
const today=Math.floor(Date.now()/DAY)*DAY, days=[];
for(let t=Math.max(FIRST, today-31*DAY); t<today; t+=DAY){ const d=dayOf(t); if(t>=today-2*DAY||!fs.existsSync(file(d))) days.push(t); }

let bad=0;
for(const t of days){
  let H=null;
  for(let k=0;k<3&&!H;k++){
    try{ const r=await fetch(BASE+'/h?from='+t+'&to='+(t+DAY)+'&k='+lockToken(),{signal:AbortSignal.timeout(60000)}); if(r.ok) H=await r.json(); else if(r.status<500) break; }
    catch(e){}
    if(!H) await new Promise(f=>setTimeout(f,5000*(k+1))); }
  const d=dayOf(t);
  if(!H||!Array.isArray(H.mins)){ console.log(d+': the recorder did not answer — not written'); bad++; continue; }
  writeJ(file(d), {v:1, t:Date.now(), day:d, from:t, to:t+DAY, final:t<today-DAY, mins:H.mins, ev:H.ev||[]});
  const cov=H.mins.length/1440;
  console.log(d+': '+H.mins.length+' minute(s) ('+(cov*100).toFixed(1)+'% of the day), '+(H.ev||[]).length+' reading(s)'+(t<today-DAY?' · final':' · written again tomorrow'));
}
const kept=fs.readdirSync(DIR).filter(f=>/^minutes-\d{4}-\d{2}-\d{2}\.json$/.test(f)).length;
console.log('backup: '+kept+' day(s) kept'+(bad?' · '+bad+' not written this run':''));
process.exit(bad&&bad===days.length?1:0);

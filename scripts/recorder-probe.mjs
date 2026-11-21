/* What the minute recorder says about its own readings, three times a minute and a bit apart: how many of each
   chain's pools the last reading priced, and the errors it kept, with every address, hash, long number and dollar
   figure taken out first (the log is public). Run: DECK_PASSPHRASE=… node scripts/recorder-probe.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initLock, lockOn, lockToken} from './lock.mjs';

const SITE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/', W='https://kt-pulse.kereslek.workers.dev';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kt-lock-'));
fs.writeFileSync(dir+'/lock.json', await (await fetch(SITE+'lock.json?t='+Date.now())).text());
initLock(dir);
if(!lockOn()){ console.log('the deck is not locked here: nothing read'); process.exit(1); }
const scrub=s=>String(s)
  .replace(/https?:\/\/[^\s|]+/g, u=>{ try{ return new URL(u).host; }catch(e){ return 'a url'; } })
  .replace(/0x[0-9a-fA-F]{6,}/g,'0x…').replace(/\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g,'…')
  .replace(/api_key=[^&\s|]+/g,'api_key=…').replace(/\$\s?[\d.,]+/g,'$…').replace(/\b\d{4,}\b/g,'#…');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let k=0;k<3;k++){
  if(k) await sleep(75000);
  let m=null; try{ const r=await fetch(W+'/m?n=1&t='+Date.now()+'&k='+lockToken()); m=r.ok?await r.json():{http:r.status}; }catch(e){ m={http:'no answer'}; }
  if(m.http){ console.log('recorder: HTTP '+m.http); continue; }
  const ago=m.last?Math.round((Date.now()-m.last)/1000)+' s ago':'—';
  console.log(new Date().toISOString().slice(11,16)+' UTC · last reading '+ago+' · pools priced: '
    +Object.entries(m.pools||{}).map(([c,v])=>c+' '+v[0]+' of '+v[1]).join(', ')+' · errors kept: '+(m.err||[]).length);
  for(const e of m.err||[]) console.log('   error: '+scrub(e).slice(0,400));
  if(m.fail) console.log('   last failed minute ('+Math.round((Date.now()-m.fail.at)/60000)+' min ago): '+scrub(m.fail.err).slice(0,400));
  // which way the listed trades went (the colours of LATEST FEES): counts only, older and newer than the 3-hour live log
  const T=Array.isArray(m.trades)?m.trades:[], old=T.filter(t=>Date.now()-t.t>3*3600e3), sd=a=>a.filter(t=>t.side&&Object.keys(t.side).length).length;
  console.log('   trades listed: '+T.length+' · with their side: '+sd(T)+' · older than 3 h: '+old.length+', with their side: '+sd(old));
}

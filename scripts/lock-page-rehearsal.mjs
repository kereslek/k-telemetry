/* the page against the sealed rehearsal copy: lock screen, wrong passphrase refused, the right one opens it */
import {chromium} from 'playwright'; import http from 'node:http'; import fs from 'node:fs';
const D=process.argv[2], PASS=process.env.REHEARSAL_PASS, page=fs.readFileSync('deck-r7k4x9/index.html');
const srv=http.createServer((q,r)=>{ const p=q.url.split('?')[0].replace(/^\/+/,'')||'index.html';
  if(p==='index.html'){ r.writeHead(200,{'content-type':'text/html'}); return r.end(page); }
  try{ r.writeHead(200,{'content-type':'application/json'}); r.end(fs.readFileSync(D+'/'+p)); }catch(e){ r.writeHead(404); r.end(); } }).listen(8768);
const b=await chromium.launch(); const pg=await (await b.newContext({viewport:{width:390,height:844}})).newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto('http://localhost:8768/',{waitUntil:'domcontentloaded'}); await pg.waitForTimeout(3000);
let bad=0; const ok=(k,v)=>{ if(v===false) bad++; console.log((v===true?'PASS ':v===false?'FAIL ':'     ')+k+(typeof v==='boolean'?'':' '+v)); };
ok('lock screen shown', !!(await pg.$('.lock-screen')));
ok('nothing loaded behind it', (await pg.evaluate(()=>state.positions.size))===0);
await pg.fill('#lockPass','not the passphrase'); await pg.click('.lock-card button'); await pg.waitForTimeout(2500);
ok('wrong passphrase refused', !!(await pg.$('.lock-screen')));
await pg.fill('#lockPass',PASS); await pg.click('.lock-card button');
ok('right passphrase opens it', await pg.waitForFunction(()=>!document.querySelector('.lock-screen'),null,{timeout:20000}).then(()=>true,()=>false));
await pg.waitForTimeout(12000);
ok('positions shown after unlock', await pg.evaluate(()=>state.positions.size));
ok('wallets known after unlock', await pg.evaluate(()=>CONFIG_DATA.profiles[0].wallets.length));
ok('page errors', errs.length===0);
await b.close(); srv.close(); process.exit(bad?1:0);

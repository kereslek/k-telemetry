/* One-off rehearsal of the lock, end to end, on a throwaway copy: the relay runs a full pass with
   a dummy passphrase, then this checks that every published file came out sealed, that the job
   log carries no address, hash or dollar figure, that the commit would take the sealed files and
   nothing in the clear, and that the page opens them. Prints counts and yes/no only. Nothing is
   pushed; the dummy passphrase protects nothing real. */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const GP=process.argv[2], D=GP+'/deck-r7k4x9', say=(k,v)=>console.log((v===true?'PASS ':v===false?'FAIL ':'     ')+k+(typeof v==='boolean'?'':' '+v));
let bad=0; const ok=(k,v)=>{ if(v===false) bad++; say(k,v); };
const log=fs.readFileSync(process.argv[3],'utf8');
ok('relay stdout lines', log.split('\n').length);
ok('stdout has no 0x address or hash', !/0x[0-9a-fA-F]{20,}/.test(log));
ok('stdout has no Solana address', !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(log));
ok('stdout has no dollar figure', !/\$\s?\d/.test(log));
const files=[...fs.readdirSync(D).filter(f=>f.endsWith('.json')).map(f=>D+'/'+f), ...fs.readdirSync(GP+'/scripts').filter(f=>/^fee-.*\.json$/.test(f)).map(f=>GP+'/scripts/'+f)];
const { initLock, readJ } = await import(GP+'/scripts/lock.mjs'); initLock(D);
for(const f of files){ const name=f.slice(GP.length+1); if(name.endsWith('lock.json')){ const L=JSON.parse(fs.readFileSync(f,'utf8')); ok(name+' has its check', !!L.check); continue; }
  const j=JSON.parse(fs.readFileSync(f,'utf8')); const sealed=j&&j.lock===1&&!!j.ct; let opens=false; try{ readJ(f); opens=true; }catch(e){}
  ok(name+' sealed and opens', sealed&&opens); }
const cfg=readJ(D+'/config.json'), data=readJ(D+'/data-main.json');
ok('wallets in the sealed config', cfg.profiles[0].wallets.length);
ok('positions in the sealed payload', (data.eth||[]).length+(data.sol||[]).length);
ok('payload t readable for the backup route', typeof JSON.parse(fs.readFileSync(D+'/data-main.json','utf8')).t==='number');
// what the commit step would take
execSync("sed 's/^if git push -q origin gh-pages; then echo \"pushed\"; exit 0; fi$/exit 0/' scripts/commit-data.sh > /tmp/commit-dry.sh", {cwd:GP});
execSync('bash /tmp/commit-dry.sh', {cwd:GP, stdio:'ignore'});
const took=execSync('git show --name-only --format= HEAD', {cwd:GP}).toString().trim().split('\n').filter(Boolean);
ok('files the commit would publish', took.length);
let clear=0; for(const n of took){ const s=fs.readFileSync(GP+'/'+n,'utf8'); if(n.endsWith('.json') && !n.endsWith('lock.json') && !/"lock":1/.test(s.slice(0,40))) clear++; }
ok('none of them in the clear', clear===0);
ok('config.json among them (sealed)', took.includes('deck-r7k4x9/config.json'));
process.exit(bad?1:0);

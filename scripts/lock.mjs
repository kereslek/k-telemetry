/* The deck's lock. The repository is public, so every file the relay publishes is readable by
   anyone; with a passphrase set (the DECK_PASSPHRASE secret) each one is published sealed
   instead: AES-256-GCM under a key derived from the passphrase (PBKDF2-SHA256, 600k rounds, the
   salt in lock.json). The page asks for the passphrase once per device and derives the same key
   with WebCrypto; the minute recorder is given the derived key, never the passphrase.

   A sealed file keeps its name and is still JSON: {"lock":1,"t":<ms>,"iv":…,"ct":…}. Only the
   timestamp stays readable, because the backup refresh route decides whether to run from it.
   Without the secret nothing changes: files are read and written as plain JSON, as before. */
import fs from 'node:fs';
import crypto from 'node:crypto';

let OUT='deck-r7k4x9', KEY=null, TOKEN=null, ON=false;
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();

export function initLock(out){
  OUT=out||OUT;
  if(!PASS) return false;
  let L=null; try{ L=JSON.parse(fs.readFileSync(OUT+'/lock.json','utf8')); }catch(e){}
  if(!L || !L.salt || !(L.iter>=100000)) throw new Error('DECK_PASSPHRASE is set but '+OUT+'/lock.json has no salt');
  const bits=crypto.pbkdf2Sync(PASS, Buffer.from(L.salt,'base64'), L.iter, 64, 'sha256');
  KEY=bits.subarray(0,32); TOKEN=bits.subarray(32).toString('hex'); ON=true;
  /* The check proves the passphrase is the one the published files were sealed with. A
     different one must stop the pass, not reseal the cumulative ledgers under a new key. */
  if(L.check){
    let ok=false; try{ ok=open(L.check)==='kt-lock-ok'; }catch(e){}
    if(!ok) throw new Error('DECK_PASSPHRASE does not open lock.json: the published files were sealed with another passphrase');
  } else {
    L.check=JSON.parse(seal('kt-lock-ok'));
    fs.writeFileSync(OUT+'/lock.json', JSON.stringify(L,null,1)+'\n');
  }
  return true;
}
export const lockOn=()=>ON;
export const lockToken=()=>TOKEN;
export const lockKeyB64=()=>KEY?Buffer.from(KEY).toString('base64'):null;

export function seal(str, t){
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct=Buffer.concat([c.update(String(str),'utf8'), c.final(), c.getAuthTag()]);   // WebCrypto's layout: ciphertext then tag
  return JSON.stringify({lock:1, ...(typeof t==='number'?{t}:{}), iv:iv.toString('base64'), ct:ct.toString('base64')});
}
export function open(env){
  const e=typeof env==='string'?JSON.parse(env):env;
  if(!KEY) throw new Error('sealed file and no DECK_PASSPHRASE to open it');
  const iv=Buffer.from(e.iv,'base64'), all=Buffer.from(e.ct,'base64');
  const d=crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(all.subarray(all.length-16));
  return Buffer.concat([d.update(all.subarray(0,all.length-16)), d.final()]).toString('utf8');
}
/* The inbox: a drop box for things handed to the deck by someone who does not hold the passphrase
   (a helper adding wallets the owner named). Its X25519 key pair is derived from the deck key, so
   its public half can be published and only a holder of the passphrase can open what is sent to
   it: an ephemeral key, a shared secret through HKDF, AES-256-GCM. {"inbox":1,"epk","iv","ct"} */
const X_PKCS8=Buffer.from('302e020100300506032b656e04220420','hex'), X_SPKI=Buffer.from('302a300506032b656e032100','hex');
function inboxPriv(){
  const seed=Buffer.from(crypto.hkdfSync('sha256', KEY, Buffer.alloc(0), Buffer.from('kt-inbox-x25519'), 32));
  return crypto.createPrivateKey({key:Buffer.concat([X_PKCS8, seed]), format:'der', type:'pkcs8'});
}
export function inboxPublic(){ return crypto.createPublicKey(inboxPriv()).export({format:'der', type:'spki'}).subarray(-32).toString('base64'); }
export function inboxSeal(str, pubB64){
  const eph=crypto.generateKeyPairSync('x25519'), epk=eph.publicKey.export({format:'der', type:'spki'}).subarray(-32);
  const pub=crypto.createPublicKey({key:Buffer.concat([X_SPKI, Buffer.from(pubB64,'base64')]), format:'der', type:'spki'});
  const k=Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({privateKey:eph.privateKey, publicKey:pub}), epk, Buffer.from('kt-inbox'), 32));
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct=Buffer.concat([c.update(String(str),'utf8'), c.final(), c.getAuthTag()]);
  return JSON.stringify({inbox:1, epk:epk.toString('base64'), iv:iv.toString('base64'), ct:ct.toString('base64')});
}
export function inboxOpen(env){
  if(!KEY) throw new Error('inbox and no DECK_PASSPHRASE to open it');
  const epk=Buffer.from(env.epk,'base64'), pub=crypto.createPublicKey({key:Buffer.concat([X_SPKI, epk]), format:'der', type:'spki'});
  const k=Buffer.from(crypto.hkdfSync('sha256', crypto.diffieHellman({privateKey:inboxPriv(), publicKey:pub}), epk, Buffer.from('kt-inbox'), 32));
  const all=Buffer.from(env.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(env.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
  return Buffer.concat([d.update(all.subarray(0,all.length-16)), d.final()]).toString('utf8');
}
export const isSealed=j=>!!(j && typeof j==='object' && j.lock===1 && j.iv && j.ct);

/* Read a published file: sealed or plain, the same object comes back. */
export function readJ(path){
  const j=JSON.parse(fs.readFileSync(path,'utf8'));
  return isSealed(j) ? JSON.parse(open(j)) : j;
}
/* Write a published file: sealed when the lock is on. `text` is the exact plain form (the relay
   formats some files by hand); its object's `t`, if any, is kept readable. */
export function writeJ(path, obj, text){
  const s=text!=null ? text : JSON.stringify(obj);
  fs.writeFileSync(path, ON ? seal(s, obj&&typeof obj.t==='number'?obj.t:undefined) : s);
}

/* With the lock on, the Actions log of a public repository is as public as the files were. The
   relay's own log is kept, sealed, in relay-log.json; the job log gets a line count and the
   first words of each error with every address and hash cut out. */
export function quietLogs(){
  if(!ON) return;
  const real={log:console.log, err:console.error}, buf=[], errs=[];
  const put=(lvl,a)=>{ const line=a.map(x=>typeof x==='string'?x:(x&&x.stack)||JSON.stringify(x)).join(' ');
    buf.push(new Date().toISOString().slice(11,19)+' '+lvl+' '+line); if(lvl!=='log') errs.push(line); };
  console.log=(...a)=>put('log',a); console.info=console.log; console.warn=(...a)=>put('warn',a); console.error=(...a)=>put('error',a);
  process.on('exit',code=>{
    try{ fs.writeFileSync(OUT+'/relay-log.json', seal(JSON.stringify(buf.slice(-4000)), Date.now())); }catch(e){}
    real.log('relay pass (sealed): '+buf.length+' log lines in relay-log.json, '+errs.length+' warnings/errors, exit '+code);
    /* only the category of each (its first word, letters only), counted: an error's text can carry
       a piece of an address, and even eight characters of one is too much in a public log */
    const cat={}; for(const e of errs){ const k=(String(e).match(/^[A-Za-z]+/)||['other'])[0]; cat[k]=(cat[k]||0)+1; }
    for(const [k,n] of Object.entries(cat).slice(0,20)) real.log('  · '+k+' ×'+n);
    /* where the pass spent its time: the longest waits between log lines, each named by the first
       word of the line that ended it (letters only — never a value) */
    const sec=x=>{ const m=/^(\d\d):(\d\d):(\d\d)/.exec(x); return m?(+m[1])*3600+(+m[2])*60+(+m[3]):null; };
    const gaps=[]; for(let i=1;i<buf.length;i++){ const a=sec(buf[i-1]), b=sec(buf[i]); if(a==null||b==null) continue;
      const d=(b-a+86400)%86400, w=(String(buf[i]).slice(9).replace(/^(log|warn|error) /,'').match(/^[A-Za-z]+/)||['?'])[0]; gaps.push([d,w]); }
    const first=sec(buf[0]||''), last=sec(buf[buf.length-1]||'');
    if(first!=null&&last!=null){ const took=(last-first+86400)%86400, top=gaps.sort((x,y)=>y[0]-x[0]).slice(0,10);
      real.log('  pass took '+took+' s; longest steps: '+top.map(([d,w])=>w+' '+d+'s').join(', '));
      // the same, as a file the commit carries: step names and seconds, nothing else
      try{ fs.writeFileSync(OUT+'/relay-timing.json', JSON.stringify({t:Date.now(), took, steps:top})+'\n'); }catch(e){} }
  });
}

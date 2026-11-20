/* The recorder's long memory (hist.js) and the relay's file store (store.js), on Node's own SQLite standing in for
   the Durable Object's, and the recorder itself (index.js) archiving minutes, keeping readings and correcting them.
   No network: the recorder is given no positions. Run: node --no-warnings test/hist.test.mjs */
import {DatabaseSync} from 'node:sqlite';
import {histInit, archiveMin, putEv, adjustOldEv, histRange, histInfo} from '../src/hist.js';
import {storeInit, storeList, storeGet, storePut, storeVer} from '../src/store.js';
let fails=0, n=0; const ok=(c,m)=>{ n++; if(!c){ fails++; console.log('FAIL', m); } else console.log('ok   ', m); };
const near=(a,b,e=1e-6)=>Math.abs(a-b)<=e;

// the Durable Object's storage, on node:sqlite: sql.exec(query, ...bindings) → cursor; KV get/put; transactionSync
function storage(){
  const db=new DatabaseSync(':memory:'), kv=new Map();
  const sql={ exec(q,...b){ const st=db.prepare(q); const rows=/^\s*(SELECT|WITH)/i.test(q)?st.all(...b):(st.run(...b),[]); return {toArray:()=>rows, one:()=>rows[0]}; } };
  return { sql, db,
    async get(k){ return Array.isArray(k)?new Map(k.map(x=>[x,kv.get(x)])):kv.get(k); },
    async put(k,v){ if(typeof k==='object') for(const [a,b] of Object.entries(k)) kv.set(a,structuredClone(b)); else kv.set(k,structuredClone(v)); },
    transactionSync(fn){ db.exec('BEGIN'); try{ const r=fn(); db.exec('COMMIT'); return r; }catch(e){ db.exec('ROLLBACK'); throw e; } } };
}

/* ---------- hist.js ---------- */
{ const S=storage(), sql=S.sql; histInit(sql); histInit(sql);
  const M=60000, t0=Date.UTC(2026,10,20,10,0);
  archiveMin(sql, String(t0), [1.5, 3, {'A 1%':1.5}]); archiveMin(sql, t0+M, [0.2, 3, null]); archiveMin(sql, String(t0), [1.5, 3, {'A 1%':1.5}]);
  putEv(sql, [t0+30e3, t0, 2.5, {'A 1%':2.5}, {'A 1%':[1,0]}, {'A 1%':[1.01,500]}]);
  putEv(sql, [t0+90e3, t0+60e3, 0.004, {}, {}, {}]);
  let R=histRange(sql, t0, t0+10*M, {[t0+M]:[0.7,3,{'B 4%':0.7}], [t0+2*M]:[0.1,3,null]});
  ok(R.mins.length===3 && near(R.mins[1][1],0.7) && R.mins[0][3]['A 1%']===1.5, 'minutes: archived and live together, a live minute over its archived one, written twice kept once');
  ok(R.ev.length===1 && R.ev[0][2]===2.5 && R.ev[0][5]['A 1%'][1]===500, 'readings kept with their pools, sides and prices; one under half a cent left out');
  // a correction after the reading has left memory: the own swap's fee taken out, then part put back
  let left=adjustOldEv(sql, t0+20e3, 'A 1%', -1.0, t0+60*M);
  R=histRange(sql, t0, t0+10*M, {});
  ok(near(left,0) && near(R.ev[0][2],1.5) && near(R.ev[0][3]['A 1%'],1.5), 'a correction reaches a reading no longer held in memory');
  left=adjustOldEv(sql, t0+20e3, 'A 1%', 0.25, t0+60*M);
  ok(near(histRange(sql,t0,t0+10*M,{}).ev[0][2],1.75), 'and a put-back');
  ok(near(adjustOldEv(sql, t0+20e3, 'A 1%', -1.0, t0+10e3),-1.0), 'one still held in memory (newer than the oldest held) is left to the live record');
  const I=histInfo(sql); ok(I.mins===2 && I.ev===2 && I.minsFrom===t0, 'counts and how far back');
}

/* ---------- store.js ---------- */
{ const S=storage(), sql=S.sql, tx=fn=>S.transactionSync(fn); storeInit(sql);
  const body=(base, files)=>JSON.stringify({base, files:files.map(([n,g,b])=>[n,g,b.length])})+'\n'+files.map(f=>f[2]).join('');
  const big='{"lock":1,"t":5,"iv":"x","ct":"'+'q'.repeat(2_500_000)+'"}', small='{"t":7,"é":"ü"}';
  let r=storePut(sql, tx, body(0, [['data-main.json',1000,big],['relay-timing.json',1000,small]]));
  ok(r.status===200 && r.ver===1 && storeVer(sql)===1, 'a pass’s files written, the set’s version moves on');
  ok(storeGet(sql,'data-main.json').body===big && storeGet(sql,'relay-timing.json').body===small, 'read back whole: a 2.5 MB file kept in parts, non-ASCII text intact');
  ok(sql.exec("SELECT COUNT(*) AS n FROM sf WHERE name='data-main.json'").one().n===3, 'in parts of a million characters');
  const L=storeList(sql); ok(L.ver===1 && L.files['data-main.json'].size===big.length && L.files['data-main.json'].gen===1000, 'the list: version, each file’s time and size');
  r=storePut(sql, tx, body(0, [['data-main.json',2000,'{"t":9}']]));
  ok(r.status===409 && r.ver===1 && storeGet(sql,'data-main.json').body===big, 'built on an older version: refused, nothing changed');
  r=storePut(sql, tx, body(1, [['data-main.json',2000,'{"t":9}']]));
  ok(r.status===200 && r.ver===2 && storeGet(sql,'data-main.json').body==='{"t":9}' && sql.exec("SELECT COUNT(*) AS n FROM sf WHERE name='data-main.json'").one().n===1, 'built on the current one: replaced, old parts gone');
  ok(storeGet(sql,'relay-timing.json').body===small, 'a file not in the pass is kept');
  for(const [bad,why] of [['{"base":2,"files":[["../x.json",1,1]]}\nx','a name outside the set'],['{"base":2,"files":[["a.json",1,5]]}\nabc','a short body'],
      ['{"base":2,"files":[["a.json",1,1]]}\nabc','a long body'],['{"base":2,"files":[["a.json",1,1],["a.json",1,1]]}\nab','a file twice'],['nonsense','no header']])
    ok(storePut(sql, tx, bad).status===400 && storeVer(sql)===2, 'refused: '+why);
  // a write that fails half way leaves nothing behind
  const realExec=sql.exec; let k=0; sql.exec=(q,...b)=>{ if(/^INSERT INTO sf/.test(q)&&++k===2) throw new Error('disk'); return realExec(q,...b); };
  let threw=false; try{ storePut(sql, tx, body(2, [['a.json',3000,'{"a":1}'],['b.json',3000,'{"b":1}']])); }catch(e){ threw=true; }
  sql.exec=realExec;
  ok(threw && storeVer(sql)===2 && !storeGet(sql,'a.json'), 'all or nothing: a failure half way leaves the set as it was');
}

/* ---------- the recorder: minutes archived as they leave the 24 hours, readings kept and corrected ---------- */
{ const {Pulse}=await import('../src/index.js');
  const S=storage(), M=60000, now=Date.now(), cut=Math.floor(now/M)*M-1440*M;
  await S.put('mins', {[cut-2*M]:[0.5,3,{'A 1%':0.5}], [cut-M]:[0.25,3,null], [cut+10*M]:[0.1,3,null]});
  await S.put('ev', [[now-3600e3, now-3610e3, 0.8, {'A 1%':0.8}, {}, {}]]);
  const P=new Pulse({storage:S}, {SRC_URL:'https://x.invalid/deck/data-main.json'});
  P.positions=async()=>[]; P.ownShare=async()=>({});
  const m=await P.load();
  ok(S.sql.exec('SELECT COUNT(*) AS n FROM hev').one().n===1, 'first load: the readings held now start the long memory');
  await P.read(['sol']);
  const R=histRange(S.sql, cut-10*M, now+M, {});
  ok(R.mins.length===2 && !m.mins[cut-2*M] && !m.mins[cut-M] && m.mins[cut+10*M], 'a reading moves the minutes past 24 hours into the long memory, the rest stay live');
  // a settled own swap: the live record takes it out of a reading in memory, and the history follows
  P.adjust(m, now-3605e3, 'A 1%', -0.3);
  ok(near(histRange(S.sql, now-4000e3, now, {}).ev[0][2], 0.5), 'a correction in memory is written to the long memory too');
  // the same for a reading the live record no longer holds
  putEv(S.sql, [now-5*3600e3, now-5*3600e3-10e3, 1.0, {'B 4%':1.0}, {}, {}]);
  P.adjust(m, now-5*3600e3-5e3, 'B 4%', -0.4);
  ok(near(histRange(S.sql, now-6*3600e3, now-4*3600e3, {}).ev[0][2], 0.6), 'and one that has left memory');
  // the history route
  const res=await P.fetch(new Request('https://pulse/h?from='+(cut-10*M)+'&to='+(now+M)));
  const H=await res.json();
  ok(res.status===200 && H.mins.length===3 && H.ev.length===2 && H.info.mins===2, '/h: archived and live minutes, readings, counts');
  // a failing history never stops the recording
  const S2=storage(); await S2.put('mins', {[cut-M]:[0.25,3,null]}); S2.sql.exec=()=>{ throw new Error('no sql'); };
  const P2=new Pulse({storage:S2}, {SRC_URL:'https://x.invalid/deck/data-main.json'}); P2.positions=async()=>[];
  const m2=await P2.load(); await P2.read(['sol']);
  ok(m2.mins[cut-M] && m2.meta.err.some(e=>/history/.test(e)), 'history down: the minute waits in memory, the reading goes on, the error is shown');
}
console.log(fails?fails+' FAILED of '+n:'all '+n+' passed'); process.exit(fails?1:0);

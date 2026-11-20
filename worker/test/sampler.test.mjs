/* The recorder's Solana account reads against servers that behave as the public ones did on 20 Nov 2026: the first
   refuses more than ten accounts in one ask (HTTP 403), the second is closed (401), the third answers five times a
   minute. No network: fetch is replaced. Run: node --no-warnings test/sampler.test.mjs */
import {accounts} from '../src/sampler.js';
let fails=0, n=0; const ok=(c,m)=>{ n++; if(!c){ fails++; console.log('FAIL', m); } else console.log('ok   ', m); };

const A='https://capped.example', B='https://closed.example', C='https://slow.example';
let calls=[], slowLeft=5;
globalThis.fetch=async(url, opt)=>{
  const body=JSON.parse(opt.body), keys=body.params[0], host=new URL(url).host; calls.push([host, keys.length]);
  const reply=(st, j)=>new Response(JSON.stringify(j), {status:st, headers:{'content-type':'application/json'}});
  if(url===A&&keys.length>10) return reply(403, {jsonrpc:'2.0', error:{code:-32602, message:'A maximum of 10 accounts is allowed'}});
  if(url===B) return reply(401, {jsonrpc:'2.0', error:{code:-32000, message:'The free public RPC is closed'}});
  if(url===C&&slowLeft--<=0) return reply(429, {statusCode:429, message:'You have exceeded your limit of 5 requests per minute'});
  // each account answers with its own name, a missing one (name 'none-…') with null
  return reply(200, {jsonrpc:'2.0', id:1, result:{value:keys.map(k=>k.startsWith('none-')?null:{data:[k,'base64']})}});
};

const keys=Array.from({length:23}, (_,i)=>i===7?'none-7':'acc-'+i);
let r=await accounts([A,B,C], keys);
ok(r.value.length===23 && r.value.every((v,i)=>i===7?v===null:v.data[0]==='acc-'+i), 'twenty-three accounts come back whole and in order, a missing one as null');
ok(calls.length===3 && calls.every(([h,k])=>h==='capped.example'&&k<=10), 'asked in three groups of ten at most, all answered by the first server');

calls=[]; r=await accounts([A,B,C], keys.slice(0,4));
ok(r.value.length===4 && calls.length===1, 'four accounts: one ask');

calls=[]; r=await accounts([A,B,C], []);
ok(r.value.length===0 && calls.length===0, 'no accounts: no ask');

// the old way, for the record: everything in one ask falls through to the slow server and runs out within a minute
calls=[]; slowLeft=5; const {one}=await import('../src/sampler.js'); let answered=0;
for(let k=0;k<8;k++){ try{ await one([A,B,C],'getMultipleAccounts',[keys,{encoding:'base64'}]); answered++; }catch(e){} }
ok(answered===5, 'one ask of twenty-three, eight times in a minute: '+answered+' answered (the slow server alone)');
calls=[]; slowLeft=5; answered=0;
for(let k=0;k<8;k++){ try{ await accounts([A,B,C], keys); answered++; }catch(e){} }
ok(answered===8 && calls.every(([h])=>h==='capped.example'), 'in groups of ten, eight times in a minute: all answered by the first server');

/* the live dial spaces its Solana readings by the asks one takes: 2.5 s each, so the servers see the same rate */
{ const {Pulse}=await import('../src/index.js');
  const db=new (await import('node:sqlite')).DatabaseSync(':memory:'), kv=new Map();
  const sql={ exec(q,...b){ const st=db.prepare(q); const rows=/^\s*(SELECT|WITH)/i.test(q)?st.all(...b):(st.run(...b),[]); return {toArray:()=>rows, one:()=>rows[0]}; } };
  const S={ sql, async get(k){ return Array.isArray(k)?new Map(k.map(x=>[x,kv.get(x)])):kv.get(k); },
    async put(k,v){ if(typeof k==='object') for(const [a,b] of Object.entries(k)) kv.set(a,b); else kv.set(k,v); }, transactionSync(fn){ return fn(); } };
  const P=new Pulse({storage:S}, {SRC_URL:'https://x.invalid/deck/data-main.json'});
  P.positions=async()=>[]; let reads=[]; P.readChain=c=>{ reads.push(c); P.lastRead[c]=Date.now(); return Promise.resolve(); };
  const ask=async(solAgo,asks)=>{ reads=[]; P.solAsks=asks; P.lastRead={sol:Date.now()-solAgo, eth:Date.now()}; await P.fetch(new Request('https://pulse/m?live=1')); return reads.includes('sol'); };
  ok(!(await ask(5000,3)) && await ask(8000,3), 'three asks a reading: Solana read again after 7.5 s, not after 5');
  ok(await ask(3000,1) && !(await ask(2000,1)), 'one ask a reading: every 2.5 s, as before');
  ok(await ask(3000,undefined), 'before the first reading says: 2.5 s');
}
// readGrowth passes on how many asks the Solana reading took (none when no Solana position is read)
{ const {readGrowth}=await import('../src/sampler.js');
  const r=await readGrowth([], {}, {chains:['sol']});
  ok(r.asks===null && Array.isArray(r.err) && !r.err.length, 'no Solana positions: no asks, no error');
}
console.log(fails?fails+' FAILED of '+n:'all '+n+' passed'); process.exit(fails?1:0);

/* The arbitrage study run end to end on a made-up world, offline: three pools of yours (two SOL/CPOOL at
   4%, one CPOOL/USDC), 28 days of trading by people, a market-making bot, an atomic bot that closes gaps of
   more than 8.5% between the two SOL pools, and your own large sales into one pool twice a week. Solana and
   the exchanges are served by a stand-in fetch; the study itself runs unchanged, sealed with a throwaway
   passphrase, and its report is opened and checked against what was planted.

   node scripts/arb-study.sim.mjs  (exit 1 on a failed check) */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buyCpool, sellCpool, cpoolPx, bestArb, swapRaw } from './arb-core.mjs';

const HERE=path.dirname(new URL(import.meta.url).pathname), DIR=fs.mkdtempSync(path.join(os.tmpdir(),'arbsim-')), OUT=path.join(DIR,'deck-r7k4x9');
fs.mkdirSync(OUT,{recursive:true});
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=buf=>{ let n=BigInt('0x'+(Buffer.from(buf).toString('hex')||'0')), s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of buf){ if(x===0) s='1'+s; else break; } return s; };
const B58M=Object.fromEntries([...B58].map((c,i)=>[c,i]));
const b58d=s=>{ let n=0n; for(const c of s) n=n*58n+BigInt(B58M[c]); const b=[]; while(n>0n){ b.unshift(Number(n&255n)); n>>=8n; } for(const c of s){ if(c==='1') b.unshift(0); else break; } while(b.length<32) b.unshift(0); return Buffer.from(b); };
let seed=7; const rnd=()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; }; const gauss=()=>{ let u=0,v=0; while(!u) u=rnd(); while(!v) v=rnd(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
const id32=()=>b58(Buffer.from(Array.from({length:32},()=>Math.floor(rnd()*256))));
const CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg', SOL='So11111111111111111111111111111111111111112', USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CLMM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', JITO='96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
const YOU=id32(), MB=id32(), AB=id32(), PEOPLE=Array.from({length:40},id32);
const MIN=60e3, D=864e5, NOW=Date.now(), T0=Math.floor((NOW-29*D)/MIN)*MIN;

/* ---------- the market ---------- */
const sol={}, cp={}; { let s=160, c=0.025; for(let t=T0;t<=NOW+MIN;t+=MIN){ s*=Math.exp(0.0009*gauss()); c*=Math.exp(0.0018*gauss()); sol[t]=s; cp[t]=c; } }
const mkt=t=>{ const m=Math.floor(t/MIN)*MIN; return {s:sol[m], c:cp[m]}; };

/* ---------- the pools ---------- */
const mkPool=(name,c0,d0,d1,quote)=>({id:id32(), name, c0, d0, d1, quote, fee:0.04, lpCut:0.84});
const A=mkPool('SOL / CPOOL',true,9,9,SOL), B=mkPool('SOL / CPOOL',false,9,9,SOL), C=mkPool('CPOOL / USDC',true,9,6,USDC);
const POOLS=[A,B,C], qUsd=(P,t)=>P.quote===SOL?mkt(t).s:1;
const pxRaw=(P,usdPerCpool,t)=>{ const qp=usdPerCpool/qUsd(P,t), k=10**(P.d0-P.d1); return P.c0?qp/k:1/(qp*k); };   // raw P for a CPOOL price
const st={}; for(const P of POOLS){ const P0=pxRaw(P,mkt(T0).c,T0), sp=Math.sqrt(P0), quoteRes=(P.quote===SOL?125e9:20000e6);
  st[P.id]={sp, L:P.c0?quoteRes/sp:quoteRes*sp}; }
const usdPx=(P,t)=>cpoolPx(P,st[P.id].sp)*qUsd(P,t);

/* ---------- transactions ---------- */
const txs=[], byPool=new Map(POOLS.map(P=>[P.id,[]])); let slot=300e6;
const event=(P,sender,zfo,a0,a1,sp,L)=>{ const b=Buffer.alloc(205); Buffer.from('40c6cde8260871e2','hex').copy(b,0); b58d(P.id).copy(b,8); b58d(sender).copy(b,40);
  b.writeBigUInt64LE(BigInt(Math.round(a0)),136); b.writeBigUInt64LE(BigInt(Math.round(a1)),152); b[168]=zfo?1:0;
  const sq=BigInt(Math.round(sp*2**64)); for(let i=0;i<16;i++) b[169+i]=Number((sq>>BigInt(8*i))&255n);
  const LL=BigInt(Math.round(L)); for(let i=0;i<16;i++) b[185+i]=Number((LL>>BigInt(8*i))&255n); b.writeInt32LE(0,201); return 'Program data: '+b.toString('base64'); };
/* one transaction: legs [{P, zfo, in}] applied in order; the payer's token changes follow from them */
function tx(t, payer, legs, {tip=0, jup=false}={}){
  const logs=[], dTok={}, dSol={v:0}; const pools=new Set(); let last=0;
  for(const g of legs){ const P=g.P, s0=st[P.id]; if(g.in==='prev') g.in=last; const r=swapRaw(s0,g.zfo,g.in,P.fee); if(!(r.out>0)) return null; last=r.out;
    s0.sp=r.sp; pools.add(P.id);
    const inMint=g.zfo?(P.c0?CPOOL:P.quote):(P.c0?P.quote:CPOOL), outMint=g.zfo?(P.c0?P.quote:CPOOL):(P.c0?CPOOL:P.quote);
    const dec=m=>m===CPOOL?9:m===USDC?6:9;
    const bump=(m,amt)=>{ if(m===SOL) dSol.v+=amt; else dTok[m]=(dTok[m]||0)+amt; };
    bump(inMint,-g.in); bump(outMint,r.out); g.out=r.out;
    logs.push(event(P,payer,g.zfo,g.zfo?g.in:r.out,g.zfo?r.out:g.in,r.sp,s0.L)); }
  const fee=5000, keys=[payer, ...(tip?[JITO]:[]), CLMM, ...(jup?[JUP]:[])];
  const pre=keys.map((k,i)=>i===0?100e9:0), post=pre.slice(); post[0]=pre[0]+Math.round(dSol.v)-fee-tip; if(tip) post[1]=tip;
  const tb=(sg)=>Object.entries(dTok).map(([m,a])=>({owner:payer, mint:m, uiTokenAmount:{amount:String(Math.max(0,Math.round(1e15+(sg>0?a:0)))), decimals:m===USDC?6:9}}));
  const sig=b58(crypto.randomBytes(64)); slot+=3;
  const T={blockTime:Math.floor(t/1000), slot, transaction:{message:{accountKeys:keys, header:{numRequiredSignatures:1}, instructions:[{programIdIndex:keys.indexOf(jup?JUP:CLMM)}]}},
    meta:{err:null, fee, preBalances:pre, postBalances:post, preTokenBalances:tb(-1), postTokenBalances:tb(1), logMessages:logs, loadedAddresses:{writable:[],readonly:[]}}};
  txs.push({sig,T}); for(const p of pools) byPool.get(p).push({signature:sig, blockTime:T.blockTime, err:null, t}); return T; }
/* the amount that takes a pool's CPOOL to a target dollar price, by bisection */
function toward(P,t,target){ const s0=st[P.id], cur=usdPx(P,t), buy=target>cur; let lo=0, hi=(P.quote===SOL?400e9:60000e6)*(buy?1:0)+(buy?0:2e15);
  for(let i=0;i<60;i++){ const m=(lo+hi)/2; const r=buy?buyCpool(P,s0,m,P.fee):sellCpool(P,s0,m,P.fee); const p=cpoolPx(P,r.sp)*qUsd(P,t); if(buy?p<target:p>target) lo=m; else hi=m; }
  return {buy, amt:(lo+hi)/2}; }
const planted={atomic:0, atomicPnl:0, own:0, mb:0, people:0};
for(let t=T0+60*MIN;t<NOW-10*MIN;t+=3*MIN){
  const m=mkt(t);
  // your own sale, twice a week, into pool A
  if((t-T0)%(3.5*D)<3*MIN&&t>T0+D){ tx(t+500,YOU,[{P:A, zfo:A.c0, in:3000/m.c*1e9}]); planted.own++; }
  // the atomic bot: A against B, both 4%, when it pays after both fees
  { const pa=usdPx(A,t), pb=usdPx(B,t), cheap=pa<pb?A:B, dear=cheap===A?B:A, g=Math.abs(Math.log(pa/pb));
    if(g>0.085){ const r=bestArb(cheap,st[cheap.id],dear,st[dear.id],0.04,0.04); if(r&&tx(t+1500,AB,[{P:cheap, zfo:!cheap.c0, in:r.qin},{P:dear, zfo:dear.c0, in:'prev'}],{tip:100000, jup:true})) planted.atomic++; } }
  // the market-making bot: a pool more than 5% off the market (worth it after the 4% fee), most of the time, brought to about 3.5%
  for(const P of POOLS){ const g=Math.log(usdPx(P,t)/m.c); if(Math.abs(g)>0.05&&rnd()<0.7){ const w=toward(P,t,m.c*Math.exp(Math.sign(g)*0.035));
      if(w.amt>0&&tx(t+2000,MB,[{P, zfo:w.buy?!P.c0:P.c0, in:w.amt}])) planted.mb++; } }
  // people
  if(rnd()<0.09){ const P=POOLS[Math.floor(rnd()*3)], usd=20+rnd()*280, buy=rnd()<0.5;
    const amt=buy?usd/qUsd(P,t)*10**(P.c0?P.d1:P.d0):usd/m.c*1e9; tx(t+2500,PEOPLE[Math.floor(rnd()*PEOPLE.length)],[{P, zfo:buy?!P.c0:P.c0, in:amt}]); planted.people++; }
}
/* ---------- what the study reads ---------- */
const days=[]; for(let t=Math.floor(T0/D)*D;t<NOW;t+=D) days.push(new Date(t).toISOString().slice(0,10));
const dayOf=t=>new Date(t).toISOString().slice(0,10);
const S=0.9;   // your share of each pool's LP fees, every day
const vol={}, lpf={}; for(const P of POOLS){ vol[P.id]={}; lpf[P.id]={}; }
for(const {T} of txs){ const t=T.blockTime*1000; for(const l of T.meta.logMessages){ const b=Buffer.from(l.slice(14),'base64'), id=b58(b.subarray(8,40)); const P=POOLS.find(x=>x.id===id);
  const zfo=b[168]===1, a0=Number(b.readBigUInt64LE(136)), a1=Number(b.readBigUInt64LE(152)), ain=zfo?a0:a1, inMint=zfo?(P.c0?CPOOL:P.quote):(P.c0?P.quote:CPOOL);
  const usd=inMint===CPOOL?ain/1e9*mkt(t).c:inMint===USDC?ain/1e6:ain/1e9*mkt(t).s, d=dayOf(t);
  vol[P.id][d]=(vol[P.id][d]||0)+usd; if(b.subarray(40,72).toString('hex')!==b58d(YOU).toString('hex')) lpf[P.id][d]=(lpf[P.id][d]||0)+usd*P.fee*P.lpCut; } }
const W=(f,o)=>fs.writeFileSync(path.join(OUT,f),JSON.stringify(o));
W('lock.json',{salt:crypto.randomBytes(16).toString('base64'), iter:100000});
W('data-main.json',{v:6, sol:[], eth:[]});
W('config.json',{profiles:[{slug:'main', wallets:[{chain:'solana', address:YOU}]}]});
W('blockcache.json',{bridgeLinks:{main:{cx:{}}}});
W('pools-main.json',{v:1, t:NOW, tokens:[{key:'cpool', sym:'CPOOL', pools:POOLS.map(P=>({id:P.id, name:P.name, venue:'Raydium CLMM', fee:P.fee, lpCut:P.lpCut, mine:true, real:true, vol:vol[P.id]}))}],
  mine:POOLS.map(P=>({id:P.id, tok:'cpool', share:Object.fromEntries(days.map(d=>[d,{s:S,tin:1}])), fees:Object.fromEntries(Object.entries(lpf[P.id]).map(([d,v])=>[d,v*S]))}))});
W('pools-replay-main.json',{v:1, pools:POOLS.map(P=>({id:P.id, name:P.name, venue:'Raydium CLMM', fee:P.fee, mine:true, days:Object.fromEntries(days.map(d=>[d,{s:S}]))}))});

/* ---------- the stand-in for Solana and the exchanges ---------- */
const acct=P=>{ const b=Buffer.alloc(300); b58d(P.c0?CPOOL:P.quote).copy(b,73); b58d(P.c0?P.quote:CPOOL).copy(b,105); b[233]=P.d0; b[234]=P.d1; return b.toString('base64'); };
const world={pools:Object.fromEntries(POOLS.map(P=>[P.id,{acct:acct(P), sigs:byPool.get(P.id).slice().reverse()}])), tx:Object.fromEntries(txs.map(x=>[x.sig,x.T])), sol, cp};
fs.writeFileSync(path.join(DIR,'world.json'),JSON.stringify(world));
fs.writeFileSync(path.join(DIR,'mock.mjs'),`
import fs from 'node:fs';
const W=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(DIR,'world.json'))},'utf8')), MIN=60e3;
const ok=o=>new Response(JSON.stringify(o),{status:200,headers:{'content-type':'application/json'}});
const range=(o,a,b)=>Object.keys(o).map(Number).filter(t=>t>=a&&t<b).sort((x,y)=>x-y);
globalThis.fetch=async(u,opt={})=>{ u=String(u);
  if(u.startsWith('http://rpc.test')){ const q=JSON.parse(opt.body), [a,o]=q.params||[];
    if(q.method==='getAccountInfo'){ const p=W.pools[a]; return ok({result:{value:p?{owner:'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', data:[p.acct,'base64']}:null}}); }
    if(q.method==='getSignaturesForAddress'){ let L=(W.pools[a]||{sigs:[]}).sigs; if(o.before){ const i=L.findIndex(x=>x.signature===o.before); L=i<0?[]:L.slice(i+1); }
      if(o.until){ const i=L.findIndex(x=>x.signature===o.until); if(i>=0) L=L.slice(0,i); } return ok({result:L.slice(0,o.limit||1000).map(({t,...x})=>x)}); }
    if(q.method==='getTransaction') return ok({result:W.tx[a]||null});
    return ok({error:{message:'unknown'}}); }
  const qs=new URL(u).searchParams;
  if(u.includes('coinbase')){ const a=Date.parse(qs.get('start')), b=Date.parse(qs.get('end'))+MIN; return ok(range(W.sol,a,b).reverse().map(t=>[t/1000,0,0,0,W.sol[t],1])); }
  if(u.includes('mexc')){ const a=+qs.get('startTime'), b=+qs.get('endTime')+1; return ok(range(W.cp,a,b).map(t=>[t,0,0,0,String(W.cp[t]*1.001)])); }
  if(u.includes('kucoin')){ const a=+qs.get('startAt')*1000, b=+qs.get('endAt')*1000+1000; return ok({data:range(W.cp,a,b).reverse().map(t=>[String(t/1000),'0',String(W.cp[t]*0.999)])}); }
  if(u.includes('bitget')){ const b=+qs.get('endTime'), a=b-200*MIN; return ok({data:range(W.cp,a,b).map(t=>[String(t),'0','0','0',String(W.cp[t])])}); }
  return new Response('',{status:404}); };
`);

/* ---------- run the study, twice (the second carries on from the cache) ---------- */
const run=()=>{ const t0=Date.now(); const r=spawnSync(process.execPath,['--import',path.join(DIR,'mock.mjs'),path.join(HERE,'arb-study.mjs')],{cwd:DIR, env:{...process.env, DECK_PASSPHRASE:'sim-pass', SOL_RPC_URL:'http://rpc.test', BUDGET_MIN:'30'}, encoding:'utf8'});
  return {code:r.status, out:r.stdout+r.stderr, ms:Date.now()-t0}; };
const r1=run(); console.log(r1.out.trim().split('\n').map(l=>'  | '+l).join('\n')); console.log('  first run '+(r1.ms/1000).toFixed(1)+' s, exit '+r1.code);
const r2=run(); console.log('  second run '+(r2.ms/1000).toFixed(1)+' s, exit '+r2.code+(r2.out.includes(' 0 transaction(s) read this run')?' (nothing new to read)':''));
process.env.DECK_PASSPHRASE='sim-pass'; const { initLock, readJ }=await import('./lock.mjs'); initLock(OUT);
const R=readJ(path.join(OUT,'arb-main.json'));
if(process.env.SIM_OUT) fs.writeFileSync(process.env.SIM_OUT, JSON.stringify(R));   // the made-up report, for the deck's own test

/* ---------- what was planted, found ---------- */
let fails=0; const ok_=(c,m)=>{ console.log((c?'ok    ':'FAIL  ')+m); if(!c) fails++; };
const cls=a=>R.traders.find(x=>x.a===a)?.cls||(R.bots.find(x=>x.a===a)?.cls)||null;
ok_(r1.code===0&&r2.code===0,'the study ran twice without an error');
ok_(R.read.complete&&R.read.missing===0,'the whole window was read ('+R.read.txWindow+' transactions)');
ok_(R.totals.trades===txs.filter(x=>x.T.blockTime*1000>=R.from).length,'every trade in the window counted: '+R.totals.trades);
ok_(cls(AB)==='atomic','the atomic bot is classed as one ('+cls(AB)+')');
ok_(cls(MB)==='market','the market-making bot is classed as one ('+cls(MB)+')');
ok_(cls(YOU)==='you','your own wallet is you ('+cls(YOU)+')');
const ab=R.bots.find(b=>b.a===AB);
ok_(ab&&ab.pnl>0&&ab.n===planted.atomic*2/2,'the atomic bot made money: '+(ab?ab.n+' trade(s)':'not profiled')+' of '+planted.atomic+' planted');
ok_(R.classes.atomic&&R.classes.atomic.uLp<0,'its trades cost you as LP');
ok_(R.classes.person&&R.classes.person.uLp>0&&R.classes.person.n>=planted.people*0.9,'people’s trades paid you as LP, and people are people ('+(R.classes.person?R.classes.person.n:0)+' of '+planted.people+')');
ok_(R.classes.market&&R.classes.market.uLp<0,'the market-making bot’s trades cost you as LP');
const pAB=R.gaps.pairs.find(p=>[p.a,p.b].includes(A.id)&&[p.a,p.b].includes(B.id));
ok_(pAB&&pAB.sum['0.08'].n>0&&(pAB.sum['0.08'].open.you||0)>0,'gaps over 8% between the two SOL pools found, some opened by your sales ('+(pAB?pAB.sum['0.08'].n:0)+')');
ok_(pAB&&pAB.sum['0.08'].take>0,'…and the atomic bot took money out of them');
const sAB=R.scenarios.self.find(p=>[p.a,p.b].includes(A.id)&&[p.a,p.b].includes(B.id));
const rowsAB=sAB.ths.map(x=>({th:x.th, ...x.grid[0].rows[1]})), bestAB=rowsAB.slice().sort((a,b)=>b.gain-a.gain)[0];
console.log('      A↔B by threshold (all won, middle cost):\n        '+rowsAB.map(r=>r.th*100+'%: '+r.n+' corrections ('+r.ours+') · '+r.prevented+' bot trades prevented (+'+r.saved+') = '+r.gain).join('\n        '));
for(const p of R.scenarios.self) console.log('      pair '+(p.a===A.id?'A':p.a===B.id?'B':'C')+'↔'+(p.b===A.id?'A':p.b===B.id?'B':'C')+': best threshold '+(p.best==null?'none (correcting does not pay)':p.best*100+'%'));
const abPnl=R.bots.find(b=>b.a===AB)?.pnl, abLp=R.classes.atomic?.uLp; console.log('      the atomic bot made '+abPnl+', and cost you '+abLp+' as LP');
ok_(bestAB.gain>0,'between the two SOL pools, correcting ourselves pays at '+bestAB.th*100+'% ('+bestAB.n+' corrections, '+bestAB.prevented+' bot trades prevented)');
ok_(R.scenarios.self.filter(p=>p.cross).every(p=>p.best==null),'between a SOL pool and the USDC pool, where no bot works, correcting is left alone');
ok_(rowsAB.every(r=>r.saved<=-abLp*1.01),'what the corrections save is never more than the own-pair bot cost you');
ok_(R.scenarios.sales.n>0&&R.scenarios.sales.gain>0,'selling across both SOL pools beats selling into one ('+R.scenarios.sales.n+' sale(s))');
const own=R.scenarios.mimic.find(m=>m.k==='own-pair');
ok_(own&&own.grid[0].rows[0].gain>0&&Math.abs(own.grid[0].rows[0].gain-ab.pnl)/ab.pnl<0.25,'copying the own-pair bot gains about what it made');
ok_(R.checks.filter(c=>c.st==='look').length===0,'every check agrees ('+R.checks.map(c=>c.st).join(',')+')');
ok_(R.combined===undefined&&R.scenarios.combined.total>0,'the three together gain');
ok_(R.daysOut.length>=28&&R.daysOut.every(d=>d.read===1),'a line for every day, every day read');
console.log((fails?'FAILED ':'passed ')+'· planted: '+JSON.stringify(planted)+' · report '+Math.round(fs.statSync(path.join(OUT,'arb-main.json')).size/1024)+' KB sealed');
fs.rmSync(DIR,{recursive:true,force:true});
process.exit(fails?1:0);

/* bridge.mjs on made-up chains: every state the page can show, each from the facts that should cause
   it, and the ones that must not be called open. Runs before the probe (bridge-probe.yml), so a broken
   reader is caught before it reads anything real. No network. */
import {readBridge, ROUTES, TOPIC, b58d} from './bridge.mjs';
const R=ROUTES[0], hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join(''), pad=h=>String(h).replace(/^0x/,'').padStart(64,'0');
const BLOCKED='0x1111111111111111111111111111111111111111', LIB='0x2222222222222222222222222222222222222222';
const now=Date.now(), H=3600e3;
const G1='0x'+'1'.repeat(64), G2='0x'+'2'.repeat(64), ETX1='0x'+'a'.repeat(64), ETX2='0x'+'b'.repeat(64);
const SIG1='5'.repeat(88), SIG2='4'.repeat(88);
const AMT=1234500000000000000000n, k=10n**9n;          // 1234.5 CPOOL in 18 decimals; 9 on Solana
let fails=0, n=0; const ok=(c,m)=>{ n++; if(!c){ fails++; console.log('FAIL', m); } else console.log('ok   ', m); };

function world(o={}){
  const W=Object.assign({peer:hex(b58d(R.store)), send:LIB, recv:LIB, paused:0, minter:R.store, peerBack:R.adapter, supply:4203859630000000n, locked:4440919310000000000000000n,
    inAge:2*H, outAge:5*H, inAmtSol:AMT/k, outBurn:AMT/k, lzDown:false, solTxDown:false, statusOk:false, extraPeerSet:null, waiting:0, rpcDown:false}, o);
  const store=new Uint8Array(200); store.set(b58d(R.mint),17); store[156]=W.paused;
  const peerAcc=new Uint8Array(60); peerAcc.set(Uint8Array.from(Buffer.from(pad(W.peerBack),'hex')),8);
  const msg=(src,dst,guid,stx,dtx,age,st='DELIVERED')=>({pathway:{srcEid:src,dstEid:dst}, guid, status:{name:st}, created:new Date(now-age).toISOString(), updated:new Date(now-age+60e3).toISOString(),
    source:{tx:{txHash:stx, blockHash:'0x'+'9'.repeat(64)}}, destination:{tx:{txHash:dtx}}});
  const msgs=[msg(30101,30168,G1,ETX1,SIG1,W.inAge), msg(30168,30101,G2,SIG2,ETX2,W.outAge)];
  for(let i=0;i<W.waiting;i++) msgs.push(msg(30101,30168,'0x'+String(i+3).repeat(64),'0x'+String(i+3).repeat(64),String(i+6).repeat(88),2*H,'INFLIGHT'));
  const io={
    eth:async(m,p)=>{ if(W.rpcDown) throw new Error('down');
      if(m==='eth_call'){ const {to,data}=p[0], sel=data.slice(0,10);
        if(sel==='0x73318091') return '0x'+pad(BLOCKED);
        if(sel==='0xbb0b6a53') return '0x'+pad(W.peer);
        if(sel==='0xb96a277f') return '0x'+pad(W.send);
        if(sel==='0x402f8468') return '0x'+pad(W.recv)+pad('0');
        if(sel==='0x70a08231') return '0x'+W.locked.toString(16).padStart(64,'0');
        throw new Error('unknown call '+sel); }
      if(m==='eth_getTransactionReceipt'){
        if(p[0]===ETX1) return {blockNumber:'0x10', logs:[{address:R.adapter, topics:[TOPIC.sent,G1,'0x'+pad('0xdead')], data:'0x'+pad((30168).toString(16))+pad(AMT.toString(16))+pad(AMT.toString(16))}]};
        if(p[0]===ETX2) return {blockNumber:'0x11', logs:[{address:R.adapter, topics:[TOPIC.recv,G2,'0x'+pad('0xbeef')], data:'0x'+pad((30168).toString(16))+pad(AMT.toString(16))}]};
        return null; }
      if(m==='eth_getBlockByNumber') return {timestamp:'0x'+Math.floor((now-W.outAge+90e3)/1000).toString(16)};
      throw new Error('unknown '+m); },
    sol:async(m,p)=>{ if(W.rpcDown) throw new Error('down');
      if(m==='getAccountInfo'&&p[0]===R.mint) return {value:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data:{parsed:{info:{mintAuthority:W.minter, supply:W.supply.toString(), decimals:9}}}}};
      if(m==='getAccountInfo'&&p[0]===R.store) return {value:{owner:R.program, data:[Buffer.from(store).toString('base64'),'base64']}};
      if(m==='getAccountInfo'&&p[0]===R.peerAcc) return {value:{owner:R.program, data:[Buffer.from(peerAcc).toString('base64'),'base64']}};
      if(m==='getSignatureStatuses'){ if(!W.statusOk) return {value:[null]}; return {value:[{slot:123, confirmationStatus:'finalized', err:W.statusOk==='err'?{InstructionError:[0,'x']}:null}]}; }
      if(m==='getBlockTime') return Math.floor((now-W.inAge+120e3)/1000);
      if(m==='getTransaction'){ if(W.solTxDown) return null;
        if(p[0]===SIG1) return {blockTime:Math.floor((now-W.inAge+120e3)/1000), meta:{err:null, innerInstructions:[{instructions:[{parsed:{type:'mintTo',info:{mint:R.mint, amount:W.inAmtSol.toString()}}}]}]}, transaction:{message:{instructions:[]}}};
        if(p[0]===SIG2) return {blockTime:Math.floor((now-W.outAge)/1000), meta:{err:null, innerInstructions:[]}, transaction:{message:{instructions:[{parsed:{type:'burnChecked',info:{mint:R.mint, tokenAmount:{amount:W.outBurn.toString()}}}}]}}};
        return null; }
      throw new Error('unknown '+m); },
    get:async u=>{ if(/layerzero/.test(u)){ if(W.lzDown) throw new Error('lz down'); return {data:msgs}; }
      if(/blockscout/.test(u)) return {items:W.extraPeerSet?[{block_number:'26200000', index:'3', topics:[TOPIC.peer], data:'0x'+pad((30168).toString(16))+pad(W.extraPeerSet==='clear'?'0':hex(b58d(R.store)))}]:[]};
      throw new Error('unknown url'); } };
  return io;
}
const one=async(o,prev)=>(await readBridge(world(o),prev)).routes[0];

let r=await one({});
ok(r.state==='open', 'all checks pass and a crossing 2 h ago: open');
ok(Object.values(r.checks).every(v=>v===true||v===false)&&r.checks.paused===false&&r.checks.supply===true, 'every check read');
ok(r.last.in&&r.last.in.verified&&r.last.out&&r.last.out.verified, 'both crossings verified on both chains');
ok(r.last.in.src===ETX1&&r.last.in.dst===SIG1&&r.last.out.src===SIG2&&r.last.out.dst===ETX2, 'the transaction hash is taken, not the block hash beside it');
ok(Math.abs(r.lastT-(now-2*H+120e3))<5e3, 'the last crossing time is its arrival on Solana');
ok(r.n30.to===1&&r.n30.back===1&&r.waiting===0, 'counted both ways, none waiting');
ok(Math.abs(r.supply.sol-4203859.63)<0.01&&Math.abs(r.supply.locked-4440919.31)<0.01, 'supply in tokens on both chains');
ok(r.hist.length===3&&r.hist[2].open===true&&new Date(r.since).toISOString().slice(0,10)==='2026-09-25', 'history from the on-chain seed: open since 25 Sep');

r=await one({peer:'0'}); ok(r.state==='closed'&&/no longer names a Solana peer/.test(r.why.join()), 'Ethereum peer cleared: closed');
r=await one({send:BLOCKED}); ok(r.state==='closed'&&/sending to Solana is blocked/.test(r.why.join()), 'send routed to the blocking library: closed');
r=await one({recv:BLOCKED}); ok(r.state==='closed'&&/receiving from Solana is blocked/.test(r.why.join()), 'receive routed to the blocking library: closed');
r=await one({paused:1}); ok(r.state==='closed'&&/paused/.test(r.why.join()), 'Solana side paused: closed');
r=await one({peerBack:'0x3333333333333333333333333333333333333333'}); ok(r.state==='closed'&&/Solana no longer names/.test(r.why.join()), 'Solana names another Ethereum peer: closed');
r=await one({minter:'9'.repeat(44)}); ok(r.state==='changed'&&/replaced/.test(r.why.join()), 'Solana minter changed: "changed", never open');
r=await one({supply:4440919310000001n*10n**9n}); ok(r.state==='changed'&&r.checks.supply===false&&/more CPOOL on Solana/.test(r.why.join()), 'supply not covered: "changed", never open (and said why)');
r=await one({inAge:4*24*H, outAge:5*24*H}); ok(r.state==='quiet', 'open but nothing crossed for 4 days: quiet');
r=await one({rpcDown:true}); ok(r.state===null, 'nothing readable: unknown, not open');
r=await one({lzDown:true}); ok(r.state==='quiet'&&!r.last.in&&!r.last.out, 'no crossing record and none before: quiet (open on chain, nothing seen crossing)');
r=await one({inAmtSol:AMT/k-1n}); ok(r.last.in&&r.last.in.verified===false&&/do not match/.test(r.last.in.note), 'amount on Solana differs: not verified');
r=await one({solTxDown:true}); ok(r.last.in&&r.last.in.verified===false&&/not read/.test(r.last.in.note)&&r.state==='quiet', 'Solana side unreadable and no status: unverified, so not counted as a crossing');
r=await one({solTxDown:true, statusOk:true}); ok(r.last.in&&r.last.in.verified===true&&r.last.in.via==='status'&&/amount could not be read/.test(r.last.in.note)&&r.state==='open', 'contents unreadable but finalized with no error: verified by status, said so');
r=await one({solTxDown:true, statusOk:'err'}); ok(r.last.in&&r.last.in.verified===false, 'finalized with an error: not verified');
r=await one({waiting:2}); ok(r.waiting===2, 'messages stuck over 30 min are counted');
const p1=(await readBridge(world({}),null));
r=(await readBridge(world({solTxDown:true}),p1)).routes[0];
ok(r.last.in&&r.last.in.verified&&r.state==='open', 'a crossing verified earlier stands when a later read cannot reach Solana');
r=(await readBridge(world({extraPeerSet:'clear', peer:'0'}),p1)).routes[0];
ok(r.state==='closed'&&r.hist[r.hist.length-1].open===false&&r.hist[r.hist.length-1].bn===26200000, 'a new PeerSet clearing Solana is added to the history');
r=(await readBridge(world({peer:'0'}),p1)).routes[0];
ok(r.hist[r.hist.length-1].open===false&&r.hist[r.hist.length-1].seen, 'a flip with no event yet is noted at the read that saw it');
console.log(fails?fails+' FAILED of '+n:'all '+n+' passed');
process.exit(fails?1:0);

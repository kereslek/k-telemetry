// Tests for worker/src/mine.js: which tokens are watched, and what one transaction of yours did,
// with made-up transactions only. Run: node worker/test/mine.test.mjs
import assert from 'node:assert/strict';
import {tracked, evmSwapOf, solSwapOf, scanMine} from '../src/mine.js';
let n=0; const t=(name,fn)=>{ fn(); n++; };
const LCX='0x8cd41041505885ef0ad3858181d66f17be8aae7e', WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', POOL='0x1111111111111111111111111111111111111111';
const CPOOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg', WSOL='So11111111111111111111111111111111111111112', SPOOL='Pool1111111111111111111111111111111111111111';
const ps=[{chain:'eth', pool:POOL, t0:LCX, t1:WETH, s0:'LCX', s1:'WETH', d0:18, d1:18, usd0:0.05, usd1:4000, lbl:'LCX / WETH 1%'},
          {chain:'sol', pool:SPOOL, m0:CPOOL, m1:WSOL, s0:'CPOOL', s1:'SOL', d0:9, d1:9, usd0:0.028, usd1:190, lbl:'CPOOL / SOL 0.25%'}];
const T=tracked(ps);
const ME='0x00000000000000000000000000000000000000aa', OTHER='0x00000000000000000000000000000000000000bb';
const topic=a=>'0x'+a.slice(2).padStart(64,'0'), hex=v=>'0x'+BigInt(v).toString(16);
const xfer=(tok,from,to,v)=>({address:tok, topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(from),topic(to)], data:hex(v)});
const SW3=(addr)=>({address:addr, topics:['0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'], data:'0x'});
const SW4={address:'0x000000000004444c5dc75cb358380d2e3de08a90', topics:['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'], data:'0x'};

t('tracked: the tokens that are not ETH, SOL or a dollar, and your pools', ()=>{
  assert.deepEqual([...T.eth.keys()],[LCX]); assert.deepEqual([...T.sol.keys()],[CPOOL]);
  assert.equal(T.pools.eth.get(POOL),'LCX / WETH 1%'); assert.equal(T.pools.sol.get(SPOOL),'CPOOL / SOL 0.25%');
});
t('evm: a buy of LCX with ETH through your own pool', ()=>{
  const rc={status:'0x1', logs:[SW3(POOL), xfer(LCX,POOL,ME,10000n*10n**18n)]};
  const r=evmSwapOf(rc,null,[ME],T.eth,T.pools.eth);
  assert.equal(r.side,'bought'); assert.equal(r.tok,'LCX'); assert.equal(r.other,'ETH'); assert.equal(r.usd,500);
  assert.equal(r.venue,'your pool'); assert.equal(r.own,'LCX / WETH 1%'); assert.equal(r.pool,POOL);
});
t('evm: a sale of LCX for WETH through Uniswap v4 (someone else’s pool)', ()=>{
  const rc={status:'0x1', logs:[xfer(LCX,ME,SW4.address,2000n*10n**18n), SW4, xfer(WETH,SW4.address,ME,25n*10n**15n)]};
  const r=evmSwapOf(rc,null,[ME],T.eth,T.pools.eth);
  assert.equal(r.side,'sold'); assert.equal(r.other,'ETH'); assert.equal(r.usd,100); assert.equal(r.venue,'Uniswap v4'); assert.equal(r.own,null);
});
t('evm: a plain transfer is not a swap, and a swap of other wallets is not yours', ()=>{
  assert.equal(evmSwapOf({logs:[xfer(LCX,ME,OTHER,5n)]},null,[ME],T.eth,T.pools.eth),null);
  assert.equal(evmSwapOf({logs:[SW3(POOL), xfer(LCX,POOL,OTHER,5n)]},null,[ME],T.eth,T.pools.eth),null);
});
const W='Wa11et1111111111111111111111111111111111111';
const soltx=(logs,pre,post,keys,lamPre,lamPost,fee=5000)=>({meta:{err:null, fee, logMessages:logs, preTokenBalances:pre, postTokenBalances:post, preBalances:lamPre, postBalances:lamPost},
  transaction:{message:{accountKeys:keys}}});
const tb=(mint,owner,ui)=>({mint, owner, uiTokenAmount:{uiAmountString:String(ui)}});
t('sol: a sale of CPOOL for SOL through your own pool (SOL unwrapped into the wallet)', ()=>{
  const tx=soltx(['Program log: Instruction: Swap'],[tb(CPOOL,W,10000)],[tb(CPOOL,W,6000)],[W,SPOOL,'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'],[1e9],[1e9+0.58e9-5000]);
  const r=solSwapOf(tx,W,T.sol,T.pools.sol);
  assert.equal(r.side,'sold'); assert.equal(r.tok,'CPOOL'); assert.equal(r.other,'SOL'); assert.equal(r.usd,112); assert.equal(r.venue,'your pool'); assert.equal(r.own,'CPOOL / SOL 0.25%');
});
t('sol: a buy of CPOOL through Jupiter, a harvest is not a swap, someone else’s token account is not yours', ()=>{
  const buy=soltx(['Program log: Instruction: Route'],[],[tb(CPOOL,W,500)],[W,'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],[2e9],[1.9e9-5000]);
  const r=solSwapOf(buy,W,T.sol,T.pools.sol); assert.equal(r.side,'bought'); assert.equal(r.venue,'Jupiter'); assert.equal(r.own,null); assert.equal(r.usd,14);
  assert.equal(solSwapOf(soltx(['Program log: Instruction: DecreaseLiquidityV2'],[tb(CPOOL,W,0)],[tb(CPOOL,W,50)],[W,SPOOL],[1e9],[1e9-5000]),W,T.sol,T.pools.sol),null);
  assert.equal(solSwapOf(soltx(['Program log: Instruction: Swap'],[tb(CPOOL,'Someone',0)],[tb(CPOOL,'Someone',50)],[W,SPOOL],[1e9],[1e9-5000]),W,T.sol,T.pools.sol),null);
});

/* The scan, against a made-up chain: a day of blocks looked through a few asks at a time, each
   swap found once, and what was found kept when a later ask fails. */
const H=20000000, NOW=Date.parse('2026-10-17T12:00:00Z'), blockT=b=>NOW-(H-b)*12000;
const tx=i=>'0x'+String(i).padStart(64,'0');
function fakeEth(){
  const logs=[{b:H-5000, h:tx(1), to:ME, tok:LCX},{b:H-100, h:tx(2), from:ME, tok:LCX},{b:H-10, h:tx(3), to:ME, tok:LCX}];
  const rc={[tx(1)]:{status:'0x1', blockNumber:hex(H-5000), logs:[SW3(POOL), xfer(LCX,POOL,ME,10000n*10n**18n)]},
            [tx(2)]:{status:'0x1', blockNumber:hex(H-100), logs:[xfer(LCX,ME,OTHER,5n*10n**18n)]},
            [tx(3)]:{status:'0x1', blockNumber:hex(H-10), logs:[SW4, xfer(LCX,SW4.address,ME,2000n*10n**18n)]}};
  const F={asks:0, fail:new Set(), receipts:[]};
  F.call=async(rpcs,method,params)=>{ assert.equal(rpcs.length,1); F.asks++;
    if(method==='eth_blockNumber') return hex(H);
    if(method==='eth_getLogs'){ const q=params[0], a=parseInt(q.fromBlock,16), z=parseInt(q.toBlock,16), w=q.topics[1]||q.topics[2], byTo=!q.topics[1];
      assert.deepEqual(q.address,[LCX]); assert.equal(w.length,1);
      return logs.filter(l=>l.b>=a&&l.b<=z&&(byTo?l.to:l.from)===ME).map(l=>({transactionHash:l.h, blockNumber:hex(l.b)})); }
    if(method==='eth_getTransactionReceipt'){ if(F.fail.has(params[0])) throw new Error('eth.example HTTP 429 too many requests'); F.receipts.push(params[0]); return rc[params[0]]; }
    if(method==='eth_getBlockByNumber') return {timestamp:hex(Math.floor(blockT(parseInt(params[0],16))/1000))};
    throw new Error('unexpected '+method); };
  return F;
}
const wallets={eth:[ME], sol:[]};
const ta=async(name,fn)=>{ await fn(); n++; };
await ta('scan: a first look reaches back a day a few asks at a time and finds each swap once', async()=>{
  const F=fakeEth(), st={}, got=[];
  for(let i=0;i<40;i++){ const b4=F.asks; got.push(...await scanMine(st,{ps, wallets, chains:['eth'], now:NOW+i*60000, budget:5, call:F.call}));
    assert.ok(F.asks-b4<=5,'within the budget'); assert.equal(st.diag.eth.err,null); if(st.diag.eth.behind===0&&!st.diag.eth.q) break; }
  assert.deepEqual(got.map(x=>[x.id,x.side,x.venue]),[[tx(1),'bought','your pool'],[tx(3),'bought','Uniswap v4']]);
  assert.equal(got[0].t,blockT(H-5000)); assert.equal(st.diag.eth.tok,1); assert.equal(st.diag.eth.w,1);
  assert.deepEqual([...new Set(F.receipts)].sort(),[tx(1),tx(2),tx(3)]);
  assert.equal((await scanMine(st,{ps, wallets, chains:['eth'], now:NOW+50*60000, budget:5, call:F.call})).length,0);
});
await ta('scan: a failed ask keeps the swaps already found, says what kind of failure, and the rest come later', async()=>{
  const F=fakeEth(), st={}; F.fail.add(tx(3));
  const a=await scanMine(st,{ps, wallets, chains:['eth'], now:NOW, budget:40, call:F.call});
  assert.deepEqual(a.map(x=>x.id),[tx(1)]); assert.equal(st.diag.eth.err,'rate limit'); assert.equal(st.diag.eth.q,1);
  F.fail.clear(); const b=await scanMine(st,{ps, wallets, chains:['eth'], now:NOW+60000, budget:40, call:F.call});
  assert.deepEqual(b.map(x=>x.id),[tx(3)]); assert.equal(st.diag.eth.err,null); assert.equal(st.diag.eth.q,0);
});
await ta('scan: Solana signatures a day old or failed are never opened; a swap seen by two wallets of yours is one', async()=>{
  const W1=W, W2='Wa11et2222222222222222222222222222222222222', opened=[];
  const sigs={[W1]:[{signature:'A', blockTime:(NOW-3600e3)/1000},{signature:'OLD', blockTime:(NOW-2*86400e3)/1000},{signature:'BAD', err:{x:1}, blockTime:(NOW-60e3)/1000}],
              [W2]:[{signature:'B', blockTime:(NOW-600e3)/1000},{signature:'A', blockTime:(NOW-3600e3)/1000}]};
  const txs={A:soltx(['Program log: Instruction: Swap'],[tb(CPOOL,W1,10000)],[tb(CPOOL,W1,6000)],[W1,SPOOL],[1e9],[1.58e9-5000]),
             B:soltx(['Program log: Instruction: Route'],[],[tb(CPOOL,W2,500)],[W2,'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],[2e9],[1.9e9-5000])};
  const call=async(rpcs,method,params)=>{ if(method==='getSignaturesForAddress') return sigs[params[0]];
    if(method==='getTransaction'){ opened.push(params[0]); return txs[params[0]]; } throw new Error('unexpected '+method); };
  const st={}, got=[];
  for(let i=0;i<10;i++){ got.push(...await scanMine(st,{ps, wallets:{eth:[], sol:[W1,W2]}, solRpcs:['https://sol.example'], chains:['sol'], now:NOW+i*60000, budget:3, call}));
    if(!st.diag.sol.q) break; }
  assert.deepEqual(got.map(x=>[x.id,x.side,x.venue]).sort(),[['A','sold','your pool'],['B','bought','Jupiter']]);
  assert.equal(got.find(x=>x.id==='A').t,NOW-3600e3); assert.deepEqual([...new Set(opened)].sort(),['A','B']);
});
await ta('scan: nothing to watch asks nothing; a request over its limit is named as such', async()=>{
  let asked=0; const st={};
  await scanMine(st,{ps, wallets:{eth:[], sol:[]}, chains:['eth','sol'], now:NOW, call:async()=>{ asked++; }});
  assert.equal(asked,0); assert.deepEqual([st.diag.eth.tok,st.diag.eth.w,st.diag.sol.tok,st.diag.sol.w],[1,0,1,0]);
  await scanMine(st,{ps, wallets, chains:['eth'], now:NOW, call:async()=>{ throw new Error('Too many subrequests.'); }});
  assert.equal(st.diag.eth.err,'request limit'); assert.ok(st.diag.eth.asks<=18);
});
console.log('mine.js: '+n+' tests passed');

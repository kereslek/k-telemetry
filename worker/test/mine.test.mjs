// Tests for worker/src/mine.js: which tokens are watched, and what one transaction of yours did,
// with made-up transactions only. Run: node worker/test/mine.test.mjs
import assert from 'node:assert/strict';
import {tracked, evmSwapOf, solSwapOf} from '../src/mine.js';
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
console.log('mine.js: '+n+' tests passed');

/* bridge-links.mjs on made-up chains: LayerZero Scan, an Ethereum node and a Solana node, all fake.
   Every case is checked against the answer it must give. Run: node scripts/bridge-links.test.mjs */
import { readLinks, linkUp, solDeltas, swapSide, hashOf, LINK_WIN } from './bridge-links.mjs';

let fails=0; const ok=(c,m)=>{ console.log((c?'ok    ':'FAIL  ')+m); if(!c) fails++; };
const R={eidFrom:30101, eidTo:30168, adapter:'0xa5ff39ea51c1e2e9152d22b606ddc372ea2b1992', tokenEth:'0x66761fa41377003622aee3c7675fc7b5c1c2fac5', mint:'CPooLMint1111111111111111111111111111111111'};
const T_SENT='0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a', T_RECV='0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c';
const SWAP_V3='0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const MIN=60000, NOW=Date.UTC(2026,10,2,12,0), SOLM='So11111111111111111111111111111111111111112', USDC='USDCmint11111111111111111111111111111111111';
const sig=s=>(s+'1'.repeat(88)).slice(0,88);                       // a made-up Solana signature
const hx=(s,n=64)=>'0x'+Buffer.from(s).toString('hex').padEnd(n,'0').slice(0,n);
const pad=a=>'0x'+a.replace(/^0x/,'').padStart(64,'0'), w=v=>BigInt.asUintN(256,BigInt(v)).toString(16).padStart(64,'0');
const POOL='PooLSoL111111111111111111111111111111111111', EPOOL='0x00000000000000000000000000000000000e7001';
const wX='WaLLetX11111111111111111111111111111111111', wY='WaLLetY11111111111111111111111111111111111', wZ='WaLLetZ11111111111111111111111111111111111';
const EXEC='ExecutoR1111111111111111111111111111111111', eE='0x00000000000000000000000000000000000000e1', vault='VauLtAuth11111111111111111111111111111111';

/* a Solana transaction moving tokens between owners (and SOL by lamports), fee payer first */
function solTx(t, payer, moves, lamports={}){
  const keys=[payer,...new Set([...Object.keys(lamports)].filter(k=>k!==payer))], pre=[], post=[]; let i=0;
  for(const [owner,mint,d,dec=6] of moves){ const a=1_000_000; pre.push({accountIndex:i, owner, mint, uiTokenAmount:{amount:String(a*10**dec), decimals:dec}});
    post.push({accountIndex:i, owner, mint, uiTokenAmount:{amount:String(Math.round((a+d)*10**dec)), decimals:dec}}); i++; }
  const preB=keys.map(()=>10e9), postB=keys.map(k=>10e9+(lamports[k]||0)*1e9-(k===payer?5000:0));
  return {blockTime:Math.floor(t/1000), meta:{err:null, fee:5000, preTokenBalances:pre, postTokenBalances:post, preBalances:preB, postBalances:postB},
          transaction:{message:{accountKeys:keys.map(k=>({pubkey:k}))}}};
}
function world(){
  const T1=NOW-5*3600e3, T2=NOW-3*3600e3, T3=NOW-1*3600e3;     // crossings: in (X), out (Z), in (E on Ethereum, Y on Solana)
  const msgs=[
    {guid:hx('g1'), pathway:{srcEid:30101,dstEid:30168}, status:{name:'DELIVERED'}, created:new Date(T1-3*MIN).toISOString(), source:{tx:{txHash:hx('e1')}}, destination:{tx:{txHash:sig('s1')}}},
    {guid:hx('g2'), pathway:{srcEid:30168,dstEid:30101}, status:{name:'DELIVERED'}, created:new Date(T2).toISOString(), source:{tx:{txHash:sig('s2')}}, destination:{tx:{txHash:hx('e2')}}},
    {guid:hx('g3'), pathway:{srcEid:30101,dstEid:30168}, status:{name:'DELIVERED'}, created:new Date(T3-3*MIN).toISOString(), source:{tx:{txHash:hx('e3')}}, destination:{tx:{txHash:sig('s3')}}},
    {guid:hx('g4'), pathway:{srcEid:30101,dstEid:30168}, status:{name:'INFLIGHT'}, created:new Date(NOW-5*MIN).toISOString(), source:{tx:{txHash:hx('e4')}}, destination:{}}];
  const amt=n=>w(BigInt(n)*10n**18n);
  const rcpt={
    [hx('e1')]:{from:'0x00000000000000000000000000000000000000a1', blockNumber:'0x10', logs:[{address:R.adapter, topics:[T_SENT, hx('g1'), pad('0x00000000000000000000000000000000000000a1')], data:'0x'+w(30168)+amt(21500)+amt(21500)}]},
    [hx('e2')]:{from:'0x00000000000000000000000000000000000000ee', blockNumber:'0x20', logs:[{address:R.adapter, topics:[T_RECV, hx('g2'), pad('0x00000000000000000000000000000000000000a2')], data:'0x'+w(30168)+amt(8700)}]},
    [hx('e3')]:{from:eE, blockNumber:'0x30', logs:[{address:R.adapter, topics:[T_SENT, hx('g3'), pad(eE)], data:'0x'+w(30168)+amt(3300)+amt(3300)}]}};
  const blocks={'0x10':T1-3*MIN, '0x20':T2+2*MIN, '0x30':T3-3*MIN, '0x40':T3-30*MIN, '0x41':T3-3*3600e3};
  const stx={
    [sig('s1')]:solTx(T1, EXEC, [[wX, R.mint, +21500]]),                 // arrives: X's CPOOL minted, the executor pays
    [sig('s2')]:solTx(T2, wZ, [[wZ, R.mint, -8700]]),                    // leaves: Z burns its CPOOL and pays
    [sig('s3')]:solTx(T3, EXEC, [[wY, R.mint, +3300]]),
    // through the deck's pool:
    [sig('a1')]:solTx(T1+9*MIN, wX, [[wX, R.mint, -21000], [vault, R.mint, +21000]], {[wX]:+1.2}),          // X sold for SOL 9 min after: linked
    [sig('a2')]:solTx(T1-10*MIN, wX, [[wX, R.mint, -500], [wX, USDC, +10]]),                               // X swapped before it arrived: not
    [sig('a3')]:solTx(T1+5*MIN, wY, [[wY, R.mint, -700], [wY, USDC, +14]]),                                // someone else: not
    [sig('a4')]:solTx(T1+20*MIN, wX, [[wX, R.mint, -300]], {[wX]:-0.5}),                                   // X added liquidity: not a swap
    [sig('a5')]:solTx(T2-14*MIN, wZ, [[wZ, R.mint, +8700], [wZ, USDC, -180]]),                             // Z bought, then bridged out: linked
    [sig('a6')]:solTx(T2-3*3600e3, wZ, [[wZ, R.mint, +100], [wZ, USDC, -2]]),                             // Z, three hours before: not
    [sig('a7')]:solTx(T1+40*MIN, wX, [[wX, R.mint, -100], [wX, USDC, +2]])};                              // X again, later in the window: linked too
  const poolSigs=['a1','a2','a3','a4','a5','a6','a7'].map(k=>({signature:sig(k), blockTime:stx[sig(k)].blockTime, err:null})).sort((a,b)=>b.blockTime-a.blockTime);
  // Ethereum pool: E bought CPOOL 30 min before sending (linked); E three hours before (not)
  const elogs=[{transactionHash:hx('x1'), logIndex:'0x1', blockNumber:'0x40', topics:[SWAP_V3, pad('0x00000000000000000000000000000000000000f0'), pad(eE)], data:'0x'+w(-3300n*10n**18n)+w(5n*10n**17n)},
               {transactionHash:hx('x2'), logIndex:'0x2', blockNumber:'0x41', topics:[SWAP_V3, pad('0x00000000000000000000000000000000000000f0'), pad(eE)], data:'0x'+w(-(10n**18n))+w(10n**15n)}];
  const etx={[hx('x1')]:{from:eE}, [hx('x2')]:{from:eE}};
  const calls={eth:0, sol:0, get:0, solTx:0};
  const io={
    get:async u=>{ calls.get++; return {data:msgs}; },
    eth:async(m,p)=>{ calls.eth++;
      if(m==='eth_getTransactionReceipt') return rcpt[p[0]]||null;
      if(m==='eth_getBlockByNumber') return blocks[p[0]]?{timestamp:'0x'+Math.floor(blocks[p[0]]/1000).toString(16)}:null;
      if(m==='eth_blockNumber') return '0x50';
      if(m==='eth_getLogs') return p[0].address===EPOOL?elogs:[];
      if(m==='eth_getTransactionByHash') return etx[p[0]]||null; return null; },
    sol:async(m,p)=>{ calls.sol++;
      if(m==='getTransaction'){ calls.solTx++; return stx[p[0]]||null; }
      if(m==='getSignaturesForAddress') return p[0]===POOL&&!(p[1]&&p[1].before)?poolSigs:[]; return null; }};
  return {io, calls, T1, T2, T3};
}
const pools=[{chain:'sol', id:POOL, mints:[R.mint, SOLM]}, {chain:'eth', id:EPOOL, mints:[R.tokenEth, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']}];

{ const W=world(), r=await readLinks({io:W.io, R, pools, prev:null, now:NOW});
  const by=k=>r.links.find(l=>l.tx===(k.startsWith('0x')?k:sig(k)));
  ok(r.n.crossings===3 && r.n.read===3, 'three delivered crossings read, the one still in flight left alone ('+r.n.crossings+', '+r.n.read+')');
  ok(by('a1') && by('a1').way==='in' && by('a1').lag===9 && by('a1').side==='sold' && by('a1').amt===21500 && by('a1').chain==='sol', 'came over, then sold 9 min later: linked, ETH → SOL, 21.5k');
  ok(by('a7') && by('a7').lag===40, 'the same wallet again inside the two hours: linked too');
  ok(!by('a2'), 'a swap before the CPOOL arrived: not linked');
  ok(!by('a3'), 'another wallet trading at the same time: not linked');
  ok(!by('a4'), 'adding liquidity (CPOOL and SOL both in): not a swap, not linked');
  ok(by('a5') && by('a5').way==='out' && by('a5').lag===-14 && by('a5').side==='bought' && by('a5').amt===8700, 'bought, then bridged out 14 min later: linked, SOL → ETH, 8.7k');
  ok(!by('a6'), 'the same wallet three hours earlier: outside the window, not linked');
  ok(by('0x'+Buffer.from('x1').toString('hex').padEnd(64,'0')) && r.links.find(l=>l.chain==='eth').side==='bought' && r.links.find(l=>l.chain==='eth').lag===-27, 'Ethereum: bought here, then bridged to Solana 27 min later (its send, not its arrival): linked');
  ok(r.links.length===4, 'four links in all, newest first: '+r.links.map(l=>l.chain+':'+l.lag).join(' '));
  const kept=JSON.stringify({cx:r.cx, sw:r.sw});
  ok(![wX,wY,wZ,eE.slice(2),EXEC].some(a=>kept.includes(a)) && !JSON.stringify(r.links).match(/WaLLet|00000000000000000000000000000000000000e1/), 'no wallet is kept or handed on: hashes in the cache, none in the links');
  ok(!r.cx[Object.keys(r.cx)[0]].ps.includes(hashOf(EXEC)), 'LayerZero’s executor, which pays for the arriving side, is not taken for the trader');
  /* the next run: nothing read twice */
  const W2=world(), r2=await readLinks({io:W2.io, R, pools, prev:{cx:r.cx, sw:r.sw}, now:NOW+60000});
  ok(W2.calls.solTx===0 && r2.links.length===4, 'the next run reads no transaction again and keeps the same links ('+W2.calls.solTx+' read)'); }

{ const W=world(), r=await readLinks({io:W.io, R, pools, prev:null, now:NOW, maxTx:2});
  ok(r.n.capped && r.links.length<4, 'a run over its allowance stops and says so ('+r.links.length+' links so far)');
  const r2=await readLinks({io:world().io, R, pools, prev:{cx:r.cx, sw:r.sw}, now:NOW, maxTx:60});
  ok(r2.links.length===4, 'and the next run finishes what it left'); }

{ const W=world(); W.io.get=async()=>null; const r=await readLinks({io:W.io, R, pools, prev:null, now:NOW});
  ok(r.n.msgs===null && r.links.length===0, 'LayerZero Scan not answering: nothing linked, and it says it could not read'); }

{ const d=solDeltas(solTx(NOW, wX, [[wX, R.mint, -5], [wX, USDC, +1]]));
  ok(swapSide(d.get(wX), R.mint)==='sold', 'deltas: CPOOL out and USDC in is a sale');
  ok(swapSide(solDeltas(solTx(NOW, wX, [[wX, R.mint, +5], [wX, USDC, +1]])).get(wX), R.mint)===null, 'CPOOL and USDC both back (a withdrawal) is not a swap');
  ok(swapSide(solDeltas(solTx(NOW, wX, [[wX, R.mint, -5]], {[wX]:+0.001})).get(wX), R.mint)===null, 'a few lamports back (rent) is not the other side of a swap'); }

{ const c={way:'in', amt:10, tSol:NOW-3600e3, tEth:NOW-3700e3, ps:[hashOf(wX)], pe:[]};
  const L=linkUp({g:c}, {['s#p']:{chain:'sol', pool:'p', t:NOW-3600e3+LINK_WIN+1000, w:[[hashOf(wX),'sold']]}}, NOW);
  ok(L.length===0, 'one second past the two hours: not linked'); }

console.log(fails?fails+' FAILED':'all passed');
process.exit(fails?1:0);

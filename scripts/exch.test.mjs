/* The exchange record (exch.mjs) against made-up chains: deposits kept, the exchange's sweeps left out, the
   sender named when it is one of the deck's wallets, each run reading only what is new and one more stretch of
   the past until the first transaction, and every transfer valued at its own time. No network.
   Run: node scripts/exch.test.mjs */
import {exchLedger, solIn} from './exch.mjs';
let fails=0, n=0; const ok=(c,m)=>{ n++; if(!c){ fails++; console.log('FAIL', m); } else console.log('ok   ', m); };
const near=(a,b)=>Math.abs(a-b)<1e-9;

/* ---------- Solana ---------- */
const CEX='CexOwner1111111111111111111111111111111111', W1='WalletOne11111111111111111111111111111111', W2='WalletTwo11111111111111111111111111111111', X='Stranger1111111111111111111111111111111111';
const ATA1='AtaCpool11111111111111111111111111111111', ATA2='AtaRay1111111111111111111111111111111111', MCP='MintCpool1111111111111111111111111111111', MRAY='MintRay11111111111111111111111111111111';
const T=Date.UTC(2026,10,20,12)/1000;
const solTx=(keys,pre,post,pt=[],qt=[],bt=T)=>({blockTime:bt, transaction:{message:{accountKeys:keys.map(k=>({pubkey:k}))}}, meta:{err:null, preBalances:pre, postBalances:post, preTokenBalances:pt, postTokenBalances:qt}});
const tb=(i,mint,owner,ui)=>({accountIndex:i, mint, owner, uiTokenAmount:{uiAmountString:String(ui)}});
const TX={
  S1: solTx([W1,CEX,'Sys'],[10e9,0,1],[4.99e9,5e9,1]),                                                          // 5 SOL from wallet one
  S2: solTx([CEX,'Hot','Sys'],[5e9,0,1],[0.1e9,4.9e9,1]),                                                       // the exchange sweeping it out
  S3: solTx([W2,'SrcAta',ATA1],[1e9,0,0],[0.99e9,0,0],[tb(1,MCP,W2,1000),tb(2,MCP,CEX,0)],[tb(1,MCP,W2,250),tb(2,MCP,CEX,750)]),   // 750 CPOOL from wallet two
  S4: solTx([CEX,ATA1,'HotAta'],[1e9,0,0],[0.99e9,0,0],[tb(1,MCP,CEX,750),tb(2,MCP,'Hot',0)],[tb(1,MCP,CEX,0),tb(2,MCP,'Hot',750)]), // swept
  S5: solTx([X,'XAta',ATA2],[1e9,0,0],[0.99e9,0,0],[tb(1,MRAY,X,40),tb(2,MRAY,CEX,0)],[tb(1,MRAY,X,0),tb(2,MRAY,CEX,40)]),         // 40 RAY from someone else
  S6: solTx([W1,CEX,'Sys'],[3e9,5e9,1],[1.99e9,6e9,1],[],[],T+86400),                                            // 1 SOL more, a day later
};
const sigs={[CEX]:['S2','S1'], [ATA1]:['S4','S3'], [ATA2]:['S5']};
let gtCalls=[];
const solIo=()=>({
  sol:async(m,p)=>{
    if(m==='getTokenAccountsByOwner') return {value:p[1].programId.startsWith('Tokenkeg')?[{pubkey:ATA1},{pubkey:ATA2}]:[]};
    if(m==='getSignaturesForAddress'){ const all=(sigs[p[0]]||[]).map(s=>({signature:s, err:null})), o=p[1]||{};
      let L=all; if(o.until){ const i=L.findIndex(x=>x.signature===o.until); L=i<0?L:L.slice(0,i); } if(o.before){ const i=L.findIndex(x=>x.signature===o.before); L=i<0?[]:L.slice(i+1); } return L.slice(0,o.limit||1000); }
    if(m==='getTransaction'){ gtCalls.push(p[0]); return TX[p[0]]; } },
  getJson:async()=>null, usdAt:async(ch,tok)=>tok==='native'?150:tok===MCP?0.02:tok===MRAY?2:null, sym:(ch,tok)=>tok==='native'?'SOL':tok===MCP?'CPOOL':tok===MRAY?'RAY':null });
{ const st={}, io=solIo();
  let r=await exchLedger({cex:[{chain:'solana',address:CEX}], wallets:[{chain:'solana',address:W1},{chain:'solana',address:W2}], io, st});
  const by=k=>r.rows.find(x=>x.k===k);
  ok(r.rows.length===3, 'Solana: three deposits kept, the two sweeps left out ('+r.rows.length+')');
  ok(by('sol:S1:native')&&near(by('sol:S1:native').amt,5)&&by('sol:S1:native').from===W1&&by('sol:S1:native').usd===750, '5 SOL from wallet one, valued at its time ($750)');
  ok(by('sol:S3:'+MCP)&&near(by('sol:S3:'+MCP).amt,750)&&by('sol:S3:'+MCP).from===W2&&by('sol:S3:'+MCP).sym==='CPOOL'&&by('sol:S3:'+MCP).usd===15, '750 CPOOL from wallet two, arriving in a token account, named and valued');
  ok(by('sol:S5:'+MRAY)&&by('sol:S5:'+MRAY).from==='other', 'RAY from an address that is not one of the deck’s: kept, its sender "other"');
  ok(r.whole, 'the whole history read (every account short of a full page)');
  // a day later: one new deposit; only it is fetched
  sigs[CEX]=['S6','S2','S1']; gtCalls=[];
  r=await exchLedger({cex:[{chain:'solana',address:CEX}], wallets:[{chain:'solana',address:W1},{chain:'solana',address:W2}], io, st});
  ok(r.rows.length===4 && gtCalls.join()==='S6' && r.rows[0].k==='sol:S6:native', 'the next run reads only what is new, newest first in the record');
  // the exchange topping its deposit address up for gas, from the address it sweeps to: its own, not a deposit, not valued
  TX.S7=solTx(['Hot',CEX,'Sys'],[9e9,1e9,1],[8.98e9,1.01e9,1],[],[],T+2*86400); sigs[CEX]=['S7','S6','S2','S1'];
  r=await exchLedger({cex:[{chain:'solana',address:CEX}], wallets:[{chain:'solana',address:W1},{chain:'solana',address:W2}], io, st});
  const g=r.rows.find(x=>x.k==='sol:S7:native');
  ok(g&&g.kind==='exchange'&&g.usd==null&&r.rows.find(x=>x.k==='sol:S1:native').kind==='wallet'&&r.rows.find(x=>x.k==='sol:S5:'+MRAY).kind==='other'&&r.rows.find(x=>x.k==='sol:S5:'+MRAY).src===X,
    'SOL from the address the exchange sweeps to is the exchange’s own (gas), not valued; the sender’s address is kept for every transfer');
}
// a long history read a stretch per run, back to the first transaction
{ const many=Array.from({length:250},(_,i)=>'L'+(249-i));   // newest first
  for(const s of many) TX[s]=solTx([W1,CEX,'Sys'],[2e9,0,1],[1e9,1e9,1],[],[],T-Number(s.slice(1))*60);
  sigs[CEX]=many; const st={}, io=solIo(); const at={cex:[{chain:'solana',address:CEX}], wallets:[{chain:'solana',address:W1}], io, st, pages:1};
  sigs[ATA1]=[]; sigs[ATA2]=[];
  let r=await exchLedger(at); const a=r.rows.length; r=await exchLedger(at); const b=r.rows.length; r=await exchLedger(at); const c=r.rows.length;
  ok(a===200&&b===250&&c===250&&r.whole, 'a history of 250, a stretch of 100 each way per run: 200, then all 250, then known to be whole ('+[a,b,c]+')');
  ok(new Set(r.rows.map(x=>x.k)).size===250, 'no transfer kept twice');
}

/* ---------- Ethereum (Blockscout) ---------- */
{ const CE='0xcex0000000000000000000000000000000000001', EW='0xwallet00000000000000000000000000000000001', TOK='0xtoken000000000000000000000000000000000001';
  const item=(h,i,v,from,ts)=>({timestamp:new Date(ts*1000).toISOString(), to:{hash:CE}, from:{hash:from}, token:{address_hash:TOK, symbol:'LCX', decimals:'18'}, total:{value:String(v), decimals:'18'}, transaction_hash:h, log_index:i});
  const pages={1:{items:[item('0xa',1,5e18,EW,T+60),item('0xb',2,2e18,'0xelse',T+30)], next_page_params:{p:2}}, 2:{items:[item('0xc',3,1e18,EW,T)], next_page_params:{p:3}}, 3:{items:[item('0xd',4,3e18,EW,T-60)], next_page_params:null}};
  const txs={items:[{timestamp:new Date(T*1000).toISOString(), to:{hash:CE}, from:{hash:EW}, value:'500000000000000000', hash:'0xe1', status:'ok'},
                    {timestamp:new Date(T*1000).toISOString(), to:{hash:CE}, from:{hash:EW}, value:'900000000000000000', hash:'0xe2', status:'error'}], next_page_params:null};
  let asked=[]; const io={ sol:async()=>null, sym:()=>null, usdAt:async(ch,tok)=>tok==='native'?2000:0.03,
    getJson:async u=>{ asked.push(u); if(/transactions/.test(u)) return txs; return /p=3/.test(u)?pages[3]:/p=2/.test(u)?pages[2]:pages[1]; } };
  const st={}, at={cex:[{chain:'ethereum',address:CE}], wallets:[{chain:'ethereum',address:EW}], io, st, pages:1};
  let r=await exchLedger(at);
  ok(r.rows.length===4 && !r.whole, 'Ethereum, first run: two pages of tokens and the ETH sent in, the failed one left out, the past still to read ('+r.rows.length+')');
  r=await exchLedger(at);
  ok(r.rows.length===5 && r.whole && r.rows.find(x=>x.k==='eth:0xd:4'), 'second run: nothing new, the rest of the past read from where it stopped ('+r.rows.length+')');
  const e=r.rows.find(x=>x.k==='eth:0xe1:native'), b=r.rows.find(x=>x.k==='eth:0xb:2');
  ok(e&&near(e.amt,0.5)&&e.usd===1000&&e.from===EW&&b.from==='other'&&b.sym==='LCX', 'ETH itself valued, the sender named when it is one of the wallets, the token named from its record');
}

/* a price not found: asked again on later runs; left unvalued for good only after six tries, once three days old */
{ const st={rows:[{k:'x',t:Date.now()-864e5,ch:'sol',tok:'Mx',amt:1,usd:null},{k:'y',t:Date.now()-5*864e5,ch:'sol',tok:'My',amt:1,usd:null},
                  {k:'z',t:Date.now()-5*864e5,ch:'sol',tok:'Mz',amt:2,usd:null,px:false}], addr:{}, v:2};
  let up=false; const io={usdAt:async(ch,tok)=>up&&tok==='Mz'?3:null, sym:()=>null};
  await exchLedger({cex:[], wallets:[], io, st});
  ok(st.rows.find(x=>x.k==='y').px!==false, 'an old transfer whose price failed once is asked again, not given up');
  up=true; await exchLedger({cex:[], wallets:[], io, st});
  ok(st.rows.find(x=>x.k==='z').usd===6, 'one marked unpriced by the old rule is asked again, and valued once the feed answers');
  for(let k=0;k<6;k++) await exchLedger({cex:[], wallets:[], io, st});
  ok(st.rows.find(x=>x.k==='y').px===false && st.rows.find(x=>x.k==='x').px!==false, 'after six tries the three-day-old one is left unvalued for good; the day-old one is still asked');
}
/* a record kept in the older form is read again from the start */
{ const st={rows:[{k:'old',t:1,ch:'sol',tok:'native',amt:1,usd:null,from:'other'}], addr:{'sol:x':{done:1}}, seen:{a:1}, at:1};
  await exchLedger({cex:[], wallets:[], io:{usdAt:async()=>null, sym:()=>null}, st});
  ok(st.v===2 && st.rows.length===0 && Object.keys(st.addr).length===0 && !st.seen, 'a record in the older form is cleared, to be read again from the first transaction');
}
console.log(fails?fails+' FAILED of '+n:'all '+n+' passed'); process.exit(fails?1:0);

/* CPOOL's Ethereum <-> Solana bridge, read from both chains: is it open, and what last crossed it.

   Public data only: the bridge's own contracts and the crossings anyone can see; no wallet of the
   deck's is read or named. The relay calls readBridge about every half hour and publishes the result
   sealed, like everything else; bridge-probe and the audits call it (or re-read the same facts
   their own way) to check it.

   The bridge is LayerZero's OFT standard (Clearpool's own bridge): on Ethereum an adapter locks
   CPOOL, on Solana an OFT program mints the Solana copy, and the reverse burns it there and unlocks
   it here. "Open" is read, never assumed:
     - the Ethereum adapter names the Solana OFT store as its peer, and the store names it back;
     - neither direction is routed through LayerZero's blocking library, and Solana is not paused;
     - the Solana minter is still that store (a replaced bridge is "changed", not "open");
     - the Solana supply is covered by the CPOOL the adapter holds locked.
   "Working" is the last crossing each way: LayerZero Scan's newest delivered message, then checked
   on both chains: the Ethereum event carries the same message id and amount, and the Solana
   transaction mints (or burns) that amount. Only a crossing seen on both chains is "verified".

   io = { eth(method, params), sol(method, params), get(url) }: each may throw. A failed read is null,
   never a default; a route whose checks cannot be read is unknown, not open. */

export const BRIDGE_V=1;
const EP='0x1a44076050125825900e736c501f859c50fe728c';            // LayerZero v2 endpoint, Ethereum
export const ROUTES=[{ id:'eth-sol', token:'CPOOL', from:'Ethereum', to:'Solana', kind:'LayerZero OFT',
  eidFrom:30101, eidTo:30168,
  adapter:'0xa5ff39ea51c1e2e9152d22b606ddc372ea2b1992',          // CPOOLOFTAdapter (locks CPOOL on Ethereum)
  tokenEth:'0x66761fa41377003622aee3c7675fc7b5c1c2fac5',
  mint:'AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg',           // CPOOL on Solana
  store:'BCtWmFRmrRB7WqjdX3FXK34TybwKu89Uzqne1ZbdYogb',          // its OFT store (the mint authority)
  program:'8hQ8mxZZGPNLAAyTCQ8ButyfqjW5isUBBJWYXbFYxiMv',        // the OFT program that owns it
  peerAcc:'EpXzwJuGhRKJTmXXYhQvxPddsKVGG5GTTnQZmPJC8xzP',        // its peer record for Ethereum: PDA ["Peer", store, 30101 big-endian]
  solDecimals:9,
  /* the route's on-chain history before this reader existed: the adapter's PeerSet events for
     Solana (eid 30168), read on 31 Oct 2026 (block, time, open after it). A set and a clear in the
     same transaction (block 25032905) left it closed and is left out. Later changes are read as
     they happen. */
  seed:[{bn:21925082, t:1740507467000, open:true}, {bn:25032148, t:1778024315000, open:false}, {bn:26051451, t:1790302907000, open:true}] }];

const SEL={peers:'0xbb0b6a53', blocked:'0x73318091', sendLib:'0xb96a277f', recvLib:'0x402f8468', balanceOf:'0x70a08231'};
export const TOPIC={sent:'0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a',   // OFTSent(bytes32,uint32,address,uint256,uint256)
  recv:'0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c',                     // OFTReceived(bytes32,uint32,address,uint256)
  peer:'0x238399d427b947898edb290f5ff0f9109849b1c3ba196a42e35f00c50a54b98b'};                    // PeerSet(uint32,bytes32)
const B58A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', B58M=Object.fromEntries([...B58A].map((c,i)=>[c,i]));
export function b58d(s){let n=0n;for(const c of s){n=n*58n+BigInt(B58M[c]);}const b=[];while(n>0n){b.unshift(Number(n&255n));n>>=8n;}for(const c of s){if(c==='1')b.unshift(0);else break;}return Uint8Array.from(b);}
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const word=(h,i)=>{ const s=String(h||'').replace(/^0x/,'').slice(64*i,64*(i+1)); return s.length===64?BigInt('0x'+s):null; };
const addrArg=a=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0'), u32Arg=n=>n.toString(16).padStart(64,'0');
const lastAddr=h=>h&&String(h).length>=66?'0x'+String(h).replace(/^0x/,'').slice(24,64).toLowerCase():null;
const safe=async f=>{ try{ const v=await f(); return v===undefined?null:v; }catch(e){ return null; } };

/* every string in a message object, with the path it sits at: LayerZero Scan's field names are
   not documented in full, so the hashes are found by shape and by which side of the trip they are on */
function strings(o,path='',out=[]){ if(o==null) return out;
  if(typeof o==='string') out.push([path.toLowerCase(),o]);
  else if(typeof o==='object') for(const [k,v] of Object.entries(o)) strings(v,path+'.'+k,out);
  return out; }
const isEvmHash=s=>/^0x[0-9a-f]{64}$/i.test(s), isSolSig=s=>/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s);
function msgOf(m){
  const S=strings(m), at=(re,test)=>(S.find(([p,v])=>re.test(p)&&test(v))||[])[1]||null;
  const num=k=>{ const v=k.split('.').reduce((a,b)=>a&&a[b],m); return v==null?null:Number(v); };
  const src=num('pathway.srcEid')??num('srcEid'), dst=num('pathway.dstEid')??num('dstEid');
  const guid=(at(/(^|\.)guid$/,isEvmHash)||'').toLowerCase()||null;
  const st=String((m.status&&(m.status.name||m.status))||'').toUpperCase();
  const created=Date.parse(m.created||m.createdAt||'')||null, updated=Date.parse(m.updated||m.updatedAt||'')||null;
  /* the transaction hash, not a block or payload hash that sits beside it */
  const txh=side=>{ for(const re of [new RegExp(side+'.*\\.txhash$'), new RegExp(side+'.*\\.tx\\.hash$'), new RegExp(side+'.*(?<!block|payload|message)hash$')]){
      const v=at(re,s=>(isEvmHash(s)&&s.toLowerCase()!==guid)||isSolSig(s)); if(v) return v; } return at(new RegExp(side),isSolSig); };
  const srcTx=txh('source'), dstTx=txh('destination');
  return {src, dst, guid, st, created, updated, srcTx, dstTx};
}

/* a Solana transaction's CPOOL mints and burns (jsonParsed), as raw amounts */
function tokenMoves(tx,mint){ const out={mint:[],burn:[]}; if(!tx) return out;
  const ins=[...((tx.meta&&tx.meta.innerInstructions)||[]).flatMap(x=>x.instructions||[]), ...((tx.transaction&&tx.transaction.message&&tx.transaction.message.instructions)||[])];
  for(const i of ins){ const p=i&&i.parsed, inf=p&&p.info; if(!inf||inf.mint!==mint) continue;
    const a=BigInt(inf.amount||(inf.tokenAmount&&inf.tokenAmount.amount)||0);
    if(/^mintTo/.test(p.type)) out.mint.push(a); else if(/^burn/.test(p.type)) out.burn.push(a); }
  return out; }

async function readRoute(R, io, prev){
  const now=Date.now(), k=10n**BigInt(18-R.solDecimals), r={id:R.id, token:R.token, from:R.from, to:R.to, kind:R.kind,
    adapter:R.adapter, store:R.store, mint:R.mint, checks:{}, why:[]};
  const call=(to,data)=>safe(()=>io.eth('eth_call',[{to,data},'latest']));
  /* configuration, Ethereum side */
  const blocked=lastAddr(await call(EP,SEL.blocked));
  const peer=await call(R.adapter,SEL.peers+u32Arg(R.eidTo));
  r.checks.peerEth=peer==null?null:(word(peer,0)===BigInt('0x'+hex(b58d(R.store))));
  if(r.checks.peerEth===false) r.why.push(word(peer,0)===0n?'Ethereum no longer names a Solana peer':'Ethereum names a different Solana peer');
  const sl=lastAddr(await call(EP,SEL.sendLib+addrArg(R.adapter)+u32Arg(R.eidTo))), rl=lastAddr(await call(EP,SEL.recvLib+addrArg(R.adapter)+u32Arg(R.eidTo)));
  r.checks.send=!blocked||!sl?null:sl!==blocked; r.checks.recv=!blocked||!rl?null:rl!==blocked;
  if(r.checks.send===false) r.why.push('sending to Solana is blocked'); if(r.checks.recv===false) r.why.push('receiving from Solana is blocked');
  const locked=word(await call(R.tokenEth,SEL.balanceOf+addrArg(R.adapter)),0);
  /* configuration, Solana side */
  const mi=await safe(()=>io.sol('getAccountInfo',[R.mint,{encoding:'jsonParsed'}])), info=mi&&mi.value&&mi.value.data&&mi.value.data.parsed&&mi.value.data.parsed.info;
  r.checks.minter=info?info.mintAuthority===R.store:null;
  if(r.checks.minter===false) r.why.push('the Solana CPOOL minter changed: the bridge was replaced');
  const acc=async a=>{ const v=await safe(()=>io.sol('getAccountInfo',[a,{encoding:'base64'}])); return v&&v.value?{owner:v.value.owner, d:Buffer.from(v.value.data[0],'base64')}:null; };
  const st=await acc(R.store), pa=await acc(R.peerAcc);
  const stOk=st&&st.owner===R.program&&st.d.length>=157&&hex(st.d.subarray(17,49))===hex(b58d(R.mint));
  r.checks.paused=stOk?st.d[156]===1:null;
  if(r.checks.paused) r.why.push('the Solana side is paused');
  r.checks.peerSol=pa&&pa.owner===R.program?hex(pa.d.subarray(8,40))===addrArg(R.adapter):null;
  if(r.checks.peerSol===false) r.why.push('Solana no longer names the Ethereum adapter');
  const supply=info?BigInt(info.supply):null;
  r.supply={sol:supply!=null?Number(supply)/10**R.solDecimals:null, locked:locked!=null?Number(locked/10n**12n)/1e6:null};
  r.checks.supply=supply!=null&&locked!=null?supply*k<=locked:null;
  if(r.checks.supply===false) r.why.push('more CPOOL on Solana than is locked on Ethereum');

  /* crossings: LayerZero Scan's newest messages for the adapter, the latest delivered each way checked on both chains */
  /* newest first, a page of 100 at a time, until the page reaches past 30 days (three pages at most) */
  const base='https://scan.layerzero-api.com/v1/messages/oapp/'+R.eidFrom+'/'+R.adapter+'?limit=100';
  let items=null, more=null;
  for(let pg=0;pg<3;pg++){
    const lz=await safe(()=>io.get(base+(more?'&nextToken='+encodeURIComponent(more):'')));
    const got=lz&&(Array.isArray(lz.data)?lz.data:Array.isArray(lz.messages)?lz.messages:null); if(!got) break;
    items=(items||[]).concat(got);
    more=lz.nextToken||(lz.pagination&&lz.pagination.nextToken)||null;
    const oldest=Math.min(...got.map(m=>Date.parse(m.created||'')||now));
    if(!more||oldest<now-30*864e5||got.length<100) break; }
  r.lz=items?{n:items.length}:null;
  const P=prev&&prev.last||{};
  r.last={in:P.in||null, out:P.out||null};          // a crossing verified earlier stands until a newer one is verified
  if(items){
    const M=items.map(msgOf).filter(x=>x.src&&x.dst), win=now-30*864e5;
    const dir=(a,b)=>M.filter(x=>x.src===a&&x.dst===b);
    const toSol=dir(R.eidFrom,R.eidTo), back=dir(R.eidTo,R.eidFrom), all=[...toSol,...back];
    const oldest=Math.min(...M.map(x=>x.created||now));
    r.n30={to:toSol.filter(x=>x.created>=win).length, back:back.filter(x=>x.created>=win).length, partial:oldest>win&&items.length%100===0};
    r.waiting=all.filter(x=>!/DELIVERED/.test(x.st)&&x.created&&x.created<now-30*60e3).length;
    const pickLast=L=>L.filter(x=>/DELIVERED/.test(x.st)).sort((a,b)=>(b.created||0)-(a.created||0))[0]||null;
    const verify=async(m,way)=>{ if(!m||!m.guid||!m.srcTx||!m.dstTx) return null;
      const evmTx=way==='in'?m.srcTx:m.dstTx, solTx=way==='in'?m.dstTx:m.srcTx;
      if(!isEvmHash(evmTx)||!isSolSig(solTx)) return null;
      const rc=await safe(()=>io.eth('eth_getTransactionReceipt',[evmTx]));
      const lg=((rc&&rc.logs)||[]).find(l=>String(l.address).toLowerCase()===R.adapter&&l.topics&&String(l.topics[1]).toLowerCase()===m.guid
        &&String(l.topics[0]).toLowerCase()===(way==='in'?TOPIC.sent:TOPIC.recv));
      if(!lg) return {t:m.created, src:m.srcTx, dst:m.dstTx, verified:false, note:'no matching Ethereum event'};
      const eid=Number(word(lg.data,0)), amt=word(lg.data,way==='in'?2:1);
      const getTx=()=>safe(()=>io.sol('getTransaction',[solTx,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'finalized'}]));
      let tx=await getTx(); if(!tx){ await new Promise(f=>setTimeout(f,1500)); tx=await getTx(); }   // public nodes drop some reads
      if(!tx){
        /* public nodes do not return an older transaction's contents, but they do return its status:
           finalized with no error, beside the Ethereum event (same message id and amount) and
           LayerZero's delivery, is a crossing seen on both chains; only its amount on Solana is unread */
        const ss=await safe(()=>io.sol('getSignatureStatuses',[[solTx],{searchTransactionHistory:true}])), s0=ss&&ss.value&&ss.value[0];
        if(s0&&!s0.err&&eid===R.eidTo&&s0.confirmationStatus==='finalized'){
          const bt=s0.slot!=null?await safe(()=>io.sol('getBlockTime',[s0.slot])):null;
          return {t:way==='in'?(bt?bt*1000:(m.updated||m.created)):(m.updated||m.created), sent:m.created, src:m.srcTx, dst:m.dstTx, verified:true, via:'status',
            note:'Solana: finalized, no error (its amount could not be read from a public node)'}; }
        return {t:m.created, src:m.srcTx, dst:m.dstTx, verified:false, note:'Solana transaction not read'}; }
      const mv=tokenMoves(tx,R.mint), want=amt/k, ok=eid===R.eidTo&&(tx.meta&&!tx.meta.err)&&(way==='in'?mv.mint:mv.burn).some(a=>a===want);
      const bt=tx.blockTime?tx.blockTime*1000:null;
      const eb=way==='out'&&rc.blockNumber?await safe(()=>io.eth('eth_getBlockByNumber',[rc.blockNumber,false])):null, et=eb?parseInt(eb.timestamp,16)*1000:null;
      // when it arrived: on Solana for a crossing in, on Ethereum for one back
      return {t:way==='in'?(bt||m.updated||m.created):(et||m.updated||m.created), sent:m.created, src:m.srcTx, dst:m.dstTx, verified:!!ok, note:ok?null:'amounts or chain do not match'};
    };
    for(const [way,L] of [['in',toSol],['out',back]]){
      const m=pickLast(L); if(!m) continue;
      if(P[way]&&P[way].src===m.srcTx&&P[way].verified) continue;     // already verified on an earlier read
      const v=await verify(m,way);
      if(v&&(v.verified||!(P[way]&&P[way].verified))) r.last[way]=v;
      else if(v) r.pending=(r.pending||0)+1; }
  }
  /* the route's history: the seed, then any PeerSet for Solana newer than it in the adapter's newest logs */
  const hist=((prev&&Array.isArray(prev.hist)&&prev.hist.length)?prev.hist:R.seed).map(h=>({...h}));
  const bs=await safe(()=>io.get('https://eth.blockscout.com/api/v2/addresses/'+R.adapter+'/logs'));
  if(bs&&Array.isArray(bs.items)){
    const newest=Math.max(...hist.map(h=>h.bn||0));
    const ev=bs.items.filter(l=>l.topics&&String(l.topics[0]).toLowerCase()===TOPIC.peer&&Number(word(l.data,0))===R.eidTo&&+l.block_number>newest)
      .sort((a,b)=>(+a.block_number-+b.block_number)||((+a.index||0)-(+b.index||0)))
      .filter((l,i,a)=>!a[i+1]||+a[i+1].block_number!==+l.block_number);       // a block's last change is what stood
    for(const l of ev){ const b=await safe(()=>io.eth('eth_getBlockByNumber',['0x'+(+l.block_number).toString(16),false]));
      hist.push({t:b?parseInt(b.timestamp,16)*1000:now, open:word(l.data,1)!==0n, bn:+l.block_number}); } }
  r.hist=hist.slice(-12);
  /* if the configuration flipped since the last read and no event explains it yet, note it at this read */
  const cfgOpen=[r.checks.peerEth,r.checks.peerSol,r.checks.send,r.checks.recv].every(x=>x===true)&&r.checks.paused===false&&r.checks.minter!==false;
  const lastH=r.hist[r.hist.length-1];
  if(lastH&&lastH.open!==cfgOpen&&[r.checks.peerEth,r.checks.peerSol,r.checks.send,r.checks.recv,r.checks.paused].every(x=>x!=null)) r.hist.push({t:now, open:cfgOpen, seen:true});
  r.since=(()=>{ for(let i=r.hist.length-1;i>=0;i--) if(r.hist[i].open!==cfgOpen) return r.hist[i+1]?r.hist[i+1].t:null; return r.hist[0]?r.hist[0].t:null; })();
  /* the state */
  const C=r.checks, any=[C.peerEth,C.peerSol,C.send,C.recv,C.paused,C.minter];
  const lastT=Math.max(r.last.in&&r.last.in.verified?r.last.in.t||0:0, r.last.out&&r.last.out.verified?r.last.out.t||0:0)||null;
  r.lastT=lastT;
  if(C.minter===false||C.supply===false) r.state='changed';      // the bridge is not what it was: never shown as open
  else if(C.peerEth===false||C.peerSol===false||C.send===false||C.recv===false||C.paused===true) r.state='closed';
  else if(any.some(x=>x==null)) r.state=null;
  else r.state=lastT&&now-lastT<3*864e5?'open':'quiet';
  return r;
}

export async function readBridge(io, prev){
  const t=Date.now(), routes=[];
  for(const R of ROUTES){ const p=prev&&Array.isArray(prev.routes)?prev.routes.find(x=>x.id===R.id):null;
    try{ routes.push(await readRoute(R,io,p)); }catch(e){ routes.push({id:R.id, token:R.token, from:R.from, to:R.to, state:null, error:String(e&&e.message||e).slice(0,80)}); } }
  return {v:BRIDGE_V, t, routes};
}

/* Is CPOOL's Ethereum <-> Solana bridge open, and is it actually carrying transfers? Run by hand
   (bridge-probe.yml). Public data only: this job is given no passphrase and reads nothing of the
   deck's. It reads the bridge's own contracts on both chains directly, and LayerZero Scan's record
   beside them, and prints contract facts, counts, times and percentages: never a wallet, a
   transaction, a message id, an amount anyone sent, or a pool.

   The bridge, per Clearpool's documentation, is LayerZero's OFT standard: on Ethereum an adapter
   locks CPOOL and on Solana an OFT program mints the Solana copy (and the reverse burns it there and
   unlocks it here). "Open" is then four things anyone can check:
     1. the Ethereum adapter names a Solana peer, and the Solana side names the adapter back;
     2. neither side routes Solana through LayerZero's blocking library, nor is paused;
     3. the Solana copy's supply is covered by what the adapter holds locked;
     4. transfers recently left one chain and arrived on the other (same amount, minutes apart). */
const CPOOL_ETH='0x66761fa41377003622aee3c7675fc7b5c1c2fac5', CPOOL_SOL='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg';
const EP='0x1a44076050125825900e736c501f859c50fe728c', EID_ETH=30101, EID_SOL=30168;
const LZ_SOL_ENDPOINT='76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6';
const TOKEN_PROGS=new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const EID_NAME={30101:'Ethereum',30168:'Solana',30109:'Polygon',30110:'Arbitrum',30111:'Optimism',30184:'Base',30102:'BNB Chain',30106:'Avalanche',30181:'Mantle',30158:'Polygon zkEVM',30295:'Flare',30214:'Scroll',30165:'zkSync',30183:'Linea',30145:'Gnosis'};
const eidName=e=>EID_NAME[e]||('eid '+e);
const ETH_RPC=['https://eth.blockscout.com/api/eth-rpc','https://eth.drpc.org','https://ethereum-rpc.publicnode.com','https://1rpc.io/eth','https://eth.llamarpc.com'];
const SOL_RPC=[process.env.SOL_RPC_URL,'https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com'].filter(Boolean);
const sleep=ms=>new Promise(f=>setTimeout(f,ms));
const now=Date.now(), H=3600e3, D=24*H;
const ago=t=>{ if(!t) return '—'; const m=(now-t)/60e3; return m<90?Math.round(m)+' min ago':m<48*60?(m/60).toFixed(1)+' h ago':(m/1440).toFixed(1)+' days ago'; };
const when=t=>t?new Date(t).toISOString().slice(0,16).replace('T',' ')+' UTC ('+ago(t)+')':'—';

/* keccak-256, so every selector and topic below is computed from its signature here, in the open */
const RC=[1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const ROT=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14], M64=(1n<<64n)-1n;
const rol=(x,n)=>n?((x<<BigInt(n))|(x>>BigInt(64-n)))&M64:x;
function kf(s){ for(let r=0;r<24;r++){ const C=[0,1,2,3,4].map(x=>s[x]^s[x+5]^s[x+10]^s[x+15]^s[x+20]);
  for(let x=0;x<5;x++){ const d=C[(x+4)%5]^rol(C[(x+1)%5],1); for(let y=0;y<25;y+=5) s[y+x]^=d; }
  const B=new Array(25); for(let x=0;x<5;x++) for(let y=0;y<5;y++) B[y+5*((2*x+3*y)%5)]=rol(s[x+5*y],ROT[x+5*y]);
  for(let x=0;x<5;x++) for(let y=0;y<5;y++) s[x+5*y]=B[x+5*y]^((~B[(x+1)%5+5*y])&M64&B[(x+2)%5+5*y]);
  s[0]^=RC[r]; } }
function keccak(str){ const m=[...new TextEncoder().encode(str)], rate=136; m.push(1); while(m.length%rate) m.push(0); m[m.length-1]|=0x80;
  const s=new Array(25).fill(0n);
  for(let o=0;o<m.length;o+=rate){ for(let i=0;i<rate/8;i++){ let v=0n; for(let b=7;b>=0;b--) v=(v<<8n)|BigInt(m[o+i*8+b]); s[i]^=v; } kf(s); }
  let h=''; for(let i=0;i<4;i++){ let v=s[i]; for(let b=0;b<8;b++){ h+=Number(v&0xffn).toString(16).padStart(2,'0'); v>>=8n; } } return '0x'+h; }
const SEL=sig=>keccak(sig).slice(0,10), TOPIC=sig=>keccak(sig);
if(TOPIC('Transfer(address,address,uint256)')!=='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'){ console.log('keccak self-test failed'); process.exit(1); }
const T={sent:TOPIC('OFTSent(bytes32,uint32,address,uint256,uint256)'), recv:TOPIC('OFTReceived(bytes32,uint32,address,uint256)'),
  peer:TOPIC('PeerSet(uint32,bytes32)'), paused:TOPIC('Paused(address)'), unpaused:TOPIC('Unpaused(address)')};

/* base58 and program-derived addresses, without a library */
const B58A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', B58M=Object.fromEntries([...B58A].map((c,i)=>[c,i]));
function b58d(s){let n=0n;for(const c of s){n=n*58n+BigInt(B58M[c]);}const b=[];while(n>0n){b.unshift(Number(n&255n));n>>=8n;}for(const c of s){if(c==='1')b.unshift(0);else break;}return new Uint8Array(b);}
function b58e(bytes){let n=0n;for(const b of bytes)n=(n<<8n)|BigInt(b);let o='';while(n>0n){o=B58A[Number(n%58n)]+o;n/=58n;}for(const b of bytes){if(b===0)o='1'+o;else break;}return o;}
const P=(1n<<255n)-19n, DD=37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function mpow(b,e,m){let r=1n;b%=m;while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n;}return r;}
function onCurve(by){let y=0n;for(let i=31;i>=0;i--)y=(y<<8n)|BigInt(i===31?(by[i]&0x7f):by[i]);if(y>=P)return false;
  const sg=(by[31]&0x80)>>7,y2=y*y%P,u=(y2-1n+P)%P,v=(DD*y2+1n)%P,v3=v*v%P*v%P,uv7=u*(v3*v3%P*v%P)%P;
  let x=u*v3%P*mpow(uv7,(P-5n)/8n,P)%P; const vxx=v*x%P*x%P;
  if(vxx!==u){ if((vxx+u)%P!==0n)return false; x=x*mpow(2n,(P-1n)/4n,P)%P; }
  if(x===0n&&sg===1)return false; return true;}
async function pda(seeds,prog){ const pg=b58d(prog), mk=new TextEncoder().encode('ProgramDerivedAddress');
  for(let bump=255;bump>=0;bump--){ const parts=[...seeds,new Uint8Array([bump]),pg,mk], buf=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));
    let o=0; for(const p of parts){ buf.set(p,o); o+=p.length; }
    const h=new Uint8Array(await crypto.subtle.digest('SHA-256',buf)); if(!onCurve(h)) return b58e(h); }
  return null; }
const pad32=b=>{ const o=new Uint8Array(32); o.set(b.slice(-32),32-Math.min(32,b.length)); return o; };
const hexBytes=h=>Uint8Array.from(String(h).replace(/^0x/,'').match(/../g)||[],x=>parseInt(x,16));
const sameBytes=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>x===b[i]);

/* the network: several public endpoints, the first real answer wins, a failure is null (never a default) */
async function get(url,init,tries=2){ for(let k=0;k<tries;k++){ try{ const r=await fetch(url,{...init,signal:AbortSignal.timeout(20000),headers:{accept:'application/json','content-type':'application/json','user-agent':'k-telemetry-bridge-probe'}});
  if(r.ok) return await r.json(); if(r.status===404) return {__status:404}; }catch(e){} await sleep(800*(k+1)); } return null; }
async function eth(method,params){ for(const u of ETH_RPC){ const r=await get(u,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1);
  if(r&&r.result!==undefined&&!r.error) return r.result; } return null; }
const call=(to,data,tag='latest')=>eth('eth_call',[{to,data},tag]);
const word=(h,i)=>{ const s=String(h||'').replace(/^0x/,'').slice(64*i,64*(i+1)); return s.length===64?BigInt('0x'+s):null; };
const addrArg=a=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0'), u32Arg=n=>n.toString(16).padStart(64,'0');
async function sol(method,params){ for(const u of SOL_RPC){ for(let k=0;k<3;k++){ const r=await get(u,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},1);
  if(r&&r.result!==undefined&&!r.error) return r.result; if(r&&r.error&&!/rate|limit|busy|too many/i.test(JSON.stringify(r.error))) break; await sleep(1000*2**k); } } return null; }
const solAcc=async a=>{ const r=await sol('getAccountInfo',[a,{encoding:'base64'}]); return r&&r.value?{owner:r.value.owner, data:Uint8Array.from(Buffer.from(r.value.data[0],'base64'))}:null; };

const out=[]; const say=(s='')=>{ out.push(s); console.log(s); };
const verdicts=[];   // [label, ok|warn|unknown]
const mark=(label,v)=>verdicts.push([label,v]);

/* ---------- Ethereum: the endpoint, then the adapter that holds CPOOL locked ---------- */
say('— Ethereum —');
const epEid=word(await call(EP,SEL('eid()')),0), blocked=await call(EP,SEL('blockedLibrary()'));
const BLOCKED=blocked?'0x'+String(blocked).slice(26,66).toLowerCase():null;
say('LayerZero endpoint: '+(epEid===BigInt(EID_ETH)?'answers as Ethereum (eid 30101)':'did not answer as expected')+' · its blocking library: '+(BLOCKED?'read':'not read'));
const supplyEth=word(await call(CPOOL_ETH,SEL('totalSupply()')),0);

let holders=[];
{ const r=await get('https://eth.blockscout.com/api/v2/tokens/'+CPOOL_ETH+'/holders');
  if(r&&Array.isArray(r.items)) holders=r.items.filter(x=>x.address&&x.address.is_contract).map(x=>({a:String(x.address.hash).toLowerCase(), name:x.address.name||null}));
  if(!holders.length){ const e=await get('https://api.ethplorer.io/getTopTokenHolders/'+CPOOL_ETH+'?apiKey=freekey&limit=100');
    for(const h of (e&&e.holders)||[]){ const code=await eth('eth_getCode',[h.address,'latest']); if(code&&code!=='0x') holders.push({a:String(h.address).toLowerCase(), name:null}); } } }
say('contracts among the largest CPOOL holders, read: '+holders.length);
let A=null;
for(const h of holders.slice(0,40)){
  const ep=await call(h.a,SEL('endpoint()')), tok=await call(h.a,SEL('token()'));
  const epA=ep&&ep.length>=66?'0x'+ep.slice(26,66).toLowerCase():null, tokA=tok&&tok.length>=66?'0x'+tok.slice(26,66).toLowerCase():null;
  if(epA===EP&&tokA===CPOOL_ETH){ A=h; break; }
  const v1=await call(h.a,SEL('lzEndpoint()'));
  if(v1&&v1.length>=66&&tokA===CPOOL_ETH) say('  an older LayerZero v1 CPOOL adapter is also among the holders ('+(h.name||'unnamed')+', '+h.a+')');
}
let lockedEth=null, peerSol=null;
if(!A){ say(holders.length?'NOT FOUND: no LayerZero v2 adapter for CPOOL among the largest holders':'the largest holders could not be read'); mark('Ethereum adapter found', holders.length?'warn':'unknown'); }
else {
  say('adapter: '+A.a+(A.name?' ('+A.name+')':'')+' · endpoint is LayerZero v2 · token is CPOOL');
  mark('Ethereum adapter found','ok');
  lockedEth=word(await call(CPOOL_ETH,SEL('balanceOf(address)')+addrArg(A.a)),0);
  if(lockedEth!=null&&supplyEth) say('CPOOL locked in it: '+(Number(lockedEth*10000n/supplyEth)/100).toFixed(2)+'% of all CPOOL (≈'+(Number(lockedEth/10n**18n)/1e6).toFixed(2)+'M)');
  const own=await call(A.a,SEL('owner()')); if(own) say('owner (who can close or reopen it): 0x'+own.slice(26,66));
  const ap=await call(A.a,SEL('approvalRequired()')); if(ap!=null) say('lock-and-release adapter (needs an approval to send): '+(word(ap,0)===1n?'yes':'no'));
  const pr=await call(A.a,SEL('peers(uint32)')+u32Arg(EID_SOL));
  peerSol=pr&&/^0x0*$/.test(pr)===false?hexBytes(pr):null;
  say('Solana peer set: '+(pr==null?'not read':peerSol?'yes → '+b58e(peerSol):'NO (cleared: the route to Solana is closed)'));
  mark('Ethereum names a Solana peer', pr==null?'unknown':peerSol?'ok':'warn');
  const sl=await call(EP,SEL('getSendLibrary(address,uint32)')+addrArg(A.a)+u32Arg(EID_SOL)), rl=await call(EP,SEL('getReceiveLibrary(address,uint32)')+addrArg(A.a)+u32Arg(EID_SOL));
  const sLib=sl&&sl.length>=66?'0x'+sl.slice(26,66).toLowerCase():null, rLib=rl&&rl.length>=66?'0x'+rl.slice(26,66).toLowerCase():null;
  say('Ethereum → Solana send library: '+(sLib?(sLib===BLOCKED?'BLOCKED (the owner shut sending)':'a working library'):'not read')
    +' · Solana → Ethereum receive library: '+(rLib?(rLib===BLOCKED?'BLOCKED (the owner shut receiving)':'a working library'):'not read'));
  mark('neither direction on the blocking library', !sLib||!rLib||!BLOCKED?'unknown':(sLib!==BLOCKED&&rLib!==BLOCKED)?'ok':'warn');
  const pz=await call(A.a,SEL('paused()')); say('pause switch: '+(pz==null?'none (or not readable)':word(pz,0)===1n?'PAUSED':'not paused'));
  if(pz!=null) mark('Ethereum side not paused', word(pz,0)===1n?'warn':'ok');
  const rlim=await call(A.a,SEL('rateLimits(uint32)')+u32Arg(EID_SOL)); if(rlim&&rlim.length>=2+64*4) say('rate limit to Solana: '+(word(rlim,2)===0n?'ZERO (nothing can pass)':'set'));
}

/* the adapter's own events, newest first, from Blockscout's index of its logs (the public RPCs
   refused most 30-day ranges with getLogs): transfers each way and their message ids for 30 days;
   peer changes and pauses as far back as the pages read go. Falls back to getLogs over 7 days. */
const sentSol=[], recvSol=[], byEid={}, guids=new Set(); const peerChanges=[], pauses=[]; let seen=0, src='none', reach=null;
if(A){
  const tip=parseInt(await eth('eth_blockNumber',[]),16), cut=tip-30*7200;
  const take=(tp,data,bn,recent)=>{ const k=tp[0];
    if(k===T.sent&&recent){ const e=Number(word(data,0)), amt=word(data,2); (byEid[e]=byEid[e]||{out:0,in:0}).out++; guids.add(String(tp[1]).toLowerCase()); if(e===EID_SOL) sentSol.push({bn,amt}); }
    else if(k===T.recv&&recent){ const e=Number(word(data,0)), amt=word(data,1); (byEid[e]=byEid[e]||{out:0,in:0}).in++; guids.add(String(tp[1]).toLowerCase()); if(e===EID_SOL) recvSol.push({bn,amt}); }
    else if(k===T.peer) peerChanges.push({bn, eid:Number(word(data,0)), cleared:word(data,1)===0n});
    else if(k===T.paused||k===T.unpaused) pauses.push({bn, on:k===T.paused}); };
  let next=null;
  for(let page=0;page<40;page++){
    const r=await get('https://eth.blockscout.com/api/v2/addresses/'+A.a+'/logs'+(next?'?'+new URLSearchParams(next).toString():''));
    if(!r||!Array.isArray(r.items)) break; src='Blockscout';
    for(const l of r.items){ seen++; const bn=+l.block_number; reach=bn; take((l.topics||[]).map(x=>x&&String(x).toLowerCase()), l.data, bn, bn>=cut); }
    if(!r.next_page_params) break; next=r.next_page_params; await sleep(250); }
  if(src==='none'&&tip){ src='getLogs (7 days)'; let unread=0;
    for(let a=tip-7*7200;a<=tip;a+=3000){
      const r=await eth('eth_getLogs',[{address:A.a,fromBlock:'0x'+a.toString(16),toBlock:'0x'+Math.min(tip,a+2999).toString(16),topics:[[T.sent,T.recv,T.peer,T.paused,T.unpaused]]}]);
      if(!Array.isArray(r)){ unread++; continue; } for(const l of r){ seen++; take(l.topics.map(x=>x.toLowerCase()), l.data, parseInt(l.blockNumber,16), true); } }
    if(unread) say('  '+unread+' block ranges could not be read'); }
  sentSol.sort((x,y)=>x.bn-y.bn); recvSol.sort((x,y)=>x.bn-y.bn);
  const tsOf=async bn=>{ const b=await eth('eth_getBlockByNumber',['0x'+bn.toString(16),false]); return b?parseInt(b.timestamp,16)*1000:null; };
  for(const x of [...sentSol.slice(-30),...recvSol.slice(-30),...peerChanges.slice(0,12),...pauses.slice(0,12)]) x.t=await tsOf(x.bn);
  say('adapter events read from '+src+': '+seen+' log entries'+(reach?' (back to block '+reach+'; 30 days ago ≈ block '+cut+')':''));
  say('transfers in the last 30 days, by chain:');
  for(const [e,c] of Object.entries(byEid).sort((x,y)=>(y[1].out+y[1].in)-(x[1].out+x[1].in))) say('  '+eidName(+e)+': sent there '+c.out+' · arrived from there '+c.in);
  if(!Object.keys(byEid).length) say('  none either way'+(reach&&reach>cut?' in the entries read':''));
  const lastS=sentSol.length?sentSol[sentSol.length-1].t:null, lastR=recvSol.length?recvSol[recvSol.length-1].t:null;
  say('last Ethereum → Solana send: '+when(lastS)+' · last Solana → Ethereum arrival: '+when(lastR));
  say('peer history in the entries read (newest first): '+(peerChanges.length?peerChanges.slice(0,12).map(p=>eidName(p.eid)+(p.cleared?' CLEARED':' set')+' '+(p.t?new Date(p.t).toISOString().slice(0,10):'@'+p.bn)).join(' · '):'no peer changes'));
  if(pauses.length) say('pauses: '+pauses.slice(0,12).map(p=>(p.on?'PAUSED ':'unpaused ')+(p.t?new Date(p.t).toISOString().slice(0,10):'@'+p.bn)).join(' · '));
}
/* ---------- Solana: the mint, who may mint it, and whether that side is configured and open ---------- */
say(''); say('— Solana —');
let solDec=null, solSupply=null, store=null, storeProg=null, storeOk=false;
{ const r=await sol('getAccountInfo',[CPOOL_SOL,{encoding:'jsonParsed'}]); const v=r&&r.value, info=v&&v.data&&v.data.parsed&&v.data.parsed.info;
  if(!info) say('CPOOL mint: not read');
  else { solDec=info.decimals; solSupply=BigInt(info.supply);
    say('CPOOL mint: '+(TOKEN_PROGS.has(v.owner)?'an SPL token':'owned by '+v.owner)+' · decimals '+solDec+' · supply ≈'+(Number(solSupply)/10**solDec/1e6).toFixed(3)+'M · freeze authority: '+(info.freezeAuthority?'yes':'none'));
    const ma=info.mintAuthority; say('mint authority: '+(ma||'none (fixed supply: nothing can bridge in)'));
    if(ma){ const acc=await solAcc(ma);
      const isStore=a=>a&&a.data.length>=157&&sameBytes(a.data.slice(17,49),b58d(CPOOL_SOL));
      if(isStore(acc)){ store=ma; storeProg=acc.owner; }
      else if(acc&&TOKEN_PROGS.has(acc.owner)&&acc.data.length>=355){   // an SPL multisig: look for the OFT store among its signers
        const n=acc.data[1]; say('  it is an SPL multisig: '+acc.data[0]+' of '+n+' signers');
        for(let i=0;i<n;i++){ const s=b58e(acc.data.slice(3+32*i,35+32*i)), sa=await solAcc(s); if(isStore(sa)){ store=s; storeProg=sa.owner; say('  one signer is the OFT store'); } } }
      if(store){ const a=await solAcc(store), d=a.data;
        storeOk=sameBytes(d.slice(81,113),b58d(LZ_SOL_ENDPOINT));
        say('OFT store: '+store+' · program '+storeProg+' · type '+(d[8]===0?'native (mints and burns)':d[8]===1?'adapter (escrow)':'unknown')
          +' · endpoint is LayerZero\'s: '+(storeOk?'yes':'NO')+' · paused: '+(d[156]===1?'YES':d[156]===0?'no':'?'));
        mark('Solana side not paused', d[156]===0?'ok':d[156]===1?'warn':'unknown');
        if(peerSol) { const m=sameBytes(peerSol,b58d(store)); say('the Ethereum adapter\'s Solana peer is this OFT store: '+(m?'yes':'no ('+b58e(peerSol)+')')); mark('the two sides name each other (Ethereum → Solana)', m?'ok':'warn'); }
        // the store's peer record for Ethereum: seeds ["Peer", store, eid] (big-endian per LayerZero; little-endian tried too)
        let found=false;
        for(const be of [true,false]){ const e=new Uint8Array(4); new DataView(e.buffer).setUint32(0,EID_ETH,!be ? true : false);
          const pc=await pda([new TextEncoder().encode('Peer'), b58d(store), e], storeProg), acc2=pc&&await solAcc(pc);
          if(acc2&&acc2.owner===storeProg){ found=true; const back=acc2.data.slice(8,40);
            const m=A&&sameBytes(back,pad32(hexBytes(A.a))); say('Solana\'s peer for Ethereum ('+(be?'big':'little')+'-endian seed): '+(m?'the adapter above':'another address 0x'+Buffer.from(back.slice(12)).toString('hex')));
            mark('the two sides name each other (Solana → Ethereum)', m?'ok':'warn'); break; } }
        if(!found){ say('Solana\'s peer record for Ethereum: not found'); mark('the two sides name each other (Solana → Ethereum)','unknown'); }
      } else { say('no LayerZero OFT store recognised behind the mint authority (its owner program: '+(acc?acc.owner:'not read')+', '+(acc?acc.data.length+' bytes':'—')+')'); mark('Solana OFT store recognised','unknown'); } }
    if(solSupply!=null&&lockedEth!=null){ const s18=solSupply*10n**BigInt(18-solDec), ok=s18<=lockedEth;
      say('Solana supply covered by CPOOL locked on Ethereum: '+(ok?'yes':'NO')+' (Solana is '+(Number(s18*10000n/(lockedEth||1n))/100).toFixed(2)+'% of the locked amount; the rest backs the other chains)');
      mark('Solana supply ≤ locked on Ethereum', ok?'ok':'warn'); } } }

/* Solana-side bridge transactions: mints are arrivals, burns are departures. Matched to the Ethereum
   events by exact amount (after the decimal conversion) within two hours: a transfer seen leaving
   one chain and arriving on the other is a verified crossing. */
const solIn=[], solOut=[]; let solFailed=0, solSigs=0;
if(store){ const sigs=await sol('getSignaturesForAddress',[store,{limit:100}])||[]; solSigs=sigs.length;
  const recent=sigs.filter(s=>s.blockTime&&s.blockTime*1000>now-30*D);
  say('OFT store transactions, last 30 days: '+recent.length+(sigs.length===100?' (100 read: there may be more)':'')+' · 24 h: '+recent.filter(s=>s.blockTime*1000>now-D).length+' · 7 d: '+recent.filter(s=>s.blockTime*1000>now-7*D).length);
  for(const s of recent.slice(0,30)){ if(s.err){ solFailed++; continue; }
    const tx=await sol('getTransaction',[s.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0}]); if(!tx) continue;
    const ins=[...(tx.meta&&tx.meta.innerInstructions||[]).flatMap(x=>x.instructions), ...(tx.transaction.message.instructions||[])];
    for(const i of ins){ const p=i.parsed, inf=p&&p.info; if(!inf||inf.mint!==CPOOL_SOL) continue;
      const amt=BigInt(inf.amount||(inf.tokenAmount&&inf.tokenAmount.amount)||0);
      if(/^mintTo/.test(p.type)) solIn.push({t:s.blockTime*1000, amt}); else if(/^burn/.test(p.type)) solOut.push({t:s.blockTime*1000, amt}); }
    await sleep(120); }
  say('read: arrivals on Solana (mints) '+solIn.length+' · departures from Solana (burns) '+solOut.length+(solFailed?' · failed transactions skipped '+solFailed:''));
  const k=solDec!=null?10n**BigInt(18-solDec):1n;
  const matchAB=(src,dst,conv,lagMax)=>src.filter(x=>x.t&&dst.some(y=>y.t&&y.t>=x.t-5*60e3&&y.t<=x.t+lagMax&&conv(x.amt)===y.amt));
  const crossIn=matchAB(sentSol,solIn,a=>a/k,2*H), crossOut=matchAB(solOut,recvSol,a=>a*k,2*H);
  const lastIn=crossIn.length?Math.max(...crossIn.map(x=>x.t)):null, lastOut=crossOut.length?Math.max(...crossOut.map(x=>x.t)):null;
  say('VERIFIED crossings (left one chain, arrived on the other, same amount): Ethereum → Solana '+crossIn.length+' of '+sentSol.filter(x=>x.t).length+' read, last '+when(lastIn)
    +' · Solana → Ethereum '+crossOut.length+' of '+solOut.length+' read, last '+when(lastOut));
  mark('a verified crossing in the last 30 days', (crossIn.length+crossOut.length)?'ok':'unknown');
}

/* ---------- LayerZero Scan, beside the chains (counts and states only) ---------- */
say(''); say('— LayerZero Scan —');
if(A){ const urls=['https://scan.layerzero-api.com/v1/messages/oapp/'+EID_ETH+'/'+A.a+'?limit=100','https://scan.layerzero-api.com/v1/messages/wallet/'+A.a+'?limit=100'];
  let got=false;
  for(const u of urls){ const r=await get(u); const items=r&&(Array.isArray(r.data)?r.data:Array.isArray(r.messages)?r.messages:null);
    say(u.split('/v1/')[1].split('/')[1]+' query: '+(r==null?'no answer':r.__status===404?'404':items?items.length+' messages':'answered (unrecognised shape: '+Object.keys(r).slice(0,6).join(',')+')'));
    if(!items||!items.length) continue; got=true;
    const pick=(o,...ks)=>{ for(const k of ks){ const v=k.split('.').reduce((a,b)=>a&&a[b],o); if(v!=null) return v; } return null; };
    const rows=items.map(m=>({src:+pick(m,'pathway.srcEid','srcEid','source.eid'), dst:+pick(m,'pathway.dstEid','dstEid','destination.eid'),
      st:String(pick(m,'status.name','status','destination.status')||'?'), t:Date.parse(pick(m,'created','createdAt','source.tx.blockTimestamp')||'')||null}));
    for(const [s,d] of [[EID_ETH,EID_SOL],[EID_SOL,EID_ETH]]){ const p=rows.filter(x=>x.src===s&&x.dst===d), st={};
      for(const x of p) st[x.st]=(st[x.st]||0)+1;
      const del=p.filter(x=>/DELIVERED/i.test(x.st)).map(x=>x.t).filter(Boolean);
      say('  '+eidName(s)+' → '+eidName(d)+': '+p.length+' in the latest '+items.length+' · '+(Object.entries(st).map(([k,n])=>k+' '+n).join(', ')||'—')+' · last delivered '+when(del.length?Math.max(...del):null)); }
    if(!rows.some(x=>x.src)) say('  first item fields: '+Object.keys(items[0]).slice(0,12).join(','));
    { const ids=items.map(m=>String(pick(m,'guid','pathway.guid','id')||'').toLowerCase()).filter(x=>/^0x[0-9a-f]{64}$/.test(x)), on=ids.filter(x=>guids.has(x)).length;
      say('  the same message ids seen in the Ethereum adapter\u2019s own events: '+on+' of '+ids.length+' (older ones fall outside the 30 days read)'); }
    break; }
  if(!got) say('LayerZero Scan gave no messages for the adapter (the chains above are the record that counts)');
}

/* ---------- the price gap: what the arbitrage that crosses this bridge sees ---------- */
say(''); say('— price gap —');
{ const ll=await get('https://coins.llama.fi/prices/current/ethereum:'+CPOOL_ETH), pe=ll&&ll.coins&&ll.coins['ethereum:'+CPOOL_ETH]&&ll.coins['ethereum:'+CPOOL_ETH].price;
  const ds=await get('https://api.dexscreener.com/tokens/v1/solana/'+CPOOL_SOL), pairs=Array.isArray(ds)?ds:[];
  const best=pairs.filter(p=>p&&p.priceUsd&&p.liquidity&&p.liquidity.usd>0).sort((a,b)=>b.liquidity.usd-a.liquidity.usd)[0];
  const jp=await get('https://lite-api.jup.ag/price/v3?ids='+CPOOL_SOL), pj=jp&&jp[CPOOL_SOL]&&jp[CPOOL_SOL].usdPrice;
  const pct=(x,r)=>!(x>0&&r>0)?'—':((x/r-1)>=0?'+':'−')+Math.abs((x/r-1)*100).toFixed(1)+'%';
  say('Solana CPOOL against Ethereum CPOOL: busiest Solana pool '+pct(best&&+best.priceUsd,pe)+' · Jupiter '+pct(pj,pe)+' (a small gap means arbitrage is crossing; a wide one that lasts means it cannot)'); }

say(''); say('— verdict —');
for(const [l,v] of verdicts) say((v==='ok'?'ok   ':v==='warn'?'WARN ':'?    ')+l);
const warn=verdicts.filter(v=>v[1]==='warn').length, ok=verdicts.filter(v=>v[1]==='ok').length;
say('bridge Ethereum ↔ Solana: '+(warn?'NOT CLEARLY OPEN ('+warn+' check(s) failed)':ok>=5?'OPEN (every check that could be read passed)':'UNCLEAR (too few checks could be read)'));

/* ---------- the relay's reader (scripts/bridge.mjs), run here first on the same public data ----------
   States, checks and times only: never a transaction hash or a message id. */
say(''); say('— the relay’s reader (bridge.mjs) —');
{ const {readBridge}=await import('./bridge.mjs');
  const io={eth:(m,p)=>eth(m,p), sol:(m,p)=>sol(m,p), get:u=>get(u)};
  const d=(t,v)=>t?when(t)+(v===false?' (NOT verified)':v?' (verified on both chains)':''):'—';
  for(const pass of [1,2]){
    const B=await readBridge(io, pass===2?globalThis.__b1:null); if(pass===1) globalThis.__b1=B;
    for(const r of B.routes){ const c=r.checks||{};
      say('read '+pass+': '+r.from+' → '+r.to+' · state '+(r.state||'unknown')+(r.why&&r.why.length?' ('+r.why.join('; ')+')':'')
        +' · checks: '+Object.entries(c).map(([k,v])=>k+'='+(v==null?'?':v)).join(' '));
      say('  last in (to Solana): '+d(r.last&&r.last.in&&r.last.in.t, r.last&&r.last.in&&r.last.in.verified)+(r.last&&r.last.in&&r.last.in.note?' · '+r.last.in.note:'')
        +' · last out (to Ethereum): '+d(r.last&&r.last.out&&r.last.out.t, r.last&&r.last.out&&r.last.out.verified)+(r.last&&r.last.out&&r.last.out.note?' · '+r.last.out.note:''));
      say('  30 days: '+(r.n30?r.n30.to+' to Solana · '+r.n30.back+' back'+(r.n30.partial?' (at least)':''):'—')+' · waiting over 30 min: '+(r.waiting??'—')
        +' · supply covered: '+(c.supply==null?'?':c.supply)+' ('+(r.supply&&r.supply.sol!=null?r.supply.sol.toFixed(2):'—')+' on Solana, '+(r.supply&&r.supply.locked!=null?r.supply.locked.toFixed(2):'—')+' locked)'
        +' · open since '+(r.since?new Date(r.since).toISOString().slice(0,10):'—')+' · history: '+(r.hist||[]).map(h=>new Date(h.t).toISOString().slice(0,10)+(h.open?' open':' shut')).join(', ')
        +(r.pending?' · newer crossing not yet verified: '+r.pending:'')+(r.error?' · error: '+r.error:''));
    } } }

/* ---------- why can the last Ethereum → Solana crossing not be read on Solana? Shapes and outcomes only ---------- */
say(''); say('— diagnosis: the Solana side of the last crossing to Solana —');
{ const lz=await get('https://scan.layerzero-api.com/v1/messages/oapp/30101/'+'0xa5ff39ea51c1e2e9152d22b606ddc372ea2b1992'+'?limit=100'), items=lz&&Array.isArray(lz.data)?lz.data:[];
  const m=items.filter(x=>x.pathway&&+x.pathway.srcEid===30101&&+x.pathway.dstEid===30168&&/DELIVERED/.test(String(x.status&&x.status.name))).sort((a,b)=>Date.parse(b.created)-Date.parse(a.created))[0];
  if(!m) say('no delivered message to Solana in the latest 100');
  else { const shape=v=>/^0x[0-9a-f]{64}$/i.test(v)?'evm-hash':/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v)?'sol-signature('+v.length+')':/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)?'sol-address':/^\d{4}-\d\d-\d\dT/.test(v)?'time':v.length>40?'long('+v.length+')':'short';
    const out=[]; const walk=(o,p)=>{ if(o==null) return; if(typeof o==='string'){ out.push(p+'='+shape(o)); return; } if(typeof o==='number'||typeof o==='boolean'){ out.push(p+'=#'); return; } if(typeof o==='object') for(const [k,v] of Object.entries(o)) walk(v,p+'.'+k); };
    walk(m.destination,'destination'); say('destination fields: '+out.join(' '));
    const sigs=[]; const grab=(o)=>{ if(o==null) return; if(typeof o==='string'){ if(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(o)) sigs.push(o); return; } if(typeof o==='object') for(const v of Object.values(o)) grab(v); }; grab(m.destination);
    say('signatures under destination: '+sigs.length);
    for(const [i,s] of sigs.entries()){
      for(const [lab,opt] of [['finalized v0',{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'finalized'}],['confirmed v0',{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}],['no options',{encoding:'jsonParsed'}]]){
        const r=await sol('getTransaction',[s,opt]);
        const ins=r?[...((r.meta&&r.meta.innerInstructions)||[]).flatMap(x=>x.instructions||[]),...((r.transaction&&r.transaction.message&&r.transaction.message.instructions)||[])]:[];
        const kinds=ins.filter(x=>x.parsed&&x.parsed.info&&x.parsed.info.mint==='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg').map(x=>x.parsed.type).join(',')||'none';
        say('  signature #'+(i+1)+' getTransaction ('+lab+'): '+(r?'read'+(r.meta&&r.meta.err?' (failed tx)':'')+' · CPOOL mint/burn instructions: '+kinds:'null'));
        await sleep(400); }
      const st=await sol('getSignatureStatuses',[[s],{searchTransactionHistory:true}]); say('  signature #'+(i+1)+' status: '+(st&&st.value&&st.value[0]?(st.value[0].confirmationStatus||'?')+(st.value[0].err?' with an error':''):'not found')); } } }

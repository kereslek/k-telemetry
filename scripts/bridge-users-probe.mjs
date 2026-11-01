/* Who uses CPOOL's Ethereum <-> Solana bridge, and what moves them? A one-off analysis (nothing is built from
   it). Public chain and market data only, and this log is public, so:
   - wallets are never shown: each is a rank (W1 = the Ethereum party with the most crossings of all time;
     S1 = the same on Solana), and contracts are said as "a contract";
   - no single pool's size or volume is shown (one of them may be the owner's): Solana's CPOOL market is
     said as a total, and prices come from each chain's busiest CPOOL pool, unnamed.
   Sections: A every crossing since the route opened, by Ethereum party; B since it reopened, the Solana
   party of each crossing and whether the same entity works both sides; C the price gap between the two
   chains hour by hour, beside the crossings; D what a round trip costs. */
const A='0xa5ff39ea51c1e2e9152d22b606ddc372ea2b1992', CPOOL_E='0x66761fa41377003622aee3c7675fc7b5c1c2fac5', CPOOL_S='AeXrLftu8chuY4ctc6oDeG4dUx6Yr4aqeakUMFNvACdg';
const FIRST=21925082, REOPEN=Date.parse('2026-09-25T00:00:00Z'), SHUT=Date.parse('2026-05-06T00:00:00Z'), EID_SOL=30168, EID_ETH=30101;
const T_SENT='0x85496b760a4b7f8d66384b9df21b381f5d1b1e79f229a47aaf4c232edc2fe59a', T_RECV='0xefed6d3500546b29533b128a29e3a94d70788727f0507505ac12eaf2e578fd9c';
const ETH_RPC=['https://eth.drpc.org','https://ethereum-rpc.publicnode.com','https://1rpc.io/eth','https://eth.blockscout.com/api/eth-rpc'];
const SOL_RPC=[process.env.SOL_RPC_URL,'https://api.mainnet-beta.solana.com'].filter(Boolean);
const sleep=ms=>new Promise(f=>setTimeout(f,ms)), now=Date.now(), D=864e5, H=36e5;
const say=(s='')=>console.log(s), pct=(a,b)=>b?Math.round(a/b*100)+'%':'—', day=t=>new Date(t).toISOString().slice(0,10);
async function get(u,tries=3){ for(let k=0;k<tries;k++){ try{ const r=await fetch(u,{signal:AbortSignal.timeout(25000),headers:{accept:'application/json','user-agent':'k-telemetry-bridge-analysis'}});
  if(r.ok) return await r.json(); if(r.status===429) await sleep(6000); }catch(e){} await sleep(1500*(k+1)); } return null; }
async function rpc(urls,method,params){ for(const u of urls){ for(let k=0;k<2;k++){ try{ const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(25000)});
  if(r.ok){ const j=await r.json(); if(j.result!=null&&!j.error) return j.result; if(j.result===null) break; } else if(r.status===429) await sleep(3000); }catch(e){} await sleep(600); } } return null; }
const word=(h,i)=>{ const s=String(h||'').replace(/^0x/,'').slice(64*i,64*(i+1)); return s.length===64?BigInt('0x'+s):null; };
const median=a=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
const fmtK=v=>v==null?'—':v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(1)+'k':v.toFixed(0);

/* ---------- A: every crossing since the route opened, by its Ethereum party ---------- */
say('— A. every crossing since the route opened (Feb 2025), by its Ethereum party —');
const ev=[]; { let next=null, pages=0;
  for(;pages<150;pages++){ const r=await get('https://eth.blockscout.com/api/v2/addresses/'+A+'/logs'+(next?'?'+new URLSearchParams(next).toString():''),8); if(!r||!Array.isArray(r.items)){ say('!! the Ethereum log read stopped early at page '+pages+' — the counts below are incomplete'); break; }
    let old=false;
    for(const l of r.items){ const bn=+l.block_number; if(bn<FIRST){ old=true; continue; } const t0=String(l.topics&&l.topics[0]).toLowerCase();
      const party=l.topics&&l.topics[2]?('0x'+String(l.topics[2]).slice(26)).toLowerCase():null;
      if(t0===T_SENT&&Number(word(l.data,0))===EID_SOL) ev.push({bn, dir:'in', party, guid:String(l.topics[1]).toLowerCase(), amt:Number(word(l.data,2)/10n**12n)/1e6, tx:l.transaction_hash});
      else if(t0===T_RECV&&Number(word(l.data,0))===EID_SOL) ev.push({bn, dir:'out', party, guid:String(l.topics[1]).toLowerCase(), amt:Number(word(l.data,1)/10n**12n)/1e6, tx:l.transaction_hash}); }
    if(old||!r.next_page_params) break; next=r.next_page_params; await sleep(200); }
  const tip=parseInt(await rpc(ETH_RPC,'eth_blockNumber',[]),16), anchors=[];
  for(let bn=FIRST;bn<tip;bn+=100000){ const b=await rpc(ETH_RPC,'eth_getBlockByNumber',['0x'+bn.toString(16),false]); if(b) anchors.push([bn,parseInt(b.timestamp,16)*1000]); }
  { const b=await rpc(ETH_RPC,'eth_getBlockByNumber',['0x'+tip.toString(16),false]); if(b) anchors.push([tip,parseInt(b.timestamp,16)*1000]); }
  const tOf=bn=>{ for(let i=1;i<anchors.length;i++) if(bn<=anchors[i][0]){ const [b0,t0]=anchors[i-1],[b1,t1]=anchors[i]; return t0+(t1-t0)*(bn-b0)/(b1-b0); } return anchors.at(-1)[1]; };
  for(const e of ev) e.t=tOf(e.bn); ev.sort((a,b)=>a.t-b.t); }
say('crossings found: '+ev.length+' ('+ev.filter(e=>e.dir==='in').length+' to Solana, '+ev.filter(e=>e.dir==='out').length+' back) · last one '+(ev.length?new Date(ev.at(-1).t).toISOString().slice(0,16)+' UTC':'—'));
// ranks of Ethereum parties, all time
const byP=new Map(); for(const e of ev){ const p=byP.get(e.party)||{n:0,v:0,in:0,out:0,first:e.t,last:e.t}; p.n++; p.v+=e.amt; p[e.dir]++; p.last=e.t; byP.set(e.party,p); }
const rank=[...byP.entries()].sort((a,b)=>b[1].n-a[1].n), W=new Map(rank.map(([a],i)=>[a,'W'+(i+1)]));
const kind={}; for(const [a] of rank.slice(0,12)){ const c=await rpc(ETH_RPC,'eth_getCode',[a,'latest']); kind[a]=c&&c!=='0x'?'a contract':'a wallet'; }
const periods=[['first period (25 Feb 2025 – 5 May 2026)',0,SHUT],['since it reopened (25 Sep 2026)',REOPEN,now+1],['last 30 days',now-30*D,now+1],['last 7 days',now-7*D,now+1],['last 3 days',now-3*D,now+1]];
for(const [lab,a,b] of periods){ const L=ev.filter(e=>e.t>=a&&e.t<b); if(!L.length){ say(lab+': no crossings'); continue; }
  const m=new Map(); for(const e of L){ const p=m.get(e.party)||{n:0,v:0,in:0,out:0}; p.n++; p.v+=e.amt; p[e.dir]++; m.set(e.party,p); }
  const s=[...m.entries()].sort((x,y)=>y[1].n-x[1].n), V=L.reduce((x,e)=>x+e.amt,0), top=k=>s.slice(0,k).reduce((x,[,p])=>x+p.n,0), topV=k=>[...m.values()].sort((x,y)=>y.v-x.v).slice(0,k).reduce((x,p)=>x+p.v,0);
  say(lab+': '+L.length+' crossings ('+L.filter(e=>e.dir==='in').length+' to Solana, '+L.filter(e=>e.dir==='out').length+' back) · '+fmtK(V)+' CPOOL · Ethereum parties '+m.size
    +' (both ways '+[...m.values()].filter(p=>p.in&&p.out).length+') · the busiest 1 / 3 / 5 made '+pct(top(1),L.length)+' / '+pct(top(3),L.length)+' / '+pct(top(5),L.length)+' of crossings, the biggest 1 / 3 by amount carried '+pct(topV(1),V)+' / '+pct(topV(3),V)+' of the CPOOL');
  say('  busiest: '+s.slice(0,6).map(([a,p])=>W.get(a)+' ('+(kind[a]||'?')+') '+p.n+' ['+p.in+' in / '+p.out+' out, '+fmtK(p.v)+']').join(' · ')); }
say('the ten busiest of all time, when each was active:');
for(const [a,p] of rank.slice(0,10)){ const L=ev.filter(e=>e.party===a), r=L.filter(e=>e.t>=REOPEN);
  say('  '+W.get(a)+' ('+kind[a]+'): '+p.n+' crossings ['+p.in+' in / '+p.out+' out], '+fmtK(p.v)+' CPOOL, median '+fmtK(median(L.map(e=>e.amt)))+' · '+day(p.first)+' → '+day(p.last)+' · since reopening '+r.length+(r.length?' (last '+((now-p.last)/D).toFixed(1)+' d ago)':'')); }
// week by week since reopening: the busiest party against the rest
{ const r=ev.filter(e=>e.t>=REOPEN), m=new Map(); for(const e of r) m.set(e.party,(m.get(e.party)||0)+1); const lead=[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2).map(x=>x[0]);
  say('since reopening, week by week (Mondays): crossings by '+lead.map(a=>W.get(a)).join(', ')+' / everyone else');
  const wk=t=>{ const d=new Date(t); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)); return d.toISOString().slice(0,10); };
  const g=new Map(); for(const e of r){ const k=wk(e.t), x=g.get(k)||{a:0,b:0,o:0,in:0,out:0}; if(e.party===lead[0]) x.a++; else if(e.party===lead[1]) x.b++; else x.o++; x[e.dir]++; g.set(k,x); }
  for(const [k,x] of [...g.entries()].sort()) say('  '+k+': '+x.a+' / '+x.b+' / '+x.o+'   ('+x.in+' to Solana, '+x.out+' back)'); }
// the size of crossings, and how they cluster in time
{ const r=ev.filter(e=>e.t>=REOPEN), gaps=[]; for(let i=1;i<r.length;i++) gaps.push((r[i].t-r[i-1].t)/H);
  const burst=gaps.filter(g=>g<1).length;
  say('since reopening: '+pct(burst,gaps.length)+' of crossings came within an hour of the one before (bursts) · amounts: median '+fmtK(median(r.map(e=>e.amt)))+', '
    +pct(r.filter(e=>e.amt>=50000).length,r.length)+' of them 50k+ CPOOL, '+pct(r.filter(e=>e.amt<5000).length,r.length)+' under 5k'); }

/* ---------- B: since reopening, the Solana party of each crossing (from LayerZero's record and Solana) ---------- */
say(''); say('— B. since reopening: who is on the Solana side —');
const msgs=[]; { let next=null;
  for(let p=0;p<12;p++){ const r=await get('https://scan.layerzero-api.com/v1/messages/oapp/'+EID_ETH+'/'+A+'?limit=100'+(next?'&nextToken='+encodeURIComponent(next):'')); const it=r&&Array.isArray(r.data)?r.data:[];
    msgs.push(...it); next=r&&r.nextToken; if(!next||!it.length||Math.min(...it.map(m=>Date.parse(m.created)||now))<REOPEN) break; await sleep(400); } }
const ML=msgs.filter(m=>Date.parse(m.created)>=REOPEN&&/DELIVERED/i.test(String(m.status&&m.status.name||m.status))&&m.pathway&&[EID_SOL,EID_ETH].includes(+m.pathway.srcEid));
say('LayerZero messages since reopening, delivered: '+ML.length);
const solParty=new Map(), pairs=new Map(); let read=0, unread=0;
const ownerUp=(tx,dir)=>{ const pre=new Map(), post=new Map(); for(const b of (tx.meta&&tx.meta.preTokenBalances)||[]) if(b.mint===CPOOL_S) pre.set(b.owner,Number(b.uiTokenAmount&&b.uiTokenAmount.uiAmountString||0));
  for(const b of (tx.meta&&tx.meta.postTokenBalances)||[]) if(b.mint===CPOOL_S) post.set(b.owner,Number(b.uiTokenAmount&&b.uiTokenAmount.uiAmountString||0));
  let best=null, bd=0; for(const o of new Set([...pre.keys(),...post.keys()])){ const d=(post.get(o)||0)-(pre.get(o)||0); if((dir==='in'?d:-d)>bd){ bd=dir==='in'?d:-d; best=o; } } return best; };
for(const m of ML){ const dir=+m.pathway.srcEid===EID_ETH?'in':'out', sig=dir==='in'?m.destination&&m.destination.tx&&m.destination.tx.txHash:m.source&&m.source.tx&&m.source.tx.txHash;
  if(!sig||String(sig).length<80){ unread++; continue; }
  const tx=await rpc(SOL_RPC,'getTransaction',[sig,{encoding:'jsonParsed',maxSupportedTransactionVersion:1,commitment:'finalized'}]); await sleep(250);
  if(!tx){ unread++; continue; } read++;
  const keys=((tx.transaction&&tx.transaction.message&&tx.transaction.message.accountKeys)||[]).map(k=>k.pubkey||k);
  const who=dir==='out'?keys[0]:ownerUp(tx,'in'); if(!who){ unread++; continue; }
  const p=solParty.get(who)||{n:0,in:0,out:0,last:0}; p.n++; p[dir]++; p.last=Math.max(p.last,Date.parse(m.created)||0); solParty.set(who,p);
  const g=String(m.guid||'').toLowerCase(), e=ev.find(x=>x.guid===g); if(e){ const k=W.get(e.party)+'|'+who; pairs.set(k,(pairs.get(k)||0)+1); } }
const sRank=[...solParty.entries()].sort((a,b)=>b[1].n-a[1].n), S=new Map(sRank.map(([a],i)=>[a,'S'+(i+1)]));
const tot=sRank.reduce((x,[,p])=>x+p.n,0);
say('Solana side read: '+read+' · not read: '+unread+' · Solana parties: '+solParty.size+' (both ways '+[...solParty.values()].filter(p=>p.in&&p.out).length+') · the busiest 1 / 3 made '
  +pct(sRank.slice(0,1).reduce((x,[,p])=>x+p.n,0),tot)+' / '+pct(sRank.slice(0,3).reduce((x,[,p])=>x+p.n,0),tot));
say('  busiest: '+sRank.slice(0,6).map(([a,p])=>S.get(a)+' '+p.n+' ['+p.in+' in / '+p.out+' out, last '+((now-p.last)/D).toFixed(1)+' d ago]').join(' · '));
const pr=[...pairs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,n])=>{ const [w,s]=k.split('|'); return w+' ⇄ '+(S.get(s)||'?')+' '+n; });
say('  the same entity on both sides (Ethereum party ⇄ Solana party, crossings): '+pr.join(' · '));
/* what the busiest Solana parties do besides bridging: their last signatures, by kind (counts only) */
for(const [a] of sRank.slice(0,3)){ const sigs=await rpc(SOL_RPC,'getSignaturesForAddress',[a,{limit:200}]); await sleep(300);
  const L=(sigs||[]).filter(x=>!x.err); const last=L[0]&&L[0].blockTime?L[0].blockTime*1000:null, days=L.length&&L.at(-1).blockTime?(now-L.at(-1).blockTime*1000)/D:null;
  let cp=0, seen=0; for(const x of L.slice(0,25)){ const t=await rpc(SOL_RPC,'getTransaction',[x.signature,{encoding:'json',maxSupportedTransactionVersion:1}]); await sleep(250); if(!t||!t.meta) continue; seen++;
    const mv=[...(t.meta.preTokenBalances||[]),...(t.meta.postTokenBalances||[])].some(b=>b.mint===CPOOL_S); if(mv) cp++; }
  say('  '+S.get(a)+': of its last '+seen+' transactions, '+cp+' moved CPOOL');
  say('  '+S.get(a)+': its latest '+L.length+' transactions span '+(days!=null?days.toFixed(1)+' days':'—')+' · its last transaction of any kind '+(last?((now-last)/H).toFixed(1)+' h ago':'—')); }

/* ---------- C: the price gap, hour by hour, beside the crossings ---------- */
say(''); say('— C. the price gap between the chains, hour by hour, and what crossed —');
const poolsOf=async net=>{ const r=await get('https://api.geckoterminal.com/api/v2/networks/'+net+'/tokens/'+(net==='eth'?CPOOL_E:CPOOL_S)+'/pools?page=1'); return (r&&r.data)||[]; };
const PE=await poolsOf('eth'); await sleep(2500); const PS=await poolsOf('solana'); await sleep(2500);
const vol=p=>Number(p.attributes&&p.attributes.volume_usd&&p.attributes.volume_usd.h24||0), res=p=>Number(p.attributes&&p.attributes.reserve_in_usd||0);
const feeOf=p=>{ const m=/(\d+(?:\.\d+)?)%/.exec(String(p.attributes&&p.attributes.name||'')); return m?+m[1]:null; };
// the reference pool: the deepest one with an ordinary fee (a pool with an odd fee can show a price nobody trades at)
const cpoolIsBase=p=>{ const id=String(p.relationships&&p.relationships.base_token&&p.relationships.base_token.data&&p.relationships.base_token.data.id||'').toLowerCase(); return id.endsWith(CPOOL_E)||id.endsWith(CPOOL_S.toLowerCase()); };
const cpx=p=>Number(p.attributes&&(cpoolIsBase(p)?p.attributes.base_token_price_usd:p.attributes.quote_token_price_usd)||0);
const busiest=L=>[...L].filter(p=>{ const f=feeOf(p); return f==null||f<=2; }).sort((a,b)=>res(b)-res(a))[0];
{ const cg=await get('https://api.coingecko.com/api/v3/simple/price?ids=clearpool&vs_currencies=usd'), ref=cg&&cg.clearpool&&cg.clearpool.usd;
  const px=cpx;
  const dev=L=>L.filter(p=>res(p)>=1000&&px(p)>0).map(p=>(px(p)/ref-1)*100).sort((a,b)=>a-b);
  say('price check against CoinGecko ($'+(ref||'—')+'): each pool with $1k+ in it, its price off CoinGecko by — Ethereum: '+(ref?dev(PE).map(x=>x.toFixed(1)+'%').join(', '):'—')+' · Solana: '+(ref?dev(PS).map(x=>x.toFixed(1)+'%').join(', '):'—'));
  const de=busiest(PE), ds=busiest(PS);
  say('reference pools (deepest, ordinary fee): Ethereum '+(de&&ref?((px(de)/ref-1)*100).toFixed(1)+'% off CoinGecko':'—')+' · Solana '+(ds&&ref?((px(ds)/ref-1)*100).toFixed(1)+'% off CoinGecko':'—')
    +' · pools with $1k+ in them: Ethereum '+PE.filter(p=>res(p)>=1000).length+', Solana '+PS.filter(p=>res(p)>=1000).length
    +' · CPOOL in all Solana pools together: $'+fmtK(PS.reduce((x,p)=>x+res(p),0))+' · 24 h trades, Solana pools together: '+PS.reduce((x,p)=>{ const t=p.attributes&&p.attributes.transactions&&p.attributes.transactions.h24; return x+(t?(t.buys||0)+(t.sells||0):0); },0)); }
say('CPOOL pools listed: Ethereum '+PE.length+', Solana '+PS.length+' · 24 h DEX volume, all pools: Ethereum $'+fmtK(PE.reduce((x,p)=>x+vol(p),0))+', Solana $'+fmtK(PS.reduce((x,p)=>x+vol(p),0)));
const ohlcv=async(net,pool)=>{ const out=new Map(); let before=Math.floor(now/1000);
  for(let k=0;k<3;k++){ const r=await get('https://api.geckoterminal.com/api/v2/networks/'+net+'/pools/'+pool+'/ohlcv/hour?aggregate=1&limit=1000&currency=usd&token='+(net==='eth'?CPOOL_E:CPOOL_S)+'&before_timestamp='+before); await sleep(2500);
    const L=(r&&r.data&&r.data.attributes&&r.data.attributes.ohlcv_list)||[]; if(!L.length) break;
    for(const [t,o,h,l,c,v] of L) out.set(t*1000,{c:+c,v:+v}); before=Math.min(...L.map(x=>x[0])); if(before*1000<REOPEN-30*D) break; }
  return out; };
const be=busiest(PE), bs=busiest(PS);
const HE=be?await ohlcv('eth',be.attributes.address):new Map(), HS=bs?await ohlcv('solana',bs.attributes.address):new Map();
say('hourly prices read: Ethereum '+HE.size+' h, Solana '+HS.size+' h (each chain’s deepest ordinary-fee CPOOL pool, unnamed)');
const hours=[...HS.keys()].filter(t=>HE.has(t)&&t>=REOPEN-0).sort((a,b)=>a-b);
const gapAt=t=>{ const e=HE.get(t), s=HS.get(t); return e&&s&&e.c>0&&s.c>0?(s.c/e.c-1)*100:null; };
// daily: the median gap, and the crossings
{ const days=new Map(); for(const t of hours){ const k=day(t), g=gapAt(t); if(g==null) continue; const d=days.get(k)||{g:[],ve:0,vs:0}; d.g.push(g); d.ve+=HE.get(t).v; d.vs+=HS.get(t).v; days.set(k,d); }
  const cr=new Map(); for(const e of ev.filter(e=>e.t>=REOPEN)){ const k=day(e.t), c=cr.get(k)||{in:0,out:0}; c[e.dir]++; cr.set(k,c); }
  say('day by day since reopening: Solana price against Ethereum (median, range of the day) · DEX volume in the two busiest pools · crossings');
  for(const [k,d] of [...days.entries()].sort()){ const c=cr.get(k)||{in:0,out:0};
    say('  '+k+': '+(median(d.g)>=0?'+':'')+median(d.g).toFixed(1)+'% ('+Math.min(...d.g).toFixed(1)+' … '+Math.max(...d.g).toFixed(1)+') · $'+fmtK(d.ve)+' / $'+fmtK(d.vs)+' · '+c.in+' to Solana, '+c.out+' back'); } }
// does a gap bring crossings? hours by gap size, and whether a crossing followed within 6 h, in the direction the gap pays
{ const B=[[-99,-4],[-4,-2],[-2,-1],[-1,1],[1,2],[2,4],[4,99]], res=B.map(()=>({h:0,any:0,right:0}));
  const crossT=ev.filter(e=>e.t>=REOPEN);
  for(const t of hours){ const g=gapAt(t); if(g==null) continue; const i=B.findIndex(([a,b])=>g>=a&&g<b); const r=res[i]; r.h++;
    const nx=crossT.filter(e=>e.t>=t&&e.t<t+6*H); if(nx.length) r.any++;
    // Solana dearer: CPOOL is worth more there, so it pays to carry it to Solana (in) and sell; cheaper: to carry it back (out)
    if(nx.some(e=>g>0?e.dir==='in':e.dir==='out')) r.right++; }
  say('hours by the gap (Solana against Ethereum), and how often a crossing followed within 6 h (any / in the direction the gap pays):');
  B.forEach(([a,b],i)=>{ const r=res[i]; if(r.h) say('  '+(a===-99?'below '+b:b===99?a+' and above':a+' to '+b)+'%: '+r.h+' h · '+pct(r.any,r.h)+' / '+pct(r.right,r.h)); }); }
{ const last=hours.slice(-72).map(gapAt).filter(g=>g!=null), last24=hours.slice(-24).map(gapAt).filter(g=>g!=null);
  say('the gap now: last 24 h median '+(median(last24)??0).toFixed(1)+'% · last 72 h median '+(median(last)??0).toFixed(1)+'%, range '+Math.min(...last).toFixed(1)+' … '+Math.max(...last).toFixed(1)+'%');
  const prs=hours.slice(-24*30).map(t=>HE.get(t).c), p0=prs[0], p1=prs.at(-1);
  say('CPOOL on Ethereum over the last 30 days: '+(p0&&p1?((p1/p0-1)*100).toFixed(0)+'%':'—')+' · its hourly swings, median '+(median(hours.slice(-24*30).map((t,i,a)=>i?Math.abs(HE.get(t).c/HE.get(a[i-1]).c-1)*100:0).slice(1))||0).toFixed(2)+'% an hour'); }

/* ---------- D: what a round trip costs ---------- */
say(''); say('— D. what a crossing costs —');
{ const toB='00000000000000000000000000'+'0'.repeat(38); // a quote needs a recipient; any 32 bytes do
  const g=await rpc(ETH_RPC,'eth_gasPrice',[]), gwei=g?parseInt(g,16)/1e9:null;
  const ep=HE.size?[...HE.values()].at(-1).c:null;
  say('Ethereum gas now: '+(gwei!=null?gwei.toFixed(2)+' gwei':'—')+' · a bridge send (~250k gas) plus a DEX swap (~150k gas) at that: about '+(gwei!=null?(400000*gwei/1e9).toFixed(5)+' ETH':'—')
    +' · LayerZero’s own fee for a send to Solana was 0.00058 ETH on 31 Oct (read live then) · CPOOL on Ethereum now $'+(ep?ep.toFixed(4):'—'));
  const fee=p=>{ const n=String(p.attributes&&p.attributes.name||''); const m=/(\d+(?:\.\d+)?)%/.exec(n); return m?+m[1]:null; };
  const fe=PE.map(fee).filter(x=>x!=null), fs=PS.map(fee).filter(x=>x!=null);
  say('pool fee tiers listed: Ethereum '+[...new Set(fe)].sort((a,b)=>a-b).join(', ')+'% · Solana '+[...new Set(fs)].sort((a,b)=>a-b).join(', ')+'% (a round trip pays one swap on each chain)'); }

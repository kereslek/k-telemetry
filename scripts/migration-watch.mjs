/* CPOOL → CLEAR MIGRATION WATCH. Everything that decides whether CPOOL on Solana can still be brought
   home and swapped before the deadline, read from several independent places every few hours:

     1. Clearpool's own word: the migration guide on Medium (deadline, latest updates, exchanges, what
        happens after the deadline), the docs' migration and bridge pages, and any new post on their blog;
     2. the bridge on chain, both sides (scripts/bridge.mjs: peers, libraries, pause, minter, supply cover,
        who controls it, rate limits and fees, how long crossings take, anything stuck), beside the
        relay's own half-hourly reading of it, so two separate reads must agree;
     3. the swap on chain: CLEAR's supply, its swapper and how much CPOOL it has taken in, and whether
        CLEAR itself has been connected to Solana (CLEAR is a LayerZero OFT too);
     4. the exchanges whose minute prices the deck uses: is the CPOOL pair still trading, is CLEAR listed.

   Public data only. Nothing of the deck's is read except the relay's last bridge reading; the result is
   written sealed (deck-r7k4x9/migration.json) for the deck. The public log carries yes/no, dates, counts
   and percentages, and Clearpool's own public wording when it changes. A change that matters is an
   ALERT: the run ends failed so GitHub emails the owner. DRY=1 reads and prints only. */
import {readBridge, ROUTES, b58d} from './bridge.mjs';
import {get as getPage, text as pageText} from './page-text.mjs';
import {initLock, readJ, writeJ} from './lock.mjs';
import crypto from 'node:crypto';

const OUT='deck-r7k4x9', FILE=OUT+'/migration.json', DRY=process.env.DRY==='1', NOW=Date.now(), V=1;
const GUIDE='https://clearpool.medium.com/cpool-clear-swap-migration-guide-8e1d42db59cf';
const DOCS_MIG='https://docs.clearpool.finance/clearpool/token/cpool/cpool-clear-migration', DOCS_BRIDGE='https://docs.clearpool.finance/clearpool/token/bridge';
const FEED='https://clearpool.medium.com/feed';
const CPOOL='0x66761fa41377003622aee3c7675fc7b5c1c2fac5', CLEAR='0x5200f539478f58d9aea962095ba3b16b5e550e00', EID_SOL=30168;
const DEADLINE_DEFAULT=Date.parse('2027-02-17T00:00:00Z');      // the guide's date; the start of that day, to be safe
const R=ROUTES[0];

/* ---------- the network: several public endpoints, the first real answer wins; a failure is null ---------- */
const ERPC=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth','https://rpc.mevblocker.io'];
const KEYED=(process.env.SOL_RPC_URL||'').split(',').map(s=>s.trim()).filter(Boolean);
const SRPC=[...KEYED,'https://solana-rpc.publicnode.com','https://api.mainnet-beta.solana.com'];
const sleep=ms=>new Promise(f=>setTimeout(f,ms));
async function getJ(url,init={},tries=2){ for(let k=0;k<tries;k++){ try{ const r=await fetch(url,{...init,signal:AbortSignal.timeout(20000),headers:{accept:'application/json','content-type':'application/json','user-agent':'k-telemetry-migration-watch'}});
  if(r.ok) return await r.json(); }catch(e){} await sleep(700*(k+1)); } return null; }
async function rpc(list,method,params){ for(const u of list){ const r=await getJ(u,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})},2);
  if(r&&r.result!==undefined&&!r.error) return r.result; } throw new Error('no answer'); }
const io={eth:(m,p)=>rpc(ERPC,m,p), sol:(m,p)=>rpc(SRPC,m,p), get:async u=>{ const j=await getJ(u); if(!j) throw new Error('no answer'); return j; }};
const call=async(to,data)=>{ try{ return await io.eth('eth_call',[{to,data},'latest']); }catch(e){ return null; } };
const word=(h,i)=>{ const s=String(h||'').replace(/^0x/,'').slice(64*i,64*(i+1)); return s.length===64?BigInt('0x'+s):null; };
const addr=h=>h&&String(h).length>=66?'0x'+String(h).replace(/^0x/,'').slice(24,64).toLowerCase():null;
const addrArg=a=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const tok=v=>v==null?null:Number(v/10n**12n)/1e6;                 // 18-decimal amount → tokens
const B58A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58e(bytes){let n=0n;for(const b of bytes)n=(n<<8n)|BigInt(b);let o='';while(n>0n){o=B58A[Number(n%58n)]+o;n/=58n;}for(const b of bytes){if(b===0)o='1'+o;else break;}return o;}
const sha=s=>crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,16);
const day=t=>t?new Date(t).toISOString().slice(0,10):'—';

/* ---------- the previous reading (sealed) ---------- */
let prev=null;
if(!DRY){ if(!String(process.env.DECK_PASSPHRASE||'').trim()){ console.log('DECK_PASSPHRASE is not set: nothing done (DRY=1 to read without writing)'); process.exit(1); }
  initLock(OUT); try{ prev=readJ(FILE); }catch(e){ prev=null; } }
const P=prev&&prev.v===V?prev:{};
const alerts=[]; const alert=(k,s)=>alerts.push({k,s});

/* ---------- 1. Clearpool's own word ---------- */
function section(txt,head){ const i=txt.search(new RegExp('\\n## '+head+'[^\\n]*\\n','i')); if(i<0) return null;
  const rest=txt.slice(i+1), j=rest.slice(3).search(/\n## /); return (j<0?rest:rest.slice(0,j+3)).split('\n').slice(1).join('\n').trim(); }
const bullets=s=>(s||'').split('\n').map(x=>x.trim()).filter(x=>/^•/.test(x)).map(x=>x.replace(/^•\s*/,'').replace(/\s*\[https?:[^\]]+\]/g,'').trim()).filter(Boolean);
const dateIn=(txt,label)=>{ const m=(txt||'').match(new RegExp(label+'\\s*:?\\s*\\n*\\s*(\\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) 20\\d\\d)','i')); return m?Date.parse(m[1]+' UTC'):null; };
const steady=t=>t.split('\n').filter(x=>!/min read|^Just now$|ago$|^Press enter|^Listen|^Share$|medium\.com\/m\/signin/.test(x.trim())).join('\n');

const G={read:false};
{ const r=await getPage(GUIDE);
  if(r.ok){ const t=pageText(r.tx,r.url).out;
    if(t.length>800&&/CLEAR/.test(t)){ G.read=true;
      G.deadline=dateIn(t,'Deadline'); G.opens=dateIn(t,'Migration opens');
      G.clear=((t.match(/CLEAR contract[^:]*:\s*(0x[0-9a-fA-F]{40})/)||[])[1]||'').toLowerCase()||null;
      G.updates=bullets(section(t,'Latest updates'));
      G.exchanges=bullets(section(t,'Exchange support')).map(x=>x.replace(/:\s*View announcement.*/i,''));
      G.after=(section(t,'After the deadline')||'').replace(/\s+/g,' ').trim();
      G.otherChain=/Bridge your CPOOL back to Ethereum|Bridge to Ethereum/i.test(t)||null;   // the table is an image; its alt text is not always there
      G.hash=sha(steady(t)); } } }
const D={read:false};
{ const r=await getPage(DOCS_MIG); if(r.ok){ const t=pageText(r.tx,r.url).out; if(/CLEAR/.test(t)){ D.read=true; D.deadline=dateIn(t,'Deadline'); D.hash=sha(steady(t.replace(/Last updated[^\n]*/g,''))); } } }
{ const r=await getPage(DOCS_BRIDGE); if(r.ok){ const t=pageText(r.tx,r.url).out; D.bridgeRead=/Bridge/.test(t); D.bridgeSolana=D.bridgeRead?/Solana/.test(t):null; } }
const F={read:false, posts:[]};
{ const r=await getPage(FEED); if(r.ok&&/<item>/.test(r.tx)){ F.read=true;
    F.posts=r.tx.split(/<item>/).slice(1).map(x=>({t:Date.parse((x.match(/<pubDate>([^<]+)<\/pubDate>/)||[])[1]||'')||null,
      title:((x.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)||[])[1]||'').trim(), link:((x.match(/<link>([^<]+)<\/link>/)||[])[1]||'').split('?')[0]})).filter(p=>p.title).slice(0,10); } }

const deadline=G.deadline||D.deadline||P.deadline||DEADLINE_DEFAULT;
if(P.guide&&G.read){
  if(G.deadline&&P.guide.deadline&&G.deadline!==P.guide.deadline) alert('deadline','the deadline in Clearpool’s guide changed: '+day(P.guide.deadline)+' → '+day(G.deadline));
  for(const u of G.updates||[]) if(!(P.guide.updates||[]).includes(u)) alert('update','Clearpool’s guide, new update: '+u);
  for(const x of G.exchanges||[]) if(!(P.guide.exchanges||[]).includes(x)) alert('exchange','Clearpool’s guide, exchange added: '+x);
  if(G.after&&P.guide.after&&G.after!==P.guide.after) alert('after','Clearpool’s guide, “After the deadline” changed: '+G.after.slice(0,300));
  if(G.clear&&P.guide.clear&&G.clear!==P.guide.clear) alert('contract','the CLEAR contract in the guide changed');
}
if(G.deadline&&D.deadline&&G.deadline!==D.deadline) alert('deadline2','the guide and the docs give different deadlines: '+day(G.deadline)+' and '+day(D.deadline));
if(P.docs&&D.read&&P.docs.hash&&D.hash!==P.docs.hash) alert('docs','Clearpool’s docs page on the migration changed');
if(P.docs&&P.docs.bridgeSolana===true&&D.bridgeSolana===false) alert('docsBridge','Clearpool’s bridge docs no longer list Solana');
if(P.feed&&F.read){ const seen=new Set((P.feed.posts||[]).map(p=>p.link)); for(const p of F.posts) if(!seen.has(p.link)&&p.t&&p.t>(P.t||0)-864e5) alert('post','new Clearpool post: '+p.title+' ('+day(p.t)+') '+p.link); }

/* ---------- 2. the bridge, on chain, both sides ---------- */
const B=await readBridge(io, P.bridgeRaw||null), br=(B.routes||[])[0]||{};
/* the relay's own reading, published sealed every half hour: a second, separate read that must agree */
let relay=null;
if(!DRY){ try{ const fs=await import('node:fs'); const f=fs.readdirSync(OUT).find(x=>/^data-.*\.json$/.test(x));
    const d=f?readJ(OUT+'/'+f):null, rr=d&&d.bridge&&Array.isArray(d.bridge.routes)?d.bridge.routes.find(x=>x&&x.id==='eth-sol'):null;
    if(rr) relay={state:rr.state||null, t:d.bridge.t||null}; }catch(e){} }
const way=br.dur&&br.dur.out, wayIn=br.dur&&br.dur.in;
const bridge={state:br.state||null, why:br.why||[], warn:br.warn||[], checks:br.checks||{}, lastT:br.lastT||null,
  lastBack:br.last&&br.last.out&&br.last.out.verified?br.last.out.t:null, lastTo:br.last&&br.last.in&&br.last.in.verified?br.last.in.t:null,
  n30:br.n30||null, n7:br.n7||null, waiting:br.waiting??null, dur:br.dur||null, supply:br.supply||null, ctl:br.ctl?{outLimit:br.ctl.outLimit, inLimit:br.ctl.inLimit, peerFeeBps:br.ctl.peerFeeBps, solFeeBps:br.ctl.solFeeBps, changes:br.ctl.changes}:null,
  since:br.since||null, relay, agree:relay&&relay.state&&br.state?(relay.state==='closed')===(br.state==='closed'):null};
const pb=P.bridge||{};
if(bridge.state==='closed'||bridge.state==='changed') alert('bridge','the CPOOL bridge Solana ⇄ Ethereum reads '+bridge.state.toUpperCase()+': '+(bridge.why.join('; ')||'—'));
else if(bridge.state==null&&pb.state!=null) alert('bridgeUnread','the CPOOL bridge could not be read this time (it read “'+pb.state+'” before)');
if(bridge.state==='open'&&(pb.state==='closed'||pb.state==='changed')) alert('bridgeBack','the CPOOL bridge reads OPEN again');
if(bridge.waiting>0) alert('stuck', bridge.waiting+' crossing(s) older than 30 minutes not delivered');
for(const w of bridge.warn) if(!(pb.warn||[]).includes(w)) alert('bridgeWarn','bridge: '+w);
if(bridge.agree===false) alert('disagree','the relay’s reading of the bridge ('+relay.state+') and this one ('+bridge.state+') disagree');

/* ---------- 3. the swap, on chain ---------- */
const S={};
{ S.clearSupply=tok(word(await call(CLEAR,'0x18160ddd'),0));
  S.swapper=addr(await call(CLEAR,'0x2b3297f9'));
  S.cpoolSupply=tok(word(await call(CPOOL,'0x18160ddd'),0));
  S.cpoolSwapped=S.swapper?tok(word(await call(CPOOL,'0x70a08231'+addrArg(S.swapper)),0)):null;      // CPOOL taken in by the swapper
  S.clearInSwapper=S.swapper?tok(word(await call(CLEAR,'0x70a08231'+addrArg(S.swapper)),0)):null;    // CLEAR it still holds to pay out
  const pz=await call(S.swapper||CLEAR,'0x5c975abb'); S.paused=pz&&pz.length>=66?word(pz,0)!==0n:null;
  S.pct=S.cpoolSwapped!=null&&S.cpoolSupply?S.cpoolSwapped/S.cpoolSupply*100:null;
  /* CLEAR's own bridge to Solana: a peer for Solana's endpoint id means CLEAR can be carried there */
  const pr=await call(CLEAR,'0xbb0b6a53'+EID_SOL.toString(16).padStart(64,'0')); const pw=word(pr,0);
  S.clearSolPeer=pw==null?null:pw!==0n;
  if(S.clearSolPeer){ const store=b58e(Uint8Array.from(Buffer.from(pw.toString(16).padStart(64,'0'),'hex')));
    try{ const a=await io.sol('getAccountInfo',[store,{encoding:'base64'}]); const d=a&&a.value?Buffer.from(a.value.data[0],'base64'):null;
      S.clearSolMint=d&&d.length>=49?b58e(d.subarray(17,49)):null; S.clearSolStore=store; }catch(e){} } }
const ps=P.swap||{};
if(S.clearSolPeer&&!ps.clearSolPeer) alert('clearSol','CLEAR is now connected to Solana on chain'+(S.clearSolMint?' (Solana mint '+S.clearSolMint+')':''));
if(S.paused===true&&ps.paused!==true&&NOW>=(G.opens||Date.parse('2026-11-17T00:00:00Z'))) alert('swapPaused','the CPOOL → CLEAR swap reads PAUSED on chain');
if(S.swapper&&ps.swapper&&S.swapper!==ps.swapper) alert('swapper','CLEAR’s swapper contract changed');

/* ---------- 4. the exchanges the deck takes CPOOL's minute price from ---------- */
const X={};
{ const m=async s=>{ const j=await getJ('https://api.mexc.com/api/v3/exchangeInfo?symbol='+s,{},1); if(!j) return false;   // an unknown pair is refused: not listed
    const x=(j.symbols||[]).find(y=>y.symbol===s); return !!x&&(String(x.status)==='1'||x.status==='ENABLED')&&x.isSpotTradingAllowed!==false; };
  X.mexc={cpool:await m('CPOOLUSDT'), clear:await m('CLEARUSDT')}; }
{ const k=async s=>{ const j=await getJ('https://api.kucoin.com/api/v2/symbols/'+s); return j?!!(j.data&&j.data.enableTrading):null; };
  X.kucoin={cpool:await k('CPOOL-USDT'), clear:await k('CLEAR-USDT')}; }
{ const b=async s=>{ const j=await getJ('https://api.bitget.com/api/v2/spot/public/symbols?symbol='+s); return j?!!(Array.isArray(j.data)&&j.data[0]&&j.data[0].status==='online'):null; };
  X.bitget={cpool:await b('CPOOLUSDT'), clear:await b('CLEARUSDT')}; }
{ const y=async s=>{ const j=await getJ('https://api.bybit.com/v5/market/instruments-info?category=spot&symbol='+s); return j&&j.result?!!(j.result.list||[]).find(x=>x.symbol===s&&x.status==='Trading'):null; };
  X.bybit={cpool:await y('CPOOLUSDT'), clear:await y('CLEARUSDT')}; }
const px=P.exch||{};
for(const [ex,v] of Object.entries(X)){ const o=px[ex]||{};
  if(o.cpool===true&&v.cpool===false) alert('exCpool',ex+': the CPOOL pair stopped trading');
  if(o.clear===false&&v.clear===true) alert('exClear',ex+': a CLEAR pair is now trading'); }
const cpoolFeeds=['mexc','kucoin','bitget'].filter(e=>X[e].cpool===true).length;

/* ---------- the result ---------- */
const daysLeft=Math.ceil((deadline-NOW)/864e5);
const hist=[...((P.hist)||[]), {t:NOW, b:bridge.state, back7:bridge.n7?bridge.n7.back:null, pct:S.pct!=null?Math.round(S.pct*100)/100:null}].filter(h=>NOW-h.t<120*864e5).slice(-400);
const res={v:V, t:NOW, deadline, opens:G.opens||P.opens||null, daysLeft,
  guide:G.read?{deadline:G.deadline, opens:G.opens, clear:G.clear, updates:G.updates, exchanges:G.exchanges, after:G.after, otherChain:G.otherChain, hash:G.hash, t:NOW}:(P.guide||null),
  docs:D.read?{deadline:D.deadline, hash:D.hash, bridgeSolana:D.bridgeSolana, t:NOW}:(P.docs||null),
  feed:F.read?{posts:F.posts, t:NOW}:(P.feed||null),
  bridge, bridgeRaw:br, swap:S, exch:X, cpoolFeeds, hist,
  alerts:[...alerts.map(a=>({...a,t:NOW})), ...((P.alerts)||[]).filter(a=>NOW-a.t<30*864e5)].slice(0,40)};

/* the public log: dates, yes/no, counts, percentages; Clearpool's public wording only when it changed */
const yn=v=>v==null?'unread':v?'yes':'no';
console.log('CPOOL → CLEAR MIGRATION WATCH · '+new Date(NOW).toISOString().slice(0,16)+'Z');
console.log('  deadline '+day(deadline)+' · '+daysLeft+' day(s) left · swap opens '+day(res.opens));
console.log('  Clearpool guide read: '+yn(G.read)+(G.read?' · deadline '+day(G.deadline)+' · '+(G.updates||[]).length+' update(s) · '+(G.exchanges||[]).length+' exchange(s) listed':'')
  +' · docs read: '+yn(D.read)+' · bridge docs list Solana: '+yn(D.bridgeSolana)+' · blog posts read: '+(F.read?F.posts.length:'unread'));
console.log('  bridge Solana ⇄ Ethereum: '+(bridge.state||'unread').toUpperCase()+' · relay’s reading agrees: '+yn(bridge.agree)
  +' · crossings 7 d: '+(bridge.n7?bridge.n7.to+' to Solana, '+bridge.n7.back+' back':'—')+' · stuck: '+(bridge.waiting??'—')
  +' · way back takes (median / slowest in ten): '+(way?Math.round(way.med/60e3)+' / '+Math.round(way.p90/60e3)+' min over '+way.n:'—')
  +' · rate limit back: '+(bridge.ctl?(bridge.ctl.outLimit?'yes':'none'):'unread')+' · fee: '+(bridge.ctl&&bridge.ctl.peerFeeBps!=null?bridge.ctl.peerFeeBps/100+'%':'none'));
console.log('  swap: swapper '+yn(!!S.swapper)+' · paused '+yn(S.paused)+' · CPOOL swapped '+(S.pct!=null?S.pct.toFixed(2)+'% of supply':'—')+' · CLEAR connected to Solana: '+yn(S.clearSolPeer));
console.log('  exchanges, CPOOL pair trading / CLEAR pair trading: '+Object.entries(X).map(([k,v])=>k+' '+yn(v.cpool)+'/'+yn(v.clear)).join(' · ')+' · CPOOL minute-price feeds left: '+cpoolFeeds+' of 3');
if(alerts.length){ console.log('\nALERTS ('+alerts.length+'):'); for(const a of alerts) console.log('  ! '+a.s); } else console.log('\nno alerts');
if(!P.t&&!DRY) console.log('(first reading: changes are alerted from the next run on)');

if(!DRY) writeJ(FILE, res, JSON.stringify(res));
/* an alert ends the run failed (the workflow's last step), after the reading is kept, so GitHub emails the owner */
if(alerts.length&&process.env.ALERT_FILE){ const fs=await import('node:fs'); fs.writeFileSync(process.env.ALERT_FILE, alerts.map(a=>'! '+a.s).join('\n')+'\n'); }

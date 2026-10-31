/* Tracking audit, read-only. When the market moves, does everything on the dashboard move with it?

   Each place the page takes a price from is set against the market now: Coinbase for ETH, BTC and
   SOL, the busiest DEX pool for every other token (DexScreener), and DefiLlama's latest price with
   its own time stamp (the feed the relay prices the wallets and the ticker strip with). For each
   part of the page it says how old its prices are and how far they sit from the market.

   The log is public: part names, ages, percentages and counts only. Tokens are counted and ranked
   by value (#1 is the largest), never named; no amount, pool, address or position is printed, and
   every line passes a last check for anything that looks like one. Run by hand: track-audit.yml. */
import {chromium} from 'playwright';
import crypto from 'node:crypto';

/* an error's message can quote the data it choked on (a JSON parse error does): if the audit
   stops, the log gets the error's kind and line only */
const stop=e=>{ const ln=(String(e&&e.stack||'').match(/track-audit\.mjs:(\d+)/)||[])[1];
  console.log('FAIL  the audit stopped: '+String(e&&e.name||'error').replace(/[^A-Za-z]/g,'')+(ln?' at line '+ln:'')+' (its message is withheld: it can carry data)'); process.exit(1); };
process.on('uncaughtException',stop); process.on('unhandledRejection',stop);

const LIVE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/';
const PASS=String(process.env.DECK_PASSPHRASE||'').trim();
let LOCKMETA=null;
try{ LOCKMETA=await (await fetch(LIVE+'lock.json?t='+Date.now())).json(); }catch(e){}
if(!(PASS&&LOCKMETA&&LOCKMETA.check)){ console.log('FAIL  the deck is not locked or DECK_PASSPHRASE is not set: nothing done'); process.exit(1); }
const BITS=crypto.pbkdf2Sync(PASS, Buffer.from(LOCKMETA.salt,'base64'), LOCKMETA.iter, 64, 'sha256'), KEY=BITS.subarray(0,32);
const openJ=j=>{ if(!(j&&j.lock===1)) return j;
  const all=Buffer.from(j.ct,'base64'), d=crypto.createDecipheriv('aes-256-gcm',KEY,Buffer.from(j.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
  return JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); };

/* every line is checked before it is printed: nothing shaped like an address or a dollar figure */
const SAFE=s=>!/0x[0-9a-f]{6,}|[1-9A-HJ-NP-Za-km-z]{30,}|\$\s?\d/i.test(s);
let fails=0, warns=0;
const out=(tag,m)=>console.log(tag+(SAFE(m)?m:'(line withheld: it carried something shaped like an address or an amount)'));
const OK=m=>out('ok    ',m), WARN=m=>{ warns++; out('WARN  ',m); }, FAIL=m=>{ fails++; out('FAIL  ',m); };
const pct=x=>x==null||!isFinite(x)?'—':(x>=0?'+':'−')+Math.abs(x*100).toFixed(1)+'%';
const age=ms=>ms==null||!isFinite(ms)?'—':ms<90e3?Math.round(ms/1e3)+' s':ms<5400e3?Math.round(ms/60e3)+' min':(ms/3600e3).toFixed(1)+' h';
const sleep=ms=>new Promise(f=>setTimeout(f,ms));
const get=async(u,ms=20000)=>{ for(let k=0;k<3;k++){ try{ const r=await fetch(u,{signal:AbortSignal.timeout(ms), headers:{accept:'application/json', 'user-agent':'k-telemetry-track-audit'}}); if(r.ok) return await r.json(); if(r.status===429) await sleep(4000); }catch(e){} await sleep(1500*(k+1)); } return null; };
const sealed=async f=>{ try{ const r=await fetch(LIVE+f+'?t='+Date.now()); return r.ok?openJ(await r.json()):null; }catch(e){ return null; } };
const now=Date.now(), OFF=0.02;
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Budapest',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

const [relay, daily, mo, recon, census]=await Promise.all(['data-main.json','daily-main.json','momentum-main.json','recon-main.json','pools-main.json'].map(sealed));
if(!relay){ FAIL('the relay file could not be read: nothing to compare'); process.exit(1); }

/* ---------- your tokens, keyed the way the page keys them ---------- */
const WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', WSOL='So11111111111111111111111111111111111111112';
const L2WETH=new Set(['0x82af49447d8a07e3bd95bd0d56f35241523fbab1','0x4200000000000000000000000000000000000006']);
const STABLE=/^(usdt|usdc|dai|usde|pyusd|fdusd|tusd|usds|usdp|gusd|lusd|usdd|frax|usdc\.e|usdt0|usd1)$/i;
const keyOf=(chain,addr,native)=>{
  if(chain==='sol'||chain==='solana') return 'sol:'+(native||addr===WSOL?'native':addr);
  if(chain==='sui'||chain==='tron') return chain+':'+addr;
  const a=String(addr||'').toLowerCase(), ch=chain||'ethereum';
  return ch+':'+(native||(ch==='ethereum'&&a===WETH)?'native':a);   // the page's tokKey: a chain's own coin is <chain>:native
};
const T=new Map();
const tok=(chain,addr,native,sym,llama)=>{ const k=keyOf(chain,addr,native); let t=T.get(k);
  if(!t){ t={k, chain:chain==='solana'?'sol':chain||'ethereum', addr:native?null:addr, native:!!native||k.endsWith(':native'), sym:null, llama:null, v:0, src:{}}; T.set(k,t); }
  if(sym&&!t.sym) t.sym=sym; if(llama&&!t.llama) t.llama=llama; return t; };
/* a part's price for a token: the value-weighted mean of what it priced the token at */
const put=(t,part,px,w)=>{ if(!(px>0)) return; const s=t.src[part]||(t.src[part]={pw:0,w:0,n:0}); const ww=w>0?w:1e-6; s.pw+=px*ww; s.w+=ww; s.n++; };
const pxOf=(t,part)=>{ const s=t.src[part]; return s&&s.w>0?s.pw/s.w:null; };

for(const p of relay.eth||[]){ const ch=p.chain||'ethereum', [s0,s1]=String(p.pairLabel||'').split(' / ');
  const t0=tok(ch,p.token0,false,s0), t1=tok(ch,p.token1,false,s1), w0=(p.amt0||0)*(p.usd0||0), w1=(p.amt1||0)*(p.usd1||0);
  t0.v+=w0; t1.v+=w1; put(t0,'relayPools',p.usd0,w0); put(t1,'relayPools',p.usd1,w1); }
for(const p of relay.sol||[]){ const [s0,s1]=String(p.pairLabel||'').split(' / ');
  const t0=tok('sol',p.mint0,false,s0), t1=tok('sol',p.mint1,false,s1), w0=(p.amt0||0)*(p.usd0||0), w1=(p.amt1||0)*(p.usd1||0);
  t0.v+=w0; t1.v+=w1; put(t0,'relayPools',p.usd0,w0); put(t1,'relayPools',p.usd1,w1); }
const idle=relay.idle||{};
for(const r of idle.rows||[]){ if(!(r.amount>0)||r.debt) continue;
  const t=tok(r.chain, r.native?null:r.addr, r.native, r.native?(r.chain==='sol'?'SOL':r.chain==='polygon'?'POL':'ETH'):r.symbol, r.llama);
  t.v+=r.usd||0; put(t,'relayWallets', r.px??(r.usd!=null?r.usd/r.amount:null), r.usd||0); if(r.pxFrom==='lp') t.lpFilled=true; }
const ranked=[...T.values()].sort((a,b)=>b.v-a.v); ranked.forEach((t,i)=>t.rank=i+1);
const totalV=ranked.reduce((s,t)=>s+t.v,0)||1;
for(const t of ranked) t.share=t.v/totalV;

/* ---------- the market now ---------- */
const cb={};
for(const s of ['ETH','BTC','SOL','POL']){
  const k=await get('https://api.exchange.coinbase.com/products/'+s+'-USD/ticker'), st=await get('https://api.exchange.coinbase.com/products/'+s+'-USD/stats');
  if(k&&+k.price>0) cb[s]={px:+k.price, open:st&&+st.open>0?+st.open:null}; }
const DEXCH={ethereum:'ethereum', arbitrum:'arbitrum', base:'base', optimism:'optimism', polygon:'polygon', sol:'solana', sui:'sui', tron:'tron'};
const byCh={}; for(const t of ranked){ if(t.native||!t.addr) continue; const c=DEXCH[t.chain]; if(c) (byCh[c]=byCh[c]||[]).push(t); }
for(const [c,list] of Object.entries(byCh)) for(let i=0;i<list.length;i+=30){
  const part=list.slice(i,i+30), j=await get('https://api.dexscreener.com/tokens/v1/'+c+'/'+part.map(t=>t.addr).join(','));
  for(const pr of Array.isArray(j)?j:[]){ const liq=+(pr.liquidity&&pr.liquidity.usd)||0, pu=+pr.priceUsd, pn=+pr.priceNative; if(!(pu>0)) continue;
    for(const t of part){ const same=a=>!!a&&(c==='ethereum'||c==='arbitrum'||c==='base'||c==='optimism'||c==='polygon'?String(a).toLowerCase()===String(t.addr).toLowerCase():a===t.addr);
      let px=null; if(same(pr.baseToken&&pr.baseToken.address)) px=pu; else if(same(pr.quoteToken&&pr.quoteToken.address)&&pn>0) px=pu/pn;
      if(px>0&&liq>(t.dexLiq||0)){ t.dex=px; t.dexLiq=liq; } } }
  await sleep(400); }
const llKey=t=>t.llama||(t.native?(t.chain==='sol'?'coingecko:solana':t.chain==='polygon'?'coingecko:polygon-ecosystem-token':'coingecko:ethereum'):(t.chain==='sol'?'solana':t.chain)+':'+t.addr);
const keys=[...new Set(ranked.map(llKey))];
for(let i=0;i<keys.length;i+=40){ const j=await get('https://coins.llama.fi/prices/current/'+keys.slice(i,i+40).join(','));
  for(const t of ranked){ const c=j&&j.coins&&j.coins[llKey(t)]; if(c&&c.price>0){ t.ll=c.price; t.llAge=now-c.timestamp*1000; } } }
for(const t of ranked){
  const major=t.native?(t.chain==='sol'?'SOL':t.chain==='polygon'?'POL':'ETH'):(t.chain!=='sol'&&L2WETH.has(String(t.addr).toLowerCase())?'ETH':null);
  t.stable=!!(t.sym&&STABLE.test(t.sym));
  if(major&&cb[major]){ t.mkt=cb[major].px; t.mktFrom='Coinbase'; }
  else if(t.dex>0&&t.dexLiq>=25000){ t.mkt=t.dex; t.mktFrom='DEX pool'; }
  else if(t.ll>0&&t.llAge<30*60e3){ t.mkt=t.ll; t.mktFrom='DefiLlama'; }
  else if(t.stable){ t.mkt=1; t.mktFrom='a dollar'; }
}
const cbChg=s=>cb[s]&&cb[s].open?cb[s].px/cb[s].open-1:null;
console.log('\n— the market now —');
OK('24 h on Coinbase: ETH '+pct(cbChg('ETH'))+' · BTC '+pct(cbChg('BTC'))+' · SOL '+pct(cbChg('SOL')));
const mine=ranked.filter(t=>t.share>=0.005&&!t.stable), withMkt=mine.filter(t=>t.mkt>0);
(withMkt.length===mine.length?OK:WARN)('your tokens worth 0.5% or more of the value (dollars aside): '+mine.length+' · a market price now for '+withMkt.length
  +' ('+withMkt.filter(t=>t.mktFrom==='Coinbase').length+' Coinbase, '+withMkt.filter(t=>t.mktFrom==='DEX pool').length+' DEX pool, '+withMkt.filter(t=>t.mktFrom==='DefiLlama').length+' DefiLlama)');
{ const ll=mine.filter(t=>t.llAge!=null), old=ll.filter(t=>t.llAge>30*60e3);
  (old.length?WARN:OK)('DefiLlama, the feed behind the wallets and the ticker strip: '+ll.length+' of '+mine.length+' priced · '+old.length+' with a price older than 30 min'
    +(ll.length?' (oldest '+age(Math.max(...ll.map(t=>t.llAge)))+')':'')); }

/* ---------- the page, as a browser opens it ---------- */
const b=await chromium.launch(), ctx=await b.newContext({viewport:{width:1440,height:900}});
await ctx.addInitScript(([salt,bits])=>{ try{ localStorage.setItem('lphud:lockKey', JSON.stringify({salt,bits})); }catch(e){} }, [LOCKMETA.salt, BITS.toString('base64')]);
const pg=await ctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto(LIVE+'?audit='+Date.now(),{waitUntil:'domcontentloaded'});
const scanned=await pg.waitForFunction(()=>typeof state!=='undefined'&&state.scanCount>=1&&!scanning,null,{timeout:240000}).then(()=>true,()=>false);
await pg.waitForTimeout(8000);
const P=await pg.evaluate(()=>{
  const k=(chain,addr)=>tokKey(chain,addr);
  const cards=[...state.positions.values()].map(p=>({k0:k(p.chain,p.chain==='sol'?p.mint0:p.token0), k1:k(p.chain,p.chain==='sol'?p.mint1:p.token1),
    u0:p.usd0, u1:p.usd1, w0:(p.amt0||0)*(p.usd0||0), w1:(p.amt1||0)*(p.usd1||0), inRange:!!p.inRange, chain:p.chain==='sol'?'Solana':'Ethereum'}));
  let book=[]; try{ book=buildTokenBook().map(t=>({k:t.key, u:t.usd, idle:t.idle, pooled:t.pooled, total:t.total, v:t.value, inPool:t.legs.length>0})); }catch(e){}
  const H=state.history||[];
  // the pools whose own price is off the market: the card says so, and PRIORITY flags the ones a trade back would pass through
  const off=[...state.positions.values()].filter(p=>p.poolGap&&Math.abs(p.poolGap.pct)>2);
  const gapRows=[...document.querySelectorAll('#actionBody .act-row')].filter(x=>/OFF THE MARKET/.test(x.innerText)).length;
  const gaps={n:off.length, inRange:off.filter(p=>p.inRange).length, shown:document.querySelectorAll('#cards .card .pgap').length, rows:gapRows,
    worst:off.length?Math.max(...off.map(p=>Math.abs(p.poolGap.pct))):null};
  /* every gauge as drawn: the card's RANGE POSITION dial (needle and figure), the range bar's cursor
     under it, the move to each edge, and where the market price would put the needle for a pool
     that is off the market; plus the momentum dials and the gas dials */
  const gauges=[...document.querySelectorAll('#cards .card')].map(c=>{
    const p=[...state.positions.values()].find(q=>String(q.id)===c.dataset.id); if(!p) return null;
    const svg=c.querySelector('.gaugebox svg'), txt=svg?(svg.querySelector('text')||{}).textContent:null;
    const nl=svg?[...svg.querySelectorAll('line')].find(l=>l.getAttribute('stroke')==='#eaf7fa'):null;
    const fN=nl?1-Math.atan2(+nl.getAttribute('y1')-+nl.getAttribute('y2'), +nl.getAttribute('x2')-+nl.getAttribute('x1'))/Math.PI:null;
    const rr=c.querySelector('.rangebar .rb-range'), cu=c.querySelector('.rangebar .rb-price');
    const L=rr?parseFloat(rr.style.left):null, W=rr?parseFloat(rr.style.width):null, X=cu?parseFloat(String(cu.style.left).replace('calc(','')):null;
    const inv=getInv(p), dLo=inv?1/p.priceUpper:p.priceLower, dHi=inv?1/p.priceLower:p.priceUpper, dPr=inv?1/p.price:p.price;
    const lin=x=>(x-dLo)/(dHi-dLo), lg=x=>Math.log(x/dLo)/Math.log(dHi/dLo), e=dispEdge(p);
    const g=p.poolGap&&Math.abs(p.poolGap.pct)>2?p.poolGap:null, Pm=g&&p.usd0>0&&p.usd1>0?p.usd0/p.usd1:null, dPm=Pm?(inv?1/Pm:Pm):null;
    return {v:p.valueUsd||0, txt, fN, mark:!!(svg&&svg.querySelector('.g-mkt')), fBar:L!=null&&W>0&&X!=null?(X-L)/W:null, lin:lin(dPr), log:lg(dPr), inRange:!!p.inRange,
      down:inv?(1-p.price/p.priceUpper)*100:p.dLow, up:inv?(p.price/p.priceLower-1)*100:p.dUp, sev:severityOf(p), inv, wide:dHi/dLo,
      gap:g?g.pct:null, mLin:dPm?lin(dPm):null, mLog:dPm?lg(dPm):null};
  }).filter(Boolean);
  const M=state.momentum, mo=['#moTileDial','#moHeroDial'].map(s=>{ const n=document.querySelector(s+' .mo-needle'); const m=n&&/rotate\((-?[\d.]+)deg\)/.exec(n.style.transform); return m?+m[1]:null; });
  /* the GAS dials as drawn, against the page's own model run again on the same readings, with the parts
     that matter worked out here independently: where the needle sits for what a re-range costs now (a
     log scale from 1 cent to $30) and the lit band (under $1, $1-5, over $5), Ethereum's usual for this
     hour (the median of that Budapest hour's readings over 14 days, six at least, else all of them), the
     lowest stretch of the next 24 hours, and Solana's base fee (three signatures at 5,000 lamports);
     then each tile tapped, its box read, and tapped again */
  const fx=typeof feeModel!=='function'||typeof gasBand!=='function'?null:(()=>{
    const E=feeModel('eth'), S=feeModel('sol'), now=Date.now(), H=state.history||[];
    const hf=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Budapest',hour:'numeric',hourCycle:'h23'});
    const bh=t=>+hf.formatToParts(new Date(t)).find(p=>p.type==='hour').value, HH=h=>String(h).padStart(2,'0')+':00';
    const md=a=>{ const s=[...a].sort((x,y)=>x-y); return s.length?s[Math.floor(s.length/2)]:null; };
    const g=H.filter(x=>x&&x.t>=now-14*864e5&&typeof x.g==='number'&&x.g>0), by=Array.from({length:24},()=>[]); for(const x of g) by[bh(x.t)].push(x.g);
    const hu=by.map(a=>a.length>=6?md(a):null), h0=bh(now), usualG=hu[h0]??md(g.map(x=>x.g));
    const hrs=Array.from({length:24},(_,i)=>(h0+i)%24), nx=hrs.map(h=>hu[h]), have=nx.filter(v=>v>0), lo=have.length?Math.min(...have):null;
    let best=null, run=null; nx.forEach((v,i)=>{ if(lo!=null&&v>0&&v<=1.3*lo){ run=run?[run[0],i]:[i,i]; if(!best||run[1]-run[0]>best[1]-best[0]) best=run; } else run=null; });
    const lowTxt=!best?null:best[0]===0?'lowest now, until '+HH((hrs[best[1]]+1)%24):'lowest '+HH(hrs[best[0]])+'\u2013'+HH((hrs[best[1]]+1)%24);
    const pos=v=>Math.max(0,Math.min(1,(Math.log10(Math.max(v,1e-4))+2)/(Math.log10(30)+2))), band=v=>v==null?'':v>=5?'wait':v>=1?'hi':'ok';
    const dial=(ch,m)=>{ const t=document.querySelector('#hPx .px[data-gch="'+ch+'"]'), s=t&&t.querySelector('svg.gdial'); if(!s) return {drawn:false};
      const n=s.querySelector('line.ndl'), on=s.querySelector('path.on'), lit=on?((on.getAttribute('class')||'').match(/z-(\w+)/)||[])[1]:'';
      const p=n?1-Math.atan2(+n.getAttribute('y1')-+n.getAttribute('y2'), +n.getAttribute('x2')-+n.getAttribute('x1'))/Math.PI:null;
      t.click(); const bx=t.querySelector('.gbox'), txt=bx?bx.textContent.replace(/\s+/g,' ').trim():''; t.click();
      return {drawn:true, band:band(m.re), needleOk:m.re==null?p==null:p!=null&&Math.abs(p-pos(m.re))<0.01, bandOk:lit===band(m.re)&&(t.dataset.gas||'')===band(m.re),
        boxOk:!!bx&&(m.re==null||txt.includes('re-range now '+fmtFee(m.re))), closed:!t.querySelector('.gbox'), txt}; };
    const de=dial('eth',E), ds=dial('sol',S), per=state.gasGwei>0&&state.ethUsd?state.gasGwei*state.ethUsd/1e9:null;
    return {oldTile:!!document.getElementById('hFees'),
      eth:{...de, boxOk:de.boxOk&&(E.re==null||((E.hv==null||de.txt.includes('harvest '+fmtFee(E.hv)))&&(E.usual==null||de.txt.includes('usual at this hour '+fmtFee(E.usual))))),
        lowOk:!de.drawn||E.re==null||!lowTxt||de.txt.includes(lowTxt), x:E.x, n:E.n, gwei:state.gasGwei, hours:have.length,
        usualOk:E.usualG==null?usualG==null:usualG!=null&&Math.abs(E.usualG-usualG)<=1e-9,
        cheapOk:best?!!E.cheap&&E.cheap.a===best[0]&&E.cheap.b===best[1]:!E.cheap, cheapLen:best?best[1]-best[0]+1:null,
        units:E.re!=null&&per?E.re/per:null, unitsHv:E.hv!=null&&per?E.hv/per:null},
      sol:{...ds, x:S.x, dayN:S.dayN, dayPaid:S.dayPaid, baseOk:S.usual==null||Math.abs(S.usual-15000/1e9*(solUsdNow()||0))<1e-12, age:state.solPrio?now-state.solPrio.t:null}};
  })();
  const dials={moL:M&&M.now?M.now.L:null, mo, warn:cfg.warnPct, fx};
  return {gauges, dials, gaps, mode:state.mode, relayUsed:!!state.relayUsed, relayAt:state.relayAt||null, dataAt:state.dataAt||null, eth:state.ethUsd, btc:state.btcUsd,
    tickers:(state.tickers||[]).map(t=>({sym:t.sym, ch:t.ch, usd:t.usd})), cards, book, histT:H.length?H[H.length-1].t:null, idleAt:state.idleAt||null};
});
await b.close();
console.log('\n— each part of the page against the market —');
if(!scanned) FAIL('the page\'s first live scan did not finish within 4 minutes');
(errs.length?WARN:OK)('page errors: '+(errs.length||'none'));
(P.mode==='live'?OK:WARN)('the page is '+(P.mode==='live'?'live':'in '+P.mode+' mode')+(P.relayUsed?' · positions on at least one chain came from the relay file, not a live read':' · positions read live'));
for(const c of P.cards){ const t0=T.get(c.k0), t1=T.get(c.k1); if(t0) put(t0,'pageCards',c.u0,c.w0); if(t1) put(t1,'pageCards',c.u1,c.w1);
  for(const [t,u,w] of [[t0,c.u0,c.w0],[t1,c.u1,c.w1]]) if(t&&u>0) (t.legs=t.legs||[]).push({u, w, inRange:c.inRange, chain:c.chain}); }
for(const x of P.book){ const t=T.get(x.k); if(t){ put(t,'pageBook',x.u,x.v||0); if(!x.inPool) t.walletOnly=true; } }
const TICK={SOL:'sol:native', LCX:'ethereum:0x8cd41041505885ef0ad3858181d66f17be8aae7e', CPOOL:'ethereum:0x66761fa41377003622aee3c7675fc7b5c1c2fac5'};
const tickRows=P.tickers.map(x=>({t:T.get(TICK[x.sym])||(x.sym==='SOL'?{mkt:cb.SOL&&cb.SOL.px}:null), u:x.usd}));

/* the day record the momentum index and the daily totals are built from: today's, as last written */
const recs=Array.isArray(daily)?daily.filter(r=>r&&r.d).sort((a,b)=>a.d<b.d?-1:a.d>b.d?1:0):[];
const rec=recs[recs.length-1]||null;
const recKey=k=>{ if(!k) return null; if(k.startsWith('sol:')){ const m=k.slice(4); return 'sol:'+(m===WSOL||m==='native'?'native':m); }
  if(k==='evm:native') return 'ethereum:native'; const a=k.slice(4).toLowerCase(); if(a===WETH) return 'ethereum:native';
  const hit=ranked.find(t=>!t.native&&t.chain!=='sol'&&String(t.addr).toLowerCase()===a); return hit?hit.k:'ethereum:'+a; };
if(rec){ for(const p of rec.ps||[]){ const a=T.get(recKey(p.k0)), c=T.get(recKey(p.k1)); if(a) put(a,'record',p.u0,(p.a0||0)*(p.u0||0)); if(c) put(c,'record',p.u1,(p.a1||0)*(p.u1||0)); }
  for(const x of rec.w||[]){ const t=T.get(recKey(x.k)); if(t) put(t,'record',x.u,(x.a||0)*(x.u||0)); } }

/* one line a part: when its prices are from, and how far they sit from the market now */
const part=(name, src, asOf, expectMin, extra='')=>{
  const rows=ranked.filter(t=>!t.stable&&t.share>=0.005&&t.mkt>0&&pxOf(t,src)>0).map(t=>({t, d:pxOf(t,src)/t.mkt-1}));
  const off=rows.filter(r=>Math.abs(r.d)>OFF), wd=rows.reduce((s,r)=>s+r.d*r.t.share,0)/(rows.reduce((s,r)=>s+r.t.share,0)||1);
  const worst=rows.length?rows.reduce((a,r)=>Math.abs(r.d)>Math.abs(a.d)?r:a):null, old=asOf!=null&&now-asOf>expectMin*60e3;
  ((off.length||old)?WARN:OK)(name+': '+(asOf!=null?'prices from '+age(now-asOf)+' ago':'prices live')+' · '+rows.length+' token(s) compared, '+off.length+' more than 2% off the market'
    +(worst?' (worst '+pct(worst.d)+' on #'+worst.t.rank+')':'')+(rows.length?' · value-weighted '+pct(wd):'')+extra);
  for(const r of off) (r.t.offIn=r.t.offIn||[]).push(name);
  return off;
};
{ const de=P.eth&&cb.ETH?P.eth/cb.ETH.px-1:null, db=P.btc&&cb.BTC?P.btc/cb.BTC.px-1:null;
  ((de==null||Math.abs(de)>0.01||(db!=null&&Math.abs(db)>0.01))?WARN:OK)('ETH and BTC in the header (Chainlink): ETH '+pct(de)+', BTC '+pct(db)+' against Coinbase'); }
{ const rows=tickRows.filter(r=>r.t&&r.t.mkt>0&&r.u>0).map(r=>r.u/r.t.mkt-1), off=rows.filter(d=>Math.abs(d)>OFF);
  ((off.length||!rows.length)?WARN:OK)('ticker strip (DefiLlama, written by the relay): prices from '+age(now-relay.t)+' ago · '+rows.length+' of '+P.tickers.length+' compared, '+off.length+' more than 2% off'
    +(rows.length?' (worst '+pct(rows.reduce((a,d)=>Math.abs(d)>Math.abs(a)?d:a,0))+')':'')); }
part('position cards (read live on the page)', 'pageCards', null, 0);
{ const g=P.gaps||{}; ((g.shown===g.n&&g.rows<=g.n)?OK:WARN)('pools whose own price is more than 2% off the market: '+(g.n||0)+' ('+(g.inRange||0)+' in range'
    +(g.worst!=null?', the furthest '+g.worst.toFixed(1)+'% off':'')+') · the gap shown on '+(g.shown||0)+' card(s) · PRIORITY rows: '+(g.rows||0)); }
/* what it adds up to: the page's tokens at the page's prices against the same amounts at the market */
{ let pv=0, mv=0; for(const x of P.book){ if(!(x.v>0)) continue; const t=T.get(x.k); pv+=x.v; mv+=t&&t.mkt>0&&!t.stable&&x.total>0?x.total*t.mkt:x.v; }
  const d=mv>0?pv/mv-1:null; ((d!=null&&Math.abs(d)>0.005)?WARN:OK)('your tokens as the page values them (pools and wallets, NFTs aside): '+pct(d)+' against the same amounts at the market now'); }
part('TOKEN EXPOSURE and the wallet list (the page\'s token book)', 'pageBook', null, 0,
  ' · '+ranked.filter(t=>t.walletOnly&&!t.stable&&t.share>=0.005).length+' token(s) held only in wallets: those keep the relay\'s wallet price');
part('wallets in the relay file', 'relayWallets', idle.t||null, 20, idle.stale?' · HELD BACK: the last complete read'+(idle.staleWallets?' ('+idle.staleWallets+' wallet(s) did not answer)':'')+(idle.stalePx?' ('+idle.stalePx+' holding(s) unpriced)':''):'');
part('pools in the relay file', 'relayPools', relay.t||null, 20);
part('today\'s day record (momentum, daily totals)', 'record', rec&&rec.t||null, 20, rec?(rec.d===today?' · it is today\'s':' · NOT today\'s: the last is from another day'):' · no record');

console.log('\n— parts that are drawn from a stored reading —');
if(mo){ const a=now-(mo.t||0), live=mo.now&&mo.now.d===today;
  ((a>90*60e3||!live)?WARN:OK)('momentum reading: written '+age(a)+' ago'+(mo.now?' · its last day '+(live?'is today':'is NOT today'):'')+' · the momentum job (every twenty minutes) is the only thing that moves it'); }
else WARN('momentum reading: not readable');
{ const H=relay.history||[], L=H[H.length-1];
  ((L&&now-L.t<30*60e3)?OK:WARN)('portfolio history: newest point '+(L?age(now-L.t)+' old':'—')+' in the relay file · on the page '+(P.histT?age(now-P.histT)+' old':'—')); }
if(relay.nfts&&relay.nfts.t) ((now-relay.nfts.t<3*3600e3)?OK:WARN)('NFT floors: read '+age(now-relay.nfts.t)+' ago');
if(recon&&recon.t) OK('reconciled history (daily): rebuilt '+age(now-recon.t)+' ago');
if(census&&census.t) OK('pool census (twice a day): '+age(now-census.t)+' old');

/* ---------- the gauges: what each one shows, and why ---------- */
console.log('\n— gauges —');
{ const G=(P.gauges||[]).slice().sort((a,b)=>b.v-a.v), r=x=>x==null||!isFinite(x)?'—':Math.round(x*100)+'%', w=P.dials.warn;
  let disagree=0, alarming=0, marks=0, gapped=0;
  G.forEach((g,i)=>{ const drawn=g.fN!=null?g.fN:null, bar=g.fBar, d=bar!=null&&drawn!=null?Math.abs(drawn-Math.max(0,Math.min(1,bar))):0;
    if(g.inRange&&d>0.02) disagree++;
    /* the amber ends mark where a warnPct move reaches an edge: the needle is in one exactly when an edge is that close */
    const span=Math.log(g.wide), z0=Math.min(0.5,-Math.log(1-w/100)/span), z1=Math.min(0.5,Math.log(1+w/100)/span);
    const inZone=g.inRange&&drawn!=null&&(drawn<z0-0.005||drawn>1-z1+0.005), close=g.down<=w||g.up<=w;
    if(g.inRange&&drawn!=null&&inZone!==close&&Math.abs(Math.min(g.down,g.up)-w)>0.5) alarming++;
    if(g.gap!=null){ gapped++; if(g.mark) marks++; }
    OK('card #'+(i+1)+': gauge reads '+(g.txt||'—')+' (needle at '+r(drawn)+') · the bar under it puts the price at '+r(bar)+' · the linear share of the price span would be '+r(g.lin)
      +' · '+(g.inRange?'a '+g.down.toFixed(1)+'% fall or a '+g.up.toFixed(1)+'% rise reaches an edge':'out of range')+' · '+g.sev+' · range '+g.wide.toFixed(g.wide<10?2:0)+'× wide'
      +(g.inv?' · shown inverted':'')+(g.gap!=null?' · pool '+(g.gap>0?'+':'−')+Math.abs(g.gap).toFixed(1)+'% vs market: at the market price it would read '+r(g.mLog):''));
  });
  ((disagree||alarming||marks<gapped)?WARN:OK)(G.length+' range gauge(s) · '+disagree+' where the needle and the bar under it differ by more than 2 points · '+alarming+' where the amber end and a '+w+'% move to the edge disagree'
    +' · the market mark on '+marks+' of '+gapped+' pool(s) off the market');
  const D=P.dials, moOk=D.moL==null||D.mo.every(a=>a==null||Math.abs(a-D.moL*9)<0.6);
  (moOk?OK:WARN)('momentum dials: '+D.mo.filter(a=>a!=null).length+' drawn, needle '+(moOk?'at the reading\'s level':'NOT at the reading\'s level'));
  /* GAS dials: each against the page's model on the same readings, with the needle, the band, the usual
     and the lowest stretch worked out again above, and Ethereum's reading against what the last 20 blocks
     charged (base fee, and base fee plus the 90th-percentile tip), read seconds apart. Ratios, counts,
     hours and colours only: no amounts */
  if(!D.fx) WARN('gas dials: not on the page');
  else { const e=D.fx.eth, s=D.fx.sol, col={ok:'green',hi:'amber',wait:'red','':'no reading'};
    const drawn=(d,why)=>{ if(!d.drawn){ why.push('no dial'); return; }
      if(!d.needleOk) why.push('the needle is NOT where what a re-range costs puts it');
      if(!d.bandOk) why.push('the lit band or the tile\u2019s top edge is NOT the one its cost gives');
      if(!d.boxOk) why.push('the tap box does NOT show what its readings give');
      if(!d.closed) why.push('the box did not close on a second tap'); };
    let why=[], mkt='';
    if(D.fx.oldTile) why.push('the old RE-RANGE GAS tile is still on the page');
    drawn(e,why);
    if(!e.lowOk) why.push('the lowest stretch in the box is NOT the one worked out here');
    if(!e.usualOk) why.push('its usual for this hour is NOT the median of that hour\u2019s readings');
    if(!e.cheapOk) why.push('the lowest stretch is NOT the one worked out here');
    if(e.gwei>0){ const fh=await feeHist();
      if(fh){ const inside=e.gwei>=fh.lo*0.9&&e.gwei<=fh.hi*1.1; if(!inside) why.push('the gas reading is outside what the last 20 blocks charged');
        mkt=' · the page\u2019s gas reading '+(inside?'within':'OUTSIDE')+' what the last 20 blocks charged ('+(e.gwei/fh.typ>=1?'+':'\u2212')+Math.abs(Math.round((e.gwei/fh.typ-1)*100))+'% against a typical transaction)'; }
      if(e.units!=null&&Math.abs(e.units/625000-1)>0.01) why.push('a re-range is not costed at 625k gas');
      if(e.unitsHv!=null&&Math.abs(e.unitsHv/175000-1)>0.01) why.push('a harvest is not costed at 175k gas'); }
    (why.length?WARN:OK)('gas dial, ETH: '+(why.length?why.join('; '):'needle and lit band ('+col[e.band]+') where its cost puts them; the tap box shows its figures; its usual for this hour and the lowest stretch match the ones worked out here')
      +(e.x!=null?' · '+(e.x>=100?Math.round(e.x):e.x.toFixed(1))+'\u00d7 its usual for this hour':' · no usual yet ('+e.n+' readings)')
      +' · '+e.hours+' of 24 hours with a usual'+(e.cheapLen?' · lowest stretch '+e.cheapLen+' h':'')+mkt);
    why=[];
    drawn(s,why);
    if(!s.baseOk) why.push('its base fee is NOT three signatures at 5,000 lamports');
    if(!(s.age!=null&&s.age<3600e3)) why.push('the relay\u2019s Solana reading is '+(s.age==null?'missing':Math.round(s.age/60e3)+' min old'));
    (why.length?WARN:OK)('gas dial, SOL: '+(why.length?why.join('; '):'needle and lit band ('+col[s.band]+') where its cost puts them; the tap box shows its figures')
      +(s.x!=null?' · '+s.x.toFixed(2)+'\u00d7 its base fee':'')
      +(s.dayN?' · a priority fee needed in '+Math.round(s.dayPaid/s.dayN*100)+'% of the last 24 hours\u2019 '+s.dayN+' readings':'')
      +(s.age!=null?' · the relay\u2019s reading '+Math.round(s.age/60e3)+' min old':'')); }
}

/* Ethereum: what the last 20 blocks charged, in gwei: the lowest base fee, and the highest base fee
   plus the 90th-percentile tip, with a typical transaction (the newest base fee plus the median tip) */
async function feeHist(){
  for(const u of ['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth']){
    try{ const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(15000),
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_feeHistory',params:['0x14','latest',[50,90]]})}); const j=r.ok?await r.json():null, h=j&&j.result;
      if(!h||!h.baseFeePerGas) continue; const g=x=>Number(BigInt(x))/1e9, base=h.baseFeePerGas.map(g), tips=(h.reward||[]).map(x=>x.map(g));
      const med=a=>{ const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]||0; };
      return {lo:Math.min(...base), hi:Math.max(...base.slice(0,-1).map((b,i)=>b+((tips[i]||[])[1]||0)), base[base.length-1]), typ:base[base.length-1]+med(tips.map(x=>x[0]))}; }catch(e){} }
  return null;
}
/* the tokens behind any WARN above, by rank, with where the market price came from */
const flagged=ranked.filter(t=>t.offIn&&t.offIn.length);
if(flagged.length){ console.log('\n— tokens off the market, by rank (#1 is your largest) —');
  for(const t of flagged){
    const parts=['pageCards','pageBook','relayWallets','relayPools','record'].map(s=>{ const p=pxOf(t,s); return p>0?({pageCards:'cards',pageBook:'book',relayWallets:'relay wallets',relayPools:'relay pools',record:'record'})[s]+' '+pct(p/t.mkt-1):null; }).filter(Boolean);
    OK('#'+t.rank+' ('+(t.share>=0.1?'10% or more':t.share>=0.02?'2–10%':'under 2%')+' of the value'+(t.walletOnly?', wallets only':'')+'): market from '+t.mktFrom+(t.mktFrom==='DEX pool'?' (busiest pool deep enough)':'')
      +' · '+parts.join(' · ')+' · DefiLlama '+(t.ll>0?pct(t.ll/t.mkt-1)+', its price '+age(t.llAge)+' old':'has no price')+(t.lpFilled?' · priced from its pool in the relay':''));
    /* each of your pools that holds it, largest first: what that pool prices it at, and whether the
       position is in range (no pool is named or sized) */
    if(t.legs&&t.legs.length) OK('   #'+t.rank+' in '+t.legs.length+' pool(s) of yours on '+[...new Set(t.legs.map(l=>l.chain))].join(' and ')+': '
      +t.legs.sort((a,b)=>b.w-a.w).map(l=>pct(l.u/t.mkt-1)+(l.inRange?' in range':' out of range')).join(' · ')
      +(t.chain==='sol'?' · its wallet price comes from Jupiter':' · its wallet price comes from DefiLlama'));
  } }

console.log('\n'+fails+' fail, '+warns+' warn');
process.exit(fails?1:0);

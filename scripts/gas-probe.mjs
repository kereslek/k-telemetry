/* Is the ETH gas meter right? Read by hand (gas-probe.yml). Market data only: gas prices, block
   fees, the median gas the public's own Uniswap v3 position operations used, and the deck's recorded
   gas readings as statistics. Nothing of the owner's: no amount, address, position or transaction.

   1. What a transaction pays now: the next block's base fee plus the tips actually paid in the last
      twenty blocks (eth_feeHistory), against the eth_gasPrice each endpoint answers, which is what
      the meter shows (the page asks its own endpoints, the relay asks its own).
   2. Where the deck's recorded readings sit on the gauge: its axis runs 0.1 to 100 gwei and its
      words are fixed (VERY LOW under 1 gwei, LOW under 5, NORMAL under 15).
   3. What the costs on the meter assume (harvest 130k gas, re-range 520k) against the median gas
      of the last few hundred calls to Uniswap v3's position manager, sorted by what each call did. */
import crypto from 'node:crypto';
const sleep=ms=>new Promise(f=>setTimeout(f,ms));
async function get(u,opt){ for(let k=0;k<3;k++){ try{ const r=await fetch(u,{...opt,signal:AbortSignal.timeout(20000)}); if(r.ok) return await r.json(); }catch(e){} await sleep(1200*(k+1)); } return null; }
const rpc=async(url,method,params=[])=>{ const j=await get(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}); return j&&j.result!=null?j.result:null; };
const gw=hex=>hex==null?null:Number(BigInt(hex))/1e9;
const f=x=>x==null?'—':x>=10?x.toFixed(1):x>=1?x.toFixed(2):x>=0.01?x.toFixed(3):x.toPrecision(2);
const pctl=(a,p)=>{ const s=a.filter(x=>x!=null&&isFinite(x)).sort((x,y)=>x-y); if(!s.length) return null; return s[Math.min(s.length-1,Math.floor(p/100*s.length))]; };
const med=a=>pctl(a,50);

/* ---------- 1. now ---------- */
const PAGE=['https://eth.drpc.org','https://ethereum-rpc.publicnode.com','https://rpc.mevblocker.io','https://1rpc.io/eth','https://rpc.flashbots.net','https://eth.meowrpc.com'];
const RELAY=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://eth.llamarpc.com','https://1rpc.io/eth','https://rpc.mevblocker.io'];
let fh=null; for(const u of ['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth']){ fh=await rpc(u,'eth_feeHistory',['0x14','latest',[10,50,90]]); if(fh&&fh.baseFeePerGas) break; }
let typical=null;
if(fh&&fh.baseFeePerGas){
  const base=fh.baseFeePerGas.map(gw), next=base[base.length-1], tips=(fh.reward||[]).map(r=>r.map(gw));
  const t10=med(tips.map(r=>r[0])), t50=med(tips.map(r=>r[1])), t90=med(tips.map(r=>r[2]));
  typical=next+t50;
  console.log('now, in gwei: the next block’s base fee '+f(next)+' (last 20 blocks '+f(Math.min(...base))+' to '+f(Math.max(...base))+')'
    +' · tips paid, median block: 10th percentile '+f(t10)+', median '+f(t50)+', 90th '+f(t90)+' · a typical transaction pays '+f(typical)
    +' · blocks '+Math.round((fh.gasUsedRatio||[]).reduce((s,x)=>s+x,0)/Math.max(1,(fh.gasUsedRatio||[]).length)*100)+'% full on average');
}else console.log('fee history: no endpoint answered');
for(const [who,list] of [['the page',PAGE],['the relay',RELAY]]){
  const rows=[]; for(const u of list){ const g=gw(await rpc(u,'eth_gasPrice')); rows.push([u.replace(/^https:\/\//,'').replace(/\/.*$/,''),g]); await sleep(200); }
  console.log('eth_gasPrice as '+who+' asks it: '+rows.map(([h,g])=>h+' '+f(g)+(g!=null&&typical?' ('+(g>=typical?'+':'')+Math.round((g/typical-1)*100)+'%)':'')).join(' · '));
}

/* ---------- 2. the deck's own readings, as statistics ---------- */
{ const PASS=String(process.env.DECK_PASSPHRASE||'').trim(), SITE='https://kereslek.github.io/k-telemetry/deck-r7k4x9/';
  const L=PASS?await get(SITE+'lock.json?t='+Date.now()):null, D=L?await get(SITE+'data-main.json?t='+Date.now()):null;
  let hist=null;
  if(L&&D&&D.lock===1){ try{ const K=crypto.pbkdf2Sync(PASS,Buffer.from(L.salt,'base64'),L.iter,64,'sha256').subarray(0,32), all=Buffer.from(D.ct,'base64');
    const d=crypto.createDecipheriv('aes-256-gcm',K,Buffer.from(D.iv,'base64')); d.setAuthTag(all.subarray(all.length-16));
    const data=JSON.parse(Buffer.concat([d.update(all.subarray(0,all.length-16)),d.final()]).toString('utf8')); hist=data.history||null;
    console.log('the relay’s latest reading: '+f(data.gasGwei)+' gwei'+(typical?' ('+(data.gasGwei>=typical?'+':'')+Math.round((data.gasGwei/typical-1)*100)+'% against what a typical transaction pays now, read '+Math.round((Date.now()-data.t)/60000)+' min apart)':'')); }catch(e){ console.log('the deck’s data could not be opened'); } }
  const g=(hist||[]).filter(x=>x&&x.g>0&&x.t>Date.now()-7*864e5).map(x=>x.g);
  if(g.length){
    const share=fn=>Math.round(g.filter(fn).length/g.length*100)+'%';
    console.log('the deck’s recorded gas, last 7 days ('+g.length+' readings): lowest '+f(pctl(g,0))+' · 10th percentile '+f(pctl(g,10))+' · median '+f(med(g))+' · 90th '+f(pctl(g,90))+' · highest '+f(pctl(g,100))+' gwei');
    console.log('on the gauge: below its 0.1 gwei floor (needle stuck at the left end) '+share(x=>x<0.1)+' of the time · VERY LOW (under 1 gwei) '+share(x=>x<1)+' · LOW '+share(x=>x>=1&&x<5)+' · NORMAL or above '+share(x=>x>=5));
  }else console.log('the deck’s recorded gas: no readings in the last 7 days');
}

/* ---------- 3. gas the public's own position operations used ---------- */
{ const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88', BS='https://eth.blockscout.com/api/v2';
  const SEL={'fc6f7865':'collect','0c49ccbe':'decrease','88316456':'mint','219f5d17':'increase','42966c68':'burn','49404b7c':'unwrap','df2ab5bb':'sweep','12210e8a':'refund','ac9650d8':'multicall'};
  // the calls inside a multicall(bytes[]): each element starts with its own four-byte selector
  const inner=hex=>{ const h=String(hex||'').replace(/^0x/,''); if(h.slice(0,8)!=='ac9650d8') return [SEL[h.slice(0,8)]||'other'];
    try{ const b=h.slice(8), w=i=>b.slice(64*i,64*(i+1)), at=Number(BigInt('0x'+w(0)))/32, n=Number(BigInt('0x'+w(at))), out=[];
      for(let i=0;i<n;i++){ const off=Number(BigInt('0x'+w(at+1+i)))/32, start=(at+1+off+1)*64; out.push(SEL[b.slice(start,start+8)]||'other'); } return out; }catch(e){ return ['other']; } };
  const kind=ops=>{ const s=new Set(ops);
    if(s.has('mint')) return 'open a position (mint)';
    if(s.has('decrease')&&s.has('collect')) return s.has('burn')?'close a position (decrease, collect, burn)':'withdraw (decrease and collect)';
    if(s.has('collect')&&!s.has('decrease')&&!s.has('increase')) return 'harvest (collect)';
    if(s.has('increase')) return 'add to a position (increase)';
    return null; };
  const by=new Map(); let url=BS+'/addresses/'+NPM+'/transactions?filter=to', pages=0, seen=0;
  while(url&&pages<8){ pages++; const r=await get(url); if(!r) break;
    for(const tx of r.items||[]){ if(tx.status!=='ok'||!(+tx.gas_used>0)) continue; seen++;
      const k=kind(inner(tx.raw_input)); if(!k) continue; if(!by.has(k)) by.set(k,[]); by.get(k).push(+tx.gas_used); }
    url=r.next_page_params?BS+'/addresses/'+NPM+'/transactions?filter=to&'+new URLSearchParams(r.next_page_params):null; await sleep(400); }
  const K=x=>Math.round(x/1000)+'k';
  console.log('Uniswap v3 position manager, the last '+seen+' successful calls, median gas used: '+[...by.entries()].sort((a,b)=>b[1].length-a[1].length)
    .map(([k,a])=>k+' '+K(med(a))+' (n '+a.length+', middle half '+K(pctl(a,25))+'–'+K(pctl(a,75))+')').join(' · '));
  const h=by.get('harvest (collect)'), w=by.get('withdraw (decrease and collect)')||by.get('close a position (decrease, collect, burn)'), m=by.get('open a position (mint)');
  if(h) console.log('the meter’s harvest assumes 130k gas: measured median '+K(med(h)));
  if(w&&m) console.log('the meter’s re-range assumes 520k gas (withdraw, collect and open a new position): measured withdraw + open '+K(med(w)+med(m)));
}

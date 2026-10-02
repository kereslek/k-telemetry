/* Fee income, minute by minute, read straight from the pools.

   What a position earns is its liquidity times the growth of the pool's fee-per-liquidity inside
   its range. Reading that growth each minute and multiplying the change by the position's
   liquidity gives the fees earned in that minute — and only fees: collecting them, adding
   liquidity or withdrawing principal moves the position's owed balance but not the pool's fee
   growth, so none of those can show up as income. The same identity the relay uses for owed
   fees, taken as a difference rather than a level.

   Uniswap v3 (Ethereum): fee growth is Q128, wrapping at 2^256.
   Raydium CLMM (Solana): fee growth is Q64 in a u128, wrapping at 2^128.

   The position list, token decimals and USD prices come from the dashboard's own published data,
   so this adds no second opinion about what is held or what it is worth. No dependencies: runs
   in a Cloudflare Worker and in Node alike. */

const NPM='0xc36442b4a4522e871399cd717abdd847ab11fe88';
const CLMM='CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
/* One eth_call per minute (everything bundled through Multicall3), so any endpoint that answers
   a plain eth_call will do; batch requests were refused by some and rate-limited by others. */
export const EVM_RPCS=['https://ethereum-rpc.publicnode.com','https://eth.drpc.org','https://1rpc.io/eth','https://rpc.mevblocker.io',
  'https://eth-mainnet.public.blastapi.io','https://rpc.flashbots.net','https://eth.llamarpc.com'];
const MC3='0xca11bde05977b3631167028862be2a173976ca11';
/* Keyless endpoints that answer a Cloudflare Worker (checked from the Workers runtime, 28 Sep):
   Solana's own api.mainnet-beta and drpc's free tier refuse it. A SOL_RPC_URL secret goes first. */
export const SOL_RPCS=['https://solana-rpc.publicnode.com','https://rpc.solanatracker.io/public','https://solana.leorpc.com/?api_key=FREE','https://solana-mainnet.gateway.tatum.io'];
const M256=(1n<<256n)-1n, M128=(1n<<128n)-1n;

/* ---------- plumbing ---------- */
async function post(url, body, ms=12000){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(ms)});
  if(!r.ok) throw new Error(url.split('/')[2]+' HTTP '+r.status+' '+(await r.text().catch(()=>'')).slice(0,80));
  return r.json();
}
async function one(rpcs, method, params){
  const errs=[];
  for(const u of rpcs){ try{ const j=await post(u,{jsonrpc:'2.0',id:1,method,params}); if(j.error) throw new Error(u.split('/')[2]+' '+j.error.message); return j.result; }catch(e){ errs.push(String(e.message||e)); } }
  throw new Error(errs.join(' | ')||'no rpc');
}

/* ---------- Ethereum: Uniswap v3 ---------- */
const word=(hex,i)=>BigInt('0x'+(hex.slice(2+64*i,2+64*(i+1))||'0'));
const i256=w=>w>=(1n<<255n)?w-(1n<<256n):w;
const u256hex=v=>((BigInt.asUintN(256,BigInt(v))).toString(16)).padStart(64,'0');
const call=(to,data)=>({to,data});
// Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[])
function encAgg(calls){
  const parts=calls.map(c=>{ const d=c.data.slice(2), len=d.length/2;
    return c.to.slice(2).toLowerCase().padStart(64,'0')+u256hex(1)+u256hex(0x60)+u256hex(len)+d.padEnd(Math.ceil(len/32)*64,'0'); });
  let off=calls.length*32; const offs=parts.map(p=>{ const o=u256hex(off); off+=p.length/2; return o; });
  return '0x82ad56cb'+u256hex(0x20)+u256hex(calls.length)+offs.join('')+parts.join('');
}
function decAgg(ret){
  const h=ret.slice(2), at=p=>Number(BigInt('0x'+h.slice(p*2,p*2+64)));
  const arr=at(0), n=at(arr), base=arr+32, out=[];
  for(let k=0;k<n;k++){ const el=base+at(base+32*k), ok=at(el)!==0, b=el+at(el+32), len=at(b);
    out.push(ok&&len?'0x'+h.slice((b+32)*2,(b+32+len)*2):null); }
  return out;
}
// failed calls come back as null, so one bad position (burned, reverted) cannot sink the rest
async function multi(rpcs, calls){
  const r=decAgg(await one(rpcs,'eth_call',[{to:MC3,data:encAgg(calls)},'latest']));
  if(r.length!==calls.length) throw new Error('multicall: reply length');
  return r;
}
function insideEvm(g,oL,oU,cur,tl,tu){
  const below=cur>=tl?oL:(g-oL)&M256, above=cur<tu?oU:(g-oU)&M256;
  return (g-below-above)&M256;
}
async function growthEvm(ps, cache, rpcs){
  const out={};
  if(!ps.length) return out;
  // tick range never changes for a token id: read once, keep
  const need=ps.filter(p=>!cache[p.id]);
  if(need.length){
    const r=await multi(rpcs, need.map(p=>call(NPM,'0x99fbab88'+u256hex(p.id))));
    need.forEach((p,i)=>{ if(r[i]) cache[p.id]={tl:Number(i256(word(r[i],5))), tu:Number(i256(word(r[i],6)))}; });
  }
  const pools=[...new Set(ps.map(p=>p.pool))];
  const calls=[], at={};
  for(const pl of pools){ at[pl]=calls.length; calls.push(call(pl,'0x3850c7bd'),call(pl,'0xf3058399'),call(pl,'0x46141319')); }
  const tickAt={}, live=ps.filter(p=>cache[p.id]);
  for(const p of live){ const c=cache[p.id];
    for(const t of [c.tl,c.tu]){ const k=p.pool+':'+t; if(tickAt[k]==null){ tickAt[k]=calls.length; calls.push(call(p.pool,'0xf30dba93'+u256hex(t))); } }
    p._i=calls.length; calls.push(call(NPM,'0x99fbab88'+u256hex(p.id))); }
  const r=await multi(rpcs, calls);
  for(const p of live){
    const c=cache[p.id], a=at[p.pool];
    const lo=r[tickAt[p.pool+':'+c.tl]], up=r[tickAt[p.pool+':'+c.tu]];
    if(!r[a]||!r[a+1]||!r[a+2]||!lo||!up||!r[p._i]) continue;        // a failed call: no reading, not a zero
    const cur=Number(i256(word(r[a],1))), g0=word(r[a+1],0), g1=word(r[a+2],0);
    out[p.id]={q:128, L:word(r[p._i],7).toString(),
      f0:insideEvm(g0,word(lo,2),word(up,2),cur,c.tl,c.tu).toString(),
      f1:insideEvm(g1,word(lo,3),word(up,3),cur,c.tl,c.tu).toString()};
  }
  return out;
}

/* ---------- Solana: Raydium CLMM ---------- */
const B58A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58M=Object.fromEntries([...B58A].map((c,i)=>[c,i]));
function b58d(s){let n=0n;for(const c of s)n=n*58n+BigInt(B58M[c]);const b=[];while(n>0n){b.unshift(Number(n&255n));n>>=8n;}for(const c of s){if(c==='1')b.unshift(0);else break;}return new Uint8Array(b);}
function b58e(bytes){let n=0n;for(const b of bytes)n=(n<<8n)|BigInt(b);let o='';while(n>0n){o=B58A[Number(n%58n)]+o;n/=58n;}for(const b of bytes){if(b===0)o='1'+o;else break;}return o;}
const P=(1n<<255n)-19n, D=37095705934669439343138083508754565189542113879843219016388785533085940283555n;
function mpow(b,e,m){let r=1n;b%=m;while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n;}return r;}
function onCurve(by){let y=0n;for(let i=31;i>=0;i--)y=(y<<8n)|BigInt(i===31?(by[i]&0x7f):by[i]);if(y>=P)return false;
  const sg=(by[31]&0x80)>>7,y2=y*y%P,u=(y2-1n+P)%P,v=(D*y2+1n)%P,v3=v*v%P*v%P,uv7=u*(v3*v3%P*v%P)%P;
  let x=u*v3%P*mpow(uv7,(P-5n)/8n,P)%P; const vxx=v*x%P*x%P;
  if(vxx!==u){ if((vxx+u)%P!==0n)return false; x=x*mpow(2n,(P-1n)/4n,P)%P; }
  if(x===0n&&sg===1)return false; return true;}
async function pda(seeds,prog){
  const pg=b58d(prog), mk=new TextEncoder().encode('ProgramDerivedAddress');
  for(let bump=255;bump>=0;bump--){
    const parts=[...seeds,new Uint8Array([bump]),pg,mk];
    const buf=new Uint8Array(parts.reduce((s,p)=>s+p.length,0)); let o=0; for(const p of parts){buf.set(p,o);o+=p.length;}
    const h=new Uint8Array(await crypto.subtle.digest('SHA-256',buf));
    if(!onCurve(h)) return b58e(h);
  }
  throw new Error('no pda');
}
const b64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const leU16=(b,o)=>b[o]|(b[o+1]<<8);
const leU128=(b,o)=>{let n=0n;for(let i=15;i>=0;i--)n=(n<<8n)|BigInt(b[o+i]);return n;};
const leI32=(b,o)=>{const u=(b[o]|(b[o+1]<<8)|(b[o+2]<<16)|(b[o+3]<<24))>>>0;return u>0x7fffffff?u-0x100000000:u;};
const i32be=v=>{const bb=new Uint8Array(4);new DataView(bb.buffer).setInt32(0,v,false);return bb;};
function insideSol(g,oL,oU,cur,tl,tu){
  const below=cur>=tl?oL:(g-oL)&M128, above=cur<tu?oU:(g-oU)&M128;
  return (g-below-above)&M128;
}
async function growthSol(ps, cache, rpcs){
  const out={};
  if(!ps.length) return out;
  const pools=[...new Set(ps.map(p=>p.pool))];
  // tick spacing per pool and each position's range: fixed, read once
  if(ps.some(p=>!cache[p.id]) || pools.some(pl=>!cache[pl])){
    const accs=[...ps.map(p=>p.pda),...pools];
    const r=await one(rpcs,'getMultipleAccounts',[accs,{encoding:'base64'}]);
    ps.forEach((p,i)=>{ const a=r.value[i]; if(!a) return; const b=b64(a.data[0]); cache[p.id]={tl:leI32(b,73),tu:leI32(b,77)}; });
    pools.forEach((pl,i)=>{ const a=r.value[ps.length+i]; if(!a) return; cache[pl]={sp:leU16(b64(a.data[0]),235)}; });
  }
  const taOf=async(pl,t)=>{ const per=cache[pl].sp*60, start=Math.floor(t/per)*per, k='ta:'+pl+':'+start;
    if(!cache[k]) cache[k]=await pda([new TextEncoder().encode('tick_array'),b58d(pl),i32be(start)],CLMM);
    return {addr:cache[k], idx:Math.round((t-start)/cache[pl].sp)}; };
  const live=ps.filter(p=>cache[p.id]&&cache[p.pool]);
  const accs=[], at={};
  const add=a=>{ if(at[a]==null){ at[a]=accs.length; accs.push(a); } return at[a]; };
  const plan=[];
  for(const p of live){
    const lo=await taOf(p.pool,cache[p.id].tl), up=await taOf(p.pool,cache[p.id].tu);
    plan.push({p, pos:add(p.pda), pool:add(p.pool), lo:{i:add(lo.addr),idx:lo.idx}, up:{i:add(up.addr),idx:up.idx}});
  }
  const r=await one(rpcs,'getMultipleAccounts',[accs,{encoding:'base64'}]);
  const buf=r.value.map(a=>a?b64(a.data[0]):null);
  for(const x of plan){
    const pb=buf[x.pos], ob=buf[x.pool], lb=buf[x.lo.i], ub=buf[x.up.i];
    if(!pb||!ob||!lb||!ub) continue;
    const tl=cache[x.p.id].tl, tu=cache[x.p.id].tu, cur=leI32(ob,269);
    const g0=leU128(ob,277), g1=leU128(ob,293);
    const lo=44+x.lo.idx*168, up=44+x.up.idx*168;
    out[x.p.id]={q:64, L:leU128(pb,81).toString(),
      f0:insideSol(g0,leU128(lb,lo+36),leU128(ub,up+36),cur,tl,tu).toString(),
      f1:insideSol(g1,leU128(lb,lo+52),leU128(ub,up+52),cur,tl,tu).toString()};
  }
  return out;
}

/* ---------- the dashboard's position list ---------- */
export function positionsFrom(data){
  const ps=[];
  for(const p of data.eth||[]) if(p.pool&&/^\d+$/.test(String(p.id))&&p.usd0!=null&&p.usd1!=null)
    ps.push({id:String(p.id), chain:'eth', pool:p.pool.toLowerCase(), d0:p.d0, d1:p.d1, usd0:p.usd0, usd1:p.usd1, lbl:(p.pairLabel||'')+' '+(p.feeLabel||'')});
  for(const p of data.sol||[]) if(p.pda&&p.poolId&&p.venue!=='orca'&&p.usd0!=null&&p.usd1!=null)
    ps.push({id:p.id, chain:'sol', pool:p.poolId, pda:p.pda, d0:p.d0, d1:p.d1, usd0:p.usd0, usd1:p.usd1, lbl:(p.pairLabel||'')+' '+(p.feeLabel||'')});
  return ps;
}

/* One reading of every position's fee growth. `cache` holds the facts that never change (ranges,
   tick spacing, tick-array addresses) and is the caller's to keep between readings. */
// a different endpoint leads each minute, so no single free provider carries every request
const rot=(a,k)=>a.map((_,i)=>a[(i+k)%a.length]);
// `opt.chains` reads only those chains ('eth', 'sol'); both by default
export async function readGrowth(ps, cache, opt={}){
  const t=Date.now(), k=Math.floor(t/60000), sol=opt.solRpcs||SOL_RPCS, fixed=opt.solFirst?1:0, on=c=>!opt.chains||opt.chains.includes(c);
  const [e,s]=await Promise.allSettled([
    on('eth')?growthEvm(ps.filter(p=>p.chain==='eth'), cache, rot(opt.evmRpcs||EVM_RPCS,k)):{},
    on('sol')?growthSol(ps.filter(p=>p.chain==='sol'), cache, [...sol.slice(0,fixed),...rot(sol.slice(fixed),k)]):{}]);
  return { t, g:{...(e.status==='fulfilled'?e.value:{}), ...(s.status==='fulfilled'?s.value:{})},
           err:[e,s].filter(x=>x.status==='rejected').map(x=>String(x.reason&&x.reason.message||x.reason)) };
}

/* Fees earned between two readings, in USD, per position. The smaller of the two liquidities is
   used, so a top-up during the minute is not credited with fees the new money did not earn. A
   position missing from either reading contributes nothing rather than a guess. */
export function earned(prev, cur, ps){
  const by={}; let usd=0;
  for(const p of ps){
    const a=prev.g[p.id], b=cur.g[p.id]; if(!a||!b||a.q!==b.q) continue;
    const mask=b.q===128?M256:M128, half=b.q===128?(1n<<255n):(1n<<127n);
    const L=BigInt(a.L)<BigInt(b.L)?BigInt(a.L):BigInt(b.L);
    let d0=(BigInt(b.f0)-BigInt(a.f0))&mask, d1=(BigInt(b.f1)-BigInt(a.f1))&mask;
    // fee growth never falls: a fall means this node is behind the last one. That is no reading at
    // all — not a zero — so the position is left out and the caller keeps the newer reading.
    if(d0>half||d1>half) continue;
    const sh=BigInt(b.q);
    const t0=Number((d0*L)>>sh)/10**p.d0, t1=Number((d1*L)>>sh)/10**p.d1;
    const v=t0*p.usd0+t1*p.usd1;
    by[p.id]=v; usd+=v;
  }
  return {usd, by};
}

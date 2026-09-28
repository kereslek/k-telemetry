// One-off: minute recorder vs the relay fee ledger over the same stretches of time (rerun).
const W='https://kt-pulse.kereslek.workers.dev/m?n=1440';
const w=await (await fetch(W)).json();
const d=await (await fetch('https://kereslek.github.io/k-telemetry/deck-r7k4x9/data-main.json?t='+Date.now())).json();
console.log('recorder: N', w.N, 'read', w.read, 'err', JSON.stringify(w.err), 'minutes', w.mins.length, 'first', new Date(w.mins[0]?.[0]).toISOString(), 'partial minutes', w.mins.filter(m=>m[2]<w.N).length);
const tk=d.feeMonth.ticks;
let tw=0, tl=0;
console.log('from   to     ledger   recorder  diff');
for(let i=1;i<tk.length;i++){
  const [a,ca]=tk[i-1], [b,cb]=tk[i];
  if(a<w.mins[0][0]) continue;
  // minutes wholly inside (a,b]; the ledger reading is taken during the relay run, so allow the edges
  const s=w.mins.filter(m=>m[0]>=a-30000 && m[0]+60000<=b+30000).reduce((x,m)=>x+m[1],0);
  const l=Math.max(0,cb-ca); tw+=s; tl+=l;
  console.log(new Date(a).toISOString().slice(11,16), new Date(b).toISOString().slice(11,16), l.toFixed(2).padStart(8), s.toFixed(2).padStart(9), (s-l).toFixed(2).padStart(7));
}
console.log('TOTAL ledger', tl.toFixed(2), 'recorder', tw.toFixed(2));
console.log('PULSE_JSON '+JSON.stringify({...w, mins:w.mins.slice(-90)}));

// Third, independent check: the trades themselves, straight from the chains.
const since=Date.now()-2*3600000;
const pools={};
for(const p of d.eth) pools['eth:'+p.pool]=p.pairLabel+' '+p.feeLabel;
for(const p of d.sol) if(p.poolId) pools['sol:'+p.poolId]=p.pairLabel+' '+p.feeLabel;
for(const [k,lbl] of Object.entries(pools)){
  const [ch,addr]=k.split(':');
  try{
    if(ch==='eth'){
      const j=await (await fetch('https://eth.blockscout.com/api/v2/addresses/'+addr+'/logs')).json();
      const sw=(j.items||[]).filter(x=>x.decoded&&/^Swap/.test(x.decoded.method_call||''));
      const ts=[];
      for(const x of sw.slice(0,15)){ const b=await (await fetch('https://eth.blockscout.com/api/v2/blocks/'+x.block_number)).json(); ts.push(Date.parse(b.timestamp)); }
      const recent=ts.filter(t=>t>=since);
      console.log('SWAPS', lbl, addr.slice(0,10), 'last 2h:', recent.length, '· latest swap', ts[0]?new Date(ts[0]).toISOString():'none');
    } else {
      const r=await (await fetch('https://solana-rpc.publicnode.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[addr,{limit:50}]})})).json();
      const s=(r.result||[]).filter(x=>!x.err);
      console.log('POOL TXS', lbl, addr.slice(0,6), 'last 2h:', s.filter(x=>x.blockTime*1000>=since).length, '· latest', s[0]?new Date(s[0].blockTime*1000).toISOString():'none');
    }
  }catch(e){ console.log('check failed', lbl, e.message); }
}

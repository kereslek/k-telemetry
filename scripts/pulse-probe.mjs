/* One-off, read-only: run the minute fee sampler against the live chain and print what it sees. */
import fs from 'node:fs';
import {positionsFrom, readGrowth, earned} from '../worker/src/sampler.js';
const data=JSON.parse(fs.readFileSync('/tmp/data.json','utf8'));
const ps=positionsFrom(data);
console.log('positions', ps.map(p=>p.chain+':'+p.id.slice(0,12)+' '+p.lbl).join(' | '));
const cache={}, sol=process.env.SOL_RPC_URL?[process.env.SOL_RPC_URL]:undefined;
const opt=sol?{solRpcs:[...sol,'https://solana-rpc.publicnode.com','https://api.mainnet-beta.solana.com']}:{};
let prev=null, tot=0, byTot={};
const N=Number(process.env.N||12);
for(let i=0;i<N;i++){
  const t0=Date.now();
  const cur=await readGrowth(ps, cache, opt);
  console.log(new Date(cur.t).toISOString().slice(11,19), 'read', Object.keys(cur.g).length+'/'+ps.length, 'in', Date.now()-t0,'ms', cur.err.length?'ERR '+cur.err.join(' ; '):'');
  if(i===0) console.log(JSON.stringify(cur.g).slice(0,600));
  if(prev){ const e=earned(prev,cur,ps); tot+=e.usd; for(const k in e.by) byTot[k]=(byTot[k]||0)+e.by[k];
    console.log('   minute $'+e.usd.toFixed(4), Object.entries(e.by).filter(([,v])=>v>0).map(([k,v])=>k.slice(0,10)+' '+v.toFixed(4)).join(' ')); }
  prev=cur;
  if(i<N-1) await new Promise(r=>setTimeout(r, 60000-(Date.now()-t0)));
}
console.log('TOTAL over', N-1, 'minutes $'+tot.toFixed(4));
for(const p of ps) console.log('  ', p.id.slice(0,14), p.lbl, (byTot[p.id]||0).toFixed(4));
const tk=data.feeMonth.ticks.slice(-6); console.log('ledger ticks (for scale):', JSON.stringify(tk));

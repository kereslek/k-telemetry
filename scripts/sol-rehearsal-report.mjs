/* Prints what a rehearsal pass of the relay produced for the Solana positions, next to what the
   live payload says, so a change can be judged on its output before it is deployed. */
import fs from 'node:fs';
const now=JSON.parse(fs.readFileSync('deck-r7k4x9/data-main.json','utf8'));
const was=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const bc=JSON.parse(fs.readFileSync('deck-r7k4x9/blockcache.json','utf8'));
const old=new Map((was.sol||[]).map(p=>[p.id,p]));
const $=v=>v==null?'—':(Math.abs(v)>=100?v.toFixed(0):v.toFixed(2));
console.log('errors:', JSON.stringify(now.errors||[]).slice(0,600));
console.log('%-12s %-12s %9s %9s %9s %8s %9s %9s %7s  %s'.replace(/%-?\d*s/g,x=>x),'');
for(const p of now.sol||[]){
  const o=old.get(p.id)||{};
  const h=bc.solHist&&bc.solHist[p.id]||{};
  console.log([String(p.id).slice(4,14).padEnd(12), (p.pairLabel||'').padEnd(13),
    'value $'+$(p.valueUsd), 'cost $'+$(p.costUsd)+' (was '+(o.costUsd!=null?'$'+$(o.costUsd):o.basisUsd!=null?'≈$'+$(o.basisUsd):'—')+')',
    'P&L '+(p.roiPct!=null?p.roiPct.toFixed(1)+'%':'—'),
    'feesLife $'+$(p.feesLifeUsd), 'ledgerFees $'+$(p.feesEverUsd),
    'age '+(p.ageDays!=null?p.ageDays.toFixed(1)+'d':'—'),
    'hist '+JSON.stringify(p.hist||null), 'onchainL '+p.liq].join('  '));
  if(p.depAmt) console.log('               deposited '+p.depAmt.map(x=>+x.toFixed(4)).join(' / ')+
    '   principal back '+p.wdAmt.map(x=>+x.toFixed(4)).join(' / ')+'   fees paid '+p.feeAmt.map(x=>+x.toFixed(4)).join(' / ')+
    '   hodl $'+$(p.hodlNowUsd)+'  IL $'+$(p.ilUsd)+'  vs hodl $'+$(p.lpVsHodlUsd));
  for(const e of (h.ev||[]).filter(e=>e.d.some(x=>x!=='0'))) console.log('               dep '+new Date(e.t*1000).toISOString().slice(0,16)+
    '  '+e.d.join(' / ')+'  $'+$(e.du)+' ['+(e.ds||'unpriced')+']'+(e.sq?' implied':''));
}

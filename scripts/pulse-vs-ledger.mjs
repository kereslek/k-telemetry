// One-off: minute recorder vs the relay's fee ledger over the same stretches of time.
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

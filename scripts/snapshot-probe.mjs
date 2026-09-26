/* One-off, read-only: the CPOOL -> CLEAR Snapshot proposal and this deck's wallets' place in it.
   Runs in Actions because hub.snapshot.org is not reachable from the dev container. */
import fs from 'node:fs';
const cfg=JSON.parse(fs.readFileSync('deck-r7k4x9/config.json','utf8'));
const evm=[...new Set(cfg.profiles.flatMap(p=>p.wallets).filter(w=>w.chain==='ethereum').map(w=>w.address.toLowerCase()))];
const gql=async q=>{ const r=await fetch('https://hub.snapshot.org/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})}); return (await r.json()); };
const found=await gql(`{ proposals(first: 10, where: {title_contains: "CLEAR"}, orderBy: "created", orderDirection: desc) {
  id title space { id name } author created start end snapshot state choices scores scores_total quorum quorumType type network votes
  strategies { name network params } discussion link body } }`);
const ps=(found.data&&found.data.proposals||[]).filter(p=>/clearpool/i.test(p.space.id+p.space.name)||/cpool/i.test(p.title+p.body));
if(!ps.length){ console.log('no proposal found', JSON.stringify(found).slice(0,2000)); process.exit(0); }
for(const p of ps){
  console.log('=== '+p.title+' | space '+p.space.id+' | '+p.state+' | '+p.link);
  console.log('start',new Date(p.start*1000).toISOString(),' end',new Date(p.end*1000).toISOString(),' snapshot block',p.snapshot,' network',p.network,' type',p.type,' quorum',p.quorum,p.quorumType||'');
  console.log('choices',JSON.stringify(p.choices));
  console.log('scores',JSON.stringify(p.scores),' total',p.scores_total,' votes',p.votes);
  console.log('strategies',JSON.stringify(p.strategies));
  console.log('discussion',p.discussion);
  console.log('--- body ---\n'+(p.body||'').slice(0,9000)+'\n--- end body ---');
  for(const a of evm){
    const vp=await gql(`{ vp(voter: "${a}", space: "${p.space.id}", proposal: "${p.id}") { vp vp_by_strategy vp_state } }`);
    const v=await gql(`{ votes(where: {proposal: "${p.id}", voter: "${a}"}) { choice vp created } }`);
    console.log('wallet',a,'vp',JSON.stringify(vp.data&&vp.data.vp),'voted',JSON.stringify(v.data&&v.data.votes));
  }
}

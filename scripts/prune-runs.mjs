/* Delete every finished Actions run created before BEFORE (an ISO time). Run logs are public on a
   public repository; this removes the ones from before the deck's lock. The log is public: counts
   only, never a run, a commit or anything a run printed. */
const BEFORE=Date.parse(process.env.BEFORE||''), REPO=process.env.GITHUB_REPOSITORY, TOKEN=process.env.GH_TOKEN;
if(!(BEFORE>0)){ console.log('BEFORE is not a time: nothing done'); process.exit(1); }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(method,u){ for(let k=0;k<6;k++){ let r=null; try{ r=await fetch('https://api.github.com/repos/'+REPO+u,{method,headers:{authorization:'Bearer '+TOKEN,accept:'application/vnd.github+json'}}); }catch(e){}
    if(r&&(r.ok||r.status===204)) return {ok:true, v:r.status===204?null:await r.json().catch(()=>null)};
    if(r&&r.status===404) return {ok:false, gone:true};
    if(r&&(r.status===403||r.status===429)){ const reset=+r.headers.get('x-ratelimit-reset'), rem=r.headers.get('x-ratelimit-remaining');
      const w=rem==='0'&&reset?reset*1000-Date.now()+2000:60000; console.log('rate limited: waiting '+Math.round(w/60000)+' min'); await sleep(Math.max(1000,w)); k--; continue; }
    await sleep(1500*(k+1)); } return {ok:false}; }
const ids=[]; let all=0;
for(let page=1; page<200; page++){ const r=await api('GET','/actions/runs?per_page=100&page='+page); const a=(r.ok&&r.v&&r.v.workflow_runs)||[]; all+=a.length;
  for(const x of a) if(Date.parse(x.created_at)<BEFORE && x.status==='completed') ids.push(x.id);
  if(a.length<100) break; }
console.log('runs listed: '+all+' · finished before the cut-off: '+ids.length);
let del=0, gone=0, failed=0;
for(const id of ids){ const r=await api('DELETE','/actions/runs/'+id); if(r.ok) del++; else if(r.gone) gone++; else failed++; }
console.log((failed?'FAIL':'ok  ')+' deleted: '+del+' · already gone: '+gone+' · could not delete: '+failed);
process.exitCode=failed?1:0;

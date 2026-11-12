/* Read Clearpool's public announcements (their Medium) and the pages they link to, as plain text.
   Public pages only: nothing of the deck's is read, sent or printed. Run by hand (clearpool-read.yml)
   with READ_URLS (comma-separated) and DEPTH (0 or 1: follow the links inside each page).
   Medium sometimes refuses robots on the article page, so the same post is also looked for in the
   publication's RSS feed, which carries the full text. */
const UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const URLS=(process.env.READ_URLS||'https://clearpool.medium.com/cpool-clear-swap-migration-guide-8e1d42db59cf').split(',').map(s=>s.trim()).filter(Boolean);
const DEPTH=+(process.env.DEPTH??1), MAXC=+(process.env.MAX_CHARS||12000);
const SKIP=/(^|\.)(x\.com|twitter\.com|t\.me|discord\.(gg|com)|linkedin\.com|youtube\.com|youtu\.be|facebook\.com|instagram\.com|reddit\.com|policy\.medium\.com|help\.medium\.com|play\.google\.com|apps\.apple\.com)$/i;

async function get(u,ms=20000){ try{ const r=await fetch(u,{headers:{'user-agent':UA,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'en'},redirect:'follow',signal:AbortSignal.timeout(ms)});
  return {ok:r.ok, st:r.status, url:r.url, ct:r.headers.get('content-type')||'', tx:await r.text()}; }catch(e){ return {ok:false, st:String(e.name||'error'), url:u, ct:'', tx:''}; } }
const ent=s=>s.replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g,"'").replace(/&ldquo;|&rdquo;/g,'"').replace(/&mdash;/g,'—').replace(/&ndash;/g,'–').replace(/&#(\d+);/g,(m,n)=>String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi,(m,n)=>String.fromCodePoint(parseInt(n,16)));
function text(html,base){ const links=[];
  let h=html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi,'');
  const art=h.match(/<article[\s\S]*?<\/article>/i); if(art) h=art[0];
  h=h.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,(m,href,t)=>{ let u; try{ u=new URL(ent(href),base).href; }catch(e){ return t; }
    const label=t.replace(/<[^>]+>/g,'').trim(); links.push([label,u]); return label+' ['+u+']'; });
  h=h.replace(/<li[^>]*>/gi,'\n • ').replace(/<(h[1-6])[^>]*>/gi,'\n\n## ').replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|figure|blockquote|pre)>/gi,'\n').replace(/<br\s*\/?>/gi,'\n').replace(/<t[dh][^>]*>/gi,' | ');
  const out=ent(h.replace(/<[^>]+>/g,'')).replace(/[ \t]+/g,' ').replace(/\n\s*\n\s*\n+/g,'\n\n').trim();
  return {out, links}; }
const slugOf=u=>{ try{ return new URL(u).pathname.split('/').filter(Boolean).pop()||''; }catch(e){ return ''; } };

let feed=null;
async function viaFeed(u){ const host=new URL(u).host; if(!/medium\.com$/.test(host)) return null;
  if(!feed){ const f=await get('https://'+host+'/feed'); feed=f.ok?f.tx:''; if(!feed){ const g=await get('https://medium.com/feed/@clearpool'); feed=g.ok?g.tx:''; } }
  const id=slugOf(u).split('-').pop(); const items=feed.split(/<item>/).slice(1);
  const it=items.find(x=>id&&x.includes(id)); if(!it) return null;
  const body=(it.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/)||[])[1]||'';
  const title=(it.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)||[])[1]||'', date=(it.match(/<pubDate>([^<]+)<\/pubDate>/)||[])[1]||'';
  return {title, date, ...text(body,u)}; }

async function read(u,level){
  console.log('\n'+'='.repeat(100)+'\n'+(level?'LINKED PAGE':'PAGE')+': '+u);
  let r=await get(u), got=null;
  if(r.ok&&/html/.test(r.ct)){ const t=text(r.tx,r.url), title=ent((r.tx.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'').trim();
    if(t.out.length>400) got={title, date:(r.tx.match(/"datePublished":"([^"]+)"/)||[])[1]||'', ...t}; }
  if(!got){ const f=await viaFeed(u).catch(()=>null); if(f){ got=f; console.log('(page answered HTTP '+r.st+'; text taken from the RSS feed)'); } }
  if(!got&&r.ok&&!/html/.test(r.ct)){ got={title:'', date:'', out:r.tx.slice(0,MAXC), links:[]}; }
  if(!got){ console.log('NOT READABLE: HTTP '+r.st+(r.tx?' · '+r.tx.length+' bytes':'')); return []; }
  console.log('TITLE: '+got.title+(got.date?'\nDATE: '+got.date:'')+'\n'+'-'.repeat(100));
  console.log(got.out.length>MAXC?got.out.slice(0,MAXC)+'\n… ['+(got.out.length-MAXC)+' more characters]':got.out);
  const seen=new Set(), links=got.links.filter(([l,x])=>{ try{ const h=new URL(x).host; if(SKIP.test(h)||seen.has(x.split('#')[0])||x.split('#')[0]===u.split('#')[0]) return false; seen.add(x.split('#')[0]); return /^https?:/.test(x); }catch(e){ return false; } });
  console.log('-'.repeat(100)+'\nLINKS IN THIS PAGE ('+links.length+'):'); for(const [l,x] of links) console.log('  - '+(l||'(no label)')+' → '+x);
  return links.map(x=>x[1]); }

// the latest posts of the publication, so nothing newer about the migration is missed
{ const f=await get('https://clearpool.medium.com/feed'); feed=f.ok?f.tx:'';
  const items=feed.split(/<item>/).slice(1).map(x=>[(x.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)||[])[1]||'',(x.match(/<pubDate>([^<]+)<\/pubDate>/)||[])[1]||'',(x.match(/<link>([^<]+)<\/link>/)||[])[1]||'']);
  console.log('CLEARPOOL MEDIUM FEED: HTTP '+f.st+' · '+items.length+' posts');
  for(const [t,d,l] of items) console.log('  '+new Date(d).toISOString().slice(0,10)+'  '+t+'  → '+l.split('?')[0]); }

const done=new Set();
for(const u of URLS){ if(done.has(u)) continue; done.add(u); const subs=await read(u,0);
  if(DEPTH>0) for(const s of subs){ const k=s.split('#')[0]; if(done.has(k)) continue; done.add(k); await read(s,1); } }

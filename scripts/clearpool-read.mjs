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
function text(html,base){ const links=[], imgs=[];
  let h=html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi,'');
  const art=h.match(/<article[\s\S]*?<\/article>/i); if(art) h=art[0];
  for(const m of h.matchAll(/<(?:img|source)\b[^>]*?(?:srcset|srcSet|src)="([^"]+)"[^>]*>/gi)){ const c=ent(m[1]).split(',').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean).pop();
    try{ const u=new URL(c,base).href; if(/\.(png|jpe?g|webp|gif)|miro\.medium\.com/i.test(u)&&!/resize:fill:(32|40|44|48|64|88):/.test(u)&&!imgs.includes(u)) imgs.push(u); }catch(e){} }
  h=h.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,(m,href,t)=>{ let u; try{ u=new URL(ent(href),base).href; }catch(e){ return t; }
    const label=t.replace(/<[^>]+>/g,'').trim(); links.push([label,u]); return label+' ['+u+']'; });
  h=h.replace(/<li[^>]*>/gi,'\n • ').replace(/<(h[1-6])[^>]*>/gi,'\n\n## ').replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|figure|blockquote|pre)>/gi,'\n').replace(/<br\s*\/?>/gi,'\n').replace(/<t[dh][^>]*>/gi,' | ');
  const out=ent(h.replace(/<[^>]+>/g,'')).replace(/[ \t]+/g,' ').replace(/\n\s*\n\s*\n+/g,'\n\n').trim();
  return {out, links, imgs}; }
const slugOf=u=>{ try{ return new URL(u).pathname.split('/').filter(Boolean).pop()||''; }catch(e){ return ''; } };

let feed=null;
async function viaFeed(u){ const host=new URL(u).host; if(!/medium\.com$/.test(host)) return null;
  if(!feed){ const f=await get('https://'+host+'/feed'); feed=f.ok?f.tx:''; if(!feed){ const g=await get('https://medium.com/feed/@clearpool'); feed=g.ok?g.tx:''; } }
  const id=slugOf(u).split('-').pop(); const items=feed.split(/<item>/).slice(1);
  const it=items.find(x=>id&&x.includes(id)); if(!it) return null;
  const body=(it.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/)||[])[1]||'';
  const title=(it.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)||[])[1]||'', date=(it.match(/<pubDate>([^<]+)<\/pubDate>/)||[])[1]||'';
  return {title, date, ...text(body,u)}; }

const IMG_DIR=process.env.IMG_DIR||'', FOLLOW=new RegExp(process.env.FOLLOW||'.','i'), BROWSER=process.env.BROWSER==='1';
let shot=0, browser=null;
async function save(u,name){ if(!IMG_DIR) return null; try{ const r=await fetch(u,{headers:{'user-agent':UA},signal:AbortSignal.timeout(20000)}); if(!r.ok) return null;
  const ct=r.headers.get('content-type')||'', ext=/png/.test(ct)?'png':/jpe?g/.test(ct)?'jpg':/webp/.test(ct)?'webp':/gif/.test(ct)?'gif':'bin';
  const fs=await import('node:fs'); fs.mkdirSync(IMG_DIR,{recursive:true}); const f=IMG_DIR+'/'+name+'.'+ext; fs.writeFileSync(f,Buffer.from(await r.arrayBuffer())); return f; }catch(e){ return null; } }
/* a real browser, for pages that are drawn by JavaScript (clearpool.finance is an app, not a document) */
async function render(u){ try{ if(!browser){ const {chromium}=await import('playwright'); browser=await chromium.launch(); }
  const pg=await browser.newPage({viewport:{width:1280,height:900}, userAgent:UA}); await pg.goto(u,{waitUntil:'networkidle',timeout:45000}).catch(()=>{}); await pg.waitForTimeout(4000);
  for(let y=0;y<12;y++){ await pg.mouse.wheel(0,900); await pg.waitForTimeout(250); }
  const out=await pg.evaluate(()=>document.body.innerText), title=await pg.title(), links=await pg.evaluate(()=>[...document.querySelectorAll('a[href]')].map(a=>[a.innerText.trim().slice(0,80),a.href]));
  let f=null; if(IMG_DIR){ const fs=await import('node:fs'); fs.mkdirSync(IMG_DIR,{recursive:true}); f=IMG_DIR+'/shot-'+String(++shot).padStart(2,'0')+'.png'; await pg.screenshot({path:f,fullPage:true}).catch(()=>{ f=null; }); }
  await pg.close(); return {title, date:'', out:out.replace(/\n\s*\n\s*\n+/g,'\n\n').trim(), links, imgs:[], shot:f}; }catch(e){ return null; } }

let pageN=0;
async function read(u,level){
  console.log('\n'+'='.repeat(100)+'\n'+(level?'LINKED PAGE':'PAGE')+': '+u);
  let r=await get(u), got=null;
  if(r.ok&&/html/.test(r.ct)){ const t=text(r.tx,r.url), title=ent((r.tx.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'').trim();
    if(t.out.length>400) got={title, date:(r.tx.match(/"datePublished":"([^"]+)"/)||[])[1]||'', ...t}; }
  if(!got){ const f=await viaFeed(u).catch(()=>null); if(f){ got=f; console.log('(page answered HTTP '+r.st+'; text taken from the RSS feed)'); } }
  if((!got||BROWSER)&&(!r.ok||/html/.test(r.ct))){ const b=await render(u); if(b&&b.out.length>(got?got.out.length:0)){ console.log('(read in a browser'+(b.shot?'; screenshot '+b.shot.split('/').pop():'')+')'); got={...b, imgs:got?got.imgs:[]}; } }
  if(!got&&r.ok&&!/html/.test(r.ct)){ got={title:'', date:'', out:r.tx.slice(0,MAXC), links:[], imgs:[]}; }
  if(!got){ console.log('NOT READABLE: HTTP '+r.st+(r.tx?' · '+r.tx.length+' bytes':'')); return []; }
  console.log('TITLE: '+got.title+(got.date?'\nDATE: '+got.date:'')+'\n'+'-'.repeat(100));
  console.log(got.out.length>MAXC?got.out.slice(0,MAXC)+'\n… ['+(got.out.length-MAXC)+' more characters]':got.out);
  const n=++pageN;
  if(IMG_DIR&&got.imgs&&got.imgs.length){ console.log('-'.repeat(100)+'\nIMAGES IN THIS PAGE ('+got.imgs.length+'):');
    let i=0; for(const x of got.imgs){ const f=await save(x,'p'+String(n).padStart(2,'0')+'-img'+String(++i).padStart(2,'0')); console.log('  '+(f?f.split('/').pop():'(not saved)')+'  ← '+x); } }
  const seen=new Set(), links=(got.links||[]).filter(([l,x])=>{ try{ const U=new URL(x), k=x.split('#')[0]; if(SKIP.test(U.host)||/\/m\/signin/.test(U.pathname)||seen.has(k)||k===u.split('#')[0]) return false; seen.add(k); return /^https?:/.test(x); }catch(e){ return false; } });
  console.log('-'.repeat(100)+'\nLINKS IN THIS PAGE ('+links.length+'):'); for(const [l,x] of links) console.log('  - '+(l||'(no label)')+' → '+x);
  return links.filter(([l,x])=>FOLLOW.test(x+' '+l)).map(x=>x[1]); }

// the latest posts of the publication, so nothing newer about the migration is missed
{ const f=await get('https://clearpool.medium.com/feed'); feed=f.ok?f.tx:'';
  const items=feed.split(/<item>/).slice(1).map(x=>[(x.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)||[])[1]||'',(x.match(/<pubDate>([^<]+)<\/pubDate>/)||[])[1]||'',(x.match(/<link>([^<]+)<\/link>/)||[])[1]||'']);
  console.log('CLEARPOOL MEDIUM FEED: HTTP '+f.st+' · '+items.length+' posts');
  for(const [t,d,l] of items) console.log('  '+new Date(d).toISOString().slice(0,10)+'  '+t+'  → '+l.split('?')[0]); }

const done=new Set();
for(const u of URLS){ if(done.has(u)) continue; done.add(u); const subs=await read(u,0);
  if(DEPTH>0) for(const s of subs){ const k=s.split('#')[0]; if(done.has(k)) continue; done.add(k); await read(s,1); } }
if(browser) await browser.close();

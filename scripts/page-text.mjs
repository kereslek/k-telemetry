/* A public web page as plain text, with its links and images: shared by clearpool-read (read by hand)
   and migration-watch (read on a schedule). Fetches only; nothing of the deck's is read or sent. */
export const UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export async function get(u,ms=20000){ try{ const r=await fetch(u,{headers:{'user-agent':UA,'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','accept-language':'en'},redirect:'follow',signal:AbortSignal.timeout(ms)});
  return {ok:r.ok, st:r.status, url:r.url, ct:r.headers.get('content-type')||'', tx:await r.text()}; }catch(e){ return {ok:false, st:String(e.name||'error'), url:u, ct:'', tx:''}; } }
export const ent=s=>s.replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&#x27;|&rsquo;|&lsquo;/g,"'").replace(/&ldquo;|&rdquo;/g,'"').replace(/&mdash;/g,'—').replace(/&ndash;/g,'–').replace(/&#(\d+);/g,(m,n)=>String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi,(m,n)=>String.fromCodePoint(parseInt(n,16)));
export function text(html,base){ const links=[], imgs=[];
  let h=html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi,'');
  const art=h.match(/<article[\s\S]*?<\/article>/i); if(art) h=art[0];
  for(const m of h.matchAll(/<(?:img|source)\b[^>]*?(?:srcset|srcSet|src)="([^"]+)"[^>]*>/gi)){ const c=ent(m[1]).split(',').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean).pop();
    try{ const u=new URL(c,base).href; if(/\.(png|jpe?g|webp|gif)|miro\.medium\.com/i.test(u)&&!/resize:fill:(32|40|44|48|64|88):/.test(u)&&!imgs.includes(u)) imgs.push(u); }catch(e){} }
  h=h.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,(m,href,t)=>{ let u; try{ u=new URL(ent(href),base).href; }catch(e){ return t; }
    const label=t.replace(/<[^>]+>/g,'').trim(); links.push([label,u]); return label+' ['+u+']'; });
  h=h.replace(/<li[^>]*>/gi,'\n • ').replace(/<(h[1-6])[^>]*>/gi,'\n\n## ').replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|figure|blockquote|pre)>/gi,'\n').replace(/<br\s*\/?>/gi,'\n').replace(/<t[dh][^>]*>/gi,' | ');
  const out=ent(h.replace(/<[^>]+>/g,'')).replace(/[ \t]+/g,' ').replace(/\n\s*\n\s*\n+/g,'\n\n').trim();
  return {out, links, imgs}; }
export const slugOf=u=>{ try{ return new URL(u).pathname.split('/').filter(Boolean).pop()||''; }catch(e){ return ''; } };

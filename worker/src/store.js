/* The relay's working files, kept here instead of being committed to git on every pass (about 300 commits a day
   of freshly sealed files, which git cannot store as differences: the repository grew by about half a gigabyte a
   day). The files arrive sealed and are kept sealed; this store never opens them.

   One version number covers the whole set. An upload names the version it was built on and is refused (409) when
   anything newer has landed since, as git refuses a push that lost a race: a pass built on stale files never
   overwrites newer ones. A pass's files are written together or not at all. A file is kept in parts of up to a
   million characters (a row holds at most 2 MB).

   Upload body: one JSON line {base, files:[[name, gen, length], ...]}, then the files' texts back to back. */
export const STORE_NAME=/^[a-z0-9][a-z0-9-]{0,60}\.json$/;
const PART=1_000_000;

export function storeInit(sql){
  sql.exec('CREATE TABLE IF NOT EXISTS sf(name TEXT NOT NULL, part INTEGER NOT NULL, gen INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(name,part))');
  sql.exec('CREATE TABLE IF NOT EXISTS sv(k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
}
export function storeVer(sql){ const r=sql.exec("SELECT v FROM sv WHERE k='ver'").toArray(); return r.length?r[0].v:0; }
/* every file's version time and size, and the set's version */
export function storeList(sql){
  const files={};
  for(const r of sql.exec('SELECT name, MAX(gen) AS gen, SUM(LENGTH(body)) AS size FROM sf GROUP BY name').toArray()) files[r.name]={gen:r.gen, size:r.size};
  return {ver:storeVer(sql), files};
}
export function storeGet(sql, name){
  if(!STORE_NAME.test(name)) return null;
  const rows=sql.exec('SELECT gen, body FROM sf WHERE name=? ORDER BY part', name).toArray();
  return rows.length?{gen:rows[0].gen, body:rows.map(r=>r.body).join('')}:null;
}
/* One pass's files. `tx` runs a function as one transaction (the object's transactionSync). */
export function storePut(sql, tx, text){
  const nl=text.indexOf('\n'); if(nl<0) return {status:400, err:'no header'};
  let h; try{ h=JSON.parse(text.slice(0,nl)); }catch(e){ return {status:400, err:'header'}; }
  if(!h||!Number.isInteger(h.base)||!Array.isArray(h.files)||!h.files.length||h.files.length>64) return {status:400, err:'header'};
  let at=nl+1; const parts=[];
  for(const f of h.files){ const [name,gen,len]=Array.isArray(f)?f:[];
    if(!STORE_NAME.test(String(name))||!Number.isInteger(gen)||gen<=0||!Number.isInteger(len)||len<0) return {status:400, err:'file'};
    const body=text.slice(at,at+len); if(body.length!==len) return {status:400, err:'length'}; at+=len; parts.push([name,gen,body]); }
  if(at!==text.length) return {status:400, err:'length'};
  if(new Set(parts.map(p=>p[0])).size!==parts.length) return {status:400, err:'twice'};
  const cur=storeVer(sql);
  if(h.base!==cur) return {status:409, ver:cur};
  tx(()=>{
    for(const [name,gen,body] of parts){
      sql.exec('DELETE FROM sf WHERE name=?', name);
      for(let i=0, k=0; i<body.length||k===0; i+=PART, k++) sql.exec('INSERT INTO sf(name,part,gen,body) VALUES(?,?,?,?)', name, k, gen, body.slice(i,i+PART));
    }
    sql.exec("INSERT OR REPLACE INTO sv(k,v) VALUES('ver',?)", cur+1);
  });
  return {status:200, ver:cur+1, n:parts.length};
}

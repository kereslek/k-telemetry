/* The minute record's long memory, in the recorder's own SQL storage (its Durable Object is SQLite-backed).

   The live record keeps 24 hours of minutes and 3 hours of readings (events) in memory. Here every minute is kept
   for good once it leaves the 24 hours (by then the relay has settled any own swap in it, so it is final), and every
   reading that found fees is kept as it happens, then corrected wherever the live record corrects it, including a
   correction that arrives after the reading has left the 3 hours. Nothing here is ever read by the live dial: a
   failure here never stops the recording (every caller catches).

   Rows read and written stay far inside the free plan: 1,440 minutes a day, and one row per reading that found fees. */
export const HIST_SPAN_MAX=31*864e5;
const J=x=>x==null?null:JSON.stringify(x), P=s=>{ if(s==null) return null; try{ return JSON.parse(s); }catch(e){ return null; } };

export function histInit(sql){
  sql.exec('CREATE TABLE IF NOT EXISTS hmin(t INTEGER PRIMARY KEY, usd REAL NOT NULL, cov REAL NOT NULL, pools TEXT)');
  sql.exec('CREATE TABLE IF NOT EXISTS hev(t INTEGER NOT NULL, a INTEGER NOT NULL, usd REAL NOT NULL, pools TEXT, side TEXT, px TEXT, PRIMARY KEY(t,a))');
}
/* a minute leaving the 24 hours, as the live record holds it: [usd, coverage, {pool: usd}] */
export function archiveMin(sql, t, row){
  sql.exec('INSERT OR REPLACE INTO hmin(t,usd,cov,pools) VALUES(?,?,?,?)', Number(t), row[0], row[1], row[2]?J(row[2]):null);
}
/* a reading that found fees, as the live record holds it: [t, from, usd, {pool: usd}, {pool: [sold0, sold1]}, {pool: [price, size]}] */
export function putEv(sql, e){
  sql.exec('INSERT OR REPLACE INTO hev(t,a,usd,pools,side,px) VALUES(?,?,?,?,?,?)', e[0], e[1], e[2], J(e[3]||{}), J(e[4]||{}), J(e[5]||{}));
}
/* A correction (the relay's own-swap settlement) to readings no longer held in memory: those older than `before`
   whose span takes in t, the same rule and order as the live record's. Returns what is left of the delta. */
export function adjustOldEv(sql, t, lbl, delta, before){
  let d=delta;
  const rows=sql.exec('SELECT t,a,usd,pools FROM hev WHERE t<? AND a-5000<=? AND t+5000>=? ORDER BY t', before, t, t).toArray();
  for(const r of rows){ if(Math.abs(d)<0.0005) break;
    const pools=P(r.pools)||{}; let usd=r.usd;
    if(d>0){ usd+=d; if(lbl) pools[lbl]=(pools[lbl]||0)+d; d=0; }
    else { const avail=lbl&&pools[lbl]!=null?pools[lbl]:usd, take=Math.min(-d,avail,usd); if(!(take>0)) continue;
      usd-=take; if(lbl&&pools[lbl]!=null){ pools[lbl]-=take; if(pools[lbl]<0.0005) delete pools[lbl]; } d+=take; }
    sql.exec('UPDATE hev SET usd=?, pools=? WHERE t=? AND a=?', Math.round(usd*1e6)/1e6, J(pools), r.t, r.a); }
  return d;
}
/* What the history holds between two moments: minutes (archived, then the live ones not yet archived) and readings.
   `live` is the live record's minutes {t: row}; a minute in both is the live one (it may still be corrected). */
export function histRange(sql, from, to, live){
  const mins=new Map();
  for(const r of sql.exec('SELECT t,usd,cov,pools FROM hmin WHERE t>=? AND t<? ORDER BY t', from, to).toArray()) mins.set(r.t,[r.t, r.usd, r.cov, P(r.pools)]);
  for(const [k,v] of Object.entries(live||{})){ const t=Number(k); if(t>=from&&t<to) mins.set(t,[t, v[0], v[1], v[2]||null]); }
  return {mins:[...mins.values()].sort((a,b)=>a[0]-b[0]), ev:histEv(sql, from, to)};
}
/* the readings that found fees between two moments, oldest first, as the live record holds them */
export function histEv(sql, from, to){
  return sql.exec('SELECT t,a,usd,pools,side,px FROM hev WHERE t>=? AND t<? AND usd>=0.005 ORDER BY t', from, to).toArray()
    .map(r=>[r.t, r.a, r.usd, P(r.pools)||{}, P(r.side)||{}, P(r.px)||{}]);
}
/* how far back the history reaches, and how much it holds (counts only) */
export function histInfo(sql){
  const a=sql.exec('SELECT MIN(t) AS t0, COUNT(*) AS n FROM hmin').toArray()[0]||{}, b=sql.exec('SELECT MIN(t) AS t0, COUNT(*) AS n FROM hev').toArray()[0]||{};
  return {minsFrom:a.t0??null, mins:a.n||0, evFrom:b.t0??null, ev:b.n||0};
}

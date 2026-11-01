/* The biggest trade of the day, for the box above LATEST FEES: of all the trades the recorder holds
   (its minute history reaches back 24 hours), the one that paid the most, over the last 24 hours and
   since midnight Budapest time (the page's "today" everywhere). Pure: tested by test/big.test.mjs. */
export const TZ='Europe/Budapest';
/* midnight in Budapest, as a UTC instant, for the day `now` falls in there (CET or CEST alike) */
export function tzMidnight(now, tz=TZ){
  const pp={}; for(const x of new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now)) pp[x.type]=x.value;
  const asUtc=Date.UTC(+pp.year,+pp.month-1,+pp.day,+pp.hour,+pp.minute,+pp.second), off=asUtc-Math.floor(now/1000)*1000;
  return Date.UTC(+pp.year,+pp.month-1,+pp.day)-off;
}
/* trades: [{t, usd, ...}] (t: when it paid its largest part). The largest by what it paid; a tie
   goes to the later one. Nothing is made up: a window with no trade is null. */
export function biggest(trades, now){
  const day0=tzMidnight(now), top=from=>{ let b=null; for(const x of trades||[]) if(x&&x.t>=from&&x.t<=now&&x.usd>0&&(!b||x.usd>b.usd||(x.usd===b.usd&&x.t>b.t))) b=x; return b; };
  return { d24:top(now-24*3600e3), today:top(day0), day0 };
}

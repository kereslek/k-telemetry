/* One-off repair of two Solana fee balances corrupted on 2026-08-27.

   A single transaction withdrew principal from KYpo and harvested both KYpo and Gibrf. The
   wallet-delta fallback booked the whole movement — both positions' fees plus the returned
   principal — against KYpo, then claimed the transaction so Gibrf skipped it and booked nothing.
   Gibrf's checkpoint advanced past the harvest, so it cannot recover it by rescanning.

   A harvest only moves value from owed to collected; it does not change lifetime fees. So the
   correct collected balance for each is simply what its lifetime total was immediately before:

     KYpo   collected 155.18071745576066 + owed 84.020371040504980 = 239.20108849626564
     Gibrf  collected 137.88285688733882 + owed 54.281415640229454 = 192.16427252756827

   Both figures are read from the payload published at 2026-08-27T07:02Z, the last one before the
   harvest. Run with --write; without it, prints what it would change.  */
import fs from 'node:fs';

const FILE='deck-r7k4x9/ledger-main.json';
const WRITE=process.argv.includes('--write');
const FIX={
  'sol:KYpoY8hHJA8FqdS56ZPJPQzSamUTmYcAdv1VCt4QnaF':
    {to:239.20108849626564, from:995.8845631281865, why:'withdrawn principal and the other position\'s fees booked as income'},
  'sol:Gibrf6n2hyNDTkK7DPTTrA7AbmV7FWVMED1TEbx5DG5s':
    {to:192.16427252756827, from:137.88285688733882, why:'harvest lost when the shared transaction was claimed by another position'},
};

const led=JSON.parse(fs.readFileSync(FILE,'utf8'));
let changed=0;
for(const [id,f] of Object.entries(FIX)){
  const L=led[id];
  if(!L){ console.log('MISSING '+id+' — skipped'); continue; }
  const cur=L.collectedUsd;
  /* Only touch the exact corrupted value. If a later run has already moved it, this repair no
     longer describes reality and must not overwrite whatever is there now. */
  if(Math.abs(cur-f.from)>0.005){
    console.log('SKIP '+id.slice(0,14)+'… — expected '+f.from.toFixed(2)+', found '+cur.toFixed(2));
    continue;
  }
  console.log((WRITE?'FIX  ':'would fix ')+id.slice(0,14)+'…  $'+cur.toFixed(2)+' -> $'+f.to.toFixed(2)+'   ('+f.why+')');
  if(WRITE){
    L.collectedUsd=f.to;
    L.repaired=(L.repaired?L.repaired+'; ':'')+f.why+'; corrected 2026-08-27';
    delete L.sharedTx;
    changed++;
  }
}
/* The monthly ledger keeps a high-water mark per position, because lifetime fees normally only
   rise and a transient short read must not look like a loss of income. That guard also freezes a
   corrected value: repairing the position ledger left the month still deriving its accumulated
   figure from the corrupted peak, so August read $2,175 when it should read $1,418. The mark has
   to come down with the correction. */
const FEES='deck-r7k4x9/fees-main.json';
const FEEFIX={
  'sol:KYpoY8hHJA8FqdS56ZPJPQzSamUTmYcAdv1VCt4QnaF': {hwm:239.20108849626564, fromHwm:995.8845631281865},
};
let feesChanged=0;
try{
  const fee=JSON.parse(fs.readFileSync(FEES,'utf8'));
  for(const [id,f] of Object.entries(FEEFIX)){
    const e=fee.pos&&fee.pos[id];
    if(!e){ console.log('MISSING '+id+' in '+FEES); continue; }
    if(Math.abs(e.hwm-f.fromHwm)>0.005){
      console.log('SKIP hwm '+id.slice(0,14)+'… — expected '+f.fromHwm.toFixed(2)+', found '+Number(e.hwm).toFixed(2));
      continue;
    }
    const accNew=Math.round((f.hwm-(e.m0||0))*100)/100;
    console.log((WRITE?'FIX  ':'would fix ')+'month '+id.slice(0,14)+'…  hwm $'+Number(e.hwm).toFixed(2)+' -> $'+f.hwm.toFixed(2)
      +',  acc $'+Number(e.acc).toFixed(2)+' -> $'+accNew.toFixed(2));
    if(WRITE){ e.hwm=f.hwm; e.acc=accNew; feesChanged++; }
  }
  if(WRITE && feesChanged){ fs.writeFileSync(FEES, JSON.stringify(fee,null,1)); }
}catch(e){ console.log('could not read '+FEES+': '+e.message); }

if(!WRITE){ console.log('\n(dry run — pass --write)'); process.exit(0); }
if(changed){ fs.writeFileSync(FILE, JSON.stringify(led,null,1)); console.log('\nwrote '+FILE); }
if(feesChanged) console.log('wrote '+FEES);
if(!changed && !feesChanged) console.log('\nnothing to change');

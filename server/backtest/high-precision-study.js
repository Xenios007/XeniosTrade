// Research-only high-precision pullback study.  Configurations are fixed here
// before the run; validation selects one and holdout is reported once.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCachedKlines, readMeta } from './data-cache.js'
import { BACKTEST_UNIVERSE } from '../../src/lib/tradingConfig.js'
import { computeSplitBoundaries, assignSplit } from './splits.js'
import { summarize } from './consolidated-audit.js'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const now=new Date(),endMs=Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)-1,startMs=endMs-5*365.25*86_400_000
const feeSlip=.0014,notional=100
const configs=Object.freeze([
  {id:'hp_r2_5_v100_t07_s15',rsi:5,volume:1,target:.7,stop:1.5},
  {id:'hp_r2_10_v100_t07_s15',rsi:10,volume:1,target:.7,stop:1.5},
  {id:'hp_r2_10_v120_t07_s15',rsi:10,volume:1.2,target:.7,stop:1.5},
  {id:'hp_r2_15_v100_t08_s15',rsi:15,volume:1,target:.8,stop:1.5},
  {id:'hp_r2_10_v100_t10_s20',rsi:10,volume:1,target:1,stop:2},
  {id:'hp_r2_5_v120_t08_s20',rsi:5,volume:1.2,target:.8,stop:2},
])
const n=v=>Number(v)||0,mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0
const ema=(a,p)=>{if(a.length<p)return null;let x=mean(a.slice(0,p)),k=2/(p+1);for(let i=p;i<a.length;i++)x+=(a[i]-x)*k;return x}
const rsi=(a,p=2)=>{if(a.length<=p)return null;let g=0,l=0;for(let i=a.length-p;i<a.length;i++){const d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}return l===0?100:100-100/(1+g/l)}
const atr=(a,p=14)=>{if(a.length<=p)return null;const tr=[];for(let i=1;i<a.length;i++)tr.push(Math.max(a[i].h-a[i].l,Math.abs(a[i].h-a[i-1].c),Math.abs(a[i].l-a[i-1].c)));return mean(tr.slice(-p))}
const c=r=>({t:n(r[0]),end:n(r[6]),o:n(r[1]),h:n(r[2]),l:n(r[3]),c:n(r[4]),v:n(r[5]),buy:n(r[9])})
const ix=(a,t,from=0)=>{let i=from;while(i<a.length&&a[i].t<t)i++;return i}
function exit(side,entry,stop,target,at,bars){const d=side==='BUY'?1:-1;for(let i=at+1;i<bars.length;i++){const b=bars[i],sl=d>0?b.l<=stop:b.h>=stop,tp=d>0?b.h>=target:b.l<=target;if(sl)return [stop,b.end,'SL'];if(tp)return [target,b.end,'TP'];if(b.end-bars[at].t>=24*3_600_000)return [b.c,b.end,'TIME']}return null}
function sum(rows){return summarize(rows.map(r=>({t:r.t,r:r.r,pnl:r.pnl,symbol:r.symbol,side:r.side})))}
const fmt=s=>`${s.trades} · ${(s.winRate*100).toFixed(1)}% · ${s.meanR.toFixed(3)}R · PF ${s.profitFactor.toFixed(3)}`
async function load(symbol){const m=await readMeta(symbol),first=Math.max(startMs,n(m?.timeframes?.['1h']?.firstCandle),n(m?.timeframes?.['5m']?.firstCandle));if(!first||first>=endMs)return[];const [oneR,fiveR]=await Promise.all([getCachedKlines(symbol,'1h',first,endMs,{readOnly:true}),getCachedKlines(symbol,'5m',first,endMs,{readOnly:true})]);const one=oneR.map(c),five=fiveR.map(c),out=[];const bounds=computeSplitBoundaries(one[0].t,one.at(-1).end,24*3_600_000);let fi=0
  for(let i=800;i<one.length;i++){if(i%4!==3)continue;const cur=one[i],h=one.slice(i-49,i+1),cl=h.map(x=>x.c),four=[];for(let j=3;j<=i;j+=4)four.push(one[j].c);const fast=ema(four,50),slow=ema(four,200),a=atr(h),rs=rsi(cl,2),vol=cur.v/Math.max(mean(h.slice(-21,-1).map(x=>x.v)),1),br=cur.buy/Math.max(cur.v,1);if(!fast||!slow||!a||rs==null)continue;const trend=fast>slow?'BUY':fast<slow?'SELL':null;if(!trend)continue;const exhausted=trend==='BUY'?rs:100-rs;const reclaim=trend==='BUY'?cur.c>cur.o&&cur.c>one[i-1].c:cur.c<cur.o&&cur.c<one[i-1].c;const flow=trend==='BUY'?br>=.5:br<=.5;if(!reclaim||!flow)continue;const at=ix(five,cur.end+1,fi);if(at>=five.length-1)break;fi=Math.max(fi,at);for(const q of configs){if(exhausted>q.rsi||vol<q.volume)continue;const entry=five[at].o,d=trend==='BUY'?1:-1,stop=entry-d*a*q.stop,target=entry+d*a*q.target;if(stop<=0)continue;const x=exit(trend,entry,stop,target,at,five);if(!x)continue;const pnl=d*(x[0]-entry)/entry*notional-notional*feeSlip,risk=Math.abs(entry-stop)/entry*notional,t=five[at].t,split=assignSplit(t,bounds);if(split!=='purged')out.push({config:q.id,symbol,side:trend,t,end:x[1],pnl,r:pnl/risk,split})}}
  return out}
async function main(){let rows=[];for(const s of BACKTEST_UNIVERSE){const x=await load(s);rows.push(...x);console.log(`${s}: ${x.length}`)}const reports=configs.map(q=>{const a=rows.filter(r=>r.config===q.id),train=a.filter(r=>r.split==='train'),val=a.filter(r=>r.split==='val'),hold=a.filter(r=>r.split==='holdout');return {config:q,...q,train:sum(train),validation:sum(val),holdout:sum(hold)}});const eligible=reports.filter(x=>x.validation.trades>=50&&x.validation.winRate>.5&&x.validation.meanR>0&&x.validation.profitFactor>=1).sort((a,b)=>b.validation.meanR-a.validation.meanR||b.validation.profitFactor-a.validation.profitFactor);const selected=eligible[0]||null;const out={generatedAt:new Date().toISOString(),period:{start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()},cost:{roundTripFeeAndSlippage:feeSlip},configs:reports,selectedByValidation:selected,decision:selected&&selected.holdout.trades>=100&&selected.holdout.winRate>.5&&selected.holdout.meanR>0&&selected.holdout.profitFactor>=1&&selected.holdout.lower95R>0?'PASS':'REJECT'};const d=path.join(root,'server/data/backtest-research');await fs.mkdir(d,{recursive:true});await fs.writeFile(path.join(d,'high-precision-study-2026-09-14.json'),JSON.stringify(out,null,2));console.log(JSON.stringify({selected,decision:out.decision},null,2))}
main().catch(e=>{console.error(e);process.exitCode=1})

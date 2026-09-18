// Predeclared liquid-crypto trend-continuation benchmark.
//
// This is deliberately independent of the eight legacy bot signals.  It uses
// only closed 1h candles to form an entry, enters on the next 5m candle, and
// uses the subsequent 5m path for the exit.  It is a research benchmark, not
// a production trading strategy.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCachedKlines, readMeta } from './data-cache.js'
import { BACKTEST_UNIVERSE } from '../../src/lib/tradingConfig.js'
import { computeSplitBoundaries, assignSplit } from './splits.js'
import { fitTree } from './train-consolidated.js'
import { summarize } from './consolidated-audit.js'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,v)=>x.startsWith('--')?[...a,[x.slice(2),v[i+1]]]:a,[]))
const years=Math.max(1,Math.min(8,Number(args.years||5)))
// The cache intentionally does not persist the in-progress month. Defaulting
// to the prior UTC month makes this read-only study reproducible and prevents
// an accidental network fetch / partial-month sample.
// Replay runs may have read the then-current month without persisting it.
// Use the month before last by default: it is guaranteed immutable in this
// cache design, whereas the immediately previous month may only exist in a
// prior process's memory.
const priorMonthEnd=Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth()-1,1)-1
const suppliedEnd=args.end?Date.parse(args.end):NaN
const endMs=Number.isFinite(suppliedEnd)?suppliedEnd:priorMonthEnd,startMs=endMs-years*365.25*24*3_600_000
const feeBps=5,slippageBps=2,notional=100
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0
const max=xs=>Math.max(...xs)
const min=xs=>Math.min(...xs)
const ema=(values,period)=>{if(values.length<period)return null;let v=mean(values.slice(0,period));const k=2/(period+1);for(let i=period;i<values.length;i++)v=(values[i]-v)*k+v;return v}
const atr=(bars,period=14)=>{if(bars.length<=period)return null;const tr=[];for(let i=1;i<bars.length;i++)tr.push(Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-bars[i-1].c),Math.abs(bars[i].l-bars[i-1].c)));let v=mean(tr.slice(0,period));for(let i=period;i<tr.length;i++)v=(v*(period-1)+tr[i])/period;return v}
const candle=r=>({t:num(r[0]),closeTime:num(r[6]),o:num(r[1]),h:num(r[2]),l:num(r[3]),c:num(r[4]),v:num(r[5]),taker:num(r[9])})
const direction=s=>s==='BUY'?1:-1
function predicted(tree,x){let n=tree;while(n.feature!==undefined)n=x[n.feature]<=n.threshold?n.left:n.right;return n.meanR}
function simulate({side,entry,stop,target,at,five}){
  const d=direction(side)
  for(let i=at+1;i<five.length;i++){
    const b=five[i], hitStop=d>0?b.l<=stop:b.h>=stop, hitTarget=d>0?b.h>=target:b.l<=target
    // A 5m OHLC bar has no intrabar order.  Stop first is conservative.
    if(hitStop)return {price:stop,end:b.closeTime,status:'SL'}
    if(hitTarget)return {price:target,end:b.closeTime,status:'TP'}
    if(b.closeTime-five[at].t>=48*3_600_000)return {price:b.c,end:b.closeTime,status:'TIME'}
  }
  return null
}
function locateNext(five,time,from){let i=from;while(i<five.length&&five[i].t<time)i++;return i}
function summary(rows){return summarize(rows.map(r=>({t:r.t,r:r.r,pnl:r.pnl,side:r.side,symbol:r.symbol}))) }
function fmt(s){return `${s.trades} trades · ${(s.winRate*100).toFixed(1)}% win · ${s.meanR.toFixed(3)} R · PF ${s.profitFactor.toFixed(3)} · 95% [${s.lower95R.toFixed(3)}, ${s.upper95R.toFixed(3)}]`}
function table(h,rows){return ['| '+h.join(' | ')+' |','| '+h.map(()=> '---').join(' | ')+' |',...rows.map(r=>'| '+r.join(' | ')+' |')].join('\n')}

async function symbolRows(symbol){
  // Never ask the cache for candles before this symbol's known first cached
  // bar: that would cause a network fetch and would turn the benchmark into a
  // different, non-reproducible dataset.
  const meta=await readMeta(symbol)
  const first=Math.max(startMs,num(meta?.timeframes?.['1h']?.firstCandle),num(meta?.timeframes?.['5m']?.firstCandle))
  if(!(first>0&&first<endMs))return []
  const [oneRaw,fiveRaw]=await Promise.all([getCachedKlines(symbol,'1h',first,endMs,{readOnly:true}),getCachedKlines(symbol,'5m',first,endMs,{readOnly:true})])
  const one=oneRaw.map(candle),five=fiveRaw.map(candle),out=[]
  if(one.length<300||five.length<1000)return out
  const bounds=computeSplitBoundaries(one[0].t,one.at(-1).closeTime,48*3_600_000)
  let f=0
  for(let i=200;i<one.length;i++){
    // One decision per completed 4h block limits serially-correlated samples.
    if(i%4!==3)continue
    const w=one.slice(i-200,i+1), closes=w.map(x=>x.c)
    // i is a completed 4h boundary.  Build the 4h regime series strictly
    // from completed 1h candles; no unfinished 4h candle can enter the EMA.
    const fourCloses=[];for(let j=3;j<=i;j+=4)fourCloses.push(one[j].c)
    const e20=ema(closes,20),e20Back=ema(closes.slice(0,-12),20),e50=ema(fourCloses,50),e200=ema(fourCloses,200)
    const a=atr(w.slice(-30),14),current=w.at(-1),previous=w.slice(-21,-1)
    const avgVolume=mean(previous.map(x=>x.v)), buyRatio=current.v>0?current.taker/current.v:.5
    if(!(a>0&&avgVolume>0&&e20&&e20Back&&e50&&e200))continue
    const longOk=e50>e200&&e20>e20Back&&current.c>e20&&current.c>max(previous.map(x=>x.h))&&current.v>=avgVolume&&buyRatio>=.52
    const shortOk=e50<e200&&e20<e20Back&&current.c<e20&&current.c<min(previous.map(x=>x.l))&&current.v>=avgVolume&&buyRatio<=.48
    if(!longOk&&!shortOk)continue
    const side=longOk?'BUY':'SELL',entryAt=locateNext(five,current.closeTime+1,f)
    if(entryAt>=five.length-1)break
    f=Math.max(f,entryAt)
    const entry=five[entryAt].o,d=direction(side),stop=entry-d*2*a,target=entry+d*4*a
    if(!(entry>0&&stop>0&&target>0))continue
    const exit=simulate({side,entry,stop,target,at:entryAt,five});if(!exit)continue
    const gross=d*(exit.price-entry)/entry*notional,friction=notional*((feeBps+slippageBps)*2/10_000),pnl=gross-friction,risk=Math.abs(entry-stop)/entry*notional
    const t=five[entryAt].t,split=assignSplit(t,bounds)
    if(split==='purged')continue
    // Fixed, entry-time features. The tree may be trained only on train rows.
    const x=[(e50-e200)/entry,(e20-e20Back)/entry,current.v/avgVolume,buyRatio-.5,a/entry,side==='BUY'?1:0]
    out.push({symbol,side,t,end:exit.end,entry,stop,target,pnl,r:pnl/risk,split,x,status:exit.status,volumeRatio:current.v/avgVolume,buyRatio})
  }
  return out
}
async function main(){
  console.log(`Trend benchmark: ${years}y through ${new Date(endMs).toISOString().slice(0,10)}, ${BACKTEST_UNIVERSE.length} cached symbols, 1h closed entries / 5m exits`)
  const rows=[]
  for(const symbol of BACKTEST_UNIVERSE){const rs=await symbolRows(symbol);rows.push(...rs);console.log(`${symbol}: ${rs.length} candidates`)}
  const train=rows.filter(r=>r.split==='train'),val=rows.filter(r=>r.split==='val'),holdout=rows.filter(r=>r.split==='holdout')
  if(train.length<100||val.length<30||holdout.length<30)throw new Error(`Too few rows: ${train.length}/${val.length}/${holdout.length}`)
  // Fixed before review: a shallow chronological expected-R tree and >0R gate.
  const tree=fitTree(train,4,30),gate=0
  const choose=rs=>{
    const candidates=rs.map(r=>({...r,prediction:predicted(tree,r.x)})).filter(r=>r.prediction>gate)
      .sort((a,b)=>a.t-b.t||b.prediction-a.prediction||a.symbol.localeCompare(b.symbol))
    const selected=[];let availableAt=-Infinity
    for(const r of candidates)if(r.t>availableAt){selected.push(r);availableAt=r.end}
    return selected
  }
  const baseline={train:summary(train),validation:summary(val),holdout:summary(holdout)}
  const ai={train:summary(choose(train)),validation:summary(choose(val)),holdout:summary(choose(holdout))}
  const stress=summary(choose(holdout).map(r=>({...r,pnl:r.pnl-notional*.0016,r:r.r-(notional*.0016)/(Math.abs(r.entry-r.stop)/r.entry*notional)})))
  const pass=s=>s.trades>=100&&s.meanR>0&&s.profitFactor>=1&&s.lower95R>0
  const report={version:'trend-benchmark-v1',generatedAt:new Date().toISOString(),period:{start:new Date(startMs).toISOString(),end:new Date(endMs).toISOString()},specification:{universe:BACKTEST_UNIVERSE,universeNote:'Static 20-symbol liquid universe. Point-in-time top-20 selection requires a wider historical universe and is not claimed here.',entry:'Closed 1h 20-bar breakout; 4h EMA50/200 trend proxy; 1h EMA20 slope; volume >= prior 20h mean; direction-aligned taker ratio.',exit:'2 hourly ATR stop, 2R target, 48h time stop; stop takes precedence in same 5m bar.',costs:{feeBps,slippageBps,stressExtraRoundTripBps:16},ai:'Shallow regression tree trained only on chronological train rows; fixed expected-R gate > 0.'},counts:{all:rows.length,train:train.length,validation:val.length,holdout:holdout.length},baseline,aiGated:ai,stressedHoldout:stress,acceptance:{criteria:'>=100 trades, positive mean R, PF >=1, lower 95% mean-R bound >0',baselineHoldout:pass(baseline.holdout),aiGatedHoldout:pass(ai.holdout),aiGatedStressHoldout:pass(stress)},rows}
  const stamp=`trend-benchmark-${new Date().toISOString().slice(0,10)}`,dataDir=path.join(root,'server/data/backtest-research'),runDir=path.join(root,'server/backtest/runs')
  await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(path.join(dataDir,`${stamp}.json`),JSON.stringify(report,null,2))
  const lines=['# Predeclared liquid-crypto trend benchmark','',`Generated: ${report.generatedAt}`,'', '## Specification','',...Object.entries(report.specification).map(([k,v])=>`- **${k}:** ${typeof v==='string'?v:JSON.stringify(v)}`),'','## Results','',table(['Variant','Train','Validation','Untouched holdout'],[['All predeclared entries',fmt(baseline.train),fmt(baseline.validation),fmt(baseline.holdout)],['Chronological AI-gated',fmt(ai.train),fmt(ai.validation),fmt(ai.holdout)],['AI-gated cost stress','—','—',fmt(stress)]]),'',`Acceptance result: baseline ${pass(baseline.holdout)?'PASS':'REJECT'}; AI-gated ${pass(ai.holdout)?'PASS':'REJECT'}; AI-gated stressed ${pass(stress)?'PASS':'REJECT'}.`,'','## Limits','', '- Static universe is not a point-in-time top-volume universe; this prevents a false liquidity claim.', '- Historical kline volume and taker-buy volume are real exchange fields. Order-book depth is not reconstructed.', '- No result authorizes deployment or live trading.']
  await fs.writeFile(path.join(runDir,`${stamp}.md`),lines.join('\n'))
  console.log(JSON.stringify({stamp,counts:report.counts,baselineHoldout:baseline.holdout,aiHoldout:ai.holdout,stress,acceptance:report.acceptance},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})

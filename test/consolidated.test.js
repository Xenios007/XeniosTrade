import test from 'node:test'
import assert from 'node:assert/strict'
import { INPUT_KEYS, SOURCE_BOTS, inputVector, scoreCandidate, CONSOLIDATED_VERSION } from '../server/strategy/consolidated-model.js'
import { splitRow, selectTrades, fitTree } from '../server/backtest/train-consolidated.js'
import { chooseSignal, paperExit } from '../server/consolidated-bot.js'
import { summarize } from '../server/backtest/consolidated-audit.js'

const features=()=>Object.fromEntries(INPUT_KEYS.slice(10).map(k=>[k,0.5]))
const candidate=()=>({features:features(),botId:'model-1',side:'BUY',stopFraction:0.01})
const artifact=()=>({version:CONSOLIDATED_VERSION,inputKeys:INPUT_KEYS,threshold:0.1,validated:false,
  tree:{feature:0,threshold:0,left:{id:1,count:200,meanR:-0.2},right:{id:2,count:150,meanR:0.2}}})

test('entry vector includes all eight source identities, refuses missing data and ignores outcomes',()=>{
  for(const botId of SOURCE_BOTS){const c={...candidate(),botId};const x=inputVector(c);assert.equal(x.length,INPUT_KEYS.length);assert.equal(x[SOURCE_BOTS.indexOf(botId)+1],1)}
  const c=candidate(),before=inputVector(c);c.features.pnl=999;c.features.reward=999;c.features.netR=999
  assert.deepEqual(inputVector(c),before)
  delete c.features.e5_rsi14;assert.equal(inputVector(c),null)
  assert.equal(inputVector({...candidate(),side:'WAIT'}),null)
  assert.equal(inputVector({...candidate(),stopFraction:0}),null)
})
test('frozen rule emits trace, rejects missing policy and rejects incompatible features',()=>{
  const a=artifact();const s=scoreCandidate(a,candidate())
  assert.equal(s.accepted,true);assert.equal(s.validated,false);assert.equal(s.trace[0].feature,'side')
  assert.equal(scoreCandidate(a,{...candidate(),side:'SELL'}).accepted,false)
  assert.equal(scoreCandidate(null,candidate()).accepted,false)
  assert.equal(scoreCandidate({...a,inputKeys:[]},candidate()).accepted,false)
})
test('global chronological split purges entries and outcomes crossing boundaries',()=>{
  const boundary=Date.parse('2024-09-01'),h=3600000
  assert.equal(splitRow(boundary-3*24*h,boundary-60*h),'train')
  assert.equal(splitRow(boundary-3*24*h,boundary),'purged')
  assert.equal(splitRow(boundary-1,boundary+1000),'purged')
  assert.equal(splitRow(Date.parse('2025-09-05'),Date.parse('2025-09-06')),'holdout')
  assert.equal(splitRow(100,99),'invalid')
})
test('selector suppresses overlapping trades and ranks by entry information only',()=>{
  const tree=artifact().tree
  const row=(t,end,bot,symbol)=>({t,end,bot,symbol,x:inputVector(candidate()),r:1})
  const rows=[row(10,20,'model-2','ETHUSDT'),row(10,25,'model-1','BTCUSDT'),row(24,30,'model-3','BTCUSDT'),row(26,40,'model-1','BTCUSDT')]
  const result=selectTrades(rows,tree,0.1)
  assert.deepEqual(result.map(r=>r.t),[10,26]);assert.equal(result[0].bot,'model-1')
  rows[0].r=999;assert.deepEqual(selectTrades(rows,tree,0.1).map(r=>r.bot),result.map(r=>r.bot))
})
test('fitting is deterministic and finds an entry-time separation',()=>{
  const rows=Array.from({length:40},(_,i)=>({x:INPUT_KEYS.map((_,j)=>j===0?(i<20?-1:1):0),r:i<20?-1:1}))
  const a=fitTree(rows,2,5),b=fitTree(rows,2,5)
  assert.deepEqual(a,b);assert.equal(a.feature,0);assert.equal(a.left.meanR,-1);assert.equal(a.right.meanR,1)
})
test('paper SL wins ties; gap stop, cost, and short direction are accounted for',()=>{
  const p={side:'BUY',entryPrice:100,stopLoss:99,takeProfit:102,notional:100,openedAt:10,lastCheckedAt:9}
  const c={time:10,closeTime:300009,open:100,high:103,low:98,close:101}
  const exit=paperExit(p,[c]);assert.equal(exit.status,'SL');assert.equal(exit.netPnl,-1.14)
  assert.equal(paperExit(p,[{...c,open:97}]).exitPrice,97)
  const short=paperExit({...p,side:'SELL',stopLoss:101,takeProfit:98},[{...c,high:100,low:97}])
  assert.equal(short.status,'TP');assert.equal(short.netPnl,1.86)
  assert.equal(paperExit(p,[{...c,time:0,closeTime:9}]),null)
})
test('paper timeout closes at the observed close',()=>{
  const p={side:'BUY',entryPrice:100,stopLoss:90,takeProfit:120,notional:100,openedAt:0,lastCheckedAt:0}
  assert.equal(paperExit(p,[{time:48*3600000-300000,closeTime:48*3600000,open:100,high:101,low:99,close:100}]).status,'TIMEOUT')
})
test('signal arbitration requires source readiness and model acceptance',()=>{
  assert.equal(chooseSignal([{ready:true,selection:{accepted:false}}]),null)
  const c={ready:true,sourceBot:'model-1',symbol:'BTCUSDT',selection:{accepted:true,expectedR:0.2}}
  assert.equal(chooseSignal([c,{...c,sourceBot:'model-3',selection:{accepted:true,expectedR:0.4}}]).sourceBot,'model-3')
})
test('statistics distinguish hit rate from expectancy and cluster uncertainty',()=>{
  const rows=[{r:1,pnl:1,t:0},{r:1,pnl:1,t:1},{r:-3,pnl:-3,t:86400000}]
  const s=summarize(rows);assert.equal(s.winRate,2/3);assert.equal(s.meanR,-1/3);assert.equal(s.profitFactor,2/3);assert.equal(s.days,2)
  assert.equal(summarize([]).lower95R,null)
})

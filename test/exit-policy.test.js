import test from 'node:test'
import assert from 'node:assert/strict'
import { parseExitPolicies, simulateExitPolicy } from '../server/backtest/exit-policy.js'

const bars=[
  [0,100,101,99,100,0,299999],
  [300000,100,102,100,101,0,599999],
  [600000,101,102,99,100,0,899999],
  [900000,100,101,100,100.5,0,1199999],
]
const base={side:'BUY',entryPrice:100,stopLoss:99,takeProfit:103,notional:100,entryBarIndex:0,entryTfRaw:bars}
test('exit policies reject unknown names and preserve the source bracket',()=>{
  assert.throws(()=>parseExitPolicies('source,wrong'),/Unknown exit policy/)
  assert.equal(simulateExitPolicy(base).status,'CLOSED_SL')
})
test('breakeven promotion is conservative on an ambiguous later bar',()=>{
  const result=simulateExitPolicy({...base,policyId:'breakeven_1r'})
  assert.equal(result.price,100)
  assert.equal(result.status,'CLOSED_SL')
})
test('one-R target closes after the target is reached',()=>{
  const result=simulateExitPolicy({...base,policyId:'target_1r'})
  assert.equal(result.price,101)
  assert.equal(result.status,'CLOSED_TP')
})

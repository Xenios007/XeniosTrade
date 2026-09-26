import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createConsolidatedTestnet,createTestnetClient,sizeTestnetSignal,TESTNET_URL} from '../server/consolidated-testnet.js'

const info={symbol:'SOLUSDT',status:'TRADING',quoteAsset:'USDT',filters:[{filterType:'MARKET_LOT_SIZE',stepSize:'0.01',minQty:'0.01',maxQty:'1000'},{filterType:'PRICE_FILTER',tickSize:'0.01'},{filterType:'MIN_NOTIONAL',notional:'5'}]}
const signal=()=>({symbol:'SOLUSDT',side:'BUY',entryPrice:100,stopLoss:99,takeProfit:102,ready:true,selection:{accepted:true},barClose:Date.now(),sourceBot:'model-1'})
async function fixture(t,options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xenios-testnet-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const calls=[],orders=new Map(),algos=new Map();let amount=0
  const transport=async(raw,request)=>{
    const url=new URL(raw),p=Object.fromEntries(url.searchParams),route=`${request.method} ${url.pathname}`
    assert.equal(url.origin,TESTNET_URL);calls.push({route,p})
    let result
    const fail=()=>({ok:false,json:async()=>({code:-2013,msg:'Order does not exist'})})
    if(route==='GET /fapi/v2/account')result={canTrade:true,availableBalance:'1000',positions:options.existing?[{symbol:'SOLUSDT',positionAmt:'1'}]:[]}
    else if(route==='GET /fapi/v1/positionSide/dual')result={dualSidePosition:false}
    else if(route==='GET /fapi/v1/openOrders')result=[]
    else if(route==='GET /fapi/v1/openAlgoOrders')result=[...algos.values()]
    else if(route==='GET /fapi/v1/exchangeInfo')result={symbols:[info]}
    else if(route==='GET /fapi/v1/premiumIndex')result={markPrice:'100'}
    else if(route==='POST /fapi/v1/leverage'||route==='POST /fapi/v1/marginType')result={}
    else if(route==='POST /fapi/v1/order') {
      result={orderId:orders.size+1,status:'FILLED',executedQty:p.quantity,avgPrice:'100',updateTime:Date.now()};orders.set(p.newClientOrderId,result)
      amount+=Number(p.quantity)*(p.side==='BUY'?1:-1)
      if(options.ambiguous&&!p.reduceOnly)throw new Error('Response lost')
    } else if(route==='GET /fapi/v1/order'){result=orders.get(p.origClientOrderId);if(!result)return fail()}
    else if(route==='POST /fapi/v1/algoOrder') {
      if(options.protectionFailure)throw new Error('Protection unavailable')
      result={algoId:algos.size+1,...p};algos.set(p.clientAlgoId,result)
    } else if(route==='GET /fapi/v1/algoOrder'){result=algos.get(p.clientAlgoId);if(!result)return fail()}
    else if(route==='DELETE /fapi/v1/algoOrder'){algos.delete(p.clientAlgoId);result={}}
    else if(route==='GET /fapi/v2/positionRisk')result=[{symbol:'SOLUSDT',positionSide:'BOTH',positionAmt:String(amount),markPrice:'100',unRealizedProfit:'0'}]
    else if(route==='GET /fapi/v1/userTrades')result=[...orders.values()].map(o=>({orderId:o.orderId,realizedPnl:'0',commission:'0',commissionAsset:'USDT',qty:o.executedQty,price:o.avgPrice}))
    else throw new Error(`Unexpected ${route}`)
    return {ok:true,json:async()=>result}
  }
  const args={dataDir:dir,getCredentials:async()=>({apiKey:'test',secretKey:'test'}),transport}
  return {adapter:createConsolidatedTestnet(args),args,calls,orders,algos}
}
test('sizing caps notional and refuses exchange minimum above cap',()=>{
  assert.ok(sizeTestnetSignal(signal(),info,100).notional<=100)
  assert.throws(()=>sizeTestnetSignal(signal(),{...info,filters:[...info.filters.filter(f=>f.filterType!=='MIN_NOTIONAL'),{filterType:'MIN_NOTIONAL',notional:101}]},100),/minimum size/)
  assert.throws(()=>sizeTestnetSignal(signal(),info,101),/diverged/)
})
test('missing credentials never fall back to simulation',async()=>{
  await assert.rejects(createTestnetClient(async()=>({}),()=>assert.fail('network call'))('POST','/fapi/v1/order'),/credentials are missing/)
})
test('confirmed entry gets two reduce-only protective orders and survives restart',async t=>{
  const f=await fixture(t);await f.adapter.configure(true);await f.adapter.tick(signal(),'frozen')
  const s=await f.adapter.status();assert.equal(s.position.protection,'confirmed');assert.equal(f.algos.size,2)
  assert.ok([...f.algos.values()].every(a=>a.reduceOnly==='true'))
  assert.equal(await f.adapter.isReserved('SOLUSDT'),true)
  const restarted=createConsolidatedTestnet(f.args);await restarted.tick();assert.equal((await restarted.status()).position.orderId,1)
})
test('lost entry response is queried, not submitted twice',async t=>{
  const f=await fixture(t,{ambiguous:true});await f.adapter.configure(true);await f.adapter.tick(signal())
  assert.equal(f.calls.filter(c=>c.route==='POST /fapi/v1/order').length,1)
  assert.equal((await f.adapter.status()).position.protection,'confirmed')
})
test('protection failure pauses and submits reduce-only emergency close',async t=>{
  const f=await fixture(t,{protectionFailure:true});await f.adapter.configure(true)
  await assert.rejects(f.adapter.tick(signal()),/Protection unavailable/)
  assert.equal((await f.adapter.status()).enabled,false)
  const close=f.calls.filter(c=>c.route==='POST /fapi/v1/order').at(-1);assert.equal(close.p.reduceOnly,'true');assert.equal(close.p.side,'SELL')
})
test('existing shared account position prevents any mutation',async t=>{
  const f=await fixture(t,{existing:true});await f.adapter.configure(true)
  await assert.rejects(f.adapter.tick(signal()),/Existing account position/)
  assert.equal(f.calls.filter(c=>c.route.startsWith('POST')).length,0)
})
test('closeNow exits the open position at market and records it as a manually closed trade',async t=>{
  const f=await fixture(t);await f.adapter.configure(true);await f.adapter.tick(signal(),'frozen')
  assert.equal((await f.adapter.status()).position.protection,'confirmed')
  const result=await f.adapter.closeNow()
  assert.equal(result.position,null);assert.equal(result.trades.length,1)
  assert.equal(result.trades[0].status,'CLOSED');assert.equal(result.trades[0].closeReason,'MANUAL')
  const close=f.calls.filter(c=>c.route==='POST /fapi/v1/order').at(-1)
  assert.equal(close.p.reduceOnly,'true');assert.equal(close.p.side,'SELL');assert.equal(close.p.type,'MARKET')
  assert.equal(await f.adapter.isReserved('SOLUSDT'),false)
})
test('closeNow refuses when there is nothing open',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.adapter.closeNow(),/No open Bot 10 testnet position/)
})
test('shared entry lock serializes legacy and consolidated entry work',async t=>{
  const f=await fixture(t),sequence=[]
  await Promise.all([f.adapter.withEntryLock(async()=>{sequence.push(1);await Promise.resolve();sequence.push(2)}),f.adapter.withEntryLock(()=>sequence.push(3))])
  assert.deepEqual(sequence,[1,2,3])
})

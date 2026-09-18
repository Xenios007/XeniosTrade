import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// Deliberately not configurable: live-money endpoints and credentials are never accepted.
export const TESTNET_URL = 'https://demo-fapi.binance.com'
export const TESTNET_LIMITS = Object.freeze({riskUsd:1,maxNotional:100,maxTradesPerDay:3,maxLossPerDay:3,leverage:1,maxHoldHours:48})
const opposite=s=>s==='BUY'?'SELL':'BUY'
const day=t=>new Date(t).toISOString().slice(0,10)
const decimals=step=>Math.max(0,Math.ceil(-Math.log10(Number(step))))
export function stepValue(value,step,up=false) {
  const v=(up?Math.ceil(value/Number(step)-1e-9):Math.floor(value/Number(step)+1e-9))*Number(step)
  return Number(v.toFixed(Math.min(12,decimals(step)+2)))
}

export function sizeTestnetSignal(signal, info, markPrice, limits=TESTNET_LIMITS) {
  if(!signal?.ready || !signal.selection?.accepted || !['BUY','SELL'].includes(signal.side)) throw new Error('No accepted consolidated signal')
  if(info?.status!=='TRADING' || info.quoteAsset!=='USDT') throw new Error('Symbol is not a trading USDT futures contract')
  const filters=Object.fromEntries(info.filters.map(f=>[f.filterType,f]))
  const lot=filters.MARKET_LOT_SIZE || filters.LOT_SIZE, tick=filters.PRICE_FILTER?.tickSize
  if(!lot || !(Number(lot.stepSize)>0) || !(Number(tick)>0)) throw new Error('Missing exchange precision filters')
  const long=signal.side==='BUY'
  let sourceStop=Number(signal.stopLoss)
  if(signal.sourceBot==='model-4' && signal.positionNotional>0) {
    const moneyStop=Number(signal.entryPrice)*(1+(long?-1:1)/signal.positionNotional)
    sourceStop=long?Math.max(sourceStop,moneyStop):Math.min(sourceStop,moneyStop)
  }
  const stopLoss=stepValue(sourceStop,tick,!long),takeProfit=stepValue(Number(signal.takeProfit),tick,!long)
  const sourcePrice=Number(signal.entryPrice),referenceStop=Math.abs(sourcePrice-stopLoss)
  if(![markPrice,sourcePrice,stopLoss,takeProfit].every(v=>Number.isFinite(v)&&v>0) || !referenceStop) throw new Error('Invalid signal prices')
  if(Math.abs(markPrice-sourcePrice)>referenceStop*0.25) throw new Error('Testnet price diverged too far from source signal')
  if(!(long?stopLoss<markPrice && markPrice<takeProfit:takeProfit<markPrice && markPrice<stopLoss)) throw new Error('Signal target/stop invalid at testnet price')
  const stopFraction=Math.abs(markPrice-stopLoss)/markPrice
  const cap=Math.min(limits.maxNotional,limits.riskUsd/(stopFraction+0.002))
  const quantity=stepValue(cap/markPrice,lot.stepSize)
  const notional=quantity*markPrice,minNotional=Number(filters.MIN_NOTIONAL?.notional||filters.NOTIONAL?.minNotional||0)
  if(quantity<Number(lot.minQty) || quantity>Number(lot.maxQty) || notional<minNotional || quantity<=0) throw new Error('Exchange minimum size does not fit the consolidated risk limit')
  return {quantity,stopLoss,takeProfit,notional,entryPrice:markPrice,stepSize:lot.stepSize}
}

export function createTestnetClient(getCredentials, transport=fetch) {
  return async function api(method, endpoint, params={}, signed=true) {
    if(!/^\/fapi\/v[123]\/[a-zA-Z/]+$/.test(endpoint)) throw new Error('Unsupported testnet endpoint')
    const q=new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)]))
    const headers={}
    if(signed) {
      const {apiKey,secretKey}=await getCredentials()
      if(!apiKey||!secretKey) throw new Error('Testnet credentials are missing; no simulation fallback is permitted')
      q.set('recvWindow','5000');q.set('timestamp',String(Date.now()))
      q.set('signature',crypto.createHmac('sha256',secretKey).update(q.toString()).digest('hex'))
      headers['X-MBX-APIKEY']=apiKey
    }
    // No retry for mutations: unknown results must be reconciled by client order ID.
    const response=await transport(`${TESTNET_URL}${endpoint}?${q}`,{method,headers,signal:AbortSignal.timeout(10000)})
    const result=await response.json()
    if(!response.ok) {const e=new Error(`Testnet ${method} ${endpoint}: ${result.msg||response.status}`);e.code=Number(result.code);throw e}
    return result
  }
}

export function createConsolidatedTestnet({dataDir,getCredentials,transport=fetch}) {
  const file=path.join(dataDir,'consolidated/testnet-state.json'),api=createTestnetClient(getCredentials,transport)
  let state,loading,busy=false,lastError=null,entryQueue=Promise.resolve()
  function withEntryLock(fn) {
    const result=entryQueue.then(fn,fn)
    entryQueue=result.catch(()=>{})
    return result
  }
  async function load() {
    if(state)return state
    if(loading)return loading
    loading=(async()=>{
      try {state=JSON.parse(await fs.readFile(file,'utf8'))} catch(e){if(e.code!=='ENOENT')throw e;state={enabled:false,mode:'binance-futures-testnet',position:null,pending:null,trades:[],lastBar:{},lastCheckedAt:null}}
      return state
    })()
    return loading
  }
  async function save() {
    await fs.mkdir(path.dirname(file),{recursive:true})
    const tmp=`${file}.${process.pid}.tmp`;await fs.writeFile(tmp,JSON.stringify(state,null,2));await fs.rename(tmp,file)
  }
  async function connection() {
    const [account,mode]=await Promise.all([api('GET','/fapi/v2/account'),api('GET','/fapi/v1/positionSide/dual')])
    if(mode.dualSidePosition!==false) throw new Error('Consolidated testnet requires one-way mode; the shared account mode will not be changed automatically')
    if(account.canTrade!==true) throw new Error('Testnet account does not permit trading')
    return {connected:true,endpoint:TESTNET_URL,availableBalance:Number(account.availableBalance),
      positions:(account.positions||[]).filter(p=>Number(p.positionAmt)!==0).map(p=>({symbol:p.symbol,quantity:Number(p.positionAmt)}))}
  }
  const status=async()=>({...(await load()),busy,error:lastError,limits:TESTNET_LIMITS,endpoint:TESTNET_URL})
  async function configure(enabled) {
    if(busy) throw new Error('Testnet reconciliation is active; try again shortly')
    await load()
    if(typeof enabled!=='boolean')throw new Error('enabled must be a boolean')
    if(enabled) {await connection();if(state.pending)throw new Error('An unresolved order must be reconciled before enabling entries')}
    state.enabled=enabled;await save();return status()
  }
  async function queryEntry(p) {
    return api('GET','/fapi/v1/order',{symbol:p.symbol,origClientOrderId:p.clientId})
  }
  async function protectedOrder(p,type,suffix,price) {
    const clientAlgoId=`${p.clientId}_${suffix}`
    try {
      return await api('POST','/fapi/v1/algoOrder',{algoType:'CONDITIONAL',symbol:p.symbol,side:opposite(p.side),type,
        quantity:p.quantity,reduceOnly:true,triggerPrice:price,workingType:'MARK_PRICE',clientAlgoId})
    } catch(error) {
      // A timed-out POST may already exist on the exchange. Never duplicate it.
      try {return await api('GET','/fapi/v1/algoOrder',{clientAlgoId})} catch {throw error}
    }
  }
  async function cancelProtection(p) {
    for(const suffix of ['sl','tp']) {
      try {await api('DELETE','/fapi/v1/algoOrder',{clientAlgoId:`${p.clientId}_${suffix}`})}
      catch(e){if(![-2011,-2013,-2016,-4509].includes(e.code))throw e}
    }
  }
  async function flatten(p,reason) {
    const positions=await api('GET','/fapi/v2/positionRisk',{symbol:p.symbol})
    const current=positions.find(v=>v.symbol===p.symbol && v.positionSide==='BOTH')
    const amount=Number(current?.positionAmt||0)
    if(amount && Math.sign(amount)!==(p.side==='BUY'?1:-1))throw new Error('Position direction changed outside consolidated bot; manual reconciliation required')
    if(amount) {
      const quantity=Math.min(Math.abs(amount),Number(p.quantity))
      let previous
      try {previous=await api('GET','/fapi/v1/order',{symbol:p.symbol,origClientOrderId:`${p.clientId}_close`})}
      catch(e){if(e.code!==-2013)throw e}
      if(previous)throw new Error('Emergency close already submitted; remaining exposure requires reconciliation')
      await api('POST','/fapi/v1/order',{symbol:p.symbol,side:opposite(p.side),type:'MARKET',quantity,reduceOnly:true,
        newClientOrderId:`${p.clientId}_close`,newOrderRespType:'RESULT'})
    }
    p.closeReason=reason
  }
  async function adopt(p,order) {
    if(['NEW','PARTIALLY_FILLED'].includes(order.status)) {
      // Cancel any unfilled remainder before protecting exactly the executed quantity.
      await api('DELETE','/fapi/v1/order',{symbol:p.symbol,orderId:order.orderId})
      order=await queryEntry(p)
    }
    const quantity=Number(order.executedQty),price=Number(order.avgPrice)
    if(!(quantity>0) || !(price>0)) {
      if(['CANCELED','REJECTED','EXPIRED'].includes(order.status)) {state.pending=null;await save();return}
      throw new Error('Entry fill is not yet confirmed; no new entries allowed')
    }
    state.position={...p,quantity,entryPrice:price,orderId:order.orderId,openedAt:Number(order.updateTime)||Date.now(),protection:'pending'}
    state.pending=null;await save()
    const position=state.position
    try {
      const sl=await protectedOrder(position,'STOP_MARKET','sl',position.stopLoss)
      position.stopAlgoId=sl.algoId;await save()
      const tp=await protectedOrder(position,'TAKE_PROFIT_MARKET','tp',position.takeProfit)
      position.takeProfitAlgoId=tp.algoId;position.protection='confirmed';await save()
    } catch(error) {
      state.enabled=false;await save()
      await flatten(position,'PROTECTION_FAILED').catch(e=>{lastError=`Protection and emergency close failed: ${e.message}`})
      throw error
    }
  }
  async function reconcile() {
    await load()
    if(state.pending) {
      // Keep unknown orders durable across restarts. Never silently declare them absent.
      await adopt(state.pending,await queryEntry(state.pending))
    }
    const p=state.position
    if(!p)return
    const positions=await api('GET','/fapi/v2/positionRisk',{symbol:p.symbol})
    const current=positions.find(v=>v.symbol===p.symbol && v.positionSide==='BOTH')
    const amount=Number(current?.positionAmt||0)
    if(amount===0) {
      await cancelProtection(p)
      const fills=await api('GET','/fapi/v1/userTrades',{symbol:p.symbol,startTime:p.openedAt-10000,limit:1000})
      // Ownership: entry plus our protective actual order IDs and emergency close ID only.
      const ids=new Set([String(p.orderId)])
      for(const suffix of ['sl','tp']) {
        try {const algo=await api('GET','/fapi/v1/algoOrder',{clientAlgoId:`${p.clientId}_${suffix}`});if(algo.actualOrderId)ids.add(String(algo.actualOrderId))}catch(e){if(![-2011,-2013,-2016,-4509].includes(e.code))throw e}
      }
      try {const close=await api('GET','/fapi/v1/order',{symbol:p.symbol,origClientOrderId:`${p.clientId}_close`});ids.add(String(close.orderId))}catch(e){if(e.code!==-2013)throw e}
      const own=fills.filter(f=>ids.has(String(f.orderId))),realized=own.reduce((s,f)=>s+Number(f.realizedPnl||0),0),fees=own.reduce((s,f)=>s+(f.commissionAsset==='USDT'?Number(f.commission||0):0),0)
      const exits=own.filter(f=>String(f.orderId)!==String(p.orderId)),exitQty=exits.reduce((s,f)=>s+Number(f.qty),0)
      state.trades.unshift({...p,status:exitQty>=p.quantity*0.999?'CLOSED':'EXTERNALLY_CLOSED_REVIEW',closedAt:Date.now(),
        realizedPnl:realized,commission:fees,netPnl:exitQty>=p.quantity*0.999?realized-fees:null,
        exitPrice:exitQty?exits.reduce((s,f)=>s+Number(f.price)*Number(f.qty),0)/exitQty:null,
        pnlNote:'Exchange realized P&L minus USDT commissions; funding and non-USDT commissions excluded.'})
      if(exitQty<p.quantity*0.999)state.enabled=false
      state.position=null;await save();return
    }
    if(Math.sign(amount)!==(p.side==='BUY'?1:-1) || Math.abs(Math.abs(amount)-p.quantity)>p.quantity*0.001) {
      state.enabled=false;await save();throw new Error('Shared symbol exposure changed; consolidated entries paused for reconciliation')
    }
    const open=await api('GET','/fapi/v1/openAlgoOrders',{symbol:p.symbol})
    const own=open.filter(o=>String(o.clientAlgoId).startsWith(`${p.clientId}_`))
    if(!own.some(o=>o.clientAlgoId===`${p.clientId}_sl`) || !own.some(o=>o.clientAlgoId===`${p.clientId}_tp`)) {
      // Triggered order may be settling. Flatten only our remaining amount, then reconcile.
      state.enabled=false;await save();await flatten(p,'MISSING_PROTECTION');return
    }
    if(Date.now()-p.openedAt>TESTNET_LIMITS.maxHoldHours*3600000) await flatten(p,'TIMEOUT')
    p.markPrice=Number(current.markPrice);p.unrealizedPnl=Number(current.unRealizedProfit);state.lastCheckedAt=Date.now();await save()
  }
  async function tickUnlocked(signal=null,modelHash=null) {
    if(busy)return status()
    busy=true
    try {
      await load();await reconcile()
      if(!state.enabled || state.position || state.pending || !signal)return status()
      if(Date.now()-signal.barClose>60000 || signal.barClose<=(state.lastBar[signal.symbol]||0))return status()
      const today=state.trades.filter(t=>day(t.openedAt)===day(Date.now()))
      if(today.length>=TESTNET_LIMITS.maxTradesPerDay || today.some(t=>t.netPnl===null)
        || today.reduce((s,t)=>s+Math.min(0,t.netPnl||0),0)<=-TESTNET_LIMITS.maxLossPerDay)throw new Error('Consolidated daily testnet limit reached')
      const account=await connection()
      if(account.positions.some(p=>p.symbol===signal.symbol))throw new Error('Existing account position on this symbol; consolidated entry skipped')
      const [orders,algos,exchange,mark]=await Promise.all([
        api('GET','/fapi/v1/openOrders',{symbol:signal.symbol}),api('GET','/fapi/v1/openAlgoOrders',{symbol:signal.symbol}),
        api('GET','/fapi/v1/exchangeInfo',{},false),api('GET','/fapi/v1/premiumIndex',{symbol:signal.symbol},false)])
      if(orders.length||algos.length)throw new Error('Existing exchange orders on symbol; consolidated entry skipped')
      const sizing=sizeTestnetSignal(signal,exchange.symbols.find(s=>s.symbol===signal.symbol),Number(mark.markPrice))
      if(account.availableBalance<sizing.notional*1.01)throw new Error('Insufficient available testnet balance at 1x leverage')
      await api('POST','/fapi/v1/leverage',{symbol:signal.symbol,leverage:TESTNET_LIMITS.leverage})
      try {await api('POST','/fapi/v1/marginType',{symbol:signal.symbol,marginType:'ISOLATED'})}catch(e){if(e.code!==-4046)throw e}
      // Persist intent BEFORE sending; reconciliation handles lost responses and crashes.
      const clientId=`xc9_${crypto.createHash('sha256').update(`${signal.symbol}|${signal.barClose}|${signal.side}`).digest('hex').slice(0,20)}`
      state.pending={...sizing,clientId,symbol:signal.symbol,side:signal.side,sourceBot:signal.sourceBot,
        selection:signal.selection,barClose:signal.barClose,modelHash,createdAt:Date.now(),mode:'binance-futures-testnet'}
      state.lastBar[signal.symbol]=signal.barClose;await save()
      let order
      try {order=await api('POST','/fapi/v1/order',{symbol:signal.symbol,side:signal.side,type:'MARKET',quantity:sizing.quantity,newClientOrderId:clientId,newOrderRespType:'RESULT'})}
      catch(error) {try {order=await queryEntry(state.pending)}catch {throw error}}
      await adopt(state.pending,order);lastError=null;return status()
    } catch(e){lastError=e.message;throw e}finally{busy=false}
  }
  const isReserved=async symbol=>{await load();return state.position?.symbol===symbol || state.pending?.symbol===symbol}
  const tick=(signal=null,modelHash=null)=>withEntryLock(()=>tickUnlocked(signal,modelHash))
  return {status,configure,connection,tick,isReserved,withEntryLock}
}

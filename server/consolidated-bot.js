import fs from 'node:fs/promises'
import path from 'node:path'
import { buildEntryFeatures } from './backtest/feature-lib.js'
import { scoreCandidate, SOURCE_BOTS } from './strategy/consolidated-model.js'
import { createConsolidatedTestnet } from './consolidated-testnet.js'

const BAR_MS = 300000
const ROUND_TRIP_COST = 0.0014
const round = n => Number(n.toFixed(8))
export function chooseSignal(candidates) {
  return candidates.filter(c=>c.ready && c.selection?.accepted)
    .sort((a,b)=>b.selection.expectedR-a.selection.expectedR || a.sourceBot.localeCompare(b.sourceBot) || a.symbol.localeCompare(b.symbol))[0] || null
}

export function paperExit(position, candles) {
  for (const c of candles.filter(c=>c.closeTime>position.lastCheckedAt && c.time>=position.openedAt)) {
    const long=position.side==='BUY'
    const sl=long?c.low<=position.stopLoss:c.high>=position.stopLoss
    const tp=long?c.high>=position.takeProfit:c.low<=position.takeProfit
    const timeout=c.closeTime-position.openedAt>=48*3600000
    if (sl || tp || timeout) {
      // Stop wins same-bar ties; gaps through stop use the worse opening price.
      const price=sl?(long?Math.min(c.open,position.stopLoss):Math.max(c.open,position.stopLoss)):tp?position.takeProfit:c.close
      const gross=(long?price-position.entryPrice:position.entryPrice-price)/position.entryPrice*position.notional
      const cost=position.notional*ROUND_TRIP_COST
      return {...position,exitPrice:price,closedAt:c.closeTime,status:sl?'SL':tp?'TP':'TIMEOUT',
        grossPnl:round(gross),cost:round(cost),netPnl:round(gross-cost)}
    }
  }
  return null
}

export function registerConsolidatedBot(app, { dataDir, fetchKlines, toCandleData, buildSignalAnalysisSnapshot, getSettings, getTestnetCredentials, autostart }) {
  const dir=path.join(dataDir,'consolidated'), stateFile=path.join(dir,'paper-state.json')
  let state=null, busy=false, lastError=null
  const testnet=getTestnetCredentials?createConsolidatedTestnet({dataDir,getCredentials:getTestnetCredentials}):null
  const initial=()=>({enabled:false,mode:'paper-only',balance:1000,position:null,trades:[],lastScanAt:null,
    signals:[],lastBars:{},symbols:['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'],riskUsd:1,maxNotional:100})
  async function loadState() {
    if(state) return state
    try {state=JSON.parse(await fs.readFile(stateFile,'utf8'))} catch(e) {if(e.code!=='ENOENT') throw e;state=initial()}
    // Restart never silently resumes paper entries. Existing paper positions remain monitored.
    state.enabled=false
    return state
  }
  async function save() {
    await fs.mkdir(dir,{recursive:true})
    const temp=`${stateFile}.${process.pid}.tmp`
    await fs.writeFile(temp,JSON.stringify(state,null,2));await fs.rename(temp,stateFile)
  }
  const read=async name=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))
  async function market(symbol, now) {
    const [b,s,e]=await Promise.all([fetchKlines(symbol,'1h',162),fetchKlines(symbol,'15m',162),fetchKlines(symbol,'5m',1000)])
    const closed=raw=>toCandleData(raw).filter(c=>c.closeTime<=now)
    const allEntry=closed(e),entry=allEntry.slice(-301),setup=closed(s).slice(-161),bias=closed(b).slice(-161)
    if(entry.length!==301 || setup.length!==161 || bias.length!==161) throw new Error(`${symbol}: candle history shorter than training windows`)
    const t=entry.at(-1).closeTime
    if(now-t>BAR_MS+15000) throw new Error(`${symbol}: stale market candles`)
    const current=toCandleData(e).find(c=>c.time===t+1)
    return {entry,setup,bias,allEntry,t,current}
  }
  async function fundingContext(symbol,t) {
    try {
      const response=await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&endTime=${t}&limit=240`,{signal:AbortSignal.timeout(8000)})
      if(!response.ok) throw new Error(`Funding HTTP ${response.status}`)
      const history=await response.json()
      const rates=history.filter(r=>Number(r.fundingTime)<=t).map(r=>Number(r.fundingRate))
      if(!rates.length || !rates.every(Number.isFinite)) throw new Error('Funding unavailable')
      const rate=rates.at(-1)
      return {fundingRate:rate,fundingPercentile:rates.filter(r=>r<=rate).length/rates.length,fundingAvailable:true}
    } catch {return {fundingRate:0,fundingPercentile:0.5,fundingAvailable:false}}
  }
  async function scan() {
    if(busy) throw new Error('A consolidated scan is already running')
    busy=true
    try {
      await loadState()
      const artifact=await read('model.json'),settings=await getSettings(),now=Date.now()
      const symbols=[...new Set([...state.symbols,...(state.position?[state.position.symbol]:[])])]
      const signals=[],errors=[],markets=new Map()
      // Bounded network load; one symbol at a time, three timeframe requests per symbol.
      for(const symbol of symbols) {
        try {
          const m=await market(symbol,now);markets.set(symbol,m)
          if(state.position?.symbol===symbol) {
            if(m.allEntry[0].time>state.position.lastCheckedAt+1) throw new Error('Paper monitoring gap exceeds available candle history; manual review required')
            const exit=paperExit(state.position,m.allEntry)
            if(exit) {state.trades.unshift(exit);state.balance=round(state.balance+exit.netPnl);state.position=null}
            else state.position.lastCheckedAt=m.t
          }
          const features=buildEntryFeatures({entryCandles:m.entry,setupCandles:m.setup,biasCandles:m.bias,tMs:m.t}).features
          const fund=await fundingContext(symbol,m.t)
          const recent=m.entry.slice(-5),buy=recent.reduce((s,c)=>s+c.takerBuyBaseVolume,0),sell=recent.reduce((s,c)=>s+c.takerSellBaseVolume,0)
          const context={...fund,orderFlowProxy:true,orderBookImbalance:sell>0?buy/sell:buy>0?3:1}
          for(const bot of SOURCE_BOTS) {
            const snapshot=buildSignalAnalysisSnapshot(symbol,m.bias,m.setup,m.entry,settings.strategy,bot,context,[])
            const stopFraction=Number(snapshot.configuredStopLossPercent)/100
            const selection=snapshot.ready?scoreCandidate(artifact,{features,botId:bot,side:snapshot.side,stopFraction}):
              {accepted:false,reason:snapshot.summary || 'Source setup not ready.'}
            signals.push({...snapshot,sourceBot:bot,selection,barClose:m.t})
          }
        } catch(e) {errors.push({symbol,error:e.message})}
      }
      const selected=chooseSignal(signals.filter(s=>s.barClose>(state.lastBars[s.symbol]||0) && Date.now()-s.barClose<=30000))
      if(state.enabled && !state.position && selected && errors.length===0) {
        const m=markets.get(selected.symbol),entryPrice=m.current?.open
        const long=selected.side==='BUY'
        let stopLoss=Number(selected.stopLoss),takeProfit=Number(selected.takeProfit)
        // Preserve Bot 4's source money-stop distance when routing a Bot 4 signal.
        if(selected.sourceBot==='model-4' && selected.positionNotional>0) {
          const moneyStop=selected.entryPrice*(1+(long?-1:1)/selected.positionNotional)
          stopLoss=long?Math.max(stopLoss,moneyStop):Math.min(stopLoss,moneyStop)
        }
        const valid=[entryPrice,stopLoss,takeProfit].every(v=>Number.isFinite(v)&&v>0)
          && (long?stopLoss<entryPrice && takeProfit>entryPrice:stopLoss>entryPrice && takeProfit<entryPrice)
        // Only enter just after a fresh close, never retrospectively halfway through a bar.
        if(valid && Date.now()-m.t<=30000 && state.balance>state.riskUsd) {
          const stopFraction=Math.abs(entryPrice-stopLoss)/entryPrice
          const notional=Math.min(state.maxNotional,state.riskUsd/(stopFraction+ROUND_TRIP_COST),state.balance)
          state.position={id:`consolidated-${selected.symbol}-${m.t}`,symbol:selected.symbol,side:selected.side,
            sourceBot:selected.sourceBot,entryPrice,stopLoss,takeProfit,notional,openedAt:m.t+1,lastCheckedAt:m.t,
            selection:selected.selection,modelHash:artifact.sourceHash,mode:'paper-only'}
        }
      }
      if(testnet && errors.length===0) {
        const testnetSignal=chooseSignal(signals.filter(s=>Date.now()-s.barClose<=60000))
        await testnet.tick(testnetSignal,artifact.sourceHash).catch(e=>errors.push({symbol:'TESTNET',error:e.message}))
      }
      for(const [symbol,m] of markets) state.lastBars[symbol]=m.t
      state.signals=signals;state.lastScanAt=Date.now();state.errors=errors;lastError=null
      await save()
      return {state,busy:false,selected,errors}
    } catch(e) {lastError=e.message;throw e} finally {busy=false}
  }
  const wrap=handler=>async(req,res)=>{try{await handler(req,res)}catch(e){res.status(e.code==='ENOENT'?503:400).json({error:e.code==='ENOENT'?'Run npm run consolidated:train to build the model first.':e.message})}}
  // `/api/consolidated` remains a compatibility alias. Bot 10 is the
  // user-facing identity; it deliberately retains the consolidated artifact,
  // state and execution implementation so no active testnet state is lost.
  const statusHandler=wrap(async(_req,res)=>{
    await loadState();const report=await read('report.json')
    res.json({botId:'model-10',botName:'Bot 10 · Consolidated Knowledge',sourceBots:SOURCE_BOTS,report,state,busy,error:lastError,testnet:testnet?await testnet.status():null})
  })
  app.get('/api/consolidated',statusHandler)
  app.get('/api/bot-10',statusHandler)
  app.post('/api/consolidated/scan',wrap(async(_req,res)=>res.json(await scan())))
  app.post('/api/consolidated/paper',wrap(async(req,res)=>{
    if(busy) throw new Error('Wait for the active scan to finish before changing paper mode.')
    await loadState();await read('model.json')
    if(typeof req.body?.enabled!=='boolean') throw new Error('enabled must be a boolean')
    state.enabled=req.body.enabled;await save();res.json({state})
  }))
  app.post('/api/consolidated/testnet/check',wrap(async(_req,res)=>{
    if(!testnet)throw new Error('Testnet execution is not installed on this runtime')
    res.json(await testnet.connection())
  }))
  app.post('/api/consolidated/testnet',wrap(async(req,res)=>{
    if(!testnet)throw new Error('Testnet execution is not installed on this runtime')
    if(busy)throw new Error('Wait for the current signal scan to finish')
    res.json({testnet:await testnet.configure(req.body?.enabled)})
  }))
  // Exits the current Bot 10 testnet position right now with a reduce-only market order, instead of waiting for its
  // stop, target, or the 48h timeout. Independent of the paper-only `busy` scan lock above (its own lock inside
  // testnet.closeNow guards against colliding with an in-flight signal entry).
  app.post('/api/consolidated/testnet/close',wrap(async(_req,res)=>{
    if(!testnet)throw new Error('Testnet execution is not installed on this runtime')
    res.json({testnet:await testnet.closeNow()})
  }))
  if(autostart) {
    const timer=setInterval(async()=>{
      try {
        await loadState()
        if(testnet)await testnet.tick()
        const exchange=testnet?await testnet.status():null
        if(!busy && (state.enabled||state.position||exchange?.enabled)) await scan()
      } catch(e){lastError=e.message}
    },15000)
    timer.unref()
  }
  return {scan,loadState,testnet}
}

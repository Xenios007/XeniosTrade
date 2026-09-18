import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { registerConsolidatedBot } from '../server/consolidated-bot.js'
import { CONSOLIDATED_VERSION, INPUT_KEYS } from '../server/strategy/consolidated-model.js'

test('consolidated API is isolated, paused by default, scans all bots, and persists paper controls',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xenios-consolidated-test-'))
  await fs.mkdir(path.join(dir,'consolidated'))
  const model={version:CONSOLIDATED_VERSION,inputKeys:INPUT_KEYS,threshold:0.1,validated:false,
    tree:{id:1,count:200,meanR:-0.2},sourceHash:'test-only'}
  await fs.writeFile(path.join(dir,'consolidated/model.json'),JSON.stringify(model))
  await fs.writeFile(path.join(dir,'consolidated/report.json'),JSON.stringify({status:'research-only'}))
  const latest=Math.floor(Date.now()/300000)*300000-1
  const makeCandles=(interval,n)=>Array.from({length:n},(_,i)=>{
    const ms=interval==='1h'?3600000:interval==='15m'?900000:300000
    const closeTime=latest-(n-1-i)*ms
    return {time:closeTime-ms+1,closeTime,open:100,high:101,low:99,close:100,volume:10,takerBuyBaseVolume:5,takerSellBaseVolume:5,deltaVolume:0}
  })
  const seen=[]
  const app=express();app.use(express.json())
  const originalFetch=globalThis.fetch
  globalThis.fetch=async(url,options)=>String(url).startsWith('https://fapi.binance.com/')?
    new Response(JSON.stringify([{fundingTime:latest-1,fundingRate:'0.0001'}]),{status:200}):originalFetch(url,options)
  const registered=registerConsolidatedBot(app,{dataDir:dir,autostart:false,
    fetchKlines:async(_s,interval,n)=>makeCandles(interval,n),toCandleData:x=>x,
    getSettings:async()=>({strategy:{}}),
    buildSignalAnalysisSnapshot:(symbol,bias,setup,entry,strategy,bot,context)=>{
      seen.push({bot,lengths:[entry.length,setup.length,bias.length],funding:context.fundingAvailable})
      return {symbol,ready:true,side:'BUY',direction:'LONG',configuredStopLossPercent:1,entryPrice:100,stopLoss:99,takeProfit:102}
    }})
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))})
  t.after(async()=>{globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true})})
  const base=`http://127.0.0.1:${server.address().port}`
  const initial=await(await originalFetch(`${base}/api/consolidated`)).json()
  assert.equal(initial.state.enabled,false);assert.equal(initial.state.balance,1000)
  const bad=await originalFetch(`${base}/api/consolidated/paper`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:'yes'})})
  assert.equal(bad.status,400)
  await registered.scan()
  assert.equal(seen.length,32)
  assert.equal(new Set(seen.map(s=>s.bot)).size,8)
  assert.ok(seen.every(s=>s.lengths.join(',')==='301,161,161' && s.funding))
  const state=await registered.loadState();assert.equal(state.position,null)
  assert.ok(state.signals.every(s=>!s.selection.accepted))
  const on=await originalFetch(`${base}/api/consolidated/paper`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true})})
  assert.equal(on.status,200)
  const persisted=JSON.parse(await fs.readFile(path.join(dir,'consolidated/paper-state.json'),'utf8'))
  assert.equal(persisted.enabled,true);assert.equal(persisted.mode,'paper-only');assert.equal(persisted.balance,1000)
})

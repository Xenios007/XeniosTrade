// Candle-only exit-policy research. Same-bar stop/target ambiguity is resolved
// pessimistically as a stop because 5m candles have no intrabar sequence.
const d = side => side === 'BUY' ? 1 : -1
const tradePnl = (side, entry, exit, notional) => d(side) * (exit - entry) / entry * notional

export const EXIT_POLICIES = Object.freeze({
  source: { id:'source', label:'Source brackets, 48h maximum' },
  target_1r: { id:'target_1r', targetR:1, label:'Source stop, 1R target' },
  target_15r: { id:'target_15r', targetR:1.5, label:'Source stop, 1.5R target' },
  breakeven_1r: { id:'breakeven_1r', breakevenAtR:1, label:'Move stop to entry after 1R' },
  time_12h: { id:'time_12h', maxHoldHours:12, label:'Source brackets, 12h time stop' },
  time_24h: { id:'time_24h', maxHoldHours:24, label:'Source brackets, 24h time stop' },
})

export function parseExitPolicies(value) {
  const ids=[...new Set(String(value || 'source,target_1r,target_15r,breakeven_1r,time_12h,time_24h').split(',').map(x=>x.trim()).filter(Boolean))]
  if(!ids.length || ids.some(id=>!EXIT_POLICIES[id])) throw new Error(`Unknown exit policy; use ${Object.keys(EXIT_POLICIES).join(', ')}`)
  return ids
}

export function simulateExitPolicy({side,entryPrice,stopLoss,takeProfit,notional,isBot4=false,entryBarIndex,entryTfRaw,maxHoldHours=48,policyId='source'}) {
  const policy=EXIT_POLICIES[policyId];if(!policy)throw new Error(`Unknown exit policy: ${policyId}`)
  const direction=d(side),risk=Math.abs(entryPrice-stopLoss),entryTime=Number(entryTfRaw[entryBarIndex]?.[0])
  const target=policy.targetR?entryPrice+direction*risk*policy.targetR:takeProfit
  const trigger=policy.breakevenAtR?entryPrice+direction*risk*policy.breakevenAtR:null
  const moneyStop=isBot4&&notional>0?entryPrice*(1-direction/notional):null
  let activeStop=stopLoss
  for(let i=entryBarIndex+1;i<entryTfRaw.length;i+=1){
    const bar=entryTfRaw[i],high=Number(bar[2]),low=Number(bar[3]),close=Number(bar[4]),time=Number(bar[6])
    const hitStop=price=>direction>0?low<=price:high>=price
    const hitTarget=direction>0?high>=target:low<=target
    if(hitStop(activeStop)||moneyStop!=null&&hitStop(moneyStop)){
      const price=hitStop(activeStop)&&(!(moneyStop!=null&&hitStop(moneyStop))||(direction>0?activeStop>=moneyStop:activeStop<=moneyStop))?activeStop:moneyStop
      return {price,time,status:'CLOSED_SL',bars:i-entryBarIndex,policyId}
    }
    if(trigger!=null&&(direction>0?high>=trigger:low<=trigger))activeStop=entryPrice
    if(hitTarget)return {price:target,time,status:'CLOSED_TP',bars:i-entryBarIndex,policyId}
    if(time-entryTime>=(policy.maxHoldHours??maxHoldHours)*3_600_000)return {price:close,time,status:tradePnl(side,entryPrice,close,notional)>=0?'CLOSED_TP':'CLOSED_SL',bars:i-entryBarIndex,timedOut:true,policyId}
  }
  return null
}

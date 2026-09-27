const fs = require('fs')
const s = JSON.parse(fs.readFileSync('server/data/settings.json', 'utf8'))
console.log('realMoneySignalModelId:', s.strategy.realMoneySignalModelId)
console.log('realMoneyExecutionArmed:', s.strategy.realMoneyExecutionArmed)
console.log('hasLiveApiKey:', Boolean(s.liveApiKey && s.liveApiKey.trim()))
console.log('hasLiveSecretKey:', Boolean(s.liveSecretKey && s.liveSecretKey.trim()))
const rm = (s.wallets || []).find((w) => w.id === 'wallet-real-money')
console.log('realMoneyWallet:', JSON.stringify({
  id: rm && rm.id,
  enabled: rm && rm.enabled,
  environment: rm && rm.environment,
  balanceMode: rm && rm.balanceMode,
  production: rm && rm.production,
}, null, 2))
const w5 = (s.wallets || []).find((w) => w.assignedSignalModelId === 'model-5')
console.log('wallet5:', JSON.stringify({
  id: w5 && w5.id,
  name: w5 && w5.name,
  enabled: w5 && w5.enabled,
  environment: w5 && w5.environment,
}, null, 2))
console.log('automation:', JSON.stringify(s.automation || null))
console.log('autoTrading:', JSON.stringify(s.autoTrading || null))

import test from 'node:test'
import assert from 'node:assert/strict'
import { getBaseDomain, getGoogleLoginUrl, getModeUrl, resolveAppMode } from '../src/lib/appMode.js'
import { getNavGroups, resolveInitialPath } from '../src/components/shell/navItems.js'

const flatten = (groups) => groups.flatMap((group) => group.items)
const paths = (groups) => flatten(groups).map((item) => item.to)

test('resolveAppMode picks the workspace from the subdomain', () => {
  assert.equal(resolveAppMode('ai.projxenios.trade'), 'ai')
  assert.equal(resolveAppMode('bot.projxenios.trade'), 'bot')
  assert.equal(resolveAppMode('AI.ProjXenios.Trade'), 'ai')
  assert.equal(resolveAppMode('projxenios.trade'), 'home')
  assert.equal(resolveAppMode('www.projxenios.trade'), 'home')
  assert.equal(resolveAppMode('example.org'), 'all')
  assert.equal(resolveAppMode('airbot.projxenios.trade'), 'all')
  assert.equal(resolveAppMode(''), 'all')
})

test('the ?app= override only works on a dev host', () => {
  assert.equal(resolveAppMode('localhost', 'ai'), 'ai')
  assert.equal(resolveAppMode('127.0.0.1', 'bot'), 'bot')
  assert.equal(resolveAppMode('localhost', 'nonsense'), 'all')
  assert.equal(resolveAppMode('localhost', 'home'), 'home')
  assert.equal(resolveAppMode('projxenios.trade', 'ai'), 'home')
  assert.equal(resolveAppMode('bot.projxenios.trade', 'ai'), 'bot')
})

test('getModeUrl links to the sibling subdomain and never on dev hosts', () => {
  const loc = (hostname, port = '') => ({ protocol: 'https:', hostname, port })
  assert.equal(getBaseDomain('bot.projxenios.trade'), 'projxenios.trade')
  assert.equal(getBaseDomain('projxenios.trade'), 'projxenios.trade')
  assert.equal(getModeUrl('ai', '/ai-trading', loc('bot.projxenios.trade')), 'https://ai.projxenios.trade/ai-trading')
  assert.equal(getModeUrl('bot', '/dashboard', loc('ai.projxenios.trade')), 'https://bot.projxenios.trade/dashboard')
  assert.equal(getModeUrl('ai', '/x', loc('bot.example.test', '8443')), 'https://ai.example.test:8443/x')
  assert.equal(getModeUrl('ai', '/', loc('localhost', '5173')), null)
  assert.equal(getModeUrl('all', '/', loc('bot.projxenios.trade')), null)
})

test('AI workspace nav has AI Trading, its own records/wallet/settings pages and the AI-side model tabs', () => {
  const groups = getNavGroups('ai')
  assert.deepEqual(paths(groups), ['/ai-trading', '/ai-history', '/ai-journal', '/ai-wallet', '/ai-models', '/ai-settings'])
  const history = flatten(groups).find((item) => item.to === '/ai-history')
  assert.deepEqual(history.children.map((c) => c.to), ['/ai-history', '/ai-history/real'])
  const models = flatten(groups).find((item) => item.to === '/ai-models')
  assert.deepEqual(models.children.map((c) => c.to), ['/ai-models', '/ai-models/browse', '/ai-models/agents'])
})

test('Bot workspace nav has the bot pages and no AI Trading', () => {
  const groups = getNavGroups('bot')
  const all = paths(groups)
  assert.ok(!all.includes('/ai-trading'))
  for (const p of ['/dashboard', '/mock-trading', '/trade-history', '/journal', '/ai-training', '/wallets', '/settings']) {
    assert.ok(all.includes(p), `${p} missing from bot nav`)
  }
  // '/ai-models/bots' (LLM Trading Bots 11-15) is hidden for now, same as the wallets/pickers those bots would
  // otherwise show up in - see signalModels.js's HIDDEN_MODEL_IDS.
  const models = flatten(groups).find((item) => item.to === '/ai-models')
  assert.deepEqual(models.children.map((c) => c.to), ['/ai-models'])
  assert.ok(all.includes('/consolidated-knowledge'), 'Consolidated Knowledge missing from bot nav')
})

test('the apex workspace still shows everything', () => {
  const all = paths(getNavGroups('all'))
  assert.ok(all.includes('/ai-trading') && all.includes('/dashboard'))
  const models = flatten(getNavGroups('all')).find((item) => item.to === '/ai-models')
  assert.equal(models.children.length, 4)
})

test('a saved path from the other workspace falls back to this one\'s home', () => {
  assert.equal(resolveInitialPath('/ai-trading/history', 'ai'), '/ai-trading/history')
  assert.equal(resolveInitialPath('/ai-wallet', 'ai'), '/ai-wallet')
  assert.equal(resolveInitialPath('/ai-history/real', 'ai'), '/ai-history/real')
  assert.equal(resolveInitialPath('/dashboard', 'ai'), '/ai-trading')
  assert.equal(resolveInitialPath('wallets', 'ai'), '/ai-trading')
  assert.equal(resolveInitialPath('/ai-trading', 'bot'), '/dashboard')
  assert.equal(resolveInitialPath('/settings/strategy', 'bot'), '/settings/strategy')
  assert.equal(resolveInitialPath('journal', 'bot'), '/journal')
  assert.equal(resolveInitialPath('', 'all'), '/dashboard')
})

test('Google sign-in starts on the apex, wherever the login screen is', () => {
  const loc = (hostname) => ({ protocol: 'https:', hostname, port: '' })
  assert.equal(getBaseDomain('www.projxenios.trade'), 'projxenios.trade')
  assert.equal(
    getGoogleLoginUrl('https://ai.projxenios.trade/ai-trading', loc('ai.projxenios.trade')),
    'https://projxenios.trade/api/auth/google/start?return=https%3A%2F%2Fai.projxenios.trade%2Fai-trading',
  )
  assert.equal(getGoogleLoginUrl('', loc('projxenios.trade')), '/api/auth/google/start')
  assert.equal(getGoogleLoginUrl('', loc('localhost')), '/api/auth/google/start')
})

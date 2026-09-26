import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBotSlotLocks, buildDefaultWallets, getUnlockedBotWalletIds, visibleTradingWallets,
} from '../src/lib/wallets.js'

test('visibleTradingWallets gives exactly the 9 sellable bot wallets, in order', () => {
  const ids = visibleTradingWallets(buildDefaultWallets()).map((wallet) => wallet.id)
  assert.deepEqual(ids, [
    'wallet-model-1', 'wallet-model-2', 'wallet-model-3', 'wallet-model-4', 'wallet-model-5',
    'wallet-model-6', 'wallet-model-7', 'wallet-model-8', 'wallet-model-9',
  ])
})

test('getUnlockedBotWalletIds caps to the first N sellable wallets, in wallet-model order', () => {
  const wallets = buildDefaultWallets()
  assert.deepEqual(getUnlockedBotWalletIds(wallets, 0), [])
  assert.deepEqual(getUnlockedBotWalletIds(wallets, 3), ['wallet-model-1', 'wallet-model-2', 'wallet-model-3'])
  assert.equal(getUnlockedBotWalletIds(wallets, 9).length, 9, 'all 9 unlocked at the full count')
  assert.equal(getUnlockedBotWalletIds(wallets, 50).length, 9, 'capping past the sellable count is a no-op')
  assert.equal(getUnlockedBotWalletIds(wallets, Infinity).length, 9, 'Infinity (admin) unlocks everything sellable')
})

test('applyBotSlotLocks marks only the sellable wallets beyond the slot count as locked', () => {
  const locked = applyBotSlotLocks(buildDefaultWallets(), 2)
  const byId = Object.fromEntries(locked.map((wallet) => [wallet.id, wallet]))

  assert.equal(byId['wallet-model-1'].locked, false)
  assert.equal(byId['wallet-model-2'].locked, false)
  assert.equal(byId['wallet-model-3'].locked, true)
  assert.equal(byId['wallet-model-9'].locked, true)
  // Bot 10 (separate environment), the hidden LLM bots 11-15, and the MAIN-kind wallets are
  // never part of the sellable slot pool - always unlocked regardless of botSlots.
  assert.equal(byId['wallet-model-10'].locked, false)
  assert.equal(byId['wallet-model-11'].locked, false)
  assert.equal(byId['wallet-main'].locked, false)
  assert.equal(byId['wallet-real-money'].locked, false)
})

test('applyBotSlotLocks with Infinity (the admin exemption) locks nothing', () => {
  const locked = applyBotSlotLocks(buildDefaultWallets(), Infinity)
  assert.ok(locked.every((wallet) => wallet.locked === false))
})

test('applyBotSlotLocks with 0 slots locks every sellable wallet, none of the rest', () => {
  const locked = applyBotSlotLocks(buildDefaultWallets(), 0)
  const sellableIds = new Set(visibleTradingWallets(buildDefaultWallets()).map((wallet) => wallet.id))
  for (const wallet of locked) {
    assert.equal(wallet.locked, sellableIds.has(wallet.id))
  }
})

test('applyBotSlotLocks does not mutate wallet enabled/other fields - only adds locked', () => {
  const original = buildDefaultWallets()
  const locked = applyBotSlotLocks(original, 1)
  const originalWallet2 = original.find((wallet) => wallet.id === 'wallet-model-2')
  const lockedWallet2 = locked.find((wallet) => wallet.id === 'wallet-model-2')
  assert.equal(lockedWallet2.enabled, originalWallet2.enabled)
  assert.equal(lockedWallet2.locked, true)
})

// ---- SaaS Phase 5 (Signals Marketplace): ownedSignalIds is an additive unlock path -------

test('getUnlockedBotWalletIds: owning a signal unlocks its wallet regardless of position, on top of the slot count', () => {
  const wallets = buildDefaultWallets()
  const unlocked = getUnlockedBotWalletIds(wallets, 1, ['model-7'])
  assert.ok(unlocked.includes('wallet-model-1'), 'still unlocked by the slot count')
  assert.ok(unlocked.includes('wallet-model-7'), 'unlocked by owning its signal, despite being far past the slot count')
  assert.ok(!unlocked.includes('wallet-model-2'), 'not granted by either path')
})

test('getUnlockedBotWalletIds: owning a signal with zero slots still unlocks just that one wallet', () => {
  const wallets = buildDefaultWallets()
  const unlocked = getUnlockedBotWalletIds(wallets, 0, ['model-4'])
  assert.deepEqual(unlocked, ['wallet-model-4'])
})

test('getUnlockedBotWalletIds: no duplicate ids when both paths grant the same wallet', () => {
  const wallets = buildDefaultWallets()
  const unlocked = getUnlockedBotWalletIds(wallets, 3, ['model-1', 'model-2'])
  const counts = {}
  for (const id of unlocked) counts[id] = (counts[id] || 0) + 1
  assert.ok(Object.values(counts).every((count) => count === 1))
})

test('applyBotSlotLocks: ownedSignalIds unlocks the matching wallet even at botSlots 0', () => {
  const locked = applyBotSlotLocks(buildDefaultWallets(), 0, ['model-9'])
  const byId = Object.fromEntries(locked.map((wallet) => [wallet.id, wallet]))
  assert.equal(byId['wallet-model-9'].locked, false)
  assert.equal(byId['wallet-model-8'].locked, true)
})

test('getUnlockedBotWalletIds: an unrecognized/stale signal id in ownedSignalIds is simply a no-op, not an error', () => {
  const wallets = buildDefaultWallets()
  const unlocked = getUnlockedBotWalletIds(wallets, 0, ['model-99-does-not-exist'])
  assert.deepEqual(unlocked, [])
})

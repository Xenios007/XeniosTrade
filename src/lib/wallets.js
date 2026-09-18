import { summarizeAccount } from './accountMetrics.js'
import { getEffectiveSignalModelStrategy } from './signalModels.js'
import { DEFAULT_SIGNAL_MODEL_ID, ensureSignalModelId, getSignalModelName } from './signalModels.js'
import { STARTING_RUNNING_BALANCE_USDT } from './tradingConfig.js'

export const MANUAL_WALLET_BALANCE_MODE = 'MANUAL'
export const EXCHANGE_SYNC_WALLET_BALANCE_MODE = 'EXCHANGE_SYNC'
export const PHASE_1_WALLET_STAGE = 'PHASE_1'
export const PHASE_2_WALLET_STAGE = 'PHASE_2'
export const DEFAULT_WALLET_SYNC_PROVIDER = 'BINANCE_FUTURES'
export const REAL_MONEY_WALLET_SYNC_PROVIDER = 'BINANCE_FUTURES_LIVE'
export const MAIN_WALLET_KIND = 'MAIN'
export const BOT_WALLET_KIND = 'BOT'
export const MAIN_WALLET_ID = 'wallet-main'
// Testnet wallets run on Binance Futures Testnet demo funds. Real-money wallets
// are the live-funds counterpart, kept separate end to end (credentials, sync
// provider, journal) so no live order can ever be routed through a testnet
// wallet or vice versa.
export const TESTNET_WALLET_ENVIRONMENT = 'TESTNET'
export const REAL_MONEY_WALLET_ENVIRONMENT = 'REAL_MONEY'
export const DEFAULT_WALLET_ENVIRONMENT = TESTNET_WALLET_ENVIRONMENT
export const REAL_MONEY_WALLET_ID = 'wallet-real-money'
// 6000+ USDT Binance Futures Testnet demo funds split across the bot wallets.
export const DEFAULT_BOT_WALLET_COUNT = 11
export const DEFAULT_BOT_ALLOCATION_USDT = 750

const DEFAULT_WALLET_BLUEPRINTS = [
  {
    id: MAIN_WALLET_ID,
    kind: MAIN_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Main Wallet',
    colorKey: 'slate',
    balanceMode: EXCHANGE_SYNC_WALLET_BALANCE_MODE,
    manualBalance: DEFAULT_BOT_ALLOCATION_USDT * DEFAULT_BOT_WALLET_COUNT,
  },
  {
    id: 'wallet-model-1',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 1',
    assignedSignalModelId: 'model-1',
    colorKey: 'sky',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-2',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 2',
    assignedSignalModelId: 'model-2',
    colorKey: 'emerald',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-3',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 3',
    assignedSignalModelId: 'model-3',
    colorKey: 'amber',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-4',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 4',
    assignedSignalModelId: 'model-4',
    colorKey: 'rose',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-5',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 5',
    assignedSignalModelId: 'model-5',
    colorKey: 'violet',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-6',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 6',
    assignedSignalModelId: 'model-6',
    colorKey: 'cyan',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-7',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 7',
    assignedSignalModelId: 'model-7',
    colorKey: 'fuchsia',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-8',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 8',
    assignedSignalModelId: 'model-8',
    colorKey: 'lime',
    allocationBalance: DEFAULT_BOT_ALLOCATION_USDT,
  },
  {
    id: 'wallet-model-9',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 9 — Experimental',
    assignedSignalModelId: 'model-9',
    colorKey: 'orange',
    // A deliberately small forward-test allocation. This is a testnet ledger
    // allocation; exchange execution still uses the account's testnet balance.
    allocationBalance: 100,
  },
  {
    id: 'wallet-model-10',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 10 — Consolidated',
    assignedSignalModelId: 'model-10',
    colorKey: 'blue',
    allocationBalance: 100,
  },
  {
    id: 'wallet-model-11',
    kind: BOT_WALLET_KIND,
    environment: TESTNET_WALLET_ENVIRONMENT,
    name: 'Wallet 11 — Bot Claude',
    assignedSignalModelId: 'model-11',
    colorKey: 'teal',
    // Small forward-test allocation, same reasoning as Wallet 9: this is a
    // testnet ledger allocation, and every decision is a metered live LLM call.
    allocationBalance: 100,
  },
  {
    id: REAL_MONEY_WALLET_ID,
    kind: MAIN_WALLET_KIND,
    environment: REAL_MONEY_WALLET_ENVIRONMENT,
    name: 'Real Money Wallet',
    colorKey: 'crimson',
    balanceMode: EXCHANGE_SYNC_WALLET_BALANCE_MODE,
    manualBalance: 0,
  },
]

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function roundMoney(value) {
  return Number(toFiniteNumber(value).toFixed(2))
}

function normalizeWalletKind(kind) {
  return String(kind || BOT_WALLET_KIND).toUpperCase() === MAIN_WALLET_KIND
    ? MAIN_WALLET_KIND
    : BOT_WALLET_KIND
}

export function normalizeWalletBalanceMode(balanceMode) {
  return String(balanceMode || MANUAL_WALLET_BALANCE_MODE).toUpperCase() === EXCHANGE_SYNC_WALLET_BALANCE_MODE
    ? EXCHANGE_SYNC_WALLET_BALANCE_MODE
    : MANUAL_WALLET_BALANCE_MODE
}

export function normalizeWalletEnvironment(environment) {
  return String(environment || DEFAULT_WALLET_ENVIRONMENT).toUpperCase() === REAL_MONEY_WALLET_ENVIRONMENT
    ? REAL_MONEY_WALLET_ENVIRONMENT
    : TESTNET_WALLET_ENVIRONMENT
}

export function isMainWallet(wallet = {}) {
  return normalizeWalletKind(wallet.kind || (wallet.id === MAIN_WALLET_ID ? MAIN_WALLET_KIND : BOT_WALLET_KIND)) === MAIN_WALLET_KIND
}

export function isTradingWallet(wallet = {}) {
  return !isMainWallet(wallet)
}

export function isRealMoneyWallet(wallet = {}) {
  return normalizeWalletEnvironment(wallet.environment) === REAL_MONEY_WALLET_ENVIRONMENT
}

export function isTestnetWallet(wallet = {}) {
  return !isRealMoneyWallet(wallet)
}

export function isExchangeSyncWallet(wallet = {}) {
  return normalizeWalletBalanceMode(wallet.balanceMode) === EXCHANGE_SYNC_WALLET_BALANCE_MODE
}

export function normalizeWalletStage(stage, balanceMode = MANUAL_WALLET_BALANCE_MODE) {
  if (normalizeWalletBalanceMode(balanceMode) === EXCHANGE_SYNC_WALLET_BALANCE_MODE) {
    return PHASE_2_WALLET_STAGE
  }

  return String(stage || PHASE_1_WALLET_STAGE).toUpperCase() === PHASE_2_WALLET_STAGE
    ? PHASE_2_WALLET_STAGE
    : PHASE_1_WALLET_STAGE
}

export function getWalletAllocationBalance(wallet = {}) {
  if (isMainWallet(wallet)) {
    return 0
  }

  return roundMoney(toFiniteNumber(
    wallet.allocationBalance,
    wallet.manualBalance,
    DEFAULT_BOT_ALLOCATION_USDT,
  ))
}

export function getWalletFundingBalance(wallet = {}) {
  const fallbackManualBalance = roundMoney(toFiniteNumber(
    wallet.manualBalance,
    isMainWallet(wallet) ? DEFAULT_BOT_ALLOCATION_USDT * 3 : STARTING_RUNNING_BALANCE_USDT,
  ))

  if (!isExchangeSyncWallet(wallet)) {
    return fallbackManualBalance
  }

  if (wallet.production?.lastSyncedAvailableBalance != null) {
    return roundMoney(toFiniteNumber(wallet.production.lastSyncedAvailableBalance, fallbackManualBalance))
  }

  if (wallet.production?.lastSyncedBalance != null) {
    return roundMoney(toFiniteNumber(wallet.production.lastSyncedBalance, fallbackManualBalance))
  }

  return fallbackManualBalance
}

export function getWalletAllocationFundingBalance(wallet = {}) {
  const fallbackFundingBalance = getWalletFundingBalance(wallet)

  if (!isExchangeSyncWallet(wallet)) {
    return fallbackFundingBalance
  }

  if (wallet.production?.lastSyncedBalance != null) {
    return roundMoney(toFiniteNumber(wallet.production.lastSyncedBalance, fallbackFundingBalance))
  }

  return fallbackFundingBalance
}

export function createDefaultWallet(blueprint, overrides = {}) {
  const kind = normalizeWalletKind(overrides.kind || blueprint.kind)
  const environment = normalizeWalletEnvironment(overrides.environment || blueprint.environment)
  const balanceMode = normalizeWalletBalanceMode(
    overrides.balanceMode
    || blueprint.balanceMode
    || (kind === MAIN_WALLET_KIND ? EXCHANGE_SYNC_WALLET_BALANCE_MODE : MANUAL_WALLET_BALANCE_MODE),
  )
  const assignedSignalModelId = kind === MAIN_WALLET_KIND
    ? null
    : ensureSignalModelId(overrides.assignedSignalModelId || blueprint.assignedSignalModelId || DEFAULT_SIGNAL_MODEL_ID)
  const allocationBalance = getWalletAllocationBalance({
    ...blueprint,
    ...overrides,
    kind,
  })
  const defaultSyncProvider = environment === REAL_MONEY_WALLET_ENVIRONMENT
    ? REAL_MONEY_WALLET_SYNC_PROVIDER
    : DEFAULT_WALLET_SYNC_PROVIDER

  return {
    id: String(overrides.id || blueprint.id),
    kind,
    environment,
    name: String(overrides.name || blueprint.name),
    enabled: kind === MAIN_WALLET_KIND ? false : (overrides.enabled == null ? true : Boolean(overrides.enabled)),
    stage: normalizeWalletStage(overrides.stage, balanceMode),
    colorKey: String(overrides.colorKey || blueprint.colorKey || 'sky'),
    assignedSignalModelId,
    assignedSignalModelName: assignedSignalModelId ? getSignalModelName(assignedSignalModelId) : '',
    balanceMode,
    allocationBalance,
    manualBalance: roundMoney(toFiniteNumber(
      overrides.manualBalance,
      kind === MAIN_WALLET_KIND ? blueprint.manualBalance : allocationBalance,
    )),
    production: {
      syncProvider: String(overrides.production?.syncProvider || defaultSyncProvider),
      syncStatus: String(overrides.production?.syncStatus || 'NOT_CONNECTED'),
      lastSyncedBalance: overrides.production?.lastSyncedBalance == null
        ? null
        : roundMoney(toFiniteNumber(overrides.production.lastSyncedBalance)),
      lastSyncedAvailableBalance: overrides.production?.lastSyncedAvailableBalance == null
        ? null
        : roundMoney(toFiniteNumber(overrides.production.lastSyncedAvailableBalance)),
      lastSyncedUnrealizedPnl: overrides.production?.lastSyncedUnrealizedPnl == null
        ? null
        : roundMoney(toFiniteNumber(overrides.production.lastSyncedUnrealizedPnl)),
      lastOpenPositionCount: Number.isFinite(Number(overrides.production?.lastOpenPositionCount))
        ? Number(overrides.production.lastOpenPositionCount)
        : 0,
      lastSyncedAt: overrides.production?.lastSyncedAt ?? null,
      lastError: typeof overrides.production?.lastError === 'string'
        ? overrides.production.lastError
        : '',
      accountAlias: typeof overrides.production?.accountAlias === 'string'
        ? overrides.production.accountAlias
        : '',
    },
  }
}

function findMatchingWallet(blueprint, incomingWallets = []) {
  const exactMatch = incomingWallets.find((wallet) => String(wallet.id || '').trim() === blueprint.id)
  if (exactMatch) {
    return exactMatch
  }

  if (blueprint.kind === MAIN_WALLET_KIND) {
    const blueprintEnvironment = normalizeWalletEnvironment(blueprint.environment)
    return incomingWallets.find((wallet) => {
      const walletLooksLikeMain = normalizeWalletKind(wallet.kind || (wallet.id === MAIN_WALLET_ID ? MAIN_WALLET_KIND : BOT_WALLET_KIND)) === MAIN_WALLET_KIND
        || (isExchangeSyncWallet(wallet) && !wallet.assignedSignalModelId)
      // A wallet with no environment tag at all is legacy data — only ever the
      // original testnet main wallet, so treat "untagged" as testnet. This
      // keeps the new real-money blueprint from adopting the existing main
      // wallet's id/balance the first time it's synthesized.
      return walletLooksLikeMain && normalizeWalletEnvironment(wallet.environment) === blueprintEnvironment
    }) || null
  }

  const assignedMatch = incomingWallets.find((wallet) => (
    normalizeWalletKind(wallet.kind) === BOT_WALLET_KIND
    && String(wallet.assignedSignalModelId || '').trim() === blueprint.assignedSignalModelId
  ))
  if (assignedMatch) {
    return assignedMatch
  }

  return incomingWallets.find((wallet) => (
    String(wallet.name || '').trim().toLowerCase() === String(blueprint.name).toLowerCase()
  )) || null
}

export function buildDefaultWallets() {
  return DEFAULT_WALLET_BLUEPRINTS.map((blueprint) => createDefaultWallet(blueprint))
}

export function normalizeWallets(rawWallets = []) {
  const incomingWallets = Array.isArray(rawWallets)
    ? rawWallets.filter((wallet) => wallet && typeof wallet === 'object')
    : []

  const normalizedDefaults = DEFAULT_WALLET_BLUEPRINTS.map((blueprint) => (
    createDefaultWallet(blueprint, findMatchingWallet(blueprint, incomingWallets) || {})
  ))

  const knownIds = new Set(normalizedDefaults.map((wallet) => wallet.id))
  const extraWallets = incomingWallets
    .filter((wallet) => {
      const walletId = String(wallet.id || '').trim()
      return walletId && !knownIds.has(walletId)
    })
    .map((wallet, index) => createDefaultWallet({
      id: String(wallet.id || `wallet-extra-${index + 1}`),
      kind: normalizeWalletKind(wallet.kind),
      name: String(wallet.name || `Wallet ${normalizedDefaults.length + index + 1}`),
      assignedSignalModelId: wallet.assignedSignalModelId || DEFAULT_SIGNAL_MODEL_ID,
      colorKey: wallet.colorKey || 'slate',
      allocationBalance: wallet.allocationBalance ?? wallet.manualBalance ?? DEFAULT_BOT_ALLOCATION_USDT,
      manualBalance: wallet.manualBalance ?? DEFAULT_BOT_ALLOCATION_USDT,
    }, wallet))

  return [...normalizedDefaults, ...extraWallets].map((wallet) => {
    if (isMainWallet(wallet)) {
      return {
        ...wallet,
        enabled: false,
        balanceMode: EXCHANGE_SYNC_WALLET_BALANCE_MODE,
        stage: PHASE_2_WALLET_STAGE,
      }
    }

    return wallet
  })
}

export function getWalletById(walletId, wallets = []) {
  const normalizedWallets = normalizeWallets(wallets)
  return normalizedWallets.find((wallet) => wallet.id === walletId) || null
}

export function getMainWallet(wallets = [], environment = TESTNET_WALLET_ENVIRONMENT) {
  const targetEnvironment = normalizeWalletEnvironment(environment)
  return normalizeWallets(wallets).find((wallet) => (
    isMainWallet(wallet) && normalizeWalletEnvironment(wallet.environment) === targetEnvironment
  )) || null
}

export function getRealMoneyWallet(wallets = []) {
  return getMainWallet(wallets, REAL_MONEY_WALLET_ENVIRONMENT)
}

export function getTradingWallets(wallets = []) {
  return normalizeWallets(wallets).filter((wallet) => isTradingWallet(wallet))
}

export function getWalletEffectiveStartingBalance(wallet = {}) {
  if (isMainWallet(wallet)) {
    return getWalletFundingBalance(wallet)
  }

  return getWalletAllocationBalance(wallet)
}

export function getMainWalletAllocatedBalance(wallets = []) {
  return roundMoney(
    getTradingWallets(wallets).reduce((sum, wallet) => sum + getWalletAllocationBalance(wallet), 0),
  )
}

export function getMainWalletAvailableAllocation(wallets = []) {
  const mainWallet = getMainWallet(wallets)
  const fundingBalance = getWalletAllocationFundingBalance(mainWallet || {})
  return roundMoney(fundingBalance - getMainWalletAllocatedBalance(wallets))
}

export function getTotalWalletStartingBalance(wallets = []) {
  return roundMoney(
    getTradingWallets(wallets).reduce((sum, wallet) => sum + getWalletEffectiveStartingBalance(wallet), 0),
  )
}

export function inferWalletIdFromTrade(trade, wallets = []) {
  // An explicit walletId pointing at a MAIN-kind wallet (the testnet Main
  // Wallet or the Real Money Wallet) must be honored as-is. Checking it only
  // against getTradingWallets() (bot wallets) below would silently reassign
  // every real-money trade to its bot's testnet reference wallet on the next
  // read/hydrate pass - which breaks that wallet's own open-position/daily
  // risk caps (they filter trade history by exact walletId match).
  const allWallets = normalizeWallets(wallets)
  const explicitWalletId = String(trade?.walletId || '').trim()
  if (explicitWalletId && allWallets.some((wallet) => wallet.id === explicitWalletId)) {
    return explicitWalletId
  }

  const normalizedWallets = getTradingWallets(wallets)
  if (normalizedWallets.length === 0) {
    return null
  }

  const signalModelId = String(trade?.signalModelId || '').trim()
  if (signalModelId) {
    const assignedWallet = normalizedWallets.find((wallet) => wallet.assignedSignalModelId === ensureSignalModelId(signalModelId))
    if (assignedWallet) {
      return assignedWallet.id
    }
  }

  return normalizedWallets[0].id
}

export function hydrateWalletMetadata(record, wallets = []) {
  if (!record || typeof record !== 'object') {
    return record
  }

  const walletId = inferWalletIdFromTrade(record, wallets)
  if (!walletId) {
    return record
  }

  const wallet = getWalletById(walletId, wallets)
  let nextRecord = record

  if (nextRecord.walletId !== walletId) {
    nextRecord = {
      ...nextRecord,
      walletId,
    }
  }

  if (wallet?.name && nextRecord.walletName !== wallet.name) {
    nextRecord = {
      ...nextRecord,
      walletName: wallet.name,
    }
  }

  if (wallet?.colorKey && nextRecord.walletColorKey !== wallet.colorKey) {
    nextRecord = {
      ...nextRecord,
      walletColorKey: wallet.colorKey,
    }
  }

  return nextRecord
}


export function buildWalletPerformanceSnapshots({
  wallets = [],
  trades = [],
  livePrices = {},
  strategy = {},
} = {}) {
  return getTradingWallets(wallets).map((wallet) => {
    const walletTrades = trades.filter((trade) => trade.walletId === wallet.id)
    const baseAccountSnapshot = summarizeAccount({
      trades: walletTrades,
      livePrices,
      strategy,
      startingBalance: getWalletEffectiveStartingBalance(wallet),
    })
    const effectiveStrategy = getEffectiveSignalModelStrategy(strategy, wallet.assignedSignalModelId, {
      runningBalance: baseAccountSnapshot.runningBalance,
    })
    const accountSnapshot = summarizeAccount({
      trades: walletTrades,
      livePrices,
      strategy: effectiveStrategy,
      startingBalance: getWalletEffectiveStartingBalance(wallet),
    })
    const closedTrades = Number(accountSnapshot.closedTradeCount || 0)
    const realizedPnl = Number(accountSnapshot.realizedPnl || 0)
    const winRate = closedTrades > 0
      ? Number(accountSnapshot.wins || 0) / closedTrades
      : 0

    return {
      wallet,
      walletTrades,
      accountSnapshot,
      effectiveStrategy,
      closedTrades,
      realizedPnl,
      winRate,
      isProfitable: realizedPnl > 0,
    }
  })
}

export function selectPhase3ChampionWallet(performanceSnapshots = [], { minClosedTrades = 20 } = {}) {
  const ranked = [...performanceSnapshots].sort((left, right) => (
    right.realizedPnl - left.realizedPnl
    || right.winRate - left.winRate
    || right.closedTrades - left.closedTrades
  ))

  const eligible = ranked.find((item) => item.realizedPnl > 0 && item.closedTrades >= minClosedTrades)
  return eligible || ranked[0] || null
}

export function buildPhase3ChampionAllocation({
  wallets = [],
  trades = [],
  livePrices = {},
  strategy = {},
  minClosedTrades = 20,
} = {}) {
  const normalizedWallets = normalizeWallets(wallets)
  const mainWallet = getMainWallet(normalizedWallets)
  const fundingBalance = roundMoney(getWalletAllocationFundingBalance(mainWallet || {}))
  const performanceSnapshots = buildWalletPerformanceSnapshots({
    wallets: normalizedWallets,
    trades,
    livePrices,
    strategy,
  })
  const champion = selectPhase3ChampionWallet(performanceSnapshots, { minClosedTrades })

  if (!champion) {
    return {
      champion: null,
      fundingBalance,
      wallets: normalizedWallets,
      snapshots: performanceSnapshots,
    }
  }

  const nextWallets = normalizedWallets.map((wallet) => {
    if (isMainWallet(wallet)) {
      return wallet
    }

    const isChampion = wallet.id === champion.wallet.id
    return {
      ...wallet,
      enabled: isChampion,
      allocationBalance: isChampion ? fundingBalance : 0,
      manualBalance: isChampion ? fundingBalance : 0,
    }
  })

  return {
    champion,
    fundingBalance,
    wallets: normalizeWallets(nextWallets),
    snapshots: performanceSnapshots,
  }
}

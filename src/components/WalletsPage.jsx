import { Activity, Bot, CircleAlert, Plus, RefreshCcw, ShieldAlert, WalletCards } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { roundMoney, summarizeAccount } from '../lib/accountMetrics'
import { evaluateAutoTradeReadiness } from '../lib/autoTradeReadiness'
import { getEffectiveSignalModelStrategy, getSignalModel } from '../lib/signalModels'
import {
  getMainWallet,
  getUnlockedBotWalletIds,
  getRealMoneyWallet,
  visibleTradingWallets,
  getWalletAllocationFundingBalance,
  getWalletAllocationBalance,
  getWalletEffectiveStartingBalance,
  getWalletFundingBalance,
  isExchangeSyncWallet,
  normalizeWallets,
  REAL_MONEY_WALLET_ENVIRONMENT,
  TESTNET_WALLET_ENVIRONMENT,
} from '../lib/wallets'
import { Panel } from './Panel'

function formatUsdt(value, withSign = false) {
  const number = Number(value || 0)
  const sign = withSign && number > 0 ? '+' : ''
  return `${sign}${number.toFixed(2)} USDT`
}

function formatSyncTime(timestamp) {
  if (!timestamp) {
    return 'Not synced yet'
  }

  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(timestamp)
  } catch {
    return 'Not synced yet'
  }
}

function getSyncStatusMeta(syncStatus) {
  const status = String(syncStatus || 'NOT_CONNECTED').toUpperCase()

  if (status === 'CONNECTED') {
    return { label: 'Connected', tone: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200', dot: 'bg-emerald-400' }
  }

  if (status === 'ERROR') {
    return { label: 'Sync error', tone: 'border-rose-400/25 bg-rose-400/10 text-rose-200', dot: 'bg-rose-400' }
  }

  if (status === 'MISSING_CREDENTIALS') {
    return { label: 'API keys missing', tone: 'border-rose-400/25 bg-rose-400/10 text-rose-200', dot: 'bg-rose-400' }
  }

  return { label: 'Not synced', tone: 'border-amber-400/25 bg-amber-400/10 text-amber-200', dot: 'bg-amber-400' }
}

// One plain-language line about the exchange connection - replaces the three-paragraph
// "guardrail" cards; the sync status pill carries the state, this just says what to do next.
function describeConnection(wallet, hasCredentials, environmentLabel) {
  if (!wallet || !isExchangeSyncWallet(wallet)) {
    return `The ${environmentLabel} account isn't set up yet - press Save wallets once to create it.`
  }
  if (!hasCredentials || wallet.production.syncStatus === 'MISSING_CREDENTIALS') {
    return `Add your Binance Futures ${environmentLabel} API key and secret in Settings > API Credentials, then press Sync.`
  }
  if (wallet.production.syncStatus === 'ERROR') {
    return wallet.production.lastError || `The last ${environmentLabel} sync failed - check your keys and sync again.`
  }
  if (wallet.production.syncStatus !== 'CONNECTED') {
    return 'Keys are saved. Press Sync to read your balance from Binance.'
  }
  return 'Balances below are read from your Binance account. Keep the app online so they stay current.'
}

function Metric({ label, value, tone = 'text-white', hint = null }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className={`mt-1.5 text-lg font-semibold ${tone}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  )
}

// The Binance account itself - one card for the environment, mirroring what you'd see on the
// exchange (wallet balance, available margin, unrealized PnL, open positions). Bots are funded
// out of this balance in the allocation table below.
function ExchangeAccountPanel({
  wallet,
  environment,
  hasCredentials,
  onUpdateWallet,
  onSyncWallet,
  syncing,
}) {
  const isLive = environment === REAL_MONEY_WALLET_ENVIRONMENT
  const environmentLabel = isLive ? 'Live' : 'Testnet'
  const status = getSyncStatusMeta(wallet?.production?.syncStatus)
  const production = wallet?.production || {}
  const synced = production.lastSyncedBalance != null
  const fundingBalance = wallet ? getWalletFundingBalance(wallet) : 0

  return (
    <div className={`rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.22)] ${isLive ? 'border-red-400/25 bg-red-400/[0.04]' : 'border-white/10 bg-white/[0.03]'}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-amber-300/25 bg-amber-300/10 text-amber-200">
            <WalletCards className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-base font-semibold text-white">Binance Futures</div>
              <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${isLive ? 'border-red-400/30 bg-red-400/10 text-red-100' : 'border-sky-400/25 bg-sky-400/10 text-sky-100'}`}>
                {environmentLabel}
              </span>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${status.tone}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </span>
            </div>
            <div className="mt-1 text-xs text-slate-400">
              {production.syncProvider || `Binance Futures ${environmentLabel}`} - last synced {formatSyncTime(production.lastSyncedAt)}
            </div>
          </div>
        </div>

        {wallet ? (
          <button
            type="button"
            disabled={syncing}
            onClick={() => onSyncWallet(wallet.id)}
            className="inline-flex items-center gap-2 rounded-2xl bg-sky-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            <RefreshCcw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync'}
          </button>
        ) : null}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Wallet balance"
          value={synced ? formatUsdt(production.lastSyncedBalance) : formatUsdt(fundingBalance)}
          hint={synced ? 'From Binance' : 'Manual figure - not synced'}
        />
        <Metric
          label="Available balance"
          value={production.lastSyncedAvailableBalance == null ? '-' : formatUsdt(production.lastSyncedAvailableBalance)}
          tone="text-emerald-300"
          hint="Free margin on Binance"
        />
        <Metric
          label="Unrealized PnL"
          value={production.lastSyncedUnrealizedPnl == null ? '-' : formatUsdt(production.lastSyncedUnrealizedPnl, true)}
          tone={Number(production.lastSyncedUnrealizedPnl) > 0 ? 'text-emerald-300' : Number(production.lastSyncedUnrealizedPnl) < 0 ? 'text-rose-300' : 'text-white'}
        />
        <Metric label="Open positions" value={`${production.lastOpenPositionCount || 0}`} hint="On the exchange" />
      </div>

      <div className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-slate-400">
        {status.label === 'Connected' ? <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" /> : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />}
        <span>{describeConnection(wallet, hasCredentials, environmentLabel)}</span>
      </div>

      {production.lastError && production.syncStatus !== 'ERROR' ? (
        <div className="mt-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-100">{production.lastError}</div>
      ) : null}

      {isLive ? (
        <div className="mt-4 rounded-2xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-xs leading-relaxed text-red-100">
          This is your real-money account. Syncing only reads your balance - no bot places live orders from this page.
          Going live is a separate, deliberate step on the Real Money Trading page.
        </div>
      ) : wallet && !synced ? (
        <label className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-400">
          Manual balance until Binance syncs
          <input
            type="number"
            min="0"
            step="0.01"
            value={wallet.manualBalance}
            onChange={(event) => onUpdateWallet(wallet.id, { manualBalance: Number(event.target.value) })}
            className="w-36 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none"
          />
          USDT
        </label>
      ) : null}
    </div>
  )
}

// One funded bot. Premade bots draw on a wallet (the allocation lives on the wallet); custom bots
// keep their allocation on the bot itself. Both render through this row so the table reads the same.
function StatLine({ label, value, tone = 'text-slate-100' }) {
  return (
    <div className="flex justify-between gap-2"><span className="text-slate-500">{label}</span><span className={`font-semibold ${tone}`}>{value}</span></div>
  )
}

function AllocationRow({ title, subtitle, caption, dotTone, dotTitle, allocation, fundingBalance, onChange, stats, statusControl }) {
  const share = fundingBalance > 0 ? Math.min(100, (allocation / fundingBalance) * 100) : 0
  const sliderMax = Math.max(fundingBalance, allocation, 1)

  return (
    <div className="grid items-center gap-x-4 gap-y-3 border-b border-white/5 px-4 py-4 last:border-b-0 md:grid-cols-[minmax(150px,1.1fr)_minmax(240px,1.8fr)_minmax(150px,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotTone}`} title={dotTitle} />
          <div className="truncate text-sm font-semibold text-white">{title}</div>
        </div>
        <div className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</div>
        {caption ? <div className="mt-0.5 text-[11px] text-slate-600">{caption}</div> : null}
      </div>

      <div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            value={allocation}
            onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
            aria-label={`${title} allocation in USDT`}
            className="w-28 rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm font-semibold text-white outline-none focus:border-sky-400/40"
          />
          <span className="text-xs text-slate-500">USDT</span>
          <span className="ml-auto text-xs font-semibold text-slate-300">{share.toFixed(0)}%</span>
        </div>
        <input
          type="range"
          min="0"
          max={sliderMax}
          step="1"
          value={Math.min(allocation, sliderMax)}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={`${title} allocation slider`}
          className="mt-2 h-1.5 w-full cursor-pointer accent-sky-400"
        />
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs md:grid-cols-1 md:gap-1">
        {stats}
      </div>

      {statusControl}
    </div>
  )
}

export function WalletsPage({
  settings,
  trades = [],
  livePrices = {},
  onSave,
  onSyncWallet,
  syncingWalletId = '',
  saving,
  ready = true,
  isAdmin = false,
  onRefresh,
}) {
  const [walletForm, setWalletForm] = useState(normalizeWallets(settings.wallets))
  const controlsDisabled = saving || !ready
  // Custom bots keep their allocation on the bot itself (saved through /api/custom-bots), so it is
  // edited here as an id -> amount map and written back on Save.
  const savedCustomBots = useMemo(() => settings.customBots || [], [settings.customBots])
  const [customAllocations, setCustomAllocations] = useState({})

  useEffect(() => {
    setWalletForm(normalizeWallets(settings.wallets))
  }, [settings.wallets])

  useEffect(() => {
    setCustomAllocations(Object.fromEntries(savedCustomBots.map((bot) => [bot.id, bot.allocationBalance || 0])))
  }, [savedCustomBots])

  // A regular user's custom bots must sit in a slot; the admin has none, so all of theirs count.
  const slottedCustomBotIds = useMemo(() => new Set((settings.botSlotList || []).map((slot) => slot.assignment)), [settings.botSlotList])
  const customBotRows = useMemo(
    () => savedCustomBots.filter((bot) => isAdmin || slottedCustomBotIds.has(bot.id)),
    [isAdmin, savedCustomBots, slottedCustomBotIds],
  )

  const normalizedWalletForm = useMemo(
    () => normalizeWallets(walletForm),
    [walletForm],
  )
  // Bot-slot entitlements: the server sends the position-unlock cap as settings.botSlots (null =
  // unlimited, the admin) and the owned/slotted bot ids as settings.ownedSignalIds. `locked`
  // itself doesn't survive normalizeWallets, so it's recomputed here with the same shared helper
  // the server uses.
  const botSlots = Number.isFinite(settings.botSlots) ? settings.botSlots : Infinity
  const ownedSignalIds = Array.isArray(settings.ownedSignalIds) ? settings.ownedSignalIds : []
  const ownedSignalKey = ownedSignalIds.join(',')
  const unlockedWalletIds = useMemo(
    () => new Set(getUnlockedBotWalletIds(normalizedWalletForm, botSlots, ownedSignalKey ? ownedSignalKey.split(',') : [])),
    [normalizedWalletForm, botSlots, ownedSignalKey],
  )
  const emptySlotCount = (settings.botSlotList || []).filter((slot) => !slot.assignment).length
  const [activeEnvironment, setActiveEnvironment] = useState(TESTNET_WALLET_ENVIRONMENT)
  const hasExchangeCredentials = Boolean(
    settings.credentials?.apiKey?.present
    && settings.credentials?.secretKey?.present,
  ) || Boolean(settings.apiKey && settings.secretKey)
  const hasLiveExchangeCredentials = Boolean(
    settings.credentials?.liveApiKey?.present
    && settings.credentials?.liveSecretKey?.present,
  ) || Boolean(settings.liveApiKey && settings.liveSecretKey)
  const mainWallet = useMemo(
    () => getMainWallet(normalizedWalletForm),
    [normalizedWalletForm],
  )
  const realMoneyWallet = useMemo(
    () => getRealMoneyWallet(normalizedWalletForm),
    [normalizedWalletForm],
  )

  // Only the bots the account actually owns get a row - locked wallets never render.
  const walletViews = useMemo(() => (
    visibleTradingWallets(normalizedWalletForm).filter((wallet) => unlockedWalletIds.has(wallet.id)).map((wallet) => {
      const walletTrades = trades.filter((trade) => trade.walletId === wallet.id)
      const baseAccountSnapshot = summarizeAccount({
        trades: walletTrades,
        livePrices,
        strategy: settings.strategy,
        startingBalance: getWalletEffectiveStartingBalance(wallet),
      })
      const effectiveStrategy = getEffectiveSignalModelStrategy(settings.strategy, wallet.assignedSignalModelId, {
        runningBalance: baseAccountSnapshot.runningBalance,
      })
      const accountSnapshot = summarizeAccount({
        trades: walletTrades,
        livePrices,
        strategy: effectiveStrategy,
        startingBalance: getWalletEffectiveStartingBalance(wallet),
      })
      const readiness = evaluateAutoTradeReadiness({
        strategy: effectiveStrategy,
        trades: walletTrades,
        accountSnapshot,
        signalModelId: wallet.assignedSignalModelId,
      })

      return { wallet, walletTrades, accountSnapshot, readiness }
    })
  ), [livePrices, normalizedWalletForm, unlockedWalletIds, settings.strategy, trades])

  // Allocation math only counts the bots on screen, so bots you don't own (and their default
  // allocations) never eat into your balance.
  const allocation = useMemo(() => {
    const fundingBalance = roundMoney(getWalletAllocationFundingBalance(mainWallet || {}))
    const allocated = roundMoney(
      walletViews.reduce((sum, view) => sum + getWalletAllocationBalance(view.wallet), 0)
      + customBotRows.reduce((sum, bot) => sum + (customAllocations[bot.id] || 0), 0),
    )
    return {
      fundingBalance,
      allocated,
      unallocated: roundMoney(fundingBalance - allocated),
      totalRunningBalance: walletViews.reduce((sum, view) => sum + view.accountSnapshot.runningBalance, 0),
      totalRealizedPnl: walletViews.reduce((sum, view) => sum + view.accountSnapshot.realizedPnl, 0),
    }
  }, [customAllocations, customBotRows, mainWallet, walletViews])

  const changedCustomBots = customBotRows.filter((bot) => (customAllocations[bot.id] || 0) !== (bot.allocationBalance || 0))
  const walletsChanged = useMemo(
    () => JSON.stringify(normalizedWalletForm) !== JSON.stringify(normalizeWallets(settings.wallets)),
    [normalizedWalletForm, settings.wallets],
  )
  const dirty = walletsChanged || changedCustomBots.length > 0

  function updateWallet(walletId, updates) {
    setWalletForm((current) => normalizeWallets(current.map((wallet) => {
      if (wallet.id !== walletId) {
        return wallet
      }

      return {
        ...wallet,
        ...updates,
        production: {
          ...wallet.production,
          ...(updates.production || {}),
        },
      }
    })))
  }

  function setAllocations(amountFor) {
    const ids = new Set(walletViews.map((view) => view.wallet.id))
    setWalletForm((current) => normalizeWallets(current.map((wallet) => {
      if (!ids.has(wallet.id)) {
        return wallet
      }
      const next = amountFor(wallet)
      return { ...wallet, allocationBalance: next, manualBalance: next }
    })))
    setCustomAllocations((current) => ({
      ...current,
      ...Object.fromEntries(customBotRows.map((bot) => [bot.id, amountFor(bot)])),
    }))
  }

  function splitEvenly() {
    const rowCount = walletViews.length + customBotRows.length
    const each = rowCount > 0 ? Math.floor((allocation.fundingBalance / rowCount) * 100) / 100 : 0
    setAllocations(() => each)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (controlsDisabled) {
      return
    }

    if (walletsChanged) {
      await onSave({
        wallets: normalizeWallets(walletForm),
      })
    }

    if (changedCustomBots.length > 0) {
      await Promise.all(changedCustomBots.map((bot) => fetch(`/api/custom-bots/${encodeURIComponent(bot.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allocationBalance: customAllocations[bot.id] || 0 }),
      })))
      await onRefresh?.()
    }
  }

  const over = allocation.unallocated < 0
  const usedPercent = allocation.fundingBalance > 0 ? Math.min(100, (allocation.allocated / allocation.fundingBalance) * 100) : 0

  return (
    <form className="grid gap-6" onSubmit={handleSubmit}>
      {!ready ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
          Waiting for the saved settings to load from the backend. Saving is disabled until the current wallet snapshot is available.
        </div>
      ) : null}

      <div className="inline-flex w-fit gap-1 rounded-2xl border border-white/10 bg-slate-950/60 p-1.5">
        <button
          type="button"
          onClick={() => setActiveEnvironment(TESTNET_WALLET_ENVIRONMENT)}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
            activeEnvironment === TESTNET_WALLET_ENVIRONMENT ? 'bg-sky-400 text-slate-950' : 'text-slate-300 hover:bg-white/[0.05]'
          }`}
        >
          Testnet
        </button>
        <button
          type="button"
          onClick={() => setActiveEnvironment(REAL_MONEY_WALLET_ENVIRONMENT)}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
            activeEnvironment === REAL_MONEY_WALLET_ENVIRONMENT ? 'bg-red-400 text-slate-950' : 'text-slate-300 hover:bg-white/[0.05]'
          }`}
        >
          Live (real money)
        </button>
      </div>

      <fieldset disabled={controlsDisabled} className="contents">
      {activeEnvironment === REAL_MONEY_WALLET_ENVIRONMENT ? (
        <ExchangeAccountPanel
          wallet={realMoneyWallet}
          environment={REAL_MONEY_WALLET_ENVIRONMENT}
          hasCredentials={hasLiveExchangeCredentials}
          onUpdateWallet={updateWallet}
          onSyncWallet={onSyncWallet}
          syncing={Boolean(realMoneyWallet) && syncingWalletId === realMoneyWallet.id}
        />
      ) : (
        <>
          {mainWallet ? (
            <ExchangeAccountPanel
              wallet={mainWallet}
              environment={TESTNET_WALLET_ENVIRONMENT}
              hasCredentials={hasExchangeCredentials}
              onUpdateWallet={updateWallet}
              onSyncWallet={onSyncWallet}
              syncing={syncingWalletId === mainWallet.id}
            />
          ) : null}

          <Panel
            title="Bot allocation"
            action={walletViews.length + customBotRows.length > 0 ? (
              <div className="flex items-center gap-2">
                <button type="button" onClick={splitEvenly} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08]">
                  Split evenly
                </button>
                <button type="button" onClick={() => setAllocations(() => 0)} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-white/[0.08]">
                  Clear
                </button>
              </div>
            ) : null}
          >
            <p className="text-sm text-slate-400">
              Choose how much of your Binance Testnet balance each bot may trade with. A bot only ever risks its own allocation.
            </p>

            <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Allocated</div>
                  <div className="mt-1 text-lg font-semibold text-white">
                    {formatUsdt(allocation.allocated)} <span className="text-sm font-normal text-slate-500">of {formatUsdt(allocation.fundingBalance)}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-[0.2em] text-slate-500">{over ? 'Over-allocated by' : 'Unallocated'}</div>
                  <div className={`mt-1 text-lg font-semibold ${over ? 'text-rose-300' : 'text-emerald-300'}`}>{formatUsdt(Math.abs(allocation.unallocated))}</div>
                </div>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                <div className={`h-full rounded-full transition-all ${over ? 'bg-rose-400' : 'bg-sky-400'}`} style={{ width: `${usedPercent}%` }} />
              </div>
              {over ? (
                <div className="mt-3 flex items-start gap-2 text-xs text-rose-200">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Your allocations add up to more than the balance on Binance. Lower some of them or fund the account first.
                </div>
              ) : null}
            </div>

            {walletViews.length + customBotRows.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center text-sm text-slate-400">
                <Bot className="mx-auto mb-2 h-5 w-5 text-slate-500" />
                You don't have an active bot to fund yet.{' '}
                <Link to="/bot-creation" className="font-semibold text-sky-300 hover:underline">Set one up in Bot Creation</Link>.
              </div>
            ) : (
              <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
                <div className="hidden grid-cols-[minmax(150px,1.1fr)_minmax(240px,1.8fr)_minmax(150px,1fr)_auto] gap-x-4 border-b border-white/10 bg-slate-950/50 px-4 py-2.5 text-[10px] uppercase tracking-[0.2em] text-slate-500 md:grid">
                  <div>Bot</div>
                  <div>Allocation</div>
                  <div>Performance</div>
                  <div className="text-right">Status</div>
                </div>
                {walletViews.map((view) => {
                  const { wallet, accountSnapshot, readiness } = view
                  const model = getSignalModel(wallet.assignedSignalModelId)
                  const pnl = accountSnapshot.realizedPnl
                  return (
                    <AllocationRow
                      key={wallet.id}
                      title={model.name}
                      subtitle={model.tag}
                      caption={wallet.name}
                      dotTone={readiness.status === 'ready' ? 'bg-emerald-400' : 'bg-amber-400'}
                      dotTitle={readiness.reason || readiness.headline}
                      allocation={getWalletAllocationBalance(wallet)}
                      fundingBalance={allocation.fundingBalance}
                      onChange={(next) => updateWallet(wallet.id, { allocationBalance: next, manualBalance: next })}
                      stats={(
                        <>
                          <StatLine label="Balance" value={formatUsdt(accountSnapshot.runningBalance)} />
                          <StatLine label="Realized" value={formatUsdt(pnl, true)} tone={pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-rose-300' : 'text-slate-100'} />
                          <StatLine label="Open" value={accountSnapshot.openTradeCount} />
                        </>
                      )}
                      statusControl={(
                        <button
                          type="button"
                          onClick={() => updateWallet(wallet.id, { enabled: !wallet.enabled })}
                          className={`justify-self-start rounded-xl px-3 py-2 text-xs font-semibold transition md:justify-self-end ${
                            wallet.enabled
                              ? 'bg-emerald-400/15 text-emerald-100 ring-1 ring-emerald-400/30'
                              : 'bg-white/[0.04] text-slate-300 ring-1 ring-white/10 hover:bg-white/[0.08]'
                          }`}
                        >
                          {wallet.enabled ? 'Trading' : 'Paused'}
                        </button>
                      )}
                    />
                  )
                })}
                {customBotRows.map((bot) => (
                  <AllocationRow
                    key={bot.id}
                    title={bot.name}
                    subtitle="Custom bot"
                    caption={bot.enabled ? 'Deployed' : 'Draft'}
                    dotTone="bg-violet-400"
                    allocation={customAllocations[bot.id] || 0}
                    fundingBalance={allocation.fundingBalance}
                    onChange={(next) => setCustomAllocations((current) => ({ ...current, [bot.id]: next }))}
                    stats={<div className="col-span-3 text-slate-500 md:col-span-1">Reserved - live trading for custom bots isn't switched on yet.</div>}
                    statusControl={(
                      <Link
                        to={`/bot-creation?bot=${encodeURIComponent(bot.id)}`}
                        className="justify-self-start rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-xs font-semibold text-violet-100 transition hover:bg-violet-400/20 md:justify-self-end"
                      >
                        Edit bot
                      </Link>
                    )}
                  />
                ))}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-slate-950/50 px-4 py-3 text-xs text-slate-400">
                  <span>{walletViews.length + customBotRows.length} bot{walletViews.length + customBotRows.length === 1 ? '' : 's'} listed</span>
                  <span>
                    Running balance <span className="font-semibold text-slate-100">{formatUsdt(allocation.totalRunningBalance)}</span>
                    {' - '}
                    Realized PnL <span className={`font-semibold ${allocation.totalRealizedPnl > 0 ? 'text-emerald-300' : allocation.totalRealizedPnl < 0 ? 'text-rose-300' : 'text-slate-100'}`}>{formatUsdt(allocation.totalRealizedPnl, true)}</span>
                  </span>
                </div>
              </div>
            )}

            {!isAdmin ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
                <span>{emptySlotCount > 0 ? `${emptySlotCount} empty bot slot${emptySlotCount === 1 ? '' : 's'} - fill ${emptySlotCount === 1 ? 'it' : 'them'} in Bot Creation to fund another bot.` : 'Need more bots?'}</span>
                <Link to="/marketplace/bot-slot" className="inline-flex items-center gap-1 font-semibold text-sky-300 hover:underline">
                  <Plus className="h-3.5 w-3.5" /> Buy a bot slot
                </Link>
              </div>
            ) : null}
          </Panel>
        </>
      )}

      <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/90 px-4 py-3 backdrop-blur-md">
        <button
          type="submit"
          disabled={controlsDisabled || !dirty}
          className="rounded-2xl bg-sky-400 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {saving ? 'Saving...' : !ready ? 'Waiting for settings...' : 'Save wallets'}
        </button>
        <span className={`text-xs ${dirty ? 'text-amber-300' : 'text-slate-500'}`}>
          {dirty ? 'You have unsaved changes.' : 'All changes saved.'}
        </span>
      </div>
      </fieldset>
    </form>
  )
}

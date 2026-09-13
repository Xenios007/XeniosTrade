import { Activity, AlertTriangle, Bot, CheckCircle2, LockKeyhole, RefreshCcw, ShieldAlert, Target, WalletCards } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getStrategyDerivedTakeProfitPerTrade, roundMoney, summarizeAccount } from '../lib/accountMetrics'
import { formatPercent } from '../lib/formatters'
import { getEffectiveSignalModelStrategy, getSignalModel, SIGNAL_MODELS } from '../lib/signalModels'
import {
  getRealMoneyWallet,
  getTradingWallets,
  getWalletEffectiveStartingBalance,
  isRealMoneyWallet,
} from '../lib/wallets'
import { isTradeOpen } from '../lib/trades'
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

function getSyncStatusTone(syncStatus) {
  const status = String(syncStatus || 'NOT_CONNECTED').toUpperCase()

  if (status === 'CONNECTED') {
    return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
  }

  if (status === 'ERROR' || status === 'MISSING_CREDENTIALS') {
    return 'border-rose-400/20 bg-rose-400/10 text-rose-100'
  }

  return 'border-amber-400/20 bg-amber-400/10 text-amber-100'
}

function getLiveStatusMeta({ hasLiveCredentials, syncStatus, learningStatus }) {
  if (!hasLiveCredentials) {
    return {
      label: 'Keys Needed',
      tone: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      icon: AlertTriangle,
      detail: 'Live Binance Futures credentials are not saved yet.',
    }
  }

  if (String(syncStatus || '').toUpperCase() !== 'CONNECTED') {
    return {
      label: 'Wallet Sync Needed',
      tone: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      icon: RefreshCcw,
      detail: 'Live keys are saved, but the real-money funding wallet is not connected.',
    }
  }

  if (!learningStatus?.realMoneyTradeReady) {
    return {
      label: 'Locked By Review Gate',
      tone: 'border-red-400/25 bg-red-400/10 text-red-100',
      icon: LockKeyhole,
      detail: 'The learning-bot reviewed-trade target has not been reached.',
    }
  }

  return {
    label: 'Ready For Manual Review',
    tone: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    icon: CheckCircle2,
    detail: 'The data gate is satisfied, but live order placement is still intentionally disabled.',
  }
}

function formatReadinessProgress(learningStatus = {}) {
  const reviewed = Number(learningStatus.eligibleClosedTradeCount || learningStatus.currentDatasetRows || 0)
  const target = Number(learningStatus.realMoneyTradeTarget || 1000)
  const remaining = Math.max(Number(learningStatus.realMoneyTradesRemaining ?? target - reviewed), 0)

  if (learningStatus.realMoneyTradeReady) {
    return `${reviewed} / ${target} reviewed trades`
  }

  return `${reviewed} / ${target} reviewed trades, ${remaining} remaining`
}

function StatCard({ label, value, detail = '', tone = 'text-white', Icon }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs uppercase tracking-[0.24em] text-slate-500">{label}</span>
        {Icon ? <Icon className="h-4 w-4 shrink-0 text-red-300" /> : null}
      </div>
      <div className={`break-words text-lg font-semibold ${tone}`}>{value}</div>
      {detail ? <div className="mt-2 text-xs leading-relaxed text-slate-400">{detail}</div> : null}
    </div>
  )
}

function isRealMoneyTrade(trade, wallets = []) {
  const wallet = wallets.find((item) => item.id === trade?.walletId)

  return Boolean(
    (wallet && isRealMoneyWallet(wallet))
      || String(trade?.environment || '').toUpperCase() === 'REAL_MONEY'
      || String(trade?.mode || '').toLowerCase().includes('live')
      || String(trade?.mode || '').toLowerCase().includes('real-money')
  )
}

export function RealMoneyTradingPage({
  settings,
  trades = [],
  livePrices = {},
  aiTrainingStatus = {},
  onSave,
  saving = false,
  ready = true,
}) {
  const wallets = useMemo(() => settings.wallets || [], [settings.wallets])
  const fundingWallet = useMemo(() => getRealMoneyWallet(wallets), [wallets])
  const realMoneyTrades = useMemo(
    () => trades.filter((trade) => isRealMoneyTrade(trade, wallets)),
    [trades, wallets],
  )
  const assignedModelId = settings.strategy?.realMoneySignalModelId || settings.strategy?.activeSignalModelId || SIGNAL_MODELS[0]?.id || ''
  const [selectedModelId, setSelectedModelId] = useState(assignedModelId)

  useEffect(() => {
    setSelectedModelId(assignedModelId)
  }, [assignedModelId])

  const assignedModel = getSignalModel(assignedModelId)
  const selectedModel = getSignalModel(selectedModelId)
  const selectedBotWallet = getTradingWallets(wallets).find((wallet) => wallet.assignedSignalModelId === selectedModelId) || null
  const hasLiveCredentials = Boolean(
    settings.credentials?.liveApiKey?.present
      && settings.credentials?.liveSecretKey?.present,
  ) || Boolean(settings.liveApiKey && settings.liveSecretKey)
  const accountSnapshot = summarizeAccount({
    trades: realMoneyTrades,
    livePrices,
    strategy: settings.strategy,
    startingBalance: fundingWallet ? getWalletEffectiveStartingBalance(fundingWallet) : 0,
  })
  const closedTrades = realMoneyTrades.filter((trade) => !isTradeOpen(trade)).length
  const openTrades = realMoneyTrades.filter((trade) => isTradeOpen(trade)).length
  const wins = realMoneyTrades.filter((trade) => !isTradeOpen(trade) && Number(trade.pnl || 0) > 0).length
  const winRate = closedTrades > 0 ? wins / closedTrades : 0
  const syncStatus = String(fundingWallet?.production?.syncStatus || 'NOT_CONNECTED')
  const liveStatus = getLiveStatusMeta({ hasLiveCredentials, syncStatus, learningStatus: aiTrainingStatus })
  const LiveStatusIcon = liveStatus.icon
  const effectiveSelectedStrategy = getEffectiveSignalModelStrategy(settings.strategy, selectedModelId, {
    runningBalance: accountSnapshot.runningBalance,
  })
  const takeProfitPerTrade = getStrategyDerivedTakeProfitPerTrade(effectiveSelectedStrategy)
  const selectedBotRiskSummary = `${formatUsdt(effectiveSelectedStrategy.maxLossPerTrade)} max loss / ${formatUsdt(takeProfitPerTrade)} target, ${effectiveSelectedStrategy.leverage}x`
  const canSave = ready && !saving && selectedModelId && selectedModelId !== assignedModelId

  async function handleSubmit(event) {
    event.preventDefault()
    if (!canSave) {
      return
    }

    await onSave({
      strategy: {
        realMoneySignalModelId: selectedModelId,
      },
    })
  }

  return (
    <div className="grid gap-6">
      <Panel title="Real Money Trading Summary">
        <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-4 text-sm text-red-100">
          Real-money trading remains separated from testnet automation. This page records the assigned live rollout bot and monitors the live funding wallet status.
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Live Status"
            value={liveStatus.label}
            detail={liveStatus.detail}
            tone={liveStatus.label.includes('Ready') ? 'text-sky-200' : liveStatus.label.includes('Locked') ? 'text-red-200' : 'text-amber-200'}
            Icon={LiveStatusIcon}
          />
          <StatCard
            label="Assigned Bot"
            value={assignedModel.name}
            detail={assignedModel.tag}
            Icon={Bot}
          />
          <StatCard
            label="Live Funding Balance"
            value={formatUsdt(fundingWallet?.production?.lastSyncedBalance ?? fundingWallet?.manualBalance)}
            detail={fundingWallet ? fundingWallet.name : 'Real money wallet missing'}
            Icon={WalletCards}
          />
          <StatCard
            label="Available Balance"
            value={formatUsdt(fundingWallet?.production?.lastSyncedAvailableBalance ?? fundingWallet?.manualBalance)}
            detail={`Last sync: ${formatSyncTime(fundingWallet?.production?.lastSyncedAt)}`}
            Icon={Activity}
          />
          <StatCard
            label="Realized P/L"
            value={formatUsdt(accountSnapshot.realizedPnl, true)}
            tone={accountSnapshot.realizedPnl > 0 ? 'text-emerald-300' : accountSnapshot.realizedPnl < 0 ? 'text-rose-300' : 'text-slate-100'}
            detail={`${closedTrades} closed / ${openTrades} open`}
            Icon={Target}
          />
          <StatCard
            label="Win Rate"
            value={closedTrades > 0 ? formatPercent(winRate * 100) : 'No closes yet'}
            detail={`${realMoneyTrades.length} real-money trade records`}
            Icon={ShieldAlert}
          />
        </div>
      </Panel>

      <Panel title="Real Money Status">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className={`rounded-2xl border px-4 py-4 ${liveStatus.tone}`}>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950/60 text-current">
                <LiveStatusIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.18em] opacity-75">Live Trade Status</div>
                <div className="mt-1 text-sm font-semibold">{liveStatus.label}</div>
                <div className="mt-2 text-xs leading-relaxed">{liveStatus.detail}</div>
                <div className="mt-2 text-xs leading-relaxed opacity-80">Execution path: disabled</div>
              </div>
            </div>
          </div>

          <div className={`rounded-2xl border px-4 py-4 ${getSyncStatusTone(syncStatus)}`}>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950/60 text-current">
                <RefreshCcw className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.18em] opacity-75">Funding Wallet Sync</div>
                <div className="mt-1 text-sm font-semibold">{syncStatus.replace(/_/g, ' ')}</div>
                <div className="mt-2 text-xs leading-relaxed">
                  {syncStatus === 'CONNECTED'
                    ? 'Live Binance Futures balance is connected for monitoring.'
                    : hasLiveCredentials
                      ? 'Live keys are saved. Use Wallets -> Real Money Wallet to sync the funding balance.'
                      : 'Add live Binance Futures keys in Settings -> API Credentials before syncing.'}
                </div>
                {fundingWallet?.production?.lastError ? (
                  <div className="mt-2 text-xs leading-relaxed opacity-80">{fundingWallet.production.lastError}</div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
              <ShieldAlert className="h-4 w-4" />
              Readiness Gate
            </div>
            <div className="mt-3 text-lg font-semibold text-white">
              {aiTrainingStatus.realMoneyTradeReady ? 'Review target reached' : 'Collecting evidence'}
            </div>
            <div className="mt-2 text-xs leading-relaxed text-slate-400">
              {formatReadinessProgress(aiTrainingStatus)}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Assign Real Money Bot">
        <form className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.24em] text-slate-500">Bot assigned to real money trading</span>
            <select
              value={selectedModelId}
              onChange={(event) => setSelectedModelId(event.target.value)}
              disabled={!ready || saving}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm font-semibold text-white outline-none disabled:cursor-not-allowed disabled:text-slate-500"
            >
              {SIGNAL_MODELS.map((model) => (
                <option key={model.id} value={model.id} className="bg-slate-900 text-white">
                  {model.name} - {model.tag}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-2xl bg-red-400 px-5 py-3 text-sm font-semibold text-slate-950 transition disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {saving ? 'Saving...' : canSave ? 'Save Assignment' : 'Assignment Saved'}
          </button>
        </form>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">
            Current selection: {selectedModel.name}. This does not enable live order placement by itself.
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">
            {selectedBotWallet ? `${selectedBotWallet.name} is the testnet reference wallet. ` : ''}
            Planned risk: {selectedBotRiskSummary}.
          </div>
        </div>
      </Panel>
    </div>
  )
}

export function getRealMoneyTrades(trades = [], wallets = []) {
  return trades.filter((trade) => isRealMoneyTrade(trade, wallets))
}

import { Activity, BarChart3, Bot, CircleAlert, RefreshCcw, ShieldAlert, Target, WalletCards } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { roundMoney, summarizeAccount } from '../lib/accountMetrics'
import { evaluateAutoTradeReadiness } from '../lib/autoTradeReadiness'
import { formatPercent } from '../lib/formatters'
import { getEffectiveSignalModelStrategy, getSignalModel, visibleSignalModels } from '../lib/signalModels'
import {
  getMainWallet,
  buildPhase3ChampionAllocation,
  getMainWalletAllocatedBalance,
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

function getWalletTone(colorKey) {
  if (colorKey === 'emerald') {
    return {
      frame: 'border-emerald-400/20 bg-emerald-400/[0.06]',
      badge: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100',
      accent: 'text-emerald-300',
    }
  }

  if (colorKey === 'amber') {
    return {
      frame: 'border-amber-400/20 bg-amber-400/[0.06]',
      badge: 'border-amber-400/20 bg-amber-400/10 text-amber-100',
      accent: 'text-amber-300',
    }
  }

  if (colorKey === 'rose') {
    return {
      frame: 'border-rose-400/20 bg-rose-400/[0.06]',
      badge: 'border-rose-400/20 bg-rose-400/10 text-rose-100',
      accent: 'text-rose-300',
    }
  }

  if (colorKey === 'slate') {
    return {
      frame: 'border-white/10 bg-white/[0.03]',
      badge: 'border-white/10 bg-white/[0.05] text-slate-100',
      accent: 'text-slate-100',
    }
  }

  if (colorKey === 'crimson') {
    return {
      frame: 'border-red-400/20 bg-red-400/[0.06]',
      badge: 'border-red-400/20 bg-red-400/10 text-red-100',
      accent: 'text-red-300',
    }
  }

  return {
    frame: 'border-sky-400/20 bg-sky-400/[0.06]',
    badge: 'border-sky-400/20 bg-sky-400/10 text-sky-100',
    accent: 'text-sky-200',
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

function buildMainWalletGuardrail(wallet, hasExchangeCredentials) {
  if (!wallet || !isExchangeSyncWallet(wallet)) {
    return {
      status: 'blocked',
      headline: 'Main wallet sync is not configured.',
      reason: 'The main wallet should be the Binance Futures Testnet wallet for this workspace.',
      detail: 'Save Wallets after resetting the wallet structure if this state appears unexpectedly.',
    }
  }

  if (!hasExchangeCredentials || wallet.production.syncStatus === 'MISSING_CREDENTIALS') {
    return {
      status: 'blocked',
      headline: 'Main wallet is waiting for Binance testnet keys.',
      reason: 'Add the Binance Futures Testnet API key and secret in Settings before the workspace can pull the funding balance.',
      detail: 'Once credentials are saved, click Sync Now to pull the latest wallet balance and available margin.',
    }
  }

  if (wallet.production.syncStatus === 'ERROR') {
    return {
      status: 'blocked',
      headline: 'Main wallet sync needs attention.',
      reason: wallet.production.lastError || 'The last Binance Futures Testnet sync attempt failed.',
      detail: 'Fix the credential or exchange error, then sync again before relying on allocations.',
    }
  }

  if (wallet.production.syncStatus !== 'CONNECTED') {
    return {
      status: 'blocked',
      headline: 'Main wallet has not synced yet.',
      reason: 'The wallet is ready for Binance Futures Testnet, but there is no confirmed account snapshot yet.',
      detail: 'Run Sync Now to pull balance, available margin, and live exchange position state into this workspace.',
    }
  }

  return {
    status: 'ready',
    headline: 'Main wallet is connected to Binance Futures Testnet.',
    reason: 'Bot allocations can now be funded against the synced available balance from Binance.',
    detail: 'Keep the app online so the funding balance stays current while the bots trade.',
  }
}

function WalletStatCard({ label, value, tone = 'text-white', Icon }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <div className="mb-4 flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.24em] text-slate-500">{label}</span>
        <Icon className="h-4 w-4 text-sky-300" />
      </div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  )
}

function MainWalletCard({
  wallet,
  hasExchangeCredentials,
  comparison,
  onUpdateWallet,
  onSyncWallet,
  syncing,
}) {
  const tone = getWalletTone(wallet.colorKey)
  const guardrail = buildMainWalletGuardrail(wallet, hasExchangeCredentials)
  const readinessTone = guardrail.status === 'ready'
    ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
    : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
  const fundingBalance = getWalletFundingBalance(wallet)
  const configuredAllocation = Number(comparison?.configuredAllocation || 0)

  return (
    <div className={`rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.22)] ${tone.frame}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Funding Wallet</div>
          <input
            value={wallet.name}
            onChange={(event) => onUpdateWallet(wallet.id, { name: event.target.value })}
            className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-base font-semibold text-white outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${tone.badge}`}>
              Binance Testnet
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-300">
              Main Wallet
            </span>
          </div>
        </div>

        <button
          type="button"
          disabled={syncing}
          onClick={() => onSyncWallet(wallet.id)}
          className="rounded-2xl bg-sky-400 px-4 py-3 text-sm font-semibold text-slate-950 transition disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {syncing ? 'Syncing...' : 'Sync Now'}
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <WalletStatCard
          label="Funding Balance"
          value={formatUsdt(wallet.production.lastSyncedBalance ?? fundingBalance)}
          tone="text-slate-100"
          Icon={WalletCards}
        />
        <WalletStatCard
          label="Available Balance"
          value={formatUsdt(fundingBalance)}
          tone={fundingBalance >= configuredAllocation ? 'text-emerald-300' : 'text-rose-300'}
          Icon={Activity}
        />
        <WalletStatCard
          label="Bot Equity In Use"
          value={formatUsdt(comparison.fundingInUse)}
          tone="text-slate-100"
          Icon={Target}
        />
        <WalletStatCard
          label="Unallocated Funding"
          value={formatUsdt(comparison.availableAllocation)}
          tone={comparison.availableAllocation >= 0 ? 'text-emerald-300' : 'text-rose-300'}
          Icon={ShieldAlert}
        />
      </div>

      <div className={`mt-5 rounded-2xl border px-4 py-4 ${readinessTone}`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950/60 text-current">
            {guardrail.status === 'ready' ? <Bot className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] opacity-75">Main Wallet Guardrail</div>
            <div className="mt-1 text-sm font-semibold">{guardrail.headline}</div>
            <div className="mt-2 text-xs leading-relaxed">{guardrail.reason}</div>
            <div className="mt-2 text-xs leading-relaxed opacity-80">{guardrail.detail}</div>
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Funding Controls</div>
          <div className="mt-4 grid gap-4">
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-slate-500">Fallback Funding Balance</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={wallet.manualBalance}
                onChange={(event) => onUpdateWallet(wallet.id, { manualBalance: Number(event.target.value) })}
                className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
              />
            </label>

            <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-sm text-sky-100">
              The main wallet is the only Binance-synced wallet. Bot wallets stay local and consume allocations from this funding balance.
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
            <RefreshCcw className="h-4 w-4" />
            Binance Testnet Sync
          </div>
          <div className="mt-4 grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Sync Provider</div>
                <div className={`mt-1 text-sm font-semibold ${tone.accent}`}>{wallet.production.syncProvider}</div>
              </div>
              <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${getSyncStatusTone(wallet.production.syncStatus)}`}>
                {wallet.production.syncStatus}
              </span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Synced Wallet Balance</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {wallet.production.lastSyncedBalance == null ? 'Not connected yet' : formatUsdt(wallet.production.lastSyncedBalance)}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Available Balance</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {wallet.production.lastSyncedAvailableBalance == null ? 'Not connected yet' : formatUsdt(wallet.production.lastSyncedAvailableBalance)}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Unrealized PnL</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">
                  {wallet.production.lastSyncedUnrealizedPnl == null ? 'Not connected yet' : formatUsdt(wallet.production.lastSyncedUnrealizedPnl, true)}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Open Exchange Positions</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{wallet.production.lastOpenPositionCount || 0}</div>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Last Synced</div>
              <div className="mt-1 text-sm font-semibold text-slate-100">{formatSyncTime(wallet.production.lastSyncedAt)}</div>
            </div>
          </div>

          {wallet.production.lastError ? (
            <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
              {wallet.production.lastError}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function buildRealMoneyWalletGuardrail(wallet, hasLiveExchangeCredentials) {
  if (!wallet) {
    return {
      status: 'blocked',
      headline: 'Real money wallet is not set up yet.',
      reason: 'Save Wallets once to let the backend synthesize the Real Money wallet from its default blueprint.',
      detail: '',
    }
  }

  if (!hasLiveExchangeCredentials || wallet.production.syncStatus === 'MISSING_CREDENTIALS') {
    return {
      status: 'blocked',
      headline: 'Real money wallet is waiting for live Binance Futures keys.',
      reason: 'Add the live Binance Futures API key and secret in Settings → API Credentials before this workspace can pull the real funding balance.',
      detail: 'These are separate from the testnet keys above — adding them does not enable any live order placement by itself.',
    }
  }

  if (wallet.production.syncStatus === 'ERROR') {
    return {
      status: 'blocked',
      headline: 'Real money wallet sync needs attention.',
      reason: wallet.production.lastError || 'The last live Binance Futures sync attempt failed.',
      detail: 'Fix the credential or exchange error, then sync again.',
    }
  }

  if (wallet.production.syncStatus !== 'CONNECTED') {
    return {
      status: 'blocked',
      headline: 'Real money wallet has not synced yet.',
      reason: 'Live keys are saved, but there is no confirmed account snapshot yet.',
      detail: 'Run Sync Now to pull the real balance from Binance Futures — this is a read-only balance check, not a trade.',
    }
  }

  return {
    status: 'ready',
    headline: 'Real money wallet is connected to Binance Futures (live).',
    reason: 'The live funding balance is confirmed. No bot places real orders yet — that requires a separate, deliberate go-live step.',
    detail: 'See GO_LIVE_READINESS.md for the checklist that has to pass before any bot trades this wallet.',
  }
}

function RealMoneyWalletCard({
  wallet,
  hasLiveExchangeCredentials,
  onUpdateWallet,
  onSyncWallet,
  syncing,
}) {
  const tone = getWalletTone(wallet?.colorKey || 'crimson')
  const guardrail = buildRealMoneyWalletGuardrail(wallet, hasLiveExchangeCredentials)
  const readinessTone = guardrail.status === 'ready'
    ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
    : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
  const fundingBalance = wallet ? getWalletFundingBalance(wallet) : 0

  return (
    <div className="grid gap-6">
      <div className="rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-4 text-sm text-red-100">
        This wallet is real money, not a simulation. It is prepared so the system is ready the moment live API keys are
        added — no bot currently places orders against it. Enabling live trading is a separate, deliberate step covered
        in GO_LIVE_READINESS.md, and is not turned on by anything on this page.
      </div>

      {wallet ? (
        <div className={`rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.22)] ${tone.frame}`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Funding Wallet</div>
              <input
                value={wallet.name}
                onChange={(event) => onUpdateWallet(wallet.id, { name: event.target.value })}
                className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-base font-semibold text-white outline-none"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${tone.badge}`}>
                  Binance Futures — Live
                </span>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-300">
                  Real Money Wallet
                </span>
              </div>
            </div>

            <button
              type="button"
              disabled={syncing}
              onClick={() => onSyncWallet(wallet.id)}
              className="rounded-2xl bg-red-400 px-4 py-3 text-sm font-semibold text-slate-950 transition disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <WalletStatCard
              label="Funding Balance"
              value={formatUsdt(wallet.production.lastSyncedBalance ?? fundingBalance)}
              tone="text-slate-100"
              Icon={WalletCards}
            />
            <WalletStatCard
              label="Available Balance"
              value={formatUsdt(wallet.production.lastSyncedAvailableBalance ?? fundingBalance)}
              tone="text-slate-100"
              Icon={Activity}
            />
            <WalletStatCard
              label="Live Keys"
              value={hasLiveExchangeCredentials ? 'Configured' : 'Missing'}
              tone={hasLiveExchangeCredentials ? 'text-emerald-300' : 'text-amber-300'}
              Icon={ShieldAlert}
            />
          </div>

          <div className={`mt-5 rounded-2xl border px-4 py-4 ${readinessTone}`}>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950/60 text-current">
                {guardrail.status === 'ready' ? <Bot className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
              </span>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-[0.18em] opacity-75">Real Money Wallet Guardrail</div>
                <div className="mt-1 text-sm font-semibold">{guardrail.headline}</div>
                <div className="mt-2 text-xs leading-relaxed">{guardrail.reason}</div>
                {guardrail.detail ? <div className="mt-2 text-xs leading-relaxed opacity-80">{guardrail.detail}</div> : null}
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">
              <RefreshCcw className="h-4 w-4" />
              Binance Futures Live Sync
            </div>
            <div className="mt-4 grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Sync Provider</div>
                  <div className={`mt-1 text-sm font-semibold ${tone.accent}`}>{wallet.production.syncProvider}</div>
                </div>
                <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${getSyncStatusTone(wallet.production.syncStatus)}`}>
                  {wallet.production.syncStatus}
                </span>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Last Synced</div>
                <div className="mt-1 text-sm font-semibold text-slate-100">{formatSyncTime(wallet.production.lastSyncedAt)}</div>
              </div>
            </div>
            {wallet.production.lastError ? (
              <div className="mt-4 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                {wallet.production.lastError}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function BotWalletCard({ wallet, view, onUpdateWallet }) {
  const tone = getWalletTone(wallet.colorKey)
  const model = getSignalModel(wallet.assignedSignalModelId)
  const readiness = view.readiness
  const readinessTone = readiness.status === 'ready'
    ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
    : 'border-amber-400/20 bg-amber-400/10 text-amber-100'
  const stats = [
    {
      label: 'Allocated Balance',
      value: formatUsdt(view.accountSnapshot.startingBalance),
      tone: 'text-slate-100',
      Icon: WalletCards,
    },
    {
      label: 'Running Balance',
      value: formatUsdt(view.accountSnapshot.runningBalance),
      tone: view.accountSnapshot.runningBalance > view.accountSnapshot.startingBalance
        ? 'text-emerald-300'
        : view.accountSnapshot.runningBalance < view.accountSnapshot.startingBalance
          ? 'text-rose-300'
          : 'text-slate-100',
      Icon: WalletCards,
    },
    {
      label: 'Available Balance',
      value: formatUsdt(view.accountSnapshot.availableBalance),
      tone: view.accountSnapshot.availableBalance >= view.accountSnapshot.marginPerTrade ? 'text-emerald-300' : 'text-rose-300',
      Icon: Activity,
    },
    {
      label: 'Realized PnL',
      value: formatUsdt(view.accountSnapshot.realizedPnl, true),
      tone: view.accountSnapshot.realizedPnl > 0 ? 'text-emerald-300' : view.accountSnapshot.realizedPnl < 0 ? 'text-rose-300' : 'text-slate-100',
      Icon: Target,
    },
    {
      label: 'Open Positions',
      value: `${view.accountSnapshot.openTradeCount}`,
      tone: view.accountSnapshot.openTradeCount > 0 ? 'text-amber-300' : 'text-slate-100',
      Icon: BarChart3,
    },
    {
      label: 'Win Rate',
      value: formatPercent(view.winRate * 100),
      tone: 'text-slate-100',
      Icon: ShieldAlert,
    },
  ]

  return (
    <div className={`rounded-[28px] border p-5 shadow-[0_18px_50px_rgba(15,23,42,0.22)] ${tone.frame}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Bot Wallet</div>
          <input
            value={wallet.name}
            onChange={(event) => onUpdateWallet(wallet.id, { name: event.target.value })}
            className="mt-2 w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-base font-semibold text-white outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${tone.badge}`}>
              {model.name}
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-300">
              Allocated From Main Wallet
            </span>
            <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
              wallet.enabled
                ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
                : 'border-white/10 bg-white/[0.04] text-slate-400'
            }`}>
              {wallet.enabled ? 'Automation Enabled' : 'Paused'}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onUpdateWallet(wallet.id, { enabled: !wallet.enabled })}
          className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
            wallet.enabled
              ? 'bg-emerald-400/15 text-emerald-100 ring-1 ring-emerald-400/30'
              : 'bg-white/[0.04] text-slate-200 ring-1 ring-white/10 hover:bg-white/[0.06]'
          }`}
        >
          {wallet.enabled ? 'Enabled' : 'Enable Wallet'}
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {stats.map((stat) => (
          <WalletStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
            tone={stat.tone}
            Icon={stat.Icon}
          />
        ))}
      </div>

      <div className={`mt-5 rounded-2xl border px-4 py-4 ${readinessTone}`}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-950/60 text-current">
            {readiness.status === 'ready' ? <Bot className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.18em] opacity-75">Bot Wallet Guardrail</div>
            <div className="mt-1 text-sm font-semibold">{readiness.headline}</div>
            <div className="mt-2 text-xs leading-relaxed">{readiness.reason}</div>
            <div className="mt-2 text-xs leading-relaxed opacity-80">{readiness.detail}</div>
          </div>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Bot Wallet Controls</div>
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-slate-500">Assigned Bot</span>
            <select
              value={wallet.assignedSignalModelId}
              onChange={(event) => onUpdateWallet(wallet.id, { assignedSignalModelId: event.target.value })}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
            >
              {visibleSignalModels().map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} - {item.tag}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-slate-500">Allocation From Main Wallet</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={getWalletAllocationBalance(wallet)}
              onChange={(event) => onUpdateWallet(wallet.id, { allocationBalance: Number(event.target.value), manualBalance: Number(event.target.value) })}
              className="w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none"
            />
          </label>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300">
          This bot trades only from its allocated balance. It does not sync directly to Binance; the main wallet provides the funding pool.
        </div>
      </div>
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
}) {
  const [walletForm, setWalletForm] = useState(normalizeWallets(settings.wallets))
  const controlsDisabled = saving || !ready

  useEffect(() => {
    setWalletForm(normalizeWallets(settings.wallets))
  }, [settings.wallets])

  const normalizedWalletForm = useMemo(
    () => normalizeWallets(walletForm),
    [walletForm],
  )
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

  const walletViews = useMemo(() => (
    visibleTradingWallets(normalizedWalletForm).map((wallet) => {
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
      const closedTrades = accountSnapshot.closedTradeCount
      const winRate = closedTrades > 0 ? accountSnapshot.wins / closedTrades : 0

      return {
        wallet,
        walletTrades,
        accountSnapshot,
        readiness,
        winRate,
      }
    })
  ), [livePrices, normalizedWalletForm, settings.strategy, trades])

  const phase3Recommendation = useMemo(() => buildPhase3ChampionAllocation({
    wallets: normalizedWalletForm,
    trades,
    livePrices,
    strategy: settings.strategy,
  }), [livePrices, normalizedWalletForm, settings.strategy, trades])

  const comparison = useMemo(() => {
    const totalRunningBalance = walletViews.reduce((sum, view) => sum + view.accountSnapshot.runningBalance, 0)
    const totalRealizedPnl = walletViews.reduce((sum, view) => sum + view.accountSnapshot.realizedPnl, 0)
    const configuredAllocation = getMainWalletAllocatedBalance(normalizedWalletForm)
    const fundingBalance = getWalletAllocationFundingBalance(mainWallet || {})
    const fundingInUse = roundMoney(configuredAllocation)

    return {
      totalRunningBalance,
      totalRealizedPnl,
      configuredAllocation,
      fundingBalance,
      fundingInUse,
      availableAllocation: roundMoney(fundingBalance - fundingInUse),
      hasExchangeCredentials,
    }
  }, [hasExchangeCredentials, mainWallet, normalizedWalletForm, walletViews])

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


    async function handleSubmit(event) {
    event.preventDefault()
    if (controlsDisabled) {
      return
    }

    await onSave({
      wallets: normalizeWallets(walletForm),
    })
  }

  return (
    <form className="grid gap-6" onSubmit={handleSubmit}>
      {!ready ? (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
          Waiting for the saved settings to load from the backend. Saving is disabled until the current wallet snapshot is available.
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 rounded-2xl border border-white/10 bg-slate-950/60 p-1.5">
        <button
          type="button"
          onClick={() => setActiveEnvironment(TESTNET_WALLET_ENVIRONMENT)}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
            activeEnvironment === TESTNET_WALLET_ENVIRONMENT
              ? 'bg-sky-400 text-slate-950'
              : 'text-slate-300 hover:bg-white/[0.05]'
          }`}
        >
          Testnet Wallets
        </button>
        <button
          type="button"
          onClick={() => setActiveEnvironment(REAL_MONEY_WALLET_ENVIRONMENT)}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
            activeEnvironment === REAL_MONEY_WALLET_ENVIRONMENT
              ? 'bg-red-400 text-slate-950'
              : 'text-slate-300 hover:bg-white/[0.05]'
          }`}
        >
          Real Money Wallet
        </button>
      </div>

      <fieldset disabled={controlsDisabled} className="contents">
      {activeEnvironment === REAL_MONEY_WALLET_ENVIRONMENT ? (
        <RealMoneyWalletCard
          wallet={realMoneyWallet}
          hasLiveExchangeCredentials={hasLiveExchangeCredentials}
          onUpdateWallet={updateWallet}
          onSyncWallet={onSyncWallet}
          syncing={Boolean(realMoneyWallet) && syncingWalletId === realMoneyWallet.id}
        />
      ) : (
      <>
      <Panel title="Wallet Lab">
        <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-4 text-sm text-sky-100">
          The workspace now uses one Binance Futures Testnet main wallet as the funding source, and {walletViews.length} bot wallets that each receive an allocation from it for auto trading.
        </div>

        <div className="mt-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-4 text-sm text-emerald-100">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-200/80">Phase 3 Preview</div>
              <div className="mt-1 font-semibold text-emerald-50">
                {phase3Recommendation.champion
                  ? `${phase3Recommendation.champion.wallet.name} is the current champion with ${formatUsdt(phase3Recommendation.champion.realizedPnl, true)} realized PnL across ${phase3Recommendation.champion.closedTrades} closed trades.`
                  : 'No bot performance data is available yet.'}
              </div>
              <div className="mt-2 text-xs leading-relaxed text-emerald-100/85">
                Phase 2 stays in multi-bot test mode so all four bots keep collecting data. Phase 3 remains locked until the live-money gate passes: 50-100 new post-hardening paper/testnet trades, stable market data, persistent AI learning, no open local-paper trades, and controlled drawdown.
              </div>
            </div>
            <button
              type="button"
              disabled
              className="rounded-2xl bg-emerald-300 px-4 py-3 text-sm font-semibold text-slate-950 transition disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              Phase 3 On Hold
            </button>
          </div>
          {phase3Recommendation.champion ? (
            <div className="mt-3 text-xs text-emerald-100/85">
              After the Phase 3 gate passes, the first live rollout would fund {phase3Recommendation.champion.wallet.name} with {formatUsdt(phase3Recommendation.fundingBalance)} from the main wallet, pause the other bot wallets, and start with tiny size plus manual supervision.
            </div>
          ) : null}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <WalletStatCard
            label="Bot Running Balance"
            value={formatUsdt(comparison.totalRunningBalance)}
            tone="text-slate-100"
            Icon={WalletCards}
          />
          <WalletStatCard
            label="Bot Workspace PnL"
            value={formatUsdt(comparison.totalRealizedPnl, true)}
            tone={comparison.totalRealizedPnl > 0 ? 'text-emerald-300' : comparison.totalRealizedPnl < 0 ? 'text-rose-300' : 'text-slate-100'}
            Icon={Target}
          />
          <WalletStatCard
            label="Configured Allocation"
            value={formatUsdt(comparison.configuredAllocation)}
            tone="text-slate-100"
            Icon={RefreshCcw}
          />
          <WalletStatCard
            label="Exchange Keys"
            value={comparison.hasExchangeCredentials ? 'Configured' : 'Missing'}
            tone={comparison.hasExchangeCredentials ? 'text-emerald-300' : 'text-amber-300'}
            Icon={ShieldAlert}
          />
        </div>
      </Panel>

      {mainWallet ? (
        <MainWalletCard
          wallet={mainWallet}
          hasExchangeCredentials={hasExchangeCredentials}
          comparison={comparison}
          onUpdateWallet={updateWallet}
          onSyncWallet={onSyncWallet}
          syncing={syncingWalletId === mainWallet.id}
        />
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        {walletViews.map((view) => (
          <BotWalletCard
            key={view.wallet.id}
            wallet={view.wallet}
            view={view}
            onUpdateWallet={updateWallet}
          />
        ))}
      </div>

      <div className={`rounded-2xl border px-4 py-4 text-sm ${
        comparison.availableAllocation >= 0
          ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
          : 'border-rose-400/20 bg-rose-400/10 text-rose-100'
      }`}>
        {comparison.availableAllocation >= 0
          ? `Main wallet still has ${formatUsdt(comparison.availableAllocation)} unallocated after funding the active bot sleeves.`
          : `Configured bot sleeve allocations exceed the main wallet funding balance by ${formatUsdt(Math.abs(comparison.availableAllocation))}. Reduce allocations or sync more real funding first.`}
      </div>
      </>
      )}

      <div>
        <button
          type="submit"
          disabled={controlsDisabled}
          className="rounded-2xl bg-sky-400 px-5 py-3 text-sm font-semibold text-slate-950 disabled:bg-slate-700 disabled:text-slate-400"
        >
          {saving ? 'Saving...' : !ready ? 'Waiting for Settings...' : 'Save Wallets'}
        </button>
      </div>
      </fieldset>
    </form>
  )
}

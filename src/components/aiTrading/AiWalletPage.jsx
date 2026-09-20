import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MODE_LABEL, postJson, useAiLedger } from '../../lib/aiTradingApi'
import { formatDateTime, formatPrice } from '../../lib/formatters'
import { Panel } from '../Panel'
import { Badge } from '../ui/Badge'
import { PageHeader } from '../ui/PageHeader'
import { StatCard, pnlTone } from '../ui/StatCard'

const usdt = (value, digits = 2) => (Number.isFinite(Number(value)) && value != null ? `${Number(value).toFixed(digits)} USDT` : '—')

function ExchangeBlock({ wallet, keysPresent }) {
  const exchange = wallet.exchange
  const label = wallet.mode === 'real' ? 'Live Binance Futures account' : 'Binance Futures testnet account'

  if (!keysPresent || !exchange?.configured) {
    return (
      <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs text-amber-100">
        {wallet.mode === 'real'
          ? 'No live Binance API keys saved — real money trades cannot be placed. Save them under API Credentials on the bot workspace.'
          : 'No testnet API keys saved — approved trades run as local paper trades and settle against the live price.'}
      </div>
    )
  }
  if (exchange.error) {
    return <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{label}: {exchange.error}</div>
  }
  return (
    <div className="grid gap-3">
      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{label} · read-only sync {formatDateTime(exchange.syncedAt)}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Exchange balance" value={usdt(exchange.walletBalance)} />
        <StatCard label="Available" value={usdt(exchange.availableBalance)} />
        <StatCard label="Unrealized (account)" value={usdt(exchange.unrealizedProfit)} tone={pnlTone(exchange.unrealizedProfit)} />
        <StatCard label="Open positions (account)" value={exchange.openPositions} sublabel="includes any bot positions" />
      </div>
    </div>
  )
}

function WalletCard({ wallet, ledger, active, onClose, closingId }) {
  const openTrades = ledger.trades.filter((trade) => trade.walletId === wallet.id && trade.status === 'OPEN')
  const led = wallet.ledger
  const winRate = led.closedTrades ? `${((led.wins / led.closedTrades) * 100).toFixed(0)}%` : '—'

  return (
    <Panel
      title={wallet.name}
      action={(
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge tone={wallet.mode === 'real' ? 'warn' : 'info'}>{MODE_LABEL[wallet.mode]}</Badge>
          {active ? <Badge tone="up">Active</Badge> : <Badge>Inactive</Badge>}
        </div>
      )}
    >
      <div className="grid gap-5">
        <ExchangeBlock wallet={wallet} keysPresent={ledger.credentials[wallet.mode]} />

        <div className="grid gap-3">
          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
            AI ledger · only trades the AI opened
            {wallet.startingBalanceDerived ? ' · baseline derived from the exchange balance' : ''}
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Starting" value={usdt(wallet.startingBalance)} />
            <StatCard label="Realized PnL" value={usdt(led.realizedPnl)} tone={pnlTone(led.realizedPnl)} sublabel={`${led.wins}W / ${led.losses}L · ${winRate}`} />
            <StatCard label="Running balance" value={usdt(led.runningBalance)} sublabel={`${usdt(led.unrealizedPnl)} unrealized`} />
            <StatCard label="Margin in use" value={usdt(led.reservedMargin)} sublabel={`${led.openTrades} open · ${led.closedTrades} closed`} />
          </div>
        </div>

        {openTrades.length > 0 ? (
          <div className="grid gap-2">
            <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Open positions</div>
            {openTrades.map((trade) => {
              const live = ledger.livePrices[trade.symbol]
              return (
                <div key={trade.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-2.5 text-xs text-slate-300">
                  <Badge tone={trade.side === 'BUY' ? 'up' : 'down'}>{trade.side === 'BUY' ? 'Long' : 'Short'}</Badge>
                  <span className="font-semibold text-white">{trade.symbol}</span>
                  <span>entry {formatPrice(trade.entryPrice, 4)}</span>
                  <span>now {live ? formatPrice(live, 4) : '—'}</span>
                  <span className="text-rose-300">SL {formatPrice(trade.stopLoss, 4)}</span>
                  <span className="text-emerald-300">TP {formatPrice(trade.takeProfit, 4)}</span>
                  <span className="text-slate-500">{trade.leverage}x · {usdt(trade.margin)} margin</span>
                  <button
                    type="button"
                    disabled={Boolean(closingId)}
                    onClick={() => onClose(trade.id)}
                    className="ml-auto rounded-full border border-rose-400/30 px-3 py-1 text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-50"
                  >
                    {closingId === trade.id ? 'Closing…' : 'Close now'}
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

export function AiWalletPage() {
  const { ledger, error, loading, refresh } = useAiLedger({ pollMs: 10_000 })
  const [syncing, setSyncing] = useState(false)
  const [closingId, setClosingId] = useState('')
  const [actionError, setActionError] = useState('')

  async function sync() {
    setSyncing(true)
    await refresh({ sync: true })
    setSyncing(false)
  }

  async function closeTrade(tradeId) {
    setClosingId(tradeId)
    setActionError('')
    try {
      await postJson(`/api/ai-trading/trades/${encodeURIComponent(tradeId)}/close`)
      await refresh({ sync: true })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The trade could not be closed.')
    } finally {
      setClosingId('')
    }
  }

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Wallet"
        description="The AI's own wallets. The exchange figures are read-only account balances; the AI ledger counts only trades the AI opened, so bot trades on the same Binance account never mix in."
        actions={(
          <>
            <Link to="/ai-settings" className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-white/20">Mode &amp; limits</Link>
            <button
              type="button"
              onClick={sync}
              disabled={syncing}
              className="inline-flex items-center gap-2 rounded-full bg-sky-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              Sync now
            </button>
          </>
        )}
      />
      {error && !ledger ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      {actionError ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{actionError}</div> : null}
      {loading && !ledger ? <Panel title="Wallet"><div className="py-8 text-center text-sm text-slate-400">Loading…</div></Panel> : null}
      {ledger ? ledger.wallets.map((wallet) => (
        <WalletCard
          key={wallet.id}
          wallet={wallet}
          ledger={ledger}
          active={ledger.config.mode === wallet.mode}
          onClose={closeTrade}
          closingId={closingId}
        />
      )) : null}
    </div>
  )
}

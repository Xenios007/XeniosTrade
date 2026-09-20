import { useState } from 'react'
import { Link, Navigate, Route, Routes } from 'react-router-dom'
import { postJson, useAiLedger } from '../../lib/aiTradingApi'
import { Panel } from '../Panel'
import { TradeHistoryStatsPanel } from '../TradeHistoryStatsPanel'
import { TradeHistoryTable } from '../TradeHistoryTable'
import { PageHeader } from '../ui/PageHeader'
import { SubNavTabs } from '../ui/SubNavTabs'

const TABS = [
  { to: '/ai-history', label: 'Testnet Trades', end: true },
  { to: '/ai-history/real', label: 'Real Money Trades' },
]

function ModeHistory({ mode, ledger, refresh }) {
  const [closing, setClosing] = useState({})
  const [error, setError] = useState('')
  const wallet = ledger.wallets.find((item) => item.mode === mode)
  const trades = ledger.trades.filter((trade) => trade.aiTradingMode === mode)

  async function closeTrade(tradeId) {
    setClosing((current) => ({ ...current, [tradeId]: true }))
    setError('')
    try {
      await postJson(`/api/ai-trading/trades/${encodeURIComponent(tradeId)}/close`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The trade could not be closed.')
    } finally {
      setClosing((current) => ({ ...current, [tradeId]: false }))
    }
  }

  if (trades.length === 0) {
    return (
      <Panel title={mode === 'real' ? 'Real Money Trade History' : 'Testnet Trade History'}>
        <div className="py-8 text-center text-sm text-slate-400">
          No {mode === 'real' ? 'real money' : 'testnet'} AI trades yet. Approved pipeline runs appear here once they are opened —
          run the pipeline on the <Link to="/ai-trading" className="text-sky-300 hover:underline">AI Trading</Link> page.
        </div>
      </Panel>
    )
  }

  return (
    <div className="grid gap-6">
      {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      <TradeHistoryStatsPanel
        trades={trades}
        livePrices={ledger.livePrices}
        trackedSymbols={Array.from(new Set(trades.map((trade) => trade.symbol)))}
        startingBalance={wallet.startingBalance}
        title={mode === 'real' ? 'Real Money Performance' : 'Testnet Performance'}
        unsyncedBalanceNote="Starting balance plus what the AI's trades made — see the Wallet page for the exchange balance."
      />
      <TradeHistoryTable
        title={mode === 'real' ? 'Real Money Trade History' : 'Testnet Trade History'}
        trades={trades}
        livePrices={ledger.livePrices}
        closingTradeIds={closing}
        onManualClose={closeTrade}
      />
    </div>
  )
}

export function AiTradeHistoryPage() {
  const { ledger, error, loading, refresh } = useAiLedger({ pollMs: 8_000 })

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Trade History"
        description="Trades the AI opened from approved pipeline runs, on its own wallets. Separate from the bots' history. Testnet and real money are tracked separately."
      />
      <SubNavTabs tabs={TABS} />
      {error && !ledger ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-xs text-rose-200">{error}</div> : null}
      {loading && !ledger ? <Panel title="Trade History"><div className="py-8 text-center text-sm text-slate-400">Loading…</div></Panel> : null}
      {ledger ? (
        <Routes>
          <Route index element={<ModeHistory mode="testnet" ledger={ledger} refresh={refresh} />} />
          <Route path="real" element={<ModeHistory mode="real" ledger={ledger} refresh={refresh} />} />
          <Route path="*" element={<Navigate to="/ai-history" replace />} />
        </Routes>
      ) : null}
    </div>
  )
}

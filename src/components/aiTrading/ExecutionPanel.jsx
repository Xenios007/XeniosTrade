import { Rocket, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MODE_LABEL, postJson } from '../../lib/aiTradingApi'
import { Badge } from '../ui/Badge'
import { Modal } from '../ui/Modal'

/**
 * Sits under an approved verdict. Testnet trades open automatically (when enabled in AI Settings) or
 * with one click. Real money is either automatic (armed AND real-money auto-execute on: no button at all,
 * only the outcome) or a deliberate click plus the symbol typed back, and only while armed. The server
 * re-checks everything (armed, fresh plan, price drift, margin cap).
 */
export function ExecutionPanel({ run, execution, onExecuted }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')

  if (!run?.final?.approved || !run.final.trade) return null

  const mode = execution?.mode || 'testnet'
  const opened = run.execution?.status === 'opened' ? run.execution : null
  const armed = mode === 'real' && execution?.realArmed === true
  // With real-money auto-execute on, entries are placed by the scan itself, so there is nothing to click. A run that was not
  // opened is either one the automatic attempt failed on (a manual try would hit the same check), one that pre-dates the switch, or
  // one whose plan has expired.
  const autoReal = armed && execution?.autoExecuteReal === true

  async function submit() {
    setBusy(true)
    setError('')
    try {
      await postJson('/api/ai-trading/execute', { runId: run.id, mode, confirm: typed })
      setConfirming(false)
      setTyped('')
      await onExecuted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The trade could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  if (opened) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
        <Badge tone="up">Opened · {MODE_LABEL[opened.mode]}</Badge>
        <span className="text-xs">
          {opened.auto ? 'Opened automatically' : 'Opened manually'} on the AI {MODE_LABEL[opened.mode].toLowerCase()} wallet.{' '}
          <Link to={opened.mode === 'real' ? '/ai-history/real' : '/ai-history'} className="text-emerald-200 underline">View in Trade History</Link>
        </span>
      </div>
    )
  }

  if (autoReal) {
    const failed = run.execution?.status === 'failed'
    return (
      <div className={`grid gap-1 rounded-2xl border px-4 py-3 text-xs ${failed ? 'border-rose-400/20 bg-rose-400/10 text-rose-200' : 'border-white/10 bg-slate-950/50 text-slate-300'}`}>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Badge tone="warn" className="shrink-0">Real money · auto</Badge>
          <span className="min-w-0 flex-1 break-words">
            {failed
              ? `The automatic real-money order was not placed: ${run.execution.error}`
              : 'Real money auto-execute is on. This approved run was not opened (it may pre-date the switch, or its plan expired).'}
          </span>
        </div>
        <span className="min-w-0 break-words text-slate-400">
          Auto-execute is on, so there is no manual Execute button. To place a run by hand, switch it off in{' '}
          <Link to="/ai-settings" className="text-sky-300 hover:underline">AI Settings</Link>.
        </span>
      </div>
    )
  }

  return (
    <div className="grid gap-3 rounded-2xl border border-white/10 bg-slate-950/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Badge tone={mode === 'real' ? 'warn' : 'info'} className="shrink-0">{MODE_LABEL[mode]} mode</Badge>
        {run.execution?.status === 'failed' ? (
          <span className="min-w-0 flex-1 break-words text-xs text-rose-300">Automatic open failed: {run.execution.error}</span>
        ) : mode === 'testnet' ? (
          <span className="min-w-0 flex-1 break-words text-xs text-slate-400">
            {execution?.autoExecuteTestnet ? 'Auto-execute is on but this run was not opened.' : 'Auto-execute is off.'} Open it on the testnet wallet:
          </span>
        ) : armed ? (
          <span className="min-w-0 flex-1 break-words text-xs text-amber-200">Real money is armed with auto-execute off — you place each trade yourself.</span>
        ) : (
          <span className="min-w-0 flex-1 break-words text-xs text-slate-400">Real money is not armed. <Link to="/ai-settings" className="text-sky-300 hover:underline">Arm it in AI Settings</Link> to trade this.</span>
        )}
        <button
          type="button"
          disabled={busy || (mode === 'real' && !armed)}
          onClick={() => (mode === 'real' ? setConfirming(true) : submit())}
          className={`ml-auto shrink-0 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
            mode === 'real' ? 'bg-amber-400 text-slate-950' : 'bg-sky-400 text-slate-950'
          }`}
        >
          <Rocket className="h-3.5 w-3.5" />
          {busy ? 'Opening…' : mode === 'real' ? 'Execute on real money' : 'Open on testnet'}
        </button>
      </div>
      {error ? <div className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">{error}</div> : null}

      {confirming ? (
        <Modal
          title="Confirm real money trade"
          onClose={() => { if (!busy) setConfirming(false) }}
          footer={(
            <>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)} className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-300">Cancel</button>
              <button
                type="button"
                disabled={busy || typed.trim().toUpperCase() !== run.symbol}
                onClick={submit}
                className="rounded-full bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? 'Placing…' : 'Place live order'}
              </button>
            </>
          )}
        >
          <div className="flex min-w-0 items-start gap-3 text-sm text-amber-100">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
            <p className="min-w-0 break-words">
              This places a real {run.final.action} market order on <strong>{run.symbol}</strong> on your live Binance Futures account,
              with an exchange-side stop-loss and take-profit. The size is capped to your real-money margin limit
              ({execution?.realMaxMarginUsdt} USDT) and your available balance. You can lose the margin.
            </p>
          </div>
          <label className="grid gap-1 text-xs text-slate-400">
            Type <code className="text-amber-200">{run.symbol}</code> to confirm
            <input
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white outline-none"
              placeholder={run.symbol}
            />
          </label>
          {error ? <div className="rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-200">{error}</div> : null}
        </Modal>
      ) : null}
    </div>
  )
}

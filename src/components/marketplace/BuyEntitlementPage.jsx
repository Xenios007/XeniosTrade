import { CheckCircle2 } from 'lucide-react'
import { useState } from 'react'
import { Panel } from '../Panel'

// SaaS Phase 8F: one shared page for the three simple instant-buy Marketplace listings (Bot
// Slot, Symbol Slot, Subscription) - each is "show what you have, buy more" with nothing
// else distinguishing them. Bot Signal is not built on this - it needs its own per-signal
// picker UI (see SignalsMarketplacePage.jsx).
export function BuyEntitlementPage({
  icon: Icon,
  title,
  description,
  currentLabel,
  currentValue,
  buyLabel,
  purchaseNote,
  onBuy,
  buying,
  isAdmin = false,
  adminNote,
}) {
  const [feedback, setFeedback] = useState(null)

  async function handleBuy() {
    setFeedback(null)
    const result = await onBuy()
    setFeedback(result?.ok
      ? { tone: 'success', message: 'Purchased.' }
      : { tone: 'error', message: result?.error || 'Unable to complete the purchase.' })
  }

  return (
    <Panel title={title}>
      <div className="flex flex-col items-center gap-4 rounded-[28px] border border-white/10 bg-white/[0.02] px-6 py-12 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full border border-sky-300/25 bg-sky-400/10 text-sky-200">
          <Icon className="h-7 w-7" />
        </span>
        <p className="max-w-md text-sm leading-relaxed text-slate-400">{description}</p>

        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-5 py-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{currentLabel}</div>
          <div className="mt-1 text-lg font-semibold text-white">{currentValue}</div>
        </div>

        {isAdmin ? (
          <p className="max-w-md text-xs text-slate-500">{adminNote || 'The admin account is exempt from this entitlement - nothing to buy here.'}</p>
        ) : (
          <>
            <button
              type="button"
              onClick={handleBuy}
              disabled={buying}
              className="inline-flex items-center gap-2 rounded-2xl bg-sky-400 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {buying ? 'Buying…' : buyLabel}
            </button>
            {purchaseNote ? <p className="max-w-md text-xs text-slate-500">{purchaseNote}</p> : null}
            {feedback ? (
              <span className={`inline-flex items-center gap-1.5 text-sm ${feedback.tone === 'success' ? 'text-emerald-300' : 'text-rose-300'}`}>
                {feedback.tone === 'success' ? <CheckCircle2 className="h-4 w-4" /> : null}
                {feedback.message}
              </span>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  )
}

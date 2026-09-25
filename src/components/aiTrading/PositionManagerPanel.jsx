import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { postJson } from '../../lib/aiTradingApi'
import { formatDateTime, formatPrice } from '../../lib/formatters'
import { Panel } from '../Panel'
import { Badge } from '../ui/Badge'

export const DECISION_TONE = {
  HOLD: 'neutral',
  MOVE_TO_BREAKEVEN: 'info',
  TIGHTEN_STOP: 'warn',
  LET_PROFIT_RUN: 'up',
  EXTEND_TAKE_PROFIT: 'up',
  PARTIAL_TAKE_PROFIT: 'info',
  EXIT_NOW: 'down',
}

export const label = (decision) => String(decision || '').replace(/_/g, ' ')
const num = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a')

function ReviewOutcome({ review }) {
  if (review.executed === false) return <span className="text-rose-300">Not executed: {review.rejectedReason}</span>
  if (review.advisoryOnly) return <span className="text-amber-200">Advisory only (not executed)</span>
  if (review.applied) return <span className="text-emerald-300">Done: {review.applied}</span>
  return null
}

function ReviewTimeline({ reviews }) {
  return (
    <ol className="mt-3 grid gap-2 border-t border-white/10 pt-3">
      {reviews.map((review) => (
        <li key={review.at} className="rounded-xl border border-white/5 bg-slate-950/40 px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-slate-500">{formatDateTime(review.at)}</span>
            <Badge tone={DECISION_TONE[review.decision] || 'neutral'}>{label(review.decision)}</Badge>
            <span className="text-slate-400">Thesis {review.thesisConfidence}%</span>
            {review.rMultiple != null ? <span className="text-slate-400">{num(review.rMultiple)}R at {formatPrice(review.price, 4)}</span> : null}
            <ReviewOutcome review={review} />
          </div>
          {review.reason ? <p className="mt-1.5 leading-relaxed text-slate-300">{review.reason}</p> : null}
          {review.whatChanged ? <p className="mt-1 leading-relaxed text-slate-500"><span className="text-slate-400">Changed:</span> {review.whatChanged}</p> : null}
          {review.expectedNext ? <p className="mt-1 leading-relaxed text-slate-500"><span className="text-slate-400">Expects:</span> {review.expectedNext}</p> : null}
          {review.invalidation ? <p className="mt-1 leading-relaxed text-slate-500"><span className="text-slate-400">Invalidation:</span> {review.invalidation}</p> : null}
          {review.warning ? <p className="mt-1 leading-relaxed text-amber-200">{review.warning}</p> : null}
        </li>
      ))}
    </ol>
  )
}

function ManagedTrade({ trade, onReview, reviewing }) {
  const [open, setOpen] = useState(false)
  const reviews = trade.managerReviews || []
  const latest = reviews[0]
  const isOpen = trade.status === 'OPEN'
  const targetText = trade.takeProfit == null ? 'open-ended' : formatPrice(trade.takeProfit, 4)
  const stopMoved = trade.initialStopLoss != null && Number(trade.initialStopLoss) !== Number(trade.stopLoss)
  const targetMoved = trade.initialTakeProfit != null && Number(trade.initialTakeProfit) !== Number(trade.takeProfit ?? -1)

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold text-white">{trade.symbol}</span>
        <Badge tone={trade.side === 'BUY' ? 'up' : 'down'}>{trade.side === 'BUY' ? 'LONG' : 'SHORT'}</Badge>
        <Badge tone={isOpen ? 'info' : 'neutral'}>{isOpen ? 'Open' : trade.closedBy === 'position-manager' ? 'Closed by Position Manager' : 'Closed'}</Badge>
        {trade.partialCloses?.length ? <Badge tone="info">{trade.partialCloses.length} partial{trade.partialCloses.length > 1 ? 's' : ''}</Badge> : null}
        <span className="text-xs text-slate-400">
          Stop {formatPrice(trade.stopLoss, 4)}{stopMoved ? ` (was ${formatPrice(trade.initialStopLoss, 4)})` : ''} · Target {targetText}{targetMoved && trade.initialTakeProfit ? ` (was ${formatPrice(trade.initialTakeProfit, 4)})` : ''}
        </span>
        {isOpen ? (
          <button
            type="button"
            disabled={reviewing}
            onClick={() => onReview(trade.id)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-white/15 px-3 py-1 text-xs font-medium text-slate-200 hover:border-white/30 disabled:opacity-50"
          >
            {reviewing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {reviewing ? 'Reviewing…' : 'Review now'}
          </button>
        ) : null}
      </div>

      {latest ? (
        <div className="mt-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-slate-500">Latest ({formatDateTime(latest.at)})</span>
            <Badge tone={DECISION_TONE[latest.decision] || 'neutral'}>{label(latest.decision)}</Badge>
            <span className="text-slate-400">Thesis {latest.thesisConfidence}%{trade.entryContext?.entryConfidence != null ? ` (entry ${trade.entryContext.entryConfidence}%)` : ''}</span>
            <ReviewOutcome review={latest} />
          </div>
          {latest.reason ? <p className="mt-1.5 leading-relaxed text-slate-300">{latest.reason}</p> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">{isOpen ? 'No review yet — the first one runs about 5 minutes after entry.' : 'This trade was never reviewed.'}</p>
      )}
      {trade.managerLastError ? <p className="mt-2 text-xs text-amber-200">Last review failed: {trade.managerLastError}</p> : null}

      {reviews.length > 1 || (reviews.length === 1 && (latest.whatChanged || latest.expectedNext || latest.invalidation)) ? (
        <>
          <button type="button" onClick={() => setOpen((value) => !value)} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-sky-300 hover:underline">
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {open ? 'Hide' : 'Show'} all {reviews.length} review{reviews.length > 1 ? 's' : ''}
          </button>
          {open ? <ReviewTimeline reviews={reviews} /> : null}
        </>
      ) : null}
    </div>
  )
}

/**
 * The Position Manager's view of the AI trades in one wallet: open positions only, each with a Review now button and its
 * full review timeline. A trade drops out the moment it closes — its history stays visible in Trade History below.
 */
export function PositionManagerPanel({ mode, trades, refresh }) {
  const [reviewing, setReviewing] = useState({})
  const [error, setError] = useState('')
  // Open trades only: once a trade closes it belongs to Trade History below, not here — it never lingers in this list
  // (and is never paginated back in) as the wallet keeps trading and the list turns over.
  const shown = trades.filter((trade) => trade.status === 'OPEN')

  async function reviewNow(tradeId) {
    setReviewing((current) => ({ ...current, [tradeId]: true }))
    setError('')
    try {
      await postJson(`/api/ai-trading/trades/${encodeURIComponent(tradeId)}/review`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The review failed.')
    } finally {
      setReviewing((current) => ({ ...current, [tradeId]: false }))
    }
  }

  if (!shown.length) return null

  return (
    <Panel title="Position Manager" action={<Badge tone="info">AI, after entry</Badge>}>
      <div className="grid gap-3">
        <p className="text-xs leading-relaxed text-slate-500">
          An AI trader re-reads each open trade every 5 minutes and decides what to do with it: hold, move to breakeven, tighten the stop, let a winner run,
          extend the target, take a partial profit, or exit early. Code only checks that a change is valid and never adds risk.
          {mode === 'real' ? ' On real-money positions it only advises unless you switch on "Position Manager acts on real money" in AI Settings.' : ''}
        </p>
        {error ? <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-2.5 text-xs text-rose-200">{error}</div> : null}
        {shown.map((trade) => <ManagedTrade key={trade.id} trade={trade} onReview={reviewNow} reviewing={Boolean(reviewing[trade.id])} />)}
      </div>
    </Panel>
  )
}

import { useEffect, useState } from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import { CoinAvatar } from './CoinAvatar'
import { formatDateTimeWithSeconds, formatPrice } from '../lib/formatters'
import { usePersistentBoolean } from '../lib/usePersistentBoolean'
import { formatTradeSource } from '../lib/trades'
import { Panel } from './Panel'
import { TradeDirectionBadge } from './TradeDirectionBadge'

// SaaS Phase 8E: extracted out of MockTradingPage.jsx so Real Money Trading can reuse the exact
// same "one row per scheduler run" log view, just fed a different (pre-filtered) autoTradeLog.

const ACTIVITY_PAGE_SIZE = 20

function summarizeActivitySteps(steps) {
  return steps.reduce((summary, step) => {
    if (step.status === 'pass') {
      summary.pass += 1
    } else if (step.status === 'blocked') {
      summary.blocked += 1
    } else {
      summary.info += 1
    }

    return summary
  }, { pass: 0, blocked: 0, info: 0 })
}

function getStepHighlightLabel(step) {
  if (step.symbol) {
    const direction = step.direction ? ` ${step.direction}` : ''
    return `${step.symbol}${direction}`.trim()
  }

  return step.message
    .replace(/\.$/, '')
    .replace(/^Found\s+/i, '')
}

function getCollapsedStepHighlights(steps) {
  const seen = new Set()

  return steps
    .filter((step) => step.status === 'pass' || step.status === 'blocked')
    .map((step) => ({
      label: getStepHighlightLabel(step),
      status: step.status,
    }))
    .filter((item) => {
      if (!item.label || seen.has(item.label)) {
        return false
      }

      seen.add(item.label)
      return true
    })
    .slice(0, 4)
}

function getAiDecisionSummary(entry) {
  const reason = String(entry?.result?.reason || '')
  const steps = entry?.result?.steps || []
  const aiStep = steps.find((step) => String(step?.message || '').startsWith('AI filter scored '))
  const paperOnlyStep = steps.find((step) => String(step?.message || '').startsWith('Paper-only AI filter would '))
  const aiModeStep = steps.find((step) => String(step?.message || '').startsWith('AI mode for '))

  if (reason.includes('AI filter skipped')) {
    const scoreMatch = reason.match(/score\s+(\d+)\/(\d+)/i)
    return {
      label: scoreMatch ? `AI skipped ${scoreMatch[1]}/${scoreMatch[2]}` : 'AI skipped',
      tone: 'skip',
      detail: null,
      mode: aiModeStep?.message.includes('paper-only') ? 'paper-only' : aiModeStep?.message.includes('hard-block') ? 'hard-block' : null,
    }
  }

  if (paperOnlyStep) {
    return {
      label: paperOnlyStep.message.includes('accept') ? 'AI accepted (paper-only)' : 'AI skipped (paper-only)',
      tone: paperOnlyStep.message.includes('accept') ? 'accept' : 'skip',
      detail: null,
      mode: aiModeStep?.message.includes('paper-only') ? 'paper-only' : aiModeStep?.message.includes('hard-block') ? 'hard-block' : null,
    }
  }

  if (aiStep) {
    const scoreMatch = aiStep.message.match(/scored .*? (\d+)\/100 .*using ([a-z0-9:-]+) policy \(threshold (\d+)\)/i)
    const accepted = String(aiStep.status || '').toLowerCase() === 'pass'

    return {
      label: scoreMatch
        ? `${accepted ? 'AI accepted' : 'AI skipped'} ${scoreMatch[1]}/${scoreMatch[3]}`
        : accepted ? 'AI accepted' : 'AI skipped',
      tone: accepted ? 'accept' : 'skip',
      detail: scoreMatch ? `policy ${scoreMatch[2]}` : null,
      mode: aiModeStep?.message.includes('paper-only') ? 'paper-only' : aiModeStep?.message.includes('hard-block') ? 'hard-block' : null,
    }
  }

  return null
}

function AutoTradeActivityEntry({ entry, defaultExpanded = false }) {
  const [expanded, setExpanded] = usePersistentBoolean(
    `mock-trading:auto-trade-activity:${entry.id}:expanded`,
    defaultExpanded,
  )
  const order = entry.result?.order || null
  const walletName = entry.walletName || order?.walletName || null
  const steps = entry.result?.steps || []
  const stepSummary = summarizeActivitySteps(steps)
  const collapsedHighlights = getCollapsedStepHighlights(steps)
  const aiDecision = getAiDecisionSummary(entry)

  return (
    <div className="overflow-hidden rounded-[26px] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.9),rgba(15,23,42,0.72))] shadow-[0_18px_40px_rgba(15,23,42,0.16)]">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-start justify-between gap-4 px-5 py-5 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {order ? <CoinAvatar symbol={order.symbol} size="sm" /> : null}
            {order ? <div className="text-sm font-semibold text-white">{order.symbol}</div> : null}
            {order ? <TradeDirectionBadge side={order.side} /> : null}
            {order?.signalModelName ? (
              <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-sky-200">
                {order.signalModelName}
              </span>
            ) : null}
            {walletName ? (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-100">
                {walletName}
              </span>
            ) : null}
            <span className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
              entry.result.executed ? 'bg-emerald-400/12 text-emerald-300' : 'bg-amber-400/12 text-amber-300'
            }`}>
              {entry.result.executed ? 'Order Sent' : 'No Trade'}
            </span>
            {aiDecision ? (
              <span className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                aiDecision.tone === 'accept'
                  ? 'bg-sky-400/12 text-sky-200'
                  : 'bg-rose-400/12 text-rose-200'
              }`}>
                {aiDecision.label}
              </span>
            ) : null}
            {aiDecision?.detail ? (
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-300">
                {aiDecision.detail}
              </span>
            ) : null}
            {aiDecision?.mode ? (
              <span className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] ${
                aiDecision.mode === 'paper-only'
                  ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                  : 'border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200'
              }`}>
                {aiDecision.mode}
              </span>
            ) : null}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs uppercase tracking-[0.18em] text-slate-500">
            <span>{formatDateTimeWithSeconds(entry.timestamp)}</span>
            {order ? <span>{formatTradeSource(order.source)}</span> : null}
            <span>{steps.length} step{steps.length === 1 ? '' : 's'}</span>
          </div>

          <div className="mt-2 truncate text-sm text-slate-300">
            {entry.result.reason}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-slate-400 sm:inline-flex">
            {expanded ? 'Collapse' : 'Expand'}
          </span>
          <ChevronDown className={`mt-1 h-4 w-4 text-slate-500 transition ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>

      {!expanded ? (
        <div className="border-t border-white/10 px-5 py-4">
          {order ? (
            <div className="flex flex-wrap gap-2 text-xs text-slate-300">
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
                Entry {formatPrice(order.entryPrice, 5)}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
                SL {formatPrice(order.stopLoss, 5)}
              </span>
              <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
                TP {formatPrice(order.takeProfit, 5)}
              </span>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.18em] text-slate-400">
            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-emerald-200">
              {stepSummary.pass} pass
            </span>
            <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-amber-200">
              {stepSummary.blocked} blocked
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">
              {stepSummary.info} info
            </span>
          </div>

          {collapsedHighlights.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {collapsedHighlights.map((item) => (
                <span
                  key={`${entry.id}-${item.label}`}
                  className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                    item.status === 'pass'
                      ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                      : 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                  }`}
                >
                  {item.label}
                </span>
              ))}
            </div>
          ) : null}
          {aiDecision ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                aiDecision.tone === 'accept'
                  ? 'border-sky-400/20 bg-sky-400/10 text-sky-200'
                  : 'border-rose-400/20 bg-rose-400/10 text-rose-200'
              }`}>
                {aiDecision.label}
              </span>
              {aiDecision.detail ? (
                <span className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-300">
                  {aiDecision.detail}
                </span>
              ) : null}
              {aiDecision.mode ? (
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${
                  aiDecision.mode === 'paper-only'
                    ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                    : 'border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200'
                }`}>
                  {aiDecision.mode}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="border-t border-white/10 px-5 py-5">
          {order ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <CoinAvatar symbol={order.symbol} size="sm" />
                <div className="text-sm font-semibold text-white">{order.symbol}</div>
                <TradeDirectionBadge side={order.side} />
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">
                  {formatTradeSource(order.source)}
                </div>
                {aiDecision ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] ${
                    aiDecision.tone === 'accept'
                      ? 'border-sky-400/20 bg-sky-400/10 text-sky-200'
                      : 'border-rose-400/20 bg-rose-400/10 text-rose-200'
                  }`}>
                    {aiDecision.label}
                  </span>
                ) : null}
                {aiDecision?.detail ? (
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-300">
                    {aiDecision.detail}
                  </span>
                ) : null}
                {aiDecision?.mode ? (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] ${
                    aiDecision.mode === 'paper-only'
                      ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
                      : 'border-fuchsia-400/20 bg-fuchsia-400/10 text-fuchsia-200'
                  }`}>
                    {aiDecision.mode}
                  </span>
                ) : null}
                {order.signalModelName ? (
                  <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-sky-200">
                    {order.signalModelName}
                  </span>
                ) : null}
                {walletName ? (
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] text-slate-100">
                    {walletName}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3 text-sm text-slate-400">
                <span>Entry {formatPrice(order.entryPrice, 5)}</span>
                <span>SL {formatPrice(order.stopLoss, 5)}</span>
                <span>TP {formatPrice(order.takeProfit, 5)}</span>
              </div>
            </>
          ) : null}

          <div className="mt-3 text-sm text-slate-300">{entry.result.reason}</div>

          <div className="mt-4 space-y-2">
            {steps.map((step, index) => (
              <div key={`${entry.id}-${index}`} className="flex items-start gap-3 text-sm">
                <span className={`mt-0.5 h-2.5 w-2.5 rounded-full ${
                  step.status === 'pass'
                    ? 'bg-emerald-400'
                    : step.status === 'blocked'
                      ? 'bg-amber-400'
                      : 'bg-slate-500'
                }`} />
                <span className="text-slate-300">{step.message}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function AutoTradeActivityView({ autoTradeLog, title = 'Auto Trade Activity', emptyMessage = 'No auto-trade activity yet.' }) {
  const [currentPage, setCurrentPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(autoTradeLog.length / ACTIVITY_PAGE_SIZE))

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages))
  }, [totalPages])

  const pageStartIndex = (currentPage - 1) * ACTIVITY_PAGE_SIZE
  const pageEndIndex = Math.min(pageStartIndex + ACTIVITY_PAGE_SIZE, autoTradeLog.length)
  const pageEntries = autoTradeLog.slice(pageStartIndex, pageEndIndex)

  return (
    <Panel title={title} action={<Bot className="h-4 w-4 text-sky-300" />}>
      <div className="rounded-2xl border border-sky-400/20 bg-sky-400/10 px-4 py-4 text-sm text-sky-100">
        Each row below shows one scheduler run. Open a row to see the exact steps, including bot checks, AI filter decisions, and why a trade was placed or skipped.
      </div>

      {autoTradeLog.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
          {emptyMessage}
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
            <div>
              Showing <span className="font-semibold text-white">{pageStartIndex + 1}-{pageEndIndex}</span> of{' '}
              <span className="font-semibold text-white">{autoTradeLog.length}</span> runs
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                disabled={currentPage <= 1}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <div className="min-w-[5.5rem] text-center text-xs uppercase tracking-[0.16em] text-slate-400">
                Page {currentPage} / {totalPages}
              </div>
              <button
                type="button"
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                disabled={currentPage >= totalPages}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {pageEntries.map((entry) => (
              <AutoTradeActivityEntry
                key={entry.id}
                entry={entry}
                defaultExpanded={false}
              />
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}

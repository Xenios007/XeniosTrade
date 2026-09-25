import { ArrowUpDown, Bot, ListFilter } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { formatDateTime, formatPercent, formatPrice } from '../lib/formatters'
import { getMarginModeLabel } from '../lib/marginModes'
import { SIGNAL_MODELS } from '../lib/signalModels'
import {
  formatTradeSource,
  getTradePnlAmount,
  getTradeRoiPercent,
  getTradeTakeProfitGap,
  getTradeTakeProfitGapPercent,
  isTradeOpen,
} from '../lib/trades'
import { CoinAvatar } from './CoinAvatar'
import { Panel } from './Panel'
import { PriceDirectionPill, getPriceDirectionMeta } from './PriceDirectionPill'
import { TradeDirectionBadge } from './TradeDirectionBadge'

const TRADE_HISTORY_PAGE_SIZE = 15

const TRADE_HISTORY_ARRANGE_OPTIONS = [
  { id: 'latest', label: 'Latest First' },
  { id: 'oldest', label: 'Oldest First' },
  { id: 'wallet', label: 'Wallet' },
  { id: 'bot', label: 'Bot' },
  { id: 'symbol', label: 'Symbol' },
  { id: 'status', label: 'Status' },
  { id: 'pnl-high', label: 'Highest P/L' },
  { id: 'pnl-low', label: 'Lowest P/L' },
]
// AI Trading's history has no bot to sort/filter by: every row is the same one AI model.
const TRADE_HISTORY_ARRANGE_OPTIONS_NO_BOT = TRADE_HISTORY_ARRANGE_OPTIONS.filter((option) => option.id !== 'bot')

const TRADE_STATUS_SORT_ORDER = {
  OPEN: 0,
  CLOSED_TP: 1,
  CLOSED_MANUAL: 2,
  CLOSED_SL: 3,
}

const TRADE_BOT_FILTER_OPTIONS = [
  { id: 'all', label: 'All Bots' },
  ...SIGNAL_MODELS.map((model) => ({ id: model.id, label: model.name })),
]

const TRADE_STATUS_FILTER_OPTIONS = [
  { id: 'all', label: 'All Statuses' },
  { id: 'OPEN', label: 'Open' },
  { id: 'CLOSED_TP', label: 'Closed · TP' },
  { id: 'CLOSED_SL', label: 'Closed · SL' },
  { id: 'CLOSED_MANUAL', label: 'Closed · Manual' },
]

function formatSignedPrice(value) {
  const number = Number(value || 0)
  const sign = number > 0 ? '+' : ''
  return `${sign}${formatPrice(number, 5)}`
}

function getRunningTone(value) {
  if (value > 0) {
    return 'text-emerald-300'
  }

  if (value < 0) {
    return 'text-rose-300'
  }

  return 'text-slate-300'
}

function getTradeStatusMeta(trade) {
  if (trade.status === 'CLOSED_TP') {
    return {
      tone: 'bg-emerald-400/12 text-emerald-300',
      label: 'CLOSED TP',
    }
  }

  if (trade.status === 'CLOSED_SL') {
    return {
      tone: 'bg-rose-400/12 text-rose-300',
      label: 'CLOSED SL',
    }
  }

  if (trade.status === 'CLOSED_MANUAL') {
    const pnl = Number(trade.pnl || 0)
    return {
      tone: pnl > 0
        ? 'bg-emerald-400/12 text-emerald-300'
        : pnl < 0
          ? 'bg-rose-400/12 text-rose-300'
          : 'bg-slate-400/12 text-slate-300',
      label: 'MANUAL CLOSE',
    }
  }

  if (trade.status === 'OPEN') {
    return {
      tone: 'bg-amber-400/12 text-amber-300',
      label: 'OPEN',
    }
  }

  return {
    tone: 'bg-slate-400/12 text-slate-300',
    label: String(trade.status || 'UNKNOWN').replaceAll('_', ' '),
  }
}

function getWalletBadgeTone(walletColorKey) {
  if (walletColorKey === 'emerald') {
    return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
  }

  if (walletColorKey === 'slate') {
    return 'border-white/10 bg-white/[0.04] text-slate-200'
  }

  return 'border-sky-400/20 bg-sky-400/10 text-sky-100'
}

function compareLabels(left, right) {
  return String(left || '').localeCompare(String(right || ''))
}

/** Page numbers to render around `current`, e.g. [1, 'ellipsis', 4, 5, 6, 'ellipsis', 20]. */
function getPaginationRange(current, total) {
  const siblingCount = 1
  const totalVisible = siblingCount * 2 + 5

  if (total <= totalVisible) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }

  const leftSibling = Math.max(current - siblingCount, 1)
  const rightSibling = Math.min(current + siblingCount, total)
  const showLeftEllipsis = leftSibling > 2
  const showRightEllipsis = rightSibling < total - 1

  if (!showLeftEllipsis && showRightEllipsis) {
    const leftCount = 3 + siblingCount * 2
    return [...Array.from({ length: leftCount }, (_, i) => i + 1), 'ellipsis', total]
  }

  if (showLeftEllipsis && !showRightEllipsis) {
    const rightCount = 3 + siblingCount * 2
    return [1, 'ellipsis', ...Array.from({ length: rightCount }, (_, i) => total - rightCount + i + 1)]
  }

  return [1, 'ellipsis', ...Array.from({ length: rightSibling - leftSibling + 1 }, (_, i) => leftSibling + i), 'ellipsis', total]
}

function getTradeSortTime(trade) {
  return Number(trade?.transactTime || trade?.closedAt || 0)
}

function getSortableTradePnl(trade, livePrices = {}) {
  if (isTradeOpen(trade)) {
    const runningPnl = getTradePnlAmount(trade, livePrices?.[trade.symbol])
    return runningPnl == null ? 0 : Number(runningPnl)
  }

  return Number(trade?.pnl || 0)
}

function formatAiPolicyLabel(policySource) {
  const normalized = String(policySource || '').trim()

  if (!normalized || normalized === 'none') {
    return 'No policy'
  }

  if (normalized === 'shared') {
    return 'Shared policy'
  }

  if (normalized === 'shared:unclassified') {
    return 'Shared fallback'
  }

  if (normalized.endsWith(':unclassified')) {
    return `${normalized.replace(':unclassified', '').toUpperCase()} fallback`
  }

  return normalized.toUpperCase()
}

function getAiEntryMeta(aiDecision) {
  if (!aiDecision || !Number.isFinite(Number(aiDecision.finalScore))) {
    return null
  }

  const accepted = Boolean(aiDecision.accept)
  const entryQualityScore = Number(aiDecision.entryQualityScore)
  const entryQualityDetail = Number.isFinite(entryQualityScore)
    ? `Entry quality ${entryQualityScore}/100`
    : null
  const setupFamily = aiDecision.setupFamily || 'Unclassified setup'
  const policyLabel = formatAiPolicyLabel(aiDecision.policySource)

  return {
    label: accepted ? 'AI Entry' : 'AI Entry Skip',
    value: `${accepted ? 'Accept' : 'Skip'} ${aiDecision.finalScore}/${aiDecision.thresholdScore}`,
    detail: `${setupFamily} via ${policyLabel}${entryQualityDetail ? ` • ${entryQualityDetail}` : ''}`,
    tone: accepted ? 'text-emerald-300' : 'text-rose-300',
    cardTone: accepted ? 'border-emerald-400/20 bg-emerald-400/10' : 'border-rose-400/20 bg-rose-400/10',
  }
}

function getAiManagementMeta(aiManagement) {
  if (!aiManagement || !Number.isFinite(Number(aiManagement.finalScore))) {
    return null
  }

  const action = String(aiManagement.action || 'adjusted')
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .toUpperCase()
  const reason = String(aiManagement.reason || 'AI adjusted the open-trade management levels.')
  const managedAt = aiManagement.managedAt ? ` • ${formatDateTime(aiManagement.managedAt)}` : ''

  return {
    label: 'AI TP / SL',
    value: `${action} ${aiManagement.finalScore}/${aiManagement.thresholdScore}`,
    detail: `${reason}${managedAt}`,
    tone: 'text-sky-200',
    cardTone: 'border-sky-400/20 bg-sky-400/10',
  }
}

function getAiMonitorMeta({ trade, isOpen, aiEntryMeta, aiManagementMeta }) {
  if (!isOpen || !aiEntryMeta) {
    return null
  }

  if (aiManagementMeta) {
    return {
      label: 'AI Managing',
      detail: "AI has already adjusted this open trade's TP or SL using the learned policy.",
      tone: 'text-sky-200',
      cardTone: 'border-sky-400/20 bg-sky-400/10',
    }
  }

  return {
    label: 'AI On Watch',
    detail: `AI is monitoring ${trade.symbol} and will only adjust TP/SL after the live progress triggers are reached.`,
    tone: 'text-amber-200',
    cardTone: 'border-amber-400/20 bg-amber-400/10',
  }
}

export function TradeHistoryTable({
  trades,
  livePrices = {},
  liveDirections = {},
  title = 'Trade History',
  closingTradeIds = {},
  onManualClose,
  // Off for AI Trading's history: it only ever has one signal model, so a bot picker (and sorting by bot) has nothing to filter.
  showBotFilter = true,
}) {
  const [arrangeBy, setArrangeBy] = useState('latest')
  const [botFilter, setBotFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [currentPage, setCurrentPage] = useState(1)
  const filteredTrades = useMemo(() => trades.filter((trade) => (
    (!showBotFilter || botFilter === 'all' || trade.signalModelId === botFilter)
    && (statusFilter === 'all' || trade.status === statusFilter)
  )), [trades, botFilter, statusFilter, showBotFilter])
  const openTrades = filteredTrades.filter((trade) => isTradeOpen(trade)).length
  const arrangedTrades = useMemo(() => {
    const nextTrades = [...filteredTrades]

    nextTrades.sort((left, right) => {
      const newestFirst = getTradeSortTime(right) - getTradeSortTime(left)

      if (arrangeBy === 'oldest') {
        return getTradeSortTime(left) - getTradeSortTime(right)
      }

      if (arrangeBy === 'wallet') {
        return compareLabels(left.walletName || 'Unassigned', right.walletName || 'Unassigned')
          || compareLabels(left.signalModelName || '', right.signalModelName || '')
          || newestFirst
      }

      if (arrangeBy === 'bot') {
        return compareLabels(left.signalModelName || 'Unassigned', right.signalModelName || 'Unassigned')
          || compareLabels(left.walletName || '', right.walletName || '')
          || newestFirst
      }

      if (arrangeBy === 'symbol') {
        return compareLabels(left.symbol, right.symbol)
          || newestFirst
      }

      if (arrangeBy === 'status') {
        return (TRADE_STATUS_SORT_ORDER[left.status] ?? 99) - (TRADE_STATUS_SORT_ORDER[right.status] ?? 99)
          || newestFirst
      }

      if (arrangeBy === 'pnl-high') {
        return getSortableTradePnl(right, livePrices) - getSortableTradePnl(left, livePrices)
          || newestFirst
      }

      if (arrangeBy === 'pnl-low') {
        return getSortableTradePnl(left, livePrices) - getSortableTradePnl(right, livePrices)
          || newestFirst
      }

      return newestFirst
    })

    return nextTrades
  }, [arrangeBy, livePrices, filteredTrades])
  const totalPages = Math.max(1, Math.ceil(arrangedTrades.length / TRADE_HISTORY_PAGE_SIZE))
  const pageStartIndex = (currentPage - 1) * TRADE_HISTORY_PAGE_SIZE
  const pageEndIndex = Math.min(pageStartIndex + TRADE_HISTORY_PAGE_SIZE, arrangedTrades.length)
  const paginatedTrades = arrangedTrades.slice(pageStartIndex, pageEndIndex)

  useEffect(() => {
    setCurrentPage(1)
  }, [arrangeBy, botFilter, statusFilter, trades.length])

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages))
  }, [totalPages])

  const paginationControls = arrangedTrades.length > TRADE_HISTORY_PAGE_SIZE ? (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
      <div>
        Showing <span className="font-semibold text-white">{pageStartIndex + 1}-{pageEndIndex}</span> of <span className="font-semibold text-white">{arrangedTrades.length}</span> trades
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
          disabled={currentPage <= 1}
          aria-label="Previous page"
          className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        {getPaginationRange(currentPage, totalPages).map((item, index) => (
          item === 'ellipsis' ? (
            <span key={`ellipsis-${index}`} className="px-1 text-xs text-slate-500">
              &hellip;
            </span>
          ) : (
            <button
              key={item}
              type="button"
              onClick={() => setCurrentPage(item)}
              aria-current={item === currentPage ? 'page' : undefined}
              className={`h-8 min-w-[2rem] rounded-full border px-2.5 text-xs font-semibold transition ${
                item === currentPage
                  ? 'border-sky-300/50 bg-sky-400/15 text-sky-100'
                  : 'border-white/10 bg-white/[0.04] text-slate-300 hover:border-white/20'
              }`}
            >
              {item}
            </button>
          )
        ))}
        <button
          type="button"
          onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
          disabled={currentPage >= totalPages}
          aria-label="Next page"
          className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  ) : null

  return (
    <Panel
      title={title}
      action={(
        <div className="flex flex-wrap items-center gap-2">
          {showBotFilter ? (
            <div className="flex items-center gap-2 rounded-full border border-emerald-300/20 bg-slate-950/35 px-3 py-2 text-emerald-100">
              <Bot className="h-3.5 w-3.5 shrink-0 text-emerald-200" />
              <span className="hidden text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-100/70 sm:inline">
                Bot
              </span>
              <select
                value={botFilter}
                onChange={(event) => setBotFilter(event.target.value)}
                className="min-w-[7rem] bg-transparent text-[11px] font-medium uppercase tracking-[0.16em] text-emerald-100 outline-none"
              >
                {TRADE_BOT_FILTER_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id} className="bg-slate-950 text-white">
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex items-center gap-2 rounded-full border border-amber-300/20 bg-slate-950/35 px-3 py-2 text-amber-100">
            <ListFilter className="h-3.5 w-3.5 shrink-0 text-amber-200" />
            <span className="hidden text-[10px] font-medium uppercase tracking-[0.18em] text-amber-100/70 sm:inline">
              Status
            </span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="min-w-[7.5rem] bg-transparent text-[11px] font-medium uppercase tracking-[0.16em] text-amber-100 outline-none"
            >
              {TRADE_STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option.id} value={option.id} className="bg-slate-950 text-white">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-sky-300/20 bg-slate-950/35 px-3 py-2 text-sky-100">
            <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-sky-200" />
            <span className="hidden text-[10px] font-medium uppercase tracking-[0.18em] text-sky-100/70 sm:inline">
              Arrange By
            </span>
            <select
              value={arrangeBy}
              onChange={(event) => setArrangeBy(event.target.value)}
              className="min-w-[8.75rem] bg-transparent text-[11px] font-medium uppercase tracking-[0.16em] text-sky-100 outline-none"
            >
              {(showBotFilter ? TRADE_HISTORY_ARRANGE_OPTIONS : TRADE_HISTORY_ARRANGE_OPTIONS_NO_BOT).map((option) => (
                <option key={option.id} value={option.id} className="bg-slate-950 text-white">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    >
      {arrangedTrades.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
          {trades.length === 0 ? 'No trades recorded yet.' : `No trades match the selected ${showBotFilter ? 'bot/status filters' : 'status filter'}.`}
        </div>
      ) : (
        <div className="min-w-0 space-y-3">
          {openTrades > 0 ? (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-4 text-sm text-amber-100">
              {openTrades} trade{openTrades === 1 ? '' : 's'} still open. Live rows below show the current market price, the gap to TP, and running P/L just like a position monitor. Use Manual Close on any live row to exit immediately at the latest market price.
            </div>
          ) : null}

          {paginationControls}

          {paginatedTrades.map((trade) => {
            const currentPrice = livePrices?.[trade.symbol]
            const currentDirection = liveDirections?.[trade.symbol] || 'flat'
            const currentDirectionMeta = getPriceDirectionMeta(currentDirection)
            const isOpen = isTradeOpen(trade)
            const isClosing = Boolean(closingTradeIds?.[trade.id])
            const runningPnl = isOpen ? getTradePnlAmount(trade, currentPrice) : null
            const runningRoi = isOpen ? getTradeRoiPercent(trade, currentPrice) : null
            const takeProfitGap = isOpen ? getTradeTakeProfitGap(trade, currentPrice) : null
            const takeProfitGapPercent = isOpen ? getTradeTakeProfitGapPercent(trade, currentPrice) : null
            const statusMeta = getTradeStatusMeta(trade)
            const displayedPnl = isOpen ? runningPnl : trade.pnl == null ? null : Number(trade.pnl)
            const displayedRoi = isOpen
              ? runningRoi
              : trade.pnl == null || !trade.margin
                ? null
                : (Number(trade.pnl || 0) / Number(trade.margin || 1)) * 100
            const aiEntryMeta = getAiEntryMeta(trade.aiDecision)
            const aiManagementMeta = getAiManagementMeta(trade.aiManagement)
            const aiMonitorMeta = getAiMonitorMeta({ trade, isOpen, aiEntryMeta, aiManagementMeta })

            return (
              <div key={trade.id} className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CoinAvatar symbol={trade.symbol} size="md" />
                      <div className="text-sm font-semibold text-white">{trade.symbol}</div>
                      <TradeDirectionBadge side={trade.side} />
                    </div>
                    <div className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">
                      {formatTradeSource(trade.source)} / {trade.mode} / {getMarginModeLabel(trade.marginMode)}
                    </div>
                    {trade.walletName ? (
                      <div className="mt-2">
                        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${getWalletBadgeTone(trade.walletColorKey)}`}>
                          {trade.walletName}
                        </span>
                      </div>
                    ) : null}
                    {trade.signalSummary ? (
                      <div className="mt-2 break-words text-sm text-slate-400">{trade.signalSummary}</div>
                    ) : null}
                    {aiEntryMeta || aiManagementMeta || aiMonitorMeta ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {aiEntryMeta ? (
                          <div className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${aiEntryMeta.cardTone} ${aiEntryMeta.tone}`}>
                            {aiEntryMeta.value}
                          </div>
                        ) : null}
                        {aiManagementMeta ? (
                          <div className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${aiManagementMeta.cardTone} ${aiManagementMeta.tone}`}>
                            {aiManagementMeta.value}
                          </div>
                        ) : null}
                        {aiMonitorMeta ? (
                          <div className={`rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${aiMonitorMeta.cardTone} ${aiMonitorMeta.tone}`}>
                            {aiMonitorMeta.label}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {/* w-full on its own line at narrow widths (never sits beside the flex-1 text block, which otherwise loses width
                      to this column for its whole height even where this column has nothing next to it) - compact corner layout
                      returns at sm: and up. */}
                  <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:flex-col sm:items-end sm:justify-start sm:gap-2">
                    <div className={`rounded-full px-3 py-1 text-center text-[11px] font-medium uppercase tracking-[0.18em] ${statusMeta.tone}`}>
                      {statusMeta.label}
                    </div>
                    {isOpen && onManualClose ? (
                      <div className="flex flex-col items-end gap-1">
                        <button
                          type="button"
                          onClick={() => onManualClose(trade.id)}
                          disabled={isClosing}
                          className="rounded-full border border-sky-300/25 bg-sky-400/10 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-sky-100 transition hover:border-sky-300/40 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-slate-400"
                        >
                          {isClosing ? 'Closing...' : 'Manual Close'}
                        </button>
                        <div className="text-[10px] uppercase tracking-[0.16em] text-slate-500">
                          Exit at latest market price
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                {aiEntryMeta || aiManagementMeta || aiMonitorMeta ? (
                  <div className={`mt-4 grid gap-3 ${(aiEntryMeta && (aiManagementMeta || aiMonitorMeta)) || (aiManagementMeta && aiMonitorMeta) ? 'xl:grid-cols-2' : ''}`}>
                    {aiEntryMeta ? (
                      <div className={`min-w-0 rounded-2xl border px-4 py-3 ${aiEntryMeta.cardTone}`}>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{aiEntryMeta.label}</div>
                        <div className={`mt-1 break-words text-sm font-semibold ${aiEntryMeta.tone}`}>{aiEntryMeta.value}</div>
                        <div className="mt-1 break-words text-xs text-slate-300">{aiEntryMeta.detail}</div>
                      </div>
                    ) : null}
                    {aiManagementMeta ? (
                      <div className={`min-w-0 rounded-2xl border px-4 py-3 ${aiManagementMeta.cardTone}`}>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{aiManagementMeta.label}</div>
                        <div className={`mt-1 break-words text-sm font-semibold ${aiManagementMeta.tone}`}>{aiManagementMeta.value}</div>
                        <div className="mt-1 break-words text-xs text-slate-300">{aiManagementMeta.detail}</div>
                      </div>
                    ) : null}
                    {aiMonitorMeta && !aiManagementMeta ? (
                      <div className={`min-w-0 rounded-2xl border px-4 py-3 ${aiMonitorMeta.cardTone}`}>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Open-Trade AI</div>
                        <div className={`mt-1 break-words text-sm font-semibold ${aiMonitorMeta.tone}`}>{aiMonitorMeta.label}</div>
                        <div className="mt-1 break-words text-xs text-slate-300">{aiMonitorMeta.detail}</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 grid grid-cols-2 gap-3 2xl:grid-cols-4">
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Entry</div>
                    <div className="mt-1 break-words text-sm font-semibold text-white">{formatPrice(trade.entryPrice, 5)}</div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Stop Loss</div>
                    <div className="mt-1 break-words text-sm font-semibold text-rose-300">{formatPrice(trade.stopLoss, 5)}</div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Take Profit</div>
                    <div className="mt-1 break-words text-sm font-semibold text-emerald-300">{formatPrice(trade.takeProfit, 5)}</div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Current Price</div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className={`break-words text-sm font-semibold ${currentDirectionMeta.valueTone}`}>
                        {currentPrice != null ? formatPrice(currentPrice, 5) : 'Live feed pending'}
                      </div>
                      {currentPrice != null ? <PriceDirectionPill direction={currentDirection} compact /> : null}
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 2xl:grid-cols-4">
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">To TP</div>
                    <div className={`mt-1 break-words text-sm font-semibold ${
                      takeProfitGap == null ? 'text-slate-300' : takeProfitGap > 0 ? 'text-amber-300' : 'text-emerald-300'
                    }`}>
                      {isOpen
                        ? takeProfitGap == null
                          ? 'Waiting for live price'
                          : takeProfitGap > 0
                            ? `${formatSignedPrice(takeProfitGap)} | ${formatPercent(takeProfitGapPercent)}`
                            : 'Reached or passed'
                        : 'Closed'}
                    </div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Running P/L</div>
                    <div className={`mt-1 break-words text-sm font-semibold ${getRunningTone(displayedPnl)}`}>
                      {isOpen
                        ? runningPnl == null
                          ? 'Waiting for live price'
                          : `${runningPnl > 0 ? '+' : ''}${runningPnl.toFixed(2)} USDT`
                        : trade.pnl == null
                          ? 'Pending'
                          : `${trade.pnl > 0 ? '+' : ''}${trade.pnl.toFixed(2)} USDT`}
                    </div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Running ROI</div>
                    <div className={`mt-1 break-words text-sm font-semibold ${getRunningTone(displayedRoi)}`}>
                      {isOpen
                        ? runningRoi == null
                          ? 'Waiting for live price'
                          : formatPercent(runningRoi)
                        : trade.pnl == null || !trade.margin
                          ? 'Pending'
                          : formatPercent((Number(trade.pnl || 0) / Number(trade.margin || 1)) * 100)}
                    </div>
                  </div>
                  <div className="min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Lifecycle</div>
                    <div className="mt-1 break-words text-sm font-semibold text-white">{formatDateTime(trade.transactTime)}</div>
                    <div className="mt-1 break-words text-[11px] uppercase tracking-[0.18em] text-slate-500">
                      {trade.closedAt ? `Closed ${formatDateTime(trade.closedAt)}` : 'Awaiting exit'}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}

          {paginationControls}
        </div>
      )}
    </Panel>
  )
}

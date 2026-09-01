import { useEffect, useState } from 'react'
import { BellRing, CheckCircle2, Clock3, ClipboardList, ShieldAlert } from 'lucide-react'
import { formatDateTimeWithSeconds } from '../lib/formatters'
import { Panel } from './Panel'

const REVIEW_LOG_PAGE_SIZE = 8

function getNotificationTone(level) {
  if (level === 'success') {
    return 'border-emerald-400/20 bg-emerald-400/10 text-emerald-100'
  }

  if (level === 'warning') {
    return 'border-amber-400/20 bg-amber-400/10 text-amber-100'
  }

  return 'border-sky-400/20 bg-sky-400/10 text-sky-100'
}

function getPhaseTone(status) {
  if (status === 'ready' || status === 'passed') {
    return 'border-emerald-400/20 bg-emerald-400/10'
  }

  if (status === 'locked') {
    return 'border-white/10 bg-slate-950/60'
  }

  return 'border-amber-400/20 bg-amber-400/10'
}

function getStatusLabel(status) {
  if (status === 'ready') {
    return 'Ready'
  }

  if (status === 'passed') {
    return 'Passed'
  }

  if (status === 'locked') {
    return 'Locked'
  }

  return 'Pending'
}

export function WorkflowNotificationsPanel({ workflow }) {
  const phases = workflow?.phases || []
  const notifications = workflow?.notifications || []
  const operations = workflow?.operations || null

  return (
    <Panel title="Workflow Notifications" action={<BellRing className="h-4 w-4 text-sky-300" />}>
      <div className="space-y-5">
        {operations && (
          <div className={`rounded-2xl border px-4 py-4 ${operations.canTrade ? 'border-emerald-400/20 bg-emerald-400/10' : 'border-amber-400/25 bg-amber-400/10'}`}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-white">
                Operational self-check — {operations.canTrade ? 'server is able to trade' : 'trading is impaired'}
              </div>
              <span className="text-[11px] uppercase tracking-[0.18em] text-slate-300">
                {operations.memory?.rssMb}MB / {operations.memory?.totalMemMb}MB • up {Math.floor((operations.uptimeSec || 0) / 60)}m
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {(operations.checks || []).map((check) => (
                <div key={check.label} className="flex items-start gap-3 text-sm">
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  )}
                  <span className={check.ok ? 'text-slate-100' : 'text-amber-100'}>
                    <span className="font-medium">{check.label}:</span> {check.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {notifications.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
            No workflow notifications yet.
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {notifications.map((notification) => (
              <div key={notification.id} className={`rounded-2xl border px-4 py-4 ${getNotificationTone(notification.level)}`}>
                <div className="text-xs uppercase tracking-[0.24em] opacity-75">Notification</div>
                <div className="mt-2 text-base font-semibold">{notification.title}</div>
                <div className="mt-2 text-sm">{notification.message}</div>
              </div>
            ))}
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-3">
          {phases.map((phase) => (
            <div key={phase.key} className={`rounded-2xl border px-4 py-4 ${getPhaseTone(phase.status)}`}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-slate-500">{phase.title}</div>
                  <div className="mt-1 text-lg font-semibold text-white">{phase.subtitle}</div>
                </div>
                <span className="rounded-full border border-white/10 bg-slate-950/70 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-200">
                  {getStatusLabel(phase.status)}
                </span>
              </div>

              <div className="mt-3 text-sm text-slate-300">{phase.summary}</div>

              <div className="mt-4 flex flex-wrap gap-2">
                {phase.highlights.map((highlight) => (
                  <span
                    key={`${phase.key}-${highlight}`}
                    className="rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-200"
                  >
                    {highlight}
                  </span>
                ))}
              </div>

              <div className="mt-4 space-y-2">
                {phase.checks.map((check) => (
                  <div key={`${phase.key}-${check.label}`} className="flex items-start gap-3 text-sm">
                    {check.passed ? (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                    )}
                    <span className={check.passed ? 'text-slate-100' : 'text-slate-300'}>{check.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}

export function SelfReviewLogPanel({ workflow }) {
  const reviewLog = workflow?.reviewLog || []
  const [currentPage, setCurrentPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(reviewLog.length / REVIEW_LOG_PAGE_SIZE))

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages))
  }, [totalPages])

  const pageStartIndex = (currentPage - 1) * REVIEW_LOG_PAGE_SIZE
  const pageEndIndex = Math.min(pageStartIndex + REVIEW_LOG_PAGE_SIZE, reviewLog.length)
  const pageEntries = reviewLog.slice(pageStartIndex, pageEndIndex)

  return (
    <Panel title="Self-Review Log" action={<ClipboardList className="h-4 w-4 text-sky-300" />}>
      {reviewLog.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-400">
          No review entries yet.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300">
            <div>
              Showing <span className="font-semibold text-white">{pageStartIndex + 1}-{pageEndIndex}</span> of{' '}
              <span className="font-semibold text-white">{reviewLog.length}</span> entries
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
              <div key={entry.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-white">{entry.headline}</div>
                    <div className="mt-1 text-sm text-slate-300">{entry.summary}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-500">
                    <Clock3 className="h-3.5 w-3.5" />
                    {formatDateTimeWithSeconds(entry.timestamp)}
                  </div>
                </div>
                {entry.operations && (
                  <div className="mt-3 border-t border-white/5 pt-3 text-xs text-slate-400">
                    <span className={entry.operations.canTrade ? 'text-emerald-300' : 'text-amber-300'}>
                      {entry.operations.canTrade ? 'able to trade' : 'trading impaired'}
                    </span>
                    {' · '}mem {entry.operations.memory?.rssMb}/{entry.operations.memory?.totalMemMb}MB
                    {' · '}up {Math.floor((entry.operations.uptimeSec || 0) / 60)}m
                    {(entry.operations.checks || []).filter((c) => !c.ok).map((c) => (
                      <span key={c.label} className="ml-2 rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-200">{c.label}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}

// Combined view kept for callers that still want notifications, phases, and the
// review log stacked together.
export function WorkflowReadinessPanel({ workflow }) {
  return (
    <div className="grid gap-6">
      <WorkflowNotificationsPanel workflow={workflow} />
      <SelfReviewLogPanel workflow={workflow} />
    </div>
  )
}

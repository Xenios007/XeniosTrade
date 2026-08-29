import { BellRing, CheckCircle2, Clock3, ClipboardList, ShieldAlert } from 'lucide-react'
import { formatDateTimeWithSeconds } from '../lib/formatters'
import { Panel } from './Panel'

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

export function WorkflowReadinessPanel({ workflow }) {
  const phases = workflow?.phases || []
  const notifications = workflow?.notifications || []
  const reviewLog = workflow?.reviewLog || []

  return (
    <Panel title="Workflow Notifications" action={<BellRing className="h-4 w-4 text-sky-300" />}>
      <div className="space-y-5">
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

        <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4">
          <div className="mb-4 flex items-center gap-2 text-xs uppercase tracking-[0.24em] text-slate-500">
            <ClipboardList className="h-4 w-4" />
            Self-Review Log
          </div>
          {reviewLog.length === 0 ? (
            <div className="text-sm text-slate-400">No review entries yet.</div>
          ) : (
            <div className="space-y-3">
              {reviewLog.slice(0, 5).map((entry) => (
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
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Panel>
  )
}

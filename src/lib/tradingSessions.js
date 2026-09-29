export const DEFAULT_AUTO_TRADE_SESSIONS = [
  {
    id: 'manila-morning',
    label: 'Manila Morning',
    startHour: 10,
    endHour: 12,
  },
  {
    id: 'manila-afternoon',
    label: 'Manila Afternoon',
    startHour: 16,
    endHour: 19,
  },
  {
    id: 'manila-night',
    label: 'Manila Night',
    startHour: 21,
    endHour: 23,
  },
]

function clampHour(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.min(Math.max(Math.floor(number), 0), 24)
}

// SaaS Phase 8H: rewritten to be index-independent (each session validates/repairs itself from
// generic fallbacks) rather than padding/repairing against DEFAULT_AUTO_TRADE_SESSIONS by
// array position - the old version broke for a user-authored list of arbitrary length (e.g. a
// 4th custom session inherited "Manila Night"'s hours as its repair fallback, since that was
// DEFAULT_AUTO_TRADE_SESSIONS.at(-1)). Only falls back to the 3 named defaults when the whole
// list is empty/missing, matching "continuous" being the real default (sessionScheduleEnabled
// off) - these only apply once a user actually turns scheduling on.
export function normalizeAutoTradeSessions(sessions = DEFAULT_AUTO_TRADE_SESSIONS) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return DEFAULT_AUTO_TRADE_SESSIONS.map((session) => ({ ...session }))
  }

  return sessions.map((session, index) => {
    const startHour = clampHour(session?.startHour, 0)
    const rawEndHour = clampHour(session?.endHour, startHour + 1)
    const endHour = rawEndHour > startHour ? rawEndHour : Math.min(startHour + 1, 24)

    return {
      id: String(session?.id || `session-${index + 1}`),
      label: String(session?.label || `Session ${index + 1}`),
      startHour,
      endHour,
    }
  })
}

export function isHourWithinScheduledSessions(hour, sessions = DEFAULT_AUTO_TRADE_SESSIONS) {
  return normalizeAutoTradeSessions(sessions).some((session) => (
    hour >= session.startHour && hour < session.endHour
  ))
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`
}

export function formatAutoTradeSessionRange(session) {
  return `${formatHour(session.startHour)} - ${formatHour(session.endHour)}`
}

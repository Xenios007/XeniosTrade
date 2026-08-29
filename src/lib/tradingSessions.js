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

export function normalizeAutoTradeSessions(sessions = DEFAULT_AUTO_TRADE_SESSIONS) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return DEFAULT_AUTO_TRADE_SESSIONS.map((session) => ({ ...session }))
  }

  return sessions.map((session, index) => {
    const fallback = DEFAULT_AUTO_TRADE_SESSIONS[index] || DEFAULT_AUTO_TRADE_SESSIONS.at(-1)
    const startHour = clampHour(session?.startHour, fallback.startHour)
    const endHour = clampHour(session?.endHour, fallback.endHour)

    return {
      id: String(session?.id || fallback.id),
      label: String(session?.label || fallback.label),
      startHour,
      endHour: endHour > startHour ? endHour : fallback.endHour,
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

export function formatCompactNumber(value, digits = 2) {
  const number = Number(value || 0)

  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: digits,
  }).format(number)
}

export function formatPrice(value, digits = 4) {
  const number = Number(value || 0)

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(number)
}

export function formatPercent(value) {
  const number = Number(value || 0)

  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`
}

export function formatTradeTime(value) {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value)
}

export function formatDateTime(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export function formatDateTimeWithSeconds(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(value)
}

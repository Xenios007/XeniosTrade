export const DEFAULT_MARGIN_MODE = 'ISOLATED'

export const MARGIN_MODE_OPTIONS = [
  {
    value: 'ISOLATED',
    label: 'Isolated',
    description: 'Limits margin exposure to the individual position.',
  },
  {
    value: 'CROSSED',
    label: 'Cross',
    description: 'Shares margin across positions in the futures wallet.',
  },
]

export function normalizeMarginMode(value) {
  const normalized = String(value || '').toUpperCase()
  return MARGIN_MODE_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : DEFAULT_MARGIN_MODE
}

export function getMarginModeLabel(value) {
  const normalized = normalizeMarginMode(value)
  return MARGIN_MODE_OPTIONS.find((option) => option.value === normalized)?.label || 'Isolated'
}

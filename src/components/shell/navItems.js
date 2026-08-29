import {
  BrainCircuit,
  Bot,
  CalendarDays,
  History,
  LayoutDashboard,
  Settings,
  Wallet,
} from 'lucide-react'

export const NAV_GROUPS = [
  {
    label: 'Trading',
    items: [
      { to: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard },
      { to: '/mock-trading', label: 'Mock Trading', Icon: Bot },
      { to: '/trade-history', label: 'Trade History', Icon: History },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { to: '/journal', label: 'Journal', Icon: CalendarDays },
      { to: '/ai-training', label: 'AI Training', Icon: BrainCircuit },
    ],
  },
  {
    label: 'Config',
    items: [
      { to: '/wallets', label: 'Wallets', Icon: Wallet },
      { to: '/settings', label: 'Settings', Icon: Settings },
    ],
  },
]

export const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items)

// Map the pre-router localStorage page keys to their new route paths so a
// returning session lands on the same page it left.
export const LEGACY_PAGE_TO_PATH = {
  dashboard: '/dashboard',
  'mock-trading': '/mock-trading',
  'learning-bot': '/ai-training',
  wallets: '/wallets',
  journal: '/journal',
  'trade-history': '/trade-history',
  settings: '/settings',
}

export const DEFAULT_PATH = '/dashboard'

export function resolveInitialPath(rawSavedValue) {
  const saved = String(rawSavedValue || '').trim()
  if (saved.startsWith('/') && NAV_ITEMS.some((item) => item.to === saved)) {
    return saved
  }
  if (LEGACY_PAGE_TO_PATH[saved]) {
    return LEGACY_PAGE_TO_PATH[saved]
  }
  return DEFAULT_PATH
}

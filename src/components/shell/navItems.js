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
      {
        to: '/dashboard',
        label: 'Dashboard',
        Icon: LayoutDashboard,
        children: [
          { to: '/dashboard', label: 'Overview' },
          { to: '/dashboard/market', label: 'Market' },
          { to: '/dashboard/auto-trade-status', label: 'Auto Trade Status' },
          { to: '/dashboard/workflow', label: 'Workflow Notifications' },
          { to: '/dashboard/self-review-log', label: 'Self-Review Log' },
          { to: '/dashboard/codex', label: 'Codex Console' },
        ],
      },
      {
        to: '/mock-trading',
        label: 'Mock Trading',
        Icon: Bot,
        children: [
          { to: '/mock-trading', label: 'Overview' },
          { to: '/mock-trading/signal-models', label: 'Signal Models' },
          { to: '/mock-trading/auto-trade-controller', label: 'Auto Trade Controller' },
          { to: '/mock-trading/auto-trade-activity', label: 'Auto Trade Activity' },
        ],
      },
      { to: '/trade-history', label: 'Trade History', Icon: History },
    ],
  },
  {
    label: 'Analysis',
    items: [
      {
        to: '/journal',
        label: 'Journal',
        Icon: CalendarDays,
        children: [
          { to: '/journal', label: 'Summary' },
          { to: '/journal/head-to-head', label: 'Head to Head' },
          { to: '/journal/wallet', label: 'Wallet Journal' },
        ],
      },
      {
        to: '/ai-training',
        label: 'AI Training',
        Icon: BrainCircuit,
        children: [
          { to: '/ai-training', label: 'Training' },
          { to: '/ai-training/backtests', label: 'Backtests' },
          { to: '/ai-training/insights', label: 'Signal Insights' },
          { to: '/ai-training/advisory', label: 'AI Advisory' },
          { to: '/ai-training/assistant', label: 'AI Assistant' },
        ],
      },
    ],
  },
  {
    label: 'Config',
    items: [
      { to: '/wallets', label: 'Wallets', Icon: Wallet },
      {
        to: '/settings',
        label: 'Settings',
        Icon: Settings,
        children: [
          { to: '/settings/automation', label: 'Automation' },
          { to: '/settings/strategy', label: 'Bot Strategy' },
          { to: '/settings/symbol-risk', label: 'Symbol Risk Profiles' },
          { to: '/settings/credentials', label: 'API Credentials' },
        ],
      },
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

const KNOWN_TOP_SEGMENTS = new Set(NAV_ITEMS.map((item) => item.to.split('/')[1]))

export function resolveInitialPath(rawSavedValue) {
  const saved = String(rawSavedValue || '').trim()
  // Accept any path whose first segment is a known section, including nested
  // routes like /settings/strategy.
  if (saved.startsWith('/') && KNOWN_TOP_SEGMENTS.has(saved.split('/')[1])) {
    return saved
  }
  if (LEGACY_PAGE_TO_PATH[saved]) {
    return LEGACY_PAGE_TO_PATH[saved]
  }
  return DEFAULT_PATH
}

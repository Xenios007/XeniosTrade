import {
  BrainCircuit,
  Bot,
  CalendarDays,
  History,
  KeyRound,
  LayoutDashboard,
  Network,
  Settings,
  Wallet,
  Layers,
} from 'lucide-react'
import { APP_META, APP_MODE, APP_MODE_AI, APP_MODE_ALL, SECTIONS_BY_MODE, isAiModelsTabVisible } from '../../lib/appMode.js'

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
          { to: '/dashboard/real-money-trading', label: 'Real Money Trading' },
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
      {
        to: '/ai-trading',
        label: 'AI Trading',
        Icon: Network,
        children: [
          { to: '/ai-trading', label: 'Pipeline' },
          { to: '/ai-trading/history', label: 'Run History' },
        ],
      },
      {
        to: '/trade-history',
        label: 'Trade History',
        Icon: History,
        children: [
          { to: '/trade-history', label: 'Testnet Trades' },
          { to: '/trade-history/real-money', label: 'Real Money Trades' },
        ],
      },
    ],
  },
  {
    // Its own top-level group, deliberately not nested under "Trading" alongside Mock Trading / AI Trading: this
    // shares no wallet, no trade-history ledger, and no symbol-collision protection with any of them - a fully
    // separate environment with its own testnet account-side ledger (see ConsolidatedBotPage / consolidated-bot.js).
    label: 'Consolidated Knowledge',
    items: [
      { to: '/consolidated-knowledge', label: 'Consolidated Knowledge', Icon: Layers },
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
        to: '/ai-models',
        label: 'AI Models',
        Icon: KeyRound,
        children: [
          { to: '/ai-models', label: 'Providers & Keys' },
          { to: '/ai-models/browse', label: 'Browse Models' },
          { to: '/ai-models/bots', label: 'Bot Assignments' },
          { to: '/ai-models/agents', label: 'Agent Assignments' },
        ],
      },
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

// NAV_GROUPS is the full (apex-domain) workspace. ai.* and bot.* each get a
// filtered view of it: only their own sections, and only their own AI Models tabs.
// ai.* has its own layout: the pipeline, then the AI wallets' records (history, journal, wallet), then config.
// Its Trade History / Journal / Wallet pages are the AI's own — not the bots' pages of the same name.
function getAiNavGroups(mode) {
  const findItem = (to) => NAV_GROUPS.flatMap((group) => group.items).find((item) => item.to === to)
  const aiModels = findItem('/ai-models')
  return [
    { label: 'Trading', items: [findItem('/ai-trading')] },
    {
      label: 'Records',
      items: [
        {
          to: '/ai-history',
          label: 'Trade History',
          Icon: History,
          children: [
            { to: '/ai-history', label: 'Testnet Trades' },
            { to: '/ai-history/real', label: 'Real Money Trades' },
          ],
        },
        { to: '/ai-journal', label: 'Journal', Icon: CalendarDays },
        { to: '/ai-wallet', label: 'Wallet', Icon: Wallet },
      ],
    },
    {
      label: 'Config',
      items: [
        { ...aiModels, children: aiModels.children.filter((child) => isAiModelsTabVisible(mode, child.to)) },
        { to: '/ai-settings', label: 'Settings', Icon: Settings },
      ],
    },
  ]
}

export function getNavGroups(mode = APP_MODE) {
  const sections = SECTIONS_BY_MODE[mode]
  if (!sections) {
    return NAV_GROUPS
  }
  if (mode === APP_MODE_AI) {
    return getAiNavGroups(mode)
  }
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items
      .filter((item) => sections.includes(item.to.split('/')[1]))
      .map((item) => (
        item.to === '/ai-models'
          ? { ...item, children: item.children.filter((child) => isAiModelsTabVisible(mode, child.to)) }
          : item
      )),
  })).filter((group) => group.items.length > 0)
}

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

export const DEFAULT_PATH = APP_META[APP_MODE].homePath

function getKnownTopSegments(mode) {
  return new Set(getNavGroups(mode).flatMap((group) => group.items).map((item) => item.to.split('/')[1]))
}

export function resolveInitialPath(rawSavedValue, mode = APP_MODE) {
  const saved = String(rawSavedValue || '').trim()
  const known = getKnownTopSegments(mode)
  const home = APP_META[mode]?.homePath || APP_META[APP_MODE_ALL].homePath
  // Accept any path whose first segment is a section of this workspace,
  // including nested routes like /settings/strategy.
  if (saved.startsWith('/') && known.has(saved.split('/')[1])) {
    return saved
  }
  const legacy = LEGACY_PAGE_TO_PATH[saved]
  if (legacy && known.has(legacy.split('/')[1])) {
    return legacy
  }
  return home
}

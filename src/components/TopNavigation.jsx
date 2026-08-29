const navItems = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'mock-trading', label: 'Mock Trading' },
  { key: 'learning-bot', label: 'AI Training' },
  { key: 'wallets', label: 'Wallets' },
  { key: 'journal', label: 'Journal' },
  { key: 'trade-history', label: 'Trade History' },
  { key: 'settings', label: 'Settings' },
]

export function TopNavigation({ currentPage, onChangePage }) {
  return (
    <nav className="flex flex-wrap gap-2">
      {navItems.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChangePage(item.key)}
          className={`rounded-full px-4 py-2 text-sm transition ${
            currentPage === item.key
              ? 'bg-sky-400 text-slate-950'
              : 'border border-white/10 bg-slate-950/60 text-slate-300 hover:border-white/20'
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}

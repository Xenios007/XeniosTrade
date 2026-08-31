import { NavLink } from 'react-router-dom'

// Pill-style secondary navigation used to switch between the nested pages of a
// section (Dashboard, Mock Trading, AI Training, Settings). `tabs` is an array
// of { to, label, end? }.
export function SubNavTabs({ tabs }) {
  return (
    <nav className="flex flex-wrap gap-2 border-b border-white/10 pb-4">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `rounded-full px-4 py-2 text-sm font-medium transition ${
              isActive
                ? 'bg-sky-400 text-slate-950'
                : 'border border-white/10 bg-slate-950/60 text-slate-300 hover:border-white/20'
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}

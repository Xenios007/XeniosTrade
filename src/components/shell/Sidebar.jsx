import { NavLink } from 'react-router-dom'
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { BrandMark } from '../BrandMark'
import { usePersistentBoolean } from '../../lib/usePersistentBoolean'
import { NAV_GROUPS } from './navItems'

const SIDEBAR_COLLAPSED_KEY = 'xeniostrade:sidebar:collapsed'

function NavItem({ to, label, Icon, collapsed, onNavigate }) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        [
          'group flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-medium transition',
          collapsed ? 'justify-center' : '',
          isActive
            ? 'bg-sky-400/15 text-sky-100 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.25)]'
            : 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-sky-300' : 'text-slate-500 group-hover:text-slate-300'}`} />
          {!collapsed ? <span className="truncate">{label}</span> : null}
        </>
      )}
    </NavLink>
  )
}

function SidebarBody({ collapsed, onToggleCollapsed, onNavigate, onClose, showClose }) {
  return (
    <div className="flex h-full flex-col">
      <div className={`flex items-center gap-3 px-4 py-5 ${collapsed ? 'justify-center px-2' : ''}`}>
        <BrandMark className="h-9 w-9" />
        {!collapsed ? (
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-[0.14em] text-white">XeniosTrade</div>
            <div className="truncate text-[10px] uppercase tracking-[0.24em] text-slate-500">Paper workspace</div>
          </div>
        ) : null}
        {showClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="ml-auto rounded-xl border border-white/10 p-1.5 text-slate-400 hover:text-white lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="space-y-1">
            {!collapsed ? (
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-600">
                {group.label}
              </div>
            ) : null}
            {group.items.map((item) => (
              <NavItem key={item.to} {...item} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </div>
        ))}
      </nav>

      <button
        type="button"
        onClick={onToggleCollapsed}
        className="m-3 hidden items-center gap-3 rounded-2xl px-3 py-2.5 text-xs font-medium uppercase tracking-[0.18em] text-slate-500 transition hover:bg-white/5 hover:text-slate-200 lg:flex"
      >
        {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        {!collapsed ? <span>Collapse</span> : null}
      </button>
    </div>
  )
}

export function Sidebar({ mobileOpen, onClose }) {
  const [collapsed, setCollapsed] = usePersistentBoolean(SIDEBAR_COLLAPSED_KEY, false)
  const toggleCollapsed = () => setCollapsed((current) => !current)

  return (
    <>
      {/* Desktop rail */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 border-r border-white/10 bg-slate-950/80 backdrop-blur-xl lg:block ${
          collapsed ? 'w-[76px]' : 'w-60'
        }`}
      >
        <SidebarBody
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
        />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-white/10 bg-slate-950 shadow-2xl">
            <SidebarBody
              collapsed={false}
              onToggleCollapsed={toggleCollapsed}
              onNavigate={onClose}
              onClose={onClose}
              showClose
            />
          </aside>
        </div>
      ) : null}
    </>
  )
}

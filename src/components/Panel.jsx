import { ChevronDown } from 'lucide-react'
import { useId } from 'react'
import { usePersistentBoolean } from '../lib/usePersistentBoolean'

export function Panel({
  title,
  action,
  children,
  className = '',
  contentClassName = '',
  collapsedContent = null,
  collapsedContentClassName = '',
  collapsible = false,
  defaultCollapsed = false,
  storageKey = null,
  keepMountedWhenCollapsed = false,
}) {
  const [collapsed, setCollapsed] = usePersistentBoolean(
    collapsible ? storageKey : null,
    defaultCollapsed,
  )
  const contentId = useId()
  const shouldRenderContent = !collapsed || keepMountedWhenCollapsed

  return (
    <section className={`min-w-0 overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-glow backdrop-blur-xl ${className}`}>
      <header className="shrink-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/10 px-5 py-4">
        {collapsible ? (
          <button
            type="button"
            aria-controls={contentId}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((current) => !current)}
            className="flex flex-1 items-center gap-3 text-left"
          >
            <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-300">{title}</h2>
            <ChevronDown className={`h-4 w-4 text-slate-500 transition ${collapsed ? '' : 'rotate-180'}`} />
          </button>
        ) : (
          <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-300">{title}</h2>
        )}
        {action ? <div className="ml-4 shrink-0">{action}</div> : null}
      </header>
      {shouldRenderContent || collapsedContent ? (
        <div id={contentId} className="min-w-0">
          {shouldRenderContent ? (
            <div
              aria-hidden={collapsed}
              className={`min-w-0 p-5 ${collapsed ? 'hidden' : ''} ${contentClassName}`}
            >
              {children}
            </div>
          ) : null}
          {collapsed && collapsedContent ? (
            <div className={`min-w-0 p-5 ${collapsedContentClassName}`}>
              {collapsedContent}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/**
 * Consistent page framing: an h1, an optional one-line description, and an
 * optional actions slot on the right. Replaces the ad-hoc mix of marketing
 * hero blocks and "no header at all" across pages.
 */
export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-400">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

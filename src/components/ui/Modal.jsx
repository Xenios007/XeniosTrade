import { X } from 'lucide-react'

/**
 * Minimal centered modal matching the app's dark-glass panel language.
 * Click on the backdrop or the X to close; clicks inside the card don't bubble.
 */
export function Modal({ title, onClose, footer, children }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-3xl border border-white/10 bg-slate-950/95 shadow-glow"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-300">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 transition hover:bg-white/5 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-4 px-6 py-5">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-white/10 px-6 py-4">{footer}</div> : null}
      </div>
    </div>
  )
}

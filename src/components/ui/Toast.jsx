import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

const ToastContext = createContext(null)

const TONE_META = {
  info: { cls: 'border-sky-400/25 bg-sky-400/10 text-sky-100', Icon: Info },
  success: { cls: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-100', Icon: CheckCircle2 },
  error: { cls: 'border-rose-400/25 bg-rose-400/10 text-rose-100', Icon: AlertTriangle },
  warning: { cls: 'border-amber-400/25 bg-amber-400/10 text-amber-100', Icon: AlertTriangle },
}

let nextId = 1

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())
  const recent = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback((message, { tone = 'info', duration = 6000 } = {}) => {
    const text = String(message || '').trim()
    if (!text) return null

    // De-dupe the same message within a short window.
    const now = Date.now()
    const lastAt = recent.current.get(text) || 0
    if (now - lastAt < 4000) return null
    recent.current.set(text, now)

    const id = nextId++
    setToasts((current) => [...current.slice(-3), { id, text, tone }])

    if (duration > 0) {
      timers.current.set(id, setTimeout(() => dismiss(id), duration))
    }
    return id
  }, [dismiss])

  const api = useMemo(() => ({
    toast: push,
    info: (message, options) => push(message, { ...options, tone: 'info' }),
    success: (message, options) => push(message, { ...options, tone: 'success' }),
    error: (message, options) => push(message, { ...options, tone: 'error' }),
    warning: (message, options) => push(message, { ...options, tone: 'warning' }),
    dismiss,
  }), [push, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => {
          const meta = TONE_META[toast.tone] || TONE_META.info
          const Icon = meta.Icon
          return (
            <div
              key={toast.id}
              role="status"
              className={`pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm shadow-lg backdrop-blur-xl ${meta.cls}`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1 break-words">{toast.text}</div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded-lg p-0.5 opacity-70 transition hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    // No-op fallback so components don't crash if used outside the provider.
    return {
      toast: () => {},
      info: () => {},
      success: () => {},
      error: () => {},
      warning: () => {},
      dismiss: () => {},
    }
  }
  return context
}

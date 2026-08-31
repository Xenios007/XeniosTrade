import { useEffect, useRef, useState } from 'react'
import { Bot, Loader2, RefreshCw, Send, Terminal } from 'lucide-react'
import { getCodexConsoleStatus, sendCodexConsoleMessage } from '../lib/api'
import { formatDateTimeWithSeconds } from '../lib/formatters'
import { Panel } from './Panel'

function newId() {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function CodexConsole() {
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [messages, setMessages] = useState([])
  const [threadId, setThreadId] = useState(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef(null)

  useEffect(() => {
    let ignore = false

    getCodexConsoleStatus()
      .then((payload) => {
        if (!ignore) {
          setStatus(payload)
        }
      })
      .catch((loadError) => {
        if (!ignore) {
          setStatusError(loadError instanceof Error ? loadError.message : 'Unable to read Codex console status.')
        }
      })

    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (node) {
      node.scrollTop = node.scrollHeight
    }
  }, [messages, sending])

  const unavailable = status && status.available === false

  async function handleSend(event) {
    event.preventDefault()
    const trimmed = input.trim()

    if (!trimmed || sending) {
      return
    }

    const userMessage = { id: newId(), role: 'user', text: trimmed, timestamp: Date.now() }
    setMessages((current) => [...current, userMessage])
    setInput('')
    setError('')
    setSending(true)

    try {
      const payload = await sendCodexConsoleMessage({ message: trimmed, threadId })
      if (payload.threadId) {
        setThreadId(payload.threadId)
      }
      setMessages((current) => [
        ...current,
        {
          id: newId(),
          role: 'assistant',
          text: payload.response || '(no response)',
          usage: payload.usage || null,
          timestamp: Date.now(),
        },
      ])
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Codex console request failed.')
    } finally {
      setSending(false)
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSend(event)
    }
  }

  function handleReset() {
    setMessages([])
    setThreadId(null)
    setError('')
  }

  return (
    <Panel
      title="Codex Console"
      action={
        <button
          type="button"
          onClick={handleReset}
          disabled={sending || messages.length === 0}
          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-200 transition hover:border-white/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          New chat
        </button>
      }
    >
      <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-slate-300">
        <div className="flex items-center gap-2 text-slate-200">
          <Terminal className="h-4 w-4 text-sky-300" />
          <span className="font-semibold">Codex chat</span>
        </div>
        <p className="mt-2 leading-6">
          Ask about the trading platform, its code, or a market idea. Codex runs on the server with the workspace as
          context in <span className="font-semibold text-slate-100">{status?.sandboxMode || 'read-only'}</span> sandbox
          mode, so it can read the project but not change files. Each message is billed to the machine&rsquo;s Codex login.
        </p>
        {statusError ? (
          <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
            {statusError}
          </div>
        ) : null}
        {unavailable ? (
          <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
            The Codex SDK is not installed on the server. Run <code>npm install @openai/codex-sdk</code> and restart the API.
          </div>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        className="mt-4 max-h-[460px] min-h-[220px] space-y-3 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/40 p-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center text-sm text-slate-500">
            <Bot className="h-6 w-6 text-slate-600" />
            <span>No messages yet. Ask Codex something about the platform.</span>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl border px-4 py-3 text-sm leading-6 ${
                  message.role === 'user'
                    ? 'border-sky-400/20 bg-sky-400/10 text-sky-50'
                    : 'border-white/10 bg-slate-950/70 text-slate-200'
                }`}
              >
                <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-slate-500">
                  {message.role === 'user' ? 'You' : 'Codex'}
                  <span className="text-slate-600">{formatDateTimeWithSeconds(message.timestamp)}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{message.text}</div>
                {message.usage ? (
                  <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-slate-500">
                    {(message.usage.input_tokens ?? message.usage.inputTokens ?? '?')} in /{' '}
                    {(message.usage.output_tokens ?? message.usage.outputTokens ?? '?')} out tokens
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
        {sending ? (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Codex is thinking&hellip;
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
          {error}
        </div>
      ) : null}

      <form onSubmit={handleSend} className="mt-4 flex items-end gap-3">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={sending || unavailable}
          placeholder="Ask Codex about the platform, the code, or a trading idea. Enter to send, Shift+Enter for a newline."
          className="min-h-[52px] flex-1 resize-y rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-sky-400/40 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={sending || unavailable || !input.trim()}
          className="inline-flex h-[52px] shrink-0 items-center justify-center gap-2 rounded-2xl bg-sky-400 px-4 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send
        </button>
      </form>
    </Panel>
  )
}

import { useState } from 'react'
import {
  ArrowRight,
  BookOpenCheck,
  Bot,
  BrainCircuit,
  CheckCircle2,
  FlaskConical,
  KeyRound,
  Layers,
  LineChart,
  LoaderCircle,
  Lock,
  Network,
  OctagonX,
  ScanSearch,
  ShieldCheck,
  Wallet,
  Waypoints,
} from 'lucide-react'
import { BrandMark } from '../BrandMark'
import { GoogleSignInButton } from '../GoogleSignInButton'
import { getGoogleLoginUrl, getModeUrl, APP_MODE_AI, APP_MODE_BOT, PASSWORD_LOGIN_ENABLED } from '../../lib/appMode'

const NAV = [
  { href: '#workspaces', label: 'Workspaces' },
  { href: '#platform', label: 'Platform' },
  { href: '#how', label: 'How it works' },
  { href: '#safeguards', label: 'Safeguards' },
]

const LOGIN_ERRORS = {
  not_allowed: "That Google account isn't approved for this workspace.",
  denied: 'Google sign-in was cancelled.',
  state: 'That sign-in attempt expired. Please try again.',
  failed: "We couldn't verify your Google sign-in. Please try again.",
  not_configured: 'Google sign-in is not set up on this server yet.',
}

// Static, clearly-labelled illustration of what a pipeline run looks like.
const EXAMPLE_STAGES = [
  { agent: 'Market Analyst', result: 'LONG · 62% confidence', tone: 'ok' },
  { agent: 'Market Flow', result: 'NEUTRAL · crowding medium', tone: 'ok' },
  { agent: 'Critic', result: 'REJECT · entry into falling knife', tone: 'stop' },
  { agent: 'Risk Manager', result: 'Skipped — already blocked', tone: 'skip' },
  { agent: 'Decision Agent', result: 'Skipped — already blocked', tone: 'skip' },
]

const PLATFORM = [
  {
    Icon: Network,
    title: 'Five-agent review desk',
    body: 'An Analyst proposes, Market Flow checks derivatives positioning, a Critic attacks the idea, a Risk Manager sizes it, and a Decision Agent confirms or holds.',
  },
  {
    Icon: Bot,
    title: 'A fleet of trading bots',
    body: '15 bots run side by side — rule-based strategies and LLM-driven bots — each with its own wallet, so you can compare them on equal terms.',
  },
  {
    Icon: Layers,
    title: 'Bring any model',
    body: 'Connect keys for 23 providers, from Claude, GPT and Gemini to OpenRouter, Groq and local Ollama, and choose the model behind every agent.',
  },
  {
    Icon: ScanSearch,
    title: 'Order-flow context',
    body: 'Funding, open interest versus price, long/short ratios, taker flow and order-book depth are summarised from public futures data — no extra keys.',
  },
  {
    Icon: FlaskConical,
    title: 'Backtests & AI training',
    body: 'Replay history into a training set, train the adaptive models, and review signal insights before a strategy gets anywhere near capital.',
  },
  {
    Icon: BookOpenCheck,
    title: 'Journal & audit trail',
    body: 'Every run stores each agent’s verdict and the numbers it saw. Trade history, head-to-head bot comparisons and wallet journals live in one place.',
  },
]

const STEPS = [
  { n: '01', title: 'Connect your models', body: 'Add provider API keys once. They are stored server-side and never sent back to the browser.' },
  { n: '02', title: 'Run the desk or the bots', body: 'Vet a single idea with the AI agents, or let the bot fleet scan markets on testnet wallets.' },
  { n: '03', title: 'Review, then decide', body: 'Read every stage’s reasoning, compare results across bots, and only then change what runs next.' },
]

const SAFEGUARDS = [
  { Icon: OctagonX, title: 'Fail closed', body: 'A stage that errors, times out or returns junk means no trade. A missing verdict is never a pass.' },
  { Icon: ShieldCheck, title: 'Code-enforced risk ceilings', body: 'A model decides stops, size and leverage, but plain code re-checks every number against fixed ceilings. A model can only be stricter than them, never looser.' },
  { Icon: Wallet, title: 'Paper-first', body: 'Bots trade testnet and simulated wallets. Real-money execution is a separate, explicitly armed switch, off by default.' },
  { Icon: Lock, title: 'Private by design', body: 'Sign-in is restricted to approved accounts, and secrets never leave the server.' },
]

function Section({ id, eyebrow, title, children }) {
  return (
    <section id={id} className="scroll-mt-20 px-4 py-20 lg:px-6">
      <div className="mx-auto max-w-6xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-sky-300/80">{eyebrow}</p>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">{title}</h2>
        <div className="mt-10">{children}</div>
      </div>
    </section>
  )
}

function StageRow({ agent, result, tone }) {
  const styles = {
    ok: { dot: 'bg-emerald-400', text: 'text-slate-200' },
    stop: { dot: 'bg-rose-400', text: 'text-rose-200' },
    skip: { dot: 'bg-slate-600', text: 'text-slate-500' },
  }[tone]

  return (
    <li className="flex items-center gap-3 rounded-xl border border-white/5 bg-slate-950/60 px-3.5 py-2.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${styles.dot}`} />
      <span className="w-28 shrink-0 text-xs font-semibold text-white sm:w-36">{agent}</span>
      <span className={`min-w-0 truncate text-xs ${styles.text}`}>{result}</span>
    </li>
  )
}

function PipelinePreview() {
  return (
    <div className="relative min-w-0">
      <div aria-hidden="true" className="absolute -inset-6 rounded-[40px] bg-sky-500/10 blur-3xl" />
      <div className="relative rounded-[28px] border border-white/10 bg-slate-900/80 p-5 shadow-glow backdrop-blur-xl sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">Pipeline run</div>
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
            Illustrative
          </span>
        </div>
        <ul className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-2">
          {EXAMPLE_STAGES.map((stage) => (
            <StageRow key={stage.agent} {...stage} />
          ))}
        </ul>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/70 px-4 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">Verdict</span>
          <span className="rounded-full border border-slate-500/30 bg-slate-500/10 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-slate-200">
            NO TRADE · HOLD
          </span>
        </div>
        <p className="mt-3 text-[11px] leading-5 text-slate-500">
          Example of the layout only — not live data and not a recommendation. Paid model calls stop as soon as a gate blocks the idea.
        </p>
      </div>
    </div>
  )
}

function WorkspaceCard({ Icon, name, host, blurb, points, href, cta, authenticated }) {
  return (
    <div className="flex flex-col rounded-[28px] border border-white/10 bg-white/[0.04] p-7 backdrop-blur-xl transition hover:border-sky-300/25">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-400/10 text-sky-200">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-lg font-semibold text-white">{name}</h3>
          <p className="text-xs text-slate-500">{host}</p>
        </div>
      </div>
      <p className="mt-5 text-sm leading-6 text-slate-300">{blurb}</p>
      <ul className="mt-5 grid gap-2.5">
        {points.map((point) => (
          <li key={point} className="flex items-start gap-2.5 text-sm text-slate-300">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
            {point}
          </li>
        ))}
      </ul>
      <a
        href={href}
        className="mt-8 inline-flex items-center justify-center gap-2 self-start rounded-full border border-sky-300/25 bg-sky-400/15 px-5 py-2.5 text-sm font-semibold text-sky-100 transition hover:border-sky-300/50 hover:bg-sky-400/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
      >
        {authenticated ? cta : 'Sign in to open'}
        <ArrowRight className="h-4 w-4" />
      </a>
    </div>
  )
}

function SignInCard({ authChecked, authenticated, googleEnabled, loginError, onPasswordLogin, aiUrl, botUrl }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onPasswordLogin(password)
      setPassword('')
    } catch (loginFailure) {
      setError(loginFailure.message)
    } finally {
      setBusy(false)
    }
  }

  if (!authChecked) {
    return (
      <div className="flex items-center justify-center gap-3 py-10 text-sm text-slate-400">
        <LoaderCircle className="h-5 w-5 animate-spin text-sky-300" /> Checking your session…
      </div>
    )
  }

  if (authenticated) {
    return (
      <div className="text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h3 className="mt-5 text-2xl font-semibold text-white">You’re signed in</h3>
        <p className="mt-2 text-sm text-slate-400">One sign-in covers both workspaces.</p>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <a href={aiUrl} className="inline-flex items-center justify-center gap-2 rounded-full bg-sky-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300">
            <Network className="h-4 w-4" /> Open AI Trading
          </a>
          <a href={botUrl} className="inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10">
            <Bot className="h-4 w-4" /> Open Bot Trading
          </a>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-400/10 text-sky-200">
          <KeyRound className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-xl font-semibold text-white">Sign in</h3>
          <p className="text-sm text-slate-400">Access is limited to approved accounts.</p>
        </div>
      </div>

      {loginError ? (
        <div role="alert" className="mt-6 rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {LOGIN_ERRORS[loginError] || 'Sign-in failed. Please try again.'}
        </div>
      ) : null}

      <div className="mt-7 grid gap-3">
        {googleEnabled ? (
          <GoogleSignInButton href={getGoogleLoginUrl()} label="Sign in with Google" className="w-full" />
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-400">
            Google sign-in isn’t available right now. Please try again shortly.
          </div>
        )}
      </div>

      {PASSWORD_LOGIN_ENABLED ? (
      <details className="group mt-6 rounded-2xl border border-white/10 bg-white/[0.03] open:bg-white/[0.05]" open={!googleEnabled}>
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-slate-300 transition hover:text-white">
          Use the local dev password instead
        </summary>
        <form onSubmit={submit} className="grid gap-3 px-4 pb-4">
          <label className="grid gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-400">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="w-full rounded-xl border border-white/10 bg-slate-900/90 px-4 py-2.5 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-sky-300/40 focus:ring-2 focus:ring-sky-300/20"
              placeholder="Owner password"
            />
          </label>
          {error ? <div role="alert" className="text-sm text-rose-300">{error}</div> : null}
          <button
            type="submit"
            disabled={busy || !password}
            className="inline-flex items-center justify-center rounded-full border border-sky-300/25 bg-sky-400/15 px-4 py-2.5 text-sm font-semibold text-sky-100 transition hover:bg-sky-400/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
      </details>
      ) : null}
    </div>
  )
}

export function HomePage({ authChecked, authenticated, googleEnabled, loginError, onPasswordLogin, onLogout }) {
  const aiUrl = getModeUrl(APP_MODE_AI, '/ai-trading') || '/?app=ai'
  const botUrl = getModeUrl(APP_MODE_BOT, '/dashboard') || '/?app=bot'

  return (
    <div className="relative min-h-screen overflow-x-clip bg-slate-950 text-white">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.16),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(20,184,166,0.10),_transparent_22%)]" />
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 bg-grid bg-[size:32px_32px] opacity-25" />

      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 lg:px-6">
          <a href="#top" className="flex items-center gap-3">
            <BrandMark className="h-8 w-8" />
            <span className="text-sm font-semibold tracking-[0.14em]">XeniosTrade</span>
          </a>
          <nav aria-label="Primary" className="ml-6 hidden items-center gap-6 md:flex">
            {NAV.map((item) => (
              <a key={item.href} href={item.href} className="text-sm text-slate-400 transition hover:text-white">
                {item.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {authenticated ? (
              <>
                <a href={aiUrl} className="hidden rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/5 sm:inline-flex">AI Trading</a>
                <a href={botUrl} className="hidden rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/5 sm:inline-flex">Bot Trading</a>
                <button type="button" onClick={onLogout} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15">Sign out</button>
              </>
            ) : (
              <a href="#signin" className="rounded-full bg-sky-400 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-300">Sign in</a>
            )}
          </div>
        </div>
      </header>

      <main id="top" className="relative">
        <section className="px-4 pb-20 pt-16 lg:px-6 lg:pt-24">
          <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] items-center gap-14 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-400/10 px-4 py-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-sky-100">
                <Waypoints className="h-3.5 w-3.5" /> Invite-only · Paper-first
              </div>
              <h1 className="mt-6 text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl">
                AI-assisted trading,
                <span className="bg-gradient-to-r from-sky-300 to-teal-300 bg-clip-text text-transparent"> with the guardrails built in.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-8 text-slate-300">
                XeniosTrade puts a five-agent AI review desk and a fleet of trading bots in one private workspace — with fixed risk ceilings, fail-closed gates, and an audit trail for every decision.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                {authenticated ? (
                  <a href="#signin" className="inline-flex items-center gap-2 rounded-full bg-sky-400 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300">
                    Open your workspaces <ArrowRight className="h-4 w-4" />
                  </a>
                ) : googleEnabled ? (
                  <GoogleSignInButton href={getGoogleLoginUrl()} label="Sign in with Google" />
                ) : (
                  <a href="#signin" className="inline-flex items-center gap-2 rounded-full bg-sky-400 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300">
                    Sign in <ArrowRight className="h-4 w-4" />
                  </a>
                )}
                <a href="#workspaces" className="inline-flex items-center gap-2 rounded-full border border-white/15 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/5">
                  Explore the workspaces
                </a>
              </div>
              <p className="mt-5 text-xs text-slate-500">Access is limited to approved accounts.</p>
            </div>
            <PipelinePreview />
          </div>
        </section>

        <Section id="workspaces" eyebrow="Two workspaces" title="Bots and AI agents, kept apart on purpose.">
          <div className="grid gap-6 lg:grid-cols-2">
            <WorkspaceCard
              Icon={Network}
              name="AI Trading"
              host="ai.projxenios.trade"
              blurb="An on-demand, advisory desk that vets one trade idea at a time and returns Trade or No Trade — with the reasoning for every stage."
              points={[
                'Analyst, Market Flow, Critic, Risk Manager and Decision agents',
                'Pick the provider and model behind each agent',
                'AI-decided risk, run history and full audit trail',
                'Advisory only — it never places an order',
              ]}
              href={aiUrl}
              cta="Open AI Trading"
              authenticated={authenticated}
            />
            <WorkspaceCard
              Icon={Bot}
              name="Bot Trading"
              host="bot.projxenios.trade"
              blurb="The bot fleet: strategies scanning markets on isolated wallets, with the dashboards to see what each one is doing and why."
              points={[
                '15 rule-based and LLM-driven bots, one wallet each',
                'Auto-trade controller, activity feed and signal models',
                'Trade history, journal and head-to-head comparisons',
                'Backtesting and adaptive AI training',
              ]}
              href={botUrl}
              cta="Open Bot Trading"
              authenticated={authenticated}
            />
          </div>
        </Section>

        <Section id="platform" eyebrow="Platform" title="Everything needed to test an idea properly.">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {PLATFORM.map(({ Icon, title, body }) => (
              <div key={title} className="rounded-3xl border border-white/10 bg-white/[0.03] p-6">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-slate-900 text-sky-300">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-5 text-base font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section id="how" eyebrow="How it works" title="From API key to audited decision in three steps.">
          <ol className="grid gap-5 md:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.n} className="rounded-3xl border border-white/10 bg-slate-900/60 p-6">
                <div className="text-3xl font-semibold text-sky-300/80">{step.n}</div>
                <h3 className="mt-4 text-base font-semibold text-white">{step.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">{step.body}</p>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="safeguards" eyebrow="Safeguards" title="Built to say no.">
          <div className="grid gap-5 sm:grid-cols-2">
            {SAFEGUARDS.map(({ Icon, title, body }) => (
              <div key={title} className="flex gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-6">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
                  <Icon className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-base font-semibold text-white">{title}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-slate-400">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <section id="signin" className="scroll-mt-20 px-4 pb-24 pt-10 lg:px-6">
          <div className="mx-auto max-w-lg rounded-[32px] border border-white/10 bg-slate-950/85 p-8 shadow-glow backdrop-blur-xl sm:p-10">
            <SignInCard
              authChecked={authChecked}
              authenticated={authenticated}
              googleEnabled={googleEnabled}
              loginError={loginError}
              onPasswordLogin={onPasswordLogin}
              aiUrl={aiUrl}
              botUrl={botUrl}
            />
          </div>
        </section>
      </main>

      <footer className="relative border-t border-white/10 px-4 py-10 lg:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 md:flex-row md:items-start md:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-8 w-8" />
            <div>
              <div className="text-sm font-semibold tracking-[0.14em]">XeniosTrade</div>
              <div className="text-xs text-slate-500">© {new Date().getFullYear()} XeniosTrade. All rights reserved.</div>
            </div>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-slate-500">
            <BrainCircuit className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]" />
            XeniosTrade is private trading software, not a broker, adviser or fund, and nothing here is investment advice. Trading leveraged and crypto derivatives carries a substantial risk of loss. AI output can be wrong; bots run on paper and testnet wallets unless real-money execution is deliberately armed. Past or simulated results do not predict future performance.
            <LineChart className="ml-1.5 inline h-3.5 w-3.5 align-[-2px]" />
          </p>
        </div>
      </footer>
    </div>
  )
}

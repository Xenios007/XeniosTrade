# XeniosTrade — Project Audit

Audit date: 2026-08-29
Scope: read-only review of `/home/xenios/app` (frontend, server, data, deploy, build) plus the workspace change log `/home/xenios/agent.md`.
Nothing in the project was modified by this audit. This file is the only thing written.

---

## 1. What the project is

| | |
|---|---|
| Name / package | `xeniostrade` (v0.0.0, private) |
| Type | Single-page React app + Node/Express API for **mock / paper crypto-futures trading** with rule-based bots and a PyTorch "learning bot" |
| Frontend | React 19, Vite 6, Tailwind 3, `lightweight-charts` 5, `lucide-react` |
| Backend | Express 5, one file: `server/mock-trading-server.js` (9,150 lines) |
| ML | `server/learning-bot/rl_trainer.py` (PyTorch DQN, CPU) launched via `spawn()` |
| Data feed | Binance Vision public REST + `wss://data-stream.binance.vision` websockets (client-side) |
| Live money | **Not enabled.** Everything is local-paper / testnet. Phase 3 is a hard live-money gate. |
| Runtime | PM2 process `xeniostrade-api`, served publicly by nginx at `https://projxenios.trade` from `/var/www/xeniostrade` |
| Total code | ~20,600 LOC (`src` + `server`, JS/JSX only) |
| Build | `npm run build` — **passes** (Vite 6.4.1, 1669 modules, 8.8s). One benign warning: `NODE_ENV=production` in `.env`. |

### Pages (7, flat nav in `TopNavigation.jsx`)
Dashboard · Mock Trading · AI Training (`learning-bot`) · Wallets · Journal · Trade History · Settings.
Current page is persisted only in `localStorage` (`xeniostrade:current-page`) — there is no router and no URL per page.

### Frontend inventory
- **Root:** `App.jsx` (2,085 lines — auth, routing, 6 websockets/intervals, platform-state polling, inline dashboard trade-review panel).
- **Page components:** `MockTradingPage` (1,047), `SettingsPage` (1,028), `LearningBotPage` (743), `WalletsPage` (708), `CandlestickChart` (1,308, lazy-loaded), `TradeHistoryTable` (541), `JournalSummaryPage` (442).
- **Panels/widgets:** `AIAssistantSidebar`, `AutoTradeStatusPanel`, `WorkflowReadinessPanel`, `TradeHistoryStatsPanel`, `StatsBar`, `SidebarMarketList`, `Panel` (shared shell), `CoinAvatar`, `PriceDirectionPill`, `TradeDirectionBadge`.
- **Dead components (not imported anywhere):** `OrderBook.jsx`, `RecentTrades.jsx`.
- **lib/:** `accountMetrics`, `api`, `autoTradeReadiness`, `coinIcons`, `formatters`, `indicators`, `marginModes`, `signalModels` (Bot 1–4 definitions), `strategyPresets`, `tradeSignal` (whale-rejection analyzer), `tradingConfig`, `tradingSessions`, `usePersistentBoolean`, `wallets`.

### Server inventory
- **31 routes** (`/healthz`, `/api/auth/*`, `/api/health`, `/api/settings`, `/api/wallets/:id/sync`, `/api/volatile-markets`, `/api/signal-model-analysis`, `/api/trade-history`, `/api/learning-bot/*`, `/api/dashboard-trade-review`, `/api/mock-order`, `/api/journal-summary`, `/api/auto-trade-*`, `/api/workflow-readiness`, `/api/bot-settings-log`, `/api/settings-audit-log`, SSE `/api/auto-trade-events`, static frontend). All `/api/*` except `/api/auth/*` require the session cookie.
- ~250 top-level functions in one module: market-data cache + circuit breaker, indicators (EMA/RSI/MACD/ATR/ADX/VWAP), candlestick pattern detectors, 4 bot signal engines, exchange execution/reconcile, learning-bot dataset/scoring/training, settings self-heal/recovery/audit, workflow-phase evaluation, terminal logging.
- Background timers: terminal monitor (10s), open-trade update (10s), auto-trader scan (5m).

### Persisted data (`server/data/`, ~10 MB of mutable JSON living in the source tree)
| File | Size | Rows |
|---|---|---|
| `auto-trade-log.json` | **6.6 MB** | 1,500 |
| `trade-history.json` | **2.1 MB** | 1,165 |
| `workflow-review-log.json` | 219 KB | 80 |
| `settings-audit-log.json` | 152 KB | 113 |
| `bot-settings-log.json` | 1.3 MB | 200 |
| `learning-bot-dataset.json` | 17 KB | (3 keys) |
| `settings.json` / `settings-recovery.json` | 7.6 KB / 1.5 KB | contains exchange credentials |

### Deploy / ops
- `deploy/oracle/xeniostrade.service` (systemd unit, unused — PM2 is the live runtime).
- `docs/ORACLE_ALWAYS_FREE_DEPLOY.md` (only doc file).
- `scripts/` is empty.
- Publish path: manual `sudo rsync -a --delete /home/xenios/app/dist/ /var/www/xeniostrade/` after every frontend build (agent cannot run it; documented drift incident where nginx served a stale bundle).

---

## 2. Findings

Severity: **H** = fix before any real money / before sharing the repo · **M** = fix soon · **L** = cleanup / nice-to-have.

### Security & secrets

| # | Sev | Finding |
|---|---|---|
| S1 | **H** | `.env` **and** `.env.example` both contain real-looking live values for `BINANCE_TESTNET_API_KEY`, `BINANCE_TESTNET_SECRET_KEY`, and `APP_LOGIN_PASSWORD` (values redacted here). `.env.example` is meant to be a committed template — it must hold placeholders only. Rotate the Binance testnet key and the app password, then scrub `.env.example`. **(`.env.example` scrubbed 2026-08-29; `.env` is now gitignored. Rotation of the exposed keys is still the owner's to do.)** |
| S2 | **H** | No `.gitignore` and the folder is **not a git repo**. The moment it is `git init`'d and pushed, `.env`, `server/data/settings.json` (exchange credentials per `agent.md`), and 10 MB of trade logs go with it. Add `.gitignore` (`.env`, `node_modules`, `dist`, `server/data/*.json` except a seed, `*.log`, `launcher-logs/`) **before** the first commit. |
| S3 | M | `/api/auth/login` has **no rate limiting, lockout, or delay**. Single shared password → brute-forceable. Add per-IP throttling + exponential backoff and a short ban after N failures. |
| S4 | M | Auth sessions are an in-memory `Map`. Every PM2 restart / deploy logs out **all** users, sessions can't be shared across processes, and there is no server-side revocation list beyond the map. Fine for one user today; a blocker for scaling or for "stay logged in across deploys". |
| S5 | L | Session cookie is only `Secure` when `AUTH_COOKIE_SECURE=true`, which is not set anywhere. It currently relies entirely on nginx TLS termination. Set it in `.env` for prod. |
| S6 | L | `.env` sets `NODE_ENV=production`, which Vite explicitly rejects and warns about on every build. Move that to the PM2 ecosystem / systemd unit, not `.env`. |
| S7 | L | `dist/` on disk is world-writable (`drwx---rwx`). Tighten permissions. |

### Correctness & reliability

| # | Sev | Finding |
|---|---|---|
| R1 | **H** | **Public market-data polling is brittle.** `agent.md` documents repeated Binance `418` / `429` / connect-timeout storms from open-trade monitoring + the 5-min scanner. A TTL cache + in-flight de-dupe + circuit breaker were added and help, but live position monitoring still depends on public REST polling. This is called out in `agent.md` as an explicit real-money blocker. Move live prices to the websocket/user-data streams server-side. |
| R2 | M | **Bot 4 "bootstrap mode" self-disables too early** (open item in `agent.md`, not fixed): `hasOwnModelPolicy` flips true as soon as *any* `model-4` row exists, so after ~9 trades (6 losses) it scores ~20 and hard-blocks everything at threshold 45 → Bot 4 stops trading and can never gather more data. Needs a minimum-sample gate before bootstrap turns off. |
| R3 | M | **Settings self-heal is fragile.** The recovery-snapshot system has already silently reverted `learningBot` settings once (root-caused and patched in `agent.md`). Any new top-level settings key must be manually added to `buildSettingsRecoverySnapshot`, `getSettingsRecoverySnapshot`, the comparison, and the restore path, *and* mirrored into `settings-recovery.json`, or it will revert on the next `getSettings`. Easy to get wrong. |
| R4 | M | `App.jsx` recreates the 30-second platform-refresh interval, `loadMarkets`, and the SSE-adjacent effects whenever `selectedSymbol` changes (it is in the dependency array of the polling effect). Symbol switching therefore tears down and rebuilds timers. Split the "poll platform state" effect from the "selected symbol" concerns. |
| R5 | L | `formatPrice(value, 5)` is used for every asset regardless of tick size — high-priced pairs get 5 dp of noise, sub-cent alts lose precision. Derive decimals from the symbol / price magnitude. |
| R6 | L | `node --check` cannot lint `.jsx` (documented). The **only** pre-deploy verification is a full `vite build`. There is no fast syntax/lint gate. |

### Performance

| # | Sev | Finding |
|---|---|---|
| P1 | M | `/api/trade-history` returns **all 1,165 rows (2.1 MB)** and `/api/auto-trade-log` returns **all 1,500 rows (6.6 MB)** on every poll. `App.jsx` refreshes both every 30 s (and on many SSE events). The client then paginates locally to 15 rows/page — after downloading everything. Add server-side pagination / `?limit`/`?since` and stop shipping the full logs. |
| P2 | M | `AUTO_TRADE_LOG_LIMIT` = 1,500 and `TRADE_HISTORY_LIMIT` = 100,000. The history file will grow toward tens of MB (Bot 4 alone was doing ~40 trades/day in bootstrap). JSON-file storage rewrites the whole file on every append. Consider SQLite / append-only NDJSON, or at least a much smaller retained window for what the API serves. |
| P3 | L | Main JS bundle is 451 KB (123 KB gzip). Only `CandlestickChart` + `lightweight-charts` are split out. `lucide-react` is imported by-name in 17 files (tree-shakes OK with Vite, but worth confirming in the build report). Route-level code-splitting per page would cut first load. |
| P4 | L | `Panel`'s `collapsedContent` + `keepMountedWhenCollapsed` still renders hidden children with a `hidden` class — collapsing a panel does not stop its work or reduce DOM. It only hides. |

### Maintainability

| # | Sev | Finding |
|---|---|---|
| M1 | **H** | `server/mock-trading-server.js` is **one 9,150-line file with ~250 functions** and no module boundaries: routing, indicators, pattern detection, 4 bot engines, exchange I/O, ML orchestration, settings machinery, logging. Every change is high-risk and hard to review. Split into `server/lib/` modules (market-data, indicators, signals/bot1-4, exchange, learning-bot, settings, workflow, routes). |
| M2 | M | `src/App.jsx` (2,085 lines) is a god component. Pull out: an `AuthGate`, a `usePlatformState` hook (the `Promise.allSettled` refresh), the websocket hooks (`useMarketTradeStream`, `useKlineStream`, `useTradePriceStream`), and the `DashboardTradeReviewPanel` (~250 lines currently inline as `renderDashboardTradeReviewPanel`). |
| M3 | M | **No tests, no ESLint, no Prettier, no README, no CI.** 20k LOC of trading logic with money-shaped math and zero automated checks. At minimum: unit tests for `lib/accountMetrics`, `lib/indicators`, `lib/tradeSignal`, and the server's PnL / risk / step-alignment helpers; an ESLint config; a `README`. |
| M4 | M | Mutable runtime state (10 MB of logs, plus `settings.json` with credentials) lives **inside the source tree** at `server/data/`. Move to a data dir outside the repo, keep only a committed seed/example, and `.gitignore` the rest. |
| M5 | L | `OrderBook.jsx` and `RecentTrades.jsx` are dead code — delete or wire up. |
| M6 | L | `agent.md` (569 lines) is doing triple duty as changelog + architecture doc + decision log, maintained by hand ("always update this after every edit"). Valuable context, but it is not discoverable as docs and drifts from code. Extract the stable parts (architecture, bot definitions, phases, deploy) into `docs/`. |
| M7 | L | Empty `scripts/` dir; stale zero-byte logs at repo root (`dev.err.log`, `server-3002.log`, etc.); unused `deploy/oracle/xeniostrade.service`. Tidy. |

### Ops / deploy

| # | Sev | Finding |
|---|---|---|
| O1 | M | Publishing the frontend is a **manual `sudo rsync` to `/var/www/xeniostrade`** that the agent can't perform and that has already served a stale bundle in the past. Give `xenios` a scoped passwordless-sudo rule for exactly that rsync (or a deploy script / systemd path unit), so build + deploy is one step. |
| O2 | L | Two PM2 daemons exist (an empty root one at `/root/.pm2`, the real one at `/home/xenios/.pm2`). Restarting as `sudo` hits the wrong one. Document/remove the root daemon. |
| O3 | L | Several pending items in `agent.md` (Bot 3/4 fixes, "train on all trades") were coded but note a still-**pending `pm2 restart xeniostrade-api` + deploy rsync**. Confirm the running process actually has the latest code. (PM2 currently shows `xeniostrade-api` online, 4 restarts, <1h uptime — it was restarted recently.) |

---

## 3. UI / UX audit

The visual language is **consistent and already fairly polished**: dark `slate-950` ground, glassmorphism panels (`bg-white/5 backdrop-blur-xl`, `rounded-3xl`, `shadow-glow`), a radial-gradient + grid backdrop, and four semantic accent colors (sky = info/active, emerald = up/win, rose = down/loss, amber = pending/warning). One shared `Panel` shell gives every section the same header treatment. That's a good foundation. The problems are **layout, density, hierarchy, and navigation**, not the palette.

### Layout & navigation

- **No router.** Page lives in `localStorage` only → no deep links, no shareable URLs, browser Back/Forward don't work, refresh always lands wherever you last were. For a multi-page control panel this is the biggest structural gap.
- **The header is enormous.** On Dashboard it stacks: `BrandMark` + title + a 4–8 cell stat grid (selected pair, auto-universe with expand/collapse, trading mode, risk model, a *second* logout button) + a divider + the 7-pill nav. It consumes ~220 px before any content and repeats data shown elsewhere.
- **Logout appears twice** — a fixed pill top-right *and* a card inside the header grid.
- **Nav is 7 undifferentiated pills** in a wrapping row. No icons, no grouping (trading vs. analysis vs. config), no active-section affordance beyond fill color.
- **Dashboard's 3-column grid** (`320px | 1fr | 360px`) only engages at `2xl`. Between `lg` and `2xl` everything linearizes and the market list / AI sidebar become full-width blocks sandwiching the chart.
- **Cards inside cards inside cards.** `Panel` → bordered sub-card → bordered stat tile → pill. Three-plus levels of `border-white/10 rounded-2xl` nesting is the norm (see `MockTradingPage`, `TradeHistoryTable` rows, `JournalSummaryPage`). It reads as busy and flattens hierarchy.

### Hierarchy & typography

- Almost everything is `text-xs`/`text-sm` with `uppercase tracking-[0.18em–0.28em]`. Wide-tracked uppercase is used for *labels, values, badges, nav, and body* — so nothing stands out. Few real headings; page titles are `text-3xl` hero blocks on some pages (`MockTradingPage`, `LearningBotPage`) and absent on others (`Dashboard`, `Trade History`).
- Inconsistent page framing: Mock Trading and AI Training open with a big marketing-style hero + "how to read this page" explainer card; Dashboard / Journal / Trade History / Wallets just start with a `Panel`.

### Redundancy

- Auto-trade status is rendered on **both** Dashboard (`AutoTradeStatusPanel`) and Mock Trading (its own controller + activity).
- AI advisory / signal readiness appears in `AIAssistantSidebar` (Dashboard + Mock Trading), in `MockTradingPage`'s hero, and per-row in `TradeHistoryTable`.
- Trading mode + risk model + tracked-symbol universe show in the header, in the Mock Trading controller, and in the auto-trade panel.

### Accessibility & feedback

- **Status is frequently color-only** (P/L tone, direction, phase). Add an icon or text token alongside color everywhere it carries meaning.
- Icon-only buttons (journal month arrows, some pills) lack `aria-label`.
- `color-scheme: dark` is hard-set; **no light theme**.
- `<select>` elements are restyled (`appearance-none`) with inconsistent focus rings vs. the custom focus styling on inputs.
- No skip-link; the decorative `absolute inset-0` gradient/grid layers sit in normal flow (they're behind content, but there's no `pointer-events-none` and they're not `aria-hidden` in every spot).
- **Error UX is a single red bar** at the top of `main`; per-panel feedback (`autoTradeFeedback`, `dashboardTradeReviewError`, settings errors) is ad hoc and styled slightly differently each time. No toast system.
- Only `CandlestickChart` has a real loading state; tables/panels show literal strings like "Live feed pending" / "Pending".

### Smaller items
- `formatPrice(x, 5)` fixed precision (see R5) shows up directly in the UI.
- The `TradeHistoryStatsPanel` marquee ticker animates infinitely (respects `prefers-reduced-motion`, good) but competes for attention with the KPI grid right above it.
- Mobile: `max-w-[1800px]` shell is fine, but the header stat grid, the head-to-head journal table (min-width 760+), and the dense trade rows are cramped < 640 px.

---

## 4. Dashboard / UI recommendation

You asked whether to pick a template or take a recommendation. **Recommendation: don't drop in a third-party dashboard template — refactor the shell and consolidate the design system you already have.** The palette, the `Panel` shell, `CoinAvatar`, the badges, and `lightweight-charts` (already a dependency) are 80% of a good trading dashboard. A template (Tremor / shadcn dashboard / a Tailwind admin kit) would fight the existing look and add dependency weight for components you've largely built.

### Target: an app-shell layout

```
┌───────────────────────────────────────────────────────────────┐
│  Top bar (56px): brand · symbol search · mode badge ·          │
│                  market-data health dot · acct P/L · logout    │
├───────┬───────────────────────────────────────────────────────┤
│ Side  │  PAGE CONTENT                                          │
│ nav   │  ┌──────────── KPI row (6 StatCards) ───────────────┐  │
│ (icon │  │ balance · realized · unrealized · win% · open ·  │  │
│  +    │  │ today's auto trades                              │  │
│ label,│  └─────────────────────────────────────────────────┘  │
│ groups│  ┌─────────────── chart ────────────┬── AI signal ──┐ │
│ , col-│  │ lightweight-charts + overlays    │ checklist /   │ │
│ lapsi-│  │                                  │ advisory      │ │
│ ble)  │  ├──────────────────────────────────┴───────────────┤ │
│       │  │ Auto-trade status  │  Workflow phases (1·2·3)    │ │
│       │  └──────────────────────────────────────────────────┘ │
└───────┴───────────────────────────────────────────────────────┘
```

### Concrete changes

1. **Add `react-router`.** One route per page (`/dashboard`, `/mock-trading`, `/ai-training`, `/wallets`, `/journal`, `/trades`, `/settings`). Keep `localStorage` only as the redirect target for `/`. Restores deep links + Back button.
2. **Left sidebar nav** (icon + label via `lucide-react`, collapsible to icons, grouped: *Trading* — Dashboard, Mock Trading, Trades · *Analysis* — Journal, AI Training · *Config* — Wallets, Settings). Removes the 7-pill row.
3. **Collapse the header into a 56 px top bar:** brand, a global symbol picker (replaces the "Selected Pair" card), a single trading-mode badge, a **market-data health indicator** (you already compute `getMarketDataHealthSnapshot()` — surface it), a compact account P/L, one logout. Move "Auto Universe" and "Risk Model" into the Dashboard body where they belong.
4. **Standardize primitives** in `src/components/ui/`: `StatCard`, `Panel` (keep), `Badge`, `Section`, `DataTable`, `EmptyState`, `Toast`. Replace the ad-hoc bordered-div-in-bordered-div nesting with these. Cap nesting at 2 levels (Panel → card).
5. **Design tokens** in `tailwind.config.js` / CSS vars: spacing scale, 2 radii (`lg`, `xl` — not `2xl`/`3xl`/`[26px]`/`[28px]`/`[30px]` all at once), the 4 semantic colors as `--color-up/-down/-info/-warn`, 3 text roles (`heading`, `body`, `label`). Then a **light theme** is just a second token block.
6. **KPI row** on the Dashboard from `summarizeAccount()` data: running balance, realized PnL, unrealized PnL, win rate, open positions, today's auto trades. This is the "dashboard" the app is currently missing — right now the Dashboard page is chart + sidebars with the numbers scattered.
7. **One global `<Toast>` / notification center** fed by all the `error` / `*Feedback` / `*Error` states. Drop the per-panel bespoke red/amber bars.
8. **Route-level `React.lazy`** for each page (like `CandlestickChart` already is) to cut first load.
9. **De-dupe:** `AutoTradeStatusPanel` lives on the Dashboard; Mock Trading links to it rather than re-rendering it. AI advisory has one canonical home (the signal panel) and is referenced, not repeated, elsewhere.
10. **Typography pass:** reserve `uppercase tracking-wide` for small labels only; give each page an `<h1>` at a consistent size; drop the marketing hero blocks on Mock Trading / AI Training in favor of a normal page header + an optional collapsible "How this works".

### If you do want a library for parts of it
- **Stat/KPI + sparkline widgets:** [Tremor](https://tremor.so) (Tailwind-native, matches the stack) — but only for the KPI row / small charts, keep `lightweight-charts` for the main price chart.
- **Primitive set:** shadcn/ui (copy-in, not a dependency) for `Dialog`, `DropdownMenu`, `Tabs`, `Toast`, `Tooltip` — these you'd otherwise hand-roll.
- Avoid full admin templates (CoreUI, Tailwind Admin, Material dashboards): wrong visual language, heavy.

### Suggested order of work
1. `.gitignore` + scrub `.env.example` + rotate secrets (S1, S2) — do this first, before anything else touches the repo.
2. App-shell: router + sidebar + slim top bar (changes 1–3).
3. `ui/` primitives + tokens + toast (changes 4, 5, 7).
4. Dashboard KPI row + de-dup (changes 6, 9).
5. Server-side pagination for history/log endpoints (P1) — needed before the trade log gets bigger.
6. Split `mock-trading-server.js` and `App.jsx` (M1, M2), add ESLint + a first test file (M3).

---

## 5. Quick wins (low effort, visible)

- Delete `OrderBook.jsx`, `RecentTrades.jsx`, empty `scripts/`, root `*.log` stubs.
- Remove `NODE_ENV=production` from `.env` (kills the build warning).
- Replace `.env.example` values with placeholders.
- Add `aria-label` to the icon-only buttons in `JournalSummaryPage` month nav.
- Remove the duplicate logout in the header grid; keep the top-right pill.
- Add `pointer-events-none` + `aria-hidden` to the decorative gradient/grid layers.
- Tighten `dist/` permissions.

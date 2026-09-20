# Session log — XeniosTrade

Running worklog so a new session can pick up where the last one stopped.
**Read the "WHERE WE LEFT OFF" block first, then the top session entry.**
Companion files: `GO_LIVE_READINESS.md` (readiness decision record),
`server/backtest/README.md` (backtest harness).

Convention: newest session on top. Update "WHERE WE LEFT OFF" at the end of
every session. Times are UTC. Server logs are UTC+8 (Asia/Manila).

---

## WHERE WE LEFT OFF  — as of 2026-09-20 (latest)

### Position Manager replaces the Decision Agent — 2026-09-20 (deployed, server restarted, first live review seen)

**Owner spec:** keep the architecture, change only the fifth AI role. Four AI agents decide entry (Analyst Codex, Flow Claude, Critic Codex, Risk Manager Codex); the Risk Manager is the FINAL entry approver (APPROVE / REDUCE / VETO + confidence; no Decision Agent). The fifth AI, **Position Manager (Claude)**, re-reviews every open trade every 5 min and decides HOLD / MOVE_TO_BREAKEVEN / TIGHTEN_STOP / LET_PROFIT_RUN / EXTEND_TAKE_PROFIT / PARTIAL_TAKE_PROFIT / EXIT_NOW. **No fixed trading rules in code** (R multiple etc. are prompt inputs only). Details: `docs/AI_TRADING.md` -> "Position Manager".

**Built:** `server/ai-trading/position-manager.js` (metrics, prompt, parser, `planPositionAction` safety checks, partial/review bookkeeping), Position Manager block + review loop + `POST /api/ai-trading/trades/:id/review` in `mock-trading-server.js`, pipeline without the Decision stage (`confidence` on the Risk Manager, gate on it), config `decision` -> `manager` migration, `execution.positionManagerActsOnReal` (off), UI: Trade History -> Position Manager panel (timeline + Review now), report/model pages/homepage text. `npm test` 200/200.

**Code-enforced safety (not trading rules):** a stop can only move toward profit and must be on the protective side of price; a target can only be extended/removed; partial 1-99%; size never added; invalid actions are rejected whole and the trade keeps its orders. On REAL money the Position Manager only advises unless "Position Manager acts on real money" is switched on in AI Settings.

**Verified live:** one real Claude review of the open testnet XRPUSDT trade: HOLD, thesis 42%, -0.59R, good reasoning, saved. **NOT verified live:** any executed action on the exchange (stop replacement, partial close, target change, EXIT_NOW) — the exchange code paths are not unit-tested (no fake exchange); watch the first executed action closely and check the stop/target orders on the testnet account. Partial-close PnL accounting (`partialRealizedPnl` added at final close) is also untested against a real partial.

**Still open from earlier:** the scan list is still the 10 TEMPORARY symbols (see the entry below); Critic is on Codex now (Gemini free tier = 20 calls/day).

### TEMPORARY: scan widened to 10 symbols + Claude/Codex agent providers — 2026-09-20 (deployed + server restarted)

**Owner request:** waiting for the first AI testnet trade; widen the auto-scan so more setups appear, then **return to the basic symbols after testing**.

**What is temporary (REVERT when testing is done):** `AI_TRADING_TEMP_SYMBOLS` in `src/lib/aiTrading.js` (XRP, DOGE, AVAX, SUI, NEAR, LINK, added on top of the base BTC/ETH/SOL/BNB) and `scan.symbols` in `server/data/ai-trading/config.json` (now those 10). To revert: set `AI_TRADING_TEMP_SYMBOLS = []`, `npm run build`, publish `dist/` to `/var/www/xeniostrade` (assets.old.<ts> procedure), `pm2 restart xeniostrade-api`, and set `scan.symbols` back to `["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"]` (or click the chips in AI Settings; the old list was those 4). Verified: a 10-symbol cycle takes ~100 s with the Codex Analyst; `npm test` 176/176.

**Agent setup at this point:** Analyst = Codex login, Flow = openrouter `qwen/qwen3.8-flash`, Critic = google (`gemini-3.5-flash`, Test OK 6.3 s), Risk = openrouter `deepseek/deepseek-v4.1-flash`, Decision = Claude login. Claude provider: `server/ai-trading/claude-agent.js` (Agent SDK; `@anthropic-ai/sdk` upgraded 0.70 -> 0.127 as its peer dep). Scan loop confirmed ticking every 5 min; every run so far is an Analyst HOLD, so Flow/Critic/Risk/Decision/testnet-open have not run live yet.

### Risk Limits page removed + AI Auto-scan every 5 min — 2026-09-20 (code done, frontend PUBLISHED, server NOT restarted)

**Owner requests:** (1) "remove risk limits page ... we leave the risk limits to the ai model" -> the tab, route (`/ai-trading/risk` now redirects) and nav entry are gone; `normalizeAiTradingConfig` always resets `config.risk` to the fixed defaults, so nothing user- or file-supplied can change them. The Risk Manager model decides stop/target/risk/leverage; the code ceilings (1% risk, 5x, 3% stop, R:R >= 1.5, confidence >= 60) were deliberately KEPT as non-editable guardrails (change `DEFAULT_AI_TRADING_CONFIG.risk` in `src/lib/aiTrading.js`). (2) "can it not run every 5 mins and find a trade?" -> **Auto-scan**, see `docs/AI_TRADING.md` -> "Auto-scan". Off by default; Settings -> Auto-scan toggle + symbol chips + per-symbol status.

**Verified:** `npm test` 169/169 (new `test/ai-trading-scan.test.js`), production build, published to /var/www/xeniostrade. **NOT verified:** the scan loop itself (never run; the server hasn't been restarted with it).

**Owner's current goal:** get **one successful AI trade** (testnet) and check how effective it is BEFORE any cost tuning. Cost-per-trade notes per model are in `docs/AI_TRADING_COSTS.md` (estimates; not measured against a live provider). Every real run so far was HOLD.

**Update (same day, after the owner's restart):** the scan loop ran on its own (BTC HOLD from `z-ai/glm-5.2:free`; ETH/SOL/BNB failed instantly with OpenRouter's generic "Provider returned error"). Added `describeProviderError` (`llm.js`, tested) so the upstream host + raw reason (likely a free-tier rate limit; NOT confirmed) show in the scan status — needs one more `pm2 restart` to take effect.

**Codex as an agent provider (owner request):** AI Models -> Agent Assignments now lists "Codex (this server's login)"; see `docs/AI_TRADING.md` -> "Codex as an agent provider". Backend needs `pm2 restart xeniostrade-api`; frontend published. 173/173 tests + one real SDK smoke call (6.8 s).

**NOT done — needs the owner:**
1. `pm2 restart xeniostrade-api` (drops logins once) — without it neither the fixed-risk change nor the scan exists server-side, and the Settings toggle will save but nothing scans.
2. **Pick a fast Analyst model** (AI Models -> Agent Assignments). It is on free `nvidia/nemotron-3-ultra-550b-a55b:free`, which took 43.9 s then timed out at the 45 s limit; scanning with it will mostly log Analyst errors. Which providers have keys saved was never checked (the classifier blocked reading credentials).
3. Turn Auto-scan on in AI Settings, watch the first cycle in the status panel / `pm2 logs`.

### AI workspace: Trade History, Journal, Wallet, Settings + testnet / real-money modes — 2026-09-20 (code done, restarted, frontend NOT published)

**Owner request** (the disconnected last task): "add trading history, journal (calendar), wallet, setting for ai model api, testnet and real money trading mode" to the AI workspace. Decisions (asked): AI gets its **own wallet + ledger** (separate from bots); **real money = manual confirm + arm switch**, never autonomous.

**Built:** see `docs/AI_TRADING.md` -> "Wallets, trading modes and execution". New: `server/ai-trading/execution.js` (pure safety rules), `test/ai-trading-execution.test.js` (11 tests), ledger in `store.js` (`trades.json`), execution/ledger/monitor block + 3 endpoints in `mock-trading-server.js`, `execution` block in `src/lib/aiTrading.js` config, pages in `src/components/aiTrading/` (History, Journal, Wallet, Settings, ExecutionPanel on approved verdicts, top-bar mode badge), ai nav = Trading / Records / Config (`navItems.js` `getAiNavGroups`). `WalletJournalCalendar` and `AgentAssignmentStrip` are now exported for reuse.

**Verified:** `npm test` 165/165; production build; screenshots (desktop + 390px) on a scratch server; scratch-server API run covering all real-money gates (not armed / wrong confirm / no live keys / auto+real refused / stale / drift / one-position cap), paper open -> monitor settle -> journal, manual close, and ONE real Binance **testnet** trade (entry + SL/TP algo orders, monitor left it open, manual close, account back to the bots' 6 positions). Scratch had no live keys and its own data dir; deleted afterwards. **Live `pm2 restart xeniostrade-api` done** (online, no crash loop). Live `server/data/ai-trading/` has no `trades.json` yet.
**NOT verified:** a live real-money order (never placed); the auto-execute-after-run path against a real LLM-approved run (all real runs so far were HOLD; the hook is unit-covered only through `assertCanExecute`).

**NOT done — needs the owner:**
1. **Publish the new frontend** — the permission classifier blocked it again. `dist/` is built (`index-DVYTsC06.js`). Run: `cd /home/xenios/app && TS=$(date +%s) && mv /var/www/xeniostrade/assets /var/www/xeniostrade/assets.old.$TS && cp -r dist/assets /var/www/xeniostrade/assets && cp dist/index.html /var/www/xeniostrade/index.html` then hard-refresh. (:3001 already serves the new build.)
2. **Log in again** on each host (the restart cleared in-memory sessions).
3. To try it: ai.projxenios.trade -> Settings (defaults: testnet, auto-execute ON, real disarmed, 5 USDT real margin cap) -> run the pipeline. Real money stays disarmed until the owner arms it.
4. Live Binance keys ARE saved and the real wallet reads the ~10 USDT live balance, so arming real money would place real orders. GO_LIVE_READINESS.md is still NO.
Carry-overs from earlier today (Google console redirect URI, nginx/cert script, secret rotation) are unchanged below.

### Update: Google-only sign-in on the public hosts — 2026-09-20
Owner: "remove 'Use the owner password instead' on login, just google login from now on." Homepage, ai. and bot. login screens now show ONLY "Sign in with Google" (verified live: no password input). `PASSWORD_LOGIN_ENABLED` (`appMode.js`) keeps the password form on localhost/127.0.0.1 only, because the OAuth callback is registered for the apex and a local instance would otherwise be locked out. **Server side unchanged:** `POST /api/auth/login` still accepts `APP_LOGIN_PASSWORD` from anyone who calls the API directly — only the UI was removed. Disabling it (e.g. an env flag) is a one-line change if the owner wants Google to be the *only* way in; the trade-off is no fallback if Google/OAuth breaks. Published as bundle `index-CiQth4un.js` (previous assets in `assets.old.1789884814`).

### Public homepage + Google sign-in on projxenios.trade — 2026-09-20 (code done, NOT live yet)

**Owner request:** professional SaaS homepage on `projxenios.trade` (ai./bot. DNS already in Cloudflare) with Google login, using the supplied OAuth client.

**Built:**
- New `home` mode in `src/lib/appMode.js` for the apex + `www.` (`?app=home` on localhost). `main.jsx` lazy-loads `HomeApp` there, so visitors never download the trading app (homepage chunk ~23 kB). The apex NO LONGER serves the full app: `/dashboard`, `/ai-trading`, etc. redirect to bot./ai.; `localhost` stays `all` for dev.
- `src/components/home/HomePage.jsx`: hero with a clearly-labelled *illustrative* pipeline run, two workspace cards, platform grid, how-it-works, safeguards, sign-in card (Google + "owner password" fallback), risk disclaimer. Copy is factual only (15 bots, 23 providers, 5 agents, fail-closed, paper-first) — deliberately NO pricing, stats or testimonials (private paper-trading system; see GO_LIVE_READINESS.md). Verified at 390/820/1440px, no horizontal overflow.
- `server/google-auth.js` (auth-code flow + PKCE + HMAC-signed state cookie + nonce; client secret stays server-side) with routes `GET /api/auth/google/{status,start,callback}` in `mock-trading-server.js`. **Access requires the verified email to be in `GOOGLE_ALLOWED_EMAILS`; an empty list rejects everyone.** Return URLs restricted to projxenios.trade / ai. / bot. (no open redirect). `test/google-auth.test.js` (11 tests); `npm test` 154/154.
- **One login for all three hosts:** session cookie gets `Domain=.projxenios.trade` (only when the request host is under it, so 127.0.0.1/SSH-tunnel access stays host-only); logout clears both variants; lookup tolerates a stale duplicate cookie. ai./bot. login screens also show "Sign in with Google" (hops to the apex for the callback, then returns).
- `.env` (gitignored, untracked) now has GOOGLE_CLIENT_ID/SECRET, `GOOGLE_ALLOWED_EMAILS=xeniosgaming87@gmail.com` (ASSUMED to be the owner's Google account — CONFIRM), `GOOGLE_REDIRECT_URI`, `AUTH_COOKIE_DOMAIN=.projxenios.trade`, `AUTH_COOKIE_SECURE=true`. `.env.example` has placeholders.

**NOT done — needs the owner:**
1. **Google Cloud Console:** Google answers `redirect_uri_mismatch` — add `https://projxenios.trade/api/auth/google/callback` under the OAuth client's *Authorized redirect URIs*. (The client ID itself is valid.) Until then the Google button fails at Google; password login still works.
2. **Restart the API** to load the routes/.env: `pm2 restart xeniostrade-api` (drops in-memory sessions once). NOT run — live system.
3. **Publish `dist/`** to `/var/www/xeniostrade` (usual procedure). Blocked by the permission classifier last time; not attempted again.
4. **ai./bot. still return 526** until `sudo bash deploy/nginx/enable-subdomains.sh` is run (cert expansion).
5. The client secret was pasted into chat — consider rotating it after go-live and updating `.env`.
Suggested order: 4 -> 1 -> 2 -> 3.
Verification note: the real `.env` creds + `google-auth.js` were exercised through a scratch server (not the trading server); the live API was never restarted.

### Split into ai.projxenios.trade and bot.projxenios.trade — 2026-09-20 (code done, NOT live yet)

**Owner request:** "separate bot trading and the new ai trading — ai.projxenios.trade / bot.projxenios.trade — arrange the ui accordingly for each."

**Design:** ONE frontend build + ONE backend (127.0.0.1:3001); the hostname picks the workspace (`src/lib/appMode.js`): `ai.*` -> AI Trading, `bot.*` -> Bot Trading, anything else (apex `projxenios.trade`, localhost) -> `all` = the original full UI, unchanged. Dev preview without DNS: `http://localhost:5173/?app=ai` (or `bot`; only honoured on localhost, remembered in sessionStorage).
- **ai.\***: nav = AI Trading (Pipeline/Run History/Risk Limits) + AI Models (Providers & Keys, Browse Models, Agent Assignments). TopBar shows "Advisory · no orders" instead of the market picker / paper balance / feed dot. The bot-only streams (Binance kline/trade sockets, signal-analysis + auto-trade polling, auto-trade SSE) are switched off (`IS_AI_APP` guards in `App.jsx`). Bot paths redirect to the bot host.
- **bot.\***: everything except AI Trading; AI Models shows Providers & Keys + Bot Assignments only. `/ai-trading` redirects to the ai host.
- Sidebar has a "Switch to ..." link to the sibling workspace (only when on a real subdomain). Login page/`document.title` are per-workspace.
- Files: `src/lib/appMode.js` (new), `shell/navItems.js` (`getNavGroups(mode)`, mode-aware `resolveInitialPath`; still CRLF), `Sidebar.jsx`, `TopBar.jsx`, `AiModelsPage.jsx`, `App.jsx` (routes/ExternalRedirect/guards), `test/app-mode.test.js` (7 tests). `npm test` 142/142; built and screenshotted all three modes (desktop + 390px) against :3001.

**NOT done — needs the owner (no sudo here, and the live publish was blocked by the permission classifier):**
1. **nginx + cert.** Both subdomains already resolve to Cloudflare but return **526**: nginx has no server block for them and the origin cert only covers `projxenios.trade`. Run `sudo bash /home/xenios/app/deploy/nginx/enable-subdomains.sh` (adds the names to both `server_name` lines, `certbot --nginx --expand --cert-name projxenios.trade`, reloads nginx; idempotent; backs up the config first). Cloudflare SSL mode is Full (strict) — that's why the cert has to be expanded.
2. **Publish the build** to `/var/www/xeniostrade` (the usual procedure in the note below). `dist/` is already built with this change, but the public site still serves the previous bundle until it's copied. The apex site keeps the full UI, so publishing is low-risk.
3. **Login is per host.** The session cookie is host-only (`SameSite=Strict`, no `Domain=`), so ai., bot. and the apex each need their own login. Making it shared would be an auth change (`Domain=.projxenios.trade`) — deliberately not done.
**Open choice:** the apex `projxenios.trade` still serves the full combined UI. Say if it should redirect to bot. or become a chooser page. `www.` resolves but isn't on the cert either (pre-existing).

### AI Trading page (5-agent advisory pipeline) + AI Models "Agent Assignments" tab — 2026-09-20

**Owner request:** "update ai models page", plus a *separate* page "ai trading" for a 5-agent flow (Market Analyst -> Quant -> Critic -> Risk Manager (code) -> Decision Agent). Explicitly "not another bot". Owner also referenced 3 screenshots at `C:\Users\Rain\Pictures\Screenshots\1-3.png` for the UI — **those were not reachable from this Linux box, so the UI follows the app's existing style, NOT the screenshots.** If the look should change, put the images somewhere on this machine (e.g. `~/Pictures`) and restyle `AiTradingPage.jsx` / `AiTradingRunReport.jsx` / the Agent Assignments tab in `AiModelsPage.jsx`.

**What was built** (full write-up: `docs/AI_TRADING.md`):
- `/ai-trading` (Pipeline, Run History, Risk Limits) — advisory only: no wallet, no signal model, never places an order.
- `/ai-models/agents` — provider + model per LLM agent (Analyst, Critic, Decision) using any provider in the AI Models catalog.
- Backend `server/ai-trading/*` + 4 endpoints in `mock-trading-server.js`; state in `server/data/ai-trading/{config,runs,quant-stats}.json` (NOT in settings.json on purpose).
- Fail-closed gates; Decision Agent cannot override a veto or flip direction; Risk Manager is plain code with hard-bounded limits.

**Verified:** `npm test` 112/112 (22 new, incl. provider caller vs local fake servers); `pm2 restart xeniostrade-api` clean; live `POST /api/ai-trading/run` on BTCUSDT pulled real Binance data and failed closed (no provider key saved -> HOLD); auth 401 when logged out; both pages screenshotted in headless Chrome with a seeded run (seed removed afterwards).

**NOT verified:** a real LLM round-trip — no provider API key is saved yet, so the Analyst/Critic/Decision prompts have only run against scripted fakes. First thing to do: save a key on AI Models -> Providers & Keys, run BTC, read the three replies.

**Follow-up same day — "Market Analyst: Failed / HTTP 404" (owner had assigned Google/Gemini):** three separate causes, all fixed and verified live with the owner's Gemini key:
1. `gemini-2.0-flash` (the catalog default) was retired by Google -> 404. Google wraps error bodies in an array (`[{"error":{...}}]`), which my parser missed, hence the bare "HTTP 404". Now parsed; catalog default for Google is `gemini-3.5-flash` (`gemini-2.5-flash` is also closed to new keys; `gemini-flash-latest` was overloaded at test time — overload is per-model and transient, one 503 retry added).
2. Reasoning models spend hidden thinking tokens out of `max_tokens`: at 1024 Gemini stopped at `finish_reason: length` mid-JSON. Now 4096, and a truncated reply raises a clear "cut off" error.
3. Real bug in my pipeline: the still-forming candle was included, so the Analyst saw "volume 0.00x". `buildMarketSnapshot` now drops candles with `closeTime > now`.
Live result: 4/4 symbols ran end-to-end (all HOLD — quiet post-selloff market); Critic (rejected a scripted LONG into a falling knife) and Decision Agent (downgraded to HOLD without quant evidence) each ran once against real Gemini with scripted upstream stages. A genuinely model-originated LONG has not been seen yet.
**NOT touched, needs an owner decision:** `server/strategy/bot-gemini.js` (Bot Gemini, wallet 13) hardcodes the same dead `gemini-2.0-flash` default, so with a Google key saved it 404s every scan cycle. Fix = set a model on AI Models -> Providers & Keys -> Google, or change the default in that file (which would start real Gemini calls/testnet trades on wallet 13).

**Owner change — "i want an ai model to be the risk manager instead":** Risk Manager is now an LLM agent (4 model-backed agents: Analyst, Critic, Risk Manager, Decision; only Quant is non-AI). Design choice, deliberate: the model proposes stop/target/risk %/leverage or vetoes, but `reviewRiskProposal` -> `runRiskManager` (code) re-runs its numbers through the Risk Limits, so it can be stricter than the limits and never looser (clamped + noted in the report; a plan still breaking a limit is rejected; an errored/malformed/unconfigured Risk Manager = veto, never unchecked sizing). It is skipped (no LLM spend) when Analyst/Quant/Critic already blocked. Old saved configs with no `risk` agent entry inherit the Analyst's provider. Verified: 121/121 tests; real Gemini Risk Manager run twice on live ETH data (scripted Analyst/Critic upstream) — vetoed both a LONG and a SHORT with data-grounded reasons. NOT seen live: a real model *approving* and having its numbers clamped (unit-tested with scripted replies only). Also reworded the AI Models "Data/Code · no model" badge to "Statistics · no AI". Deployed to /var/www/xeniostrade.

**Owner change — "build the market flow agent and replace the quant":** the Quant Agent is gone (as an agent AND as a gate); in its slot is a **Market Flow Agent** (LLM) that judges derivatives positioning + order flow: funding/basis, open interest vs price (code-computed regime label), long/short + top-trader ratios, futures taker flow, book depth, BTC move. Data: `server/ai-trading/flow-data.js`, Binance public futures endpoints, no keys, ~100 ms. Verdict SUPPORTS/NEUTRAL/AGAINST + crowding + flags citing numbers; AGAINST (or flow data unavailable / <2 of 5 sources / no provider) is a hard gate and skips all later paid stages. Metrics are stored beside the verdict for audit. Backtest stats are now one background line for the Risk Manager + Decision Agent and never block; `vetoOnNegativeEv` setting deleted. Old configs: the new `flow` agent inherits the Analyst's provider (owner's = Google). Found+fixed during live test: taker ratio was an average of per-candle ratios (pointed opposite to real flow) -> now volume-weighted; spot candle taker share relabelled. Verified: 130/130 tests; live data 5/5 sources for ETH/SOL; a real Gemini Flow Agent call on live SOL data (gemini-3.1-flash-lite) returned NEUTRAL/crowding MEDIUM with flags citing the real numbers; UI screenshotted; published to /var/www/xeniostrade. Real-Gemini limits hit: `gemini-3.5-flash` free quota ran out during testing (per-model; the per-stage error is shown and fails closed), and every real Analyst call so far returned HOLD, so a full model-originated LONG/SHORT through all five real stages has still never been seen.

**Owner request — "check localhost:5173/models for ui and add 'browse models', include all ai models, openrouter include free models, for testing":** the reference page is on the owner's Windows machine (port 5173 not reachable from here, same as the screenshots), so the UI follows the app's own style — if it should look different, get the reference onto this box. Built **AI Models -> Browse Models** (`/ai-models/browse`): live model lists for every connected provider (their saved key, server-side) + OpenRouter's public catalog always live (446 models, 24 priced at 0 / 22 chat) + suggested models for the rest; search/provider/free/JSON-mode/sort filters, "Free models for testing" shortcut, **Test** (one real call through `callAgentJson`), **Use for agent** (assign to any of the 5 agents), copy id. Endpoints `GET /api/ai-models/browse`, `POST /api/ai-models/test`. See docs/AI_TRADING.md.
Found live: (1) the owner's **OpenAI slot holds an OpenRouter key** (`sk-or-v1...`, OpenAI rejects it) — OpenRouter therefore shows "not connected" and its Test/Use buttons are disabled until a key is saved under OpenRouter on Providers & Keys. I did NOT move it (editing settings.json credentials is a landmine; the UI does it safely). The page now says so. (2) Ollama/LM Studio wrongly showed connected off the default localhost URL -> fixed (needs a saved URL, like the Providers page). (3) **Security:** provider 401s echo partial keys ("sk-or-v1****e47a") and I was passing that to the browser -> `redactSecrets` now applied to catalog + agent-call errors (so also stored run history). 135/135 tests. Published to /var/www/xeniostrade.

**Heads-up (now historical):** the Quant Agent's evidence (117k backtest trades, all rule-based Bots 1-4) has negative EV overall (~32% win / ~1.6 payoff), so with the default "block on negative EV" nearly every trade is vetoed. Correct per the data; toggle on Risk Limits tab.

**Publish step I missed at first (owner: "ui still not updated"):** `https://projxenios.trade` is served by **nginx from `/var/www/xeniostrade`**, a separate copy — `npm run build` only updates `/home/xenios/app/dist` (port 3001). After every frontend build: move `/var/www/xeniostrade/assets` to `assets.old.<ts>`, then copy `dist/assets` and `dist/index.html` in (works without sudo while those are owned by `xenios`; else `sudo rsync -a --delete /home/xenios/app/dist/ /var/www/xeniostrade/`). Done for this session's build (bundle `index-C2rpgMcF.js`); verify with `curl -sk https://localhost/ | grep -o 'assets/index-[^"]*'`.

**Gotchas added:** `npm run ai-trading:quant-stats` must be re-run after a new backtest (streams the 116 MB file; ~5s). `navItems.js` is CRLF — edit without normalising line endings. Uncommitted.

---

### (previous) 2026-09-16 entries

### Real Money Wallet balance sync was silently reading the testnet account — bug from the previous session's own safety fix — 2026-09-16

**Owner report:** Wallets page "Real Money Wallet" showed 855.77 USDT, but the
actual live Binance account only has 10.25 USDT (owner had drawn it down for
real-trade testing). Owner correctly suspected the *previous* session's fix
(the "only bot 5 can trade real money" change below, 2026-09-15) caused this,
since the balance was correct before that session.

**Root cause:** that fix's `resolveAuthorizedWalletEnvironment()` guard
included a "master kill switch" — any wallet is forced down to `TESTNET`
unless `settings.strategy.realMoneyExecutionArmed` is `true` (it's `false` by
design; live execution is still off). This gate was meant to stop *order
placement*, but it was also applied to `syncExchangeWalletBalance()` — the
read-only balance sync. So every "Sync Now" on `wallet-real-money` got routed
to the **testnet** API/credentials instead of the live ones. Proof:
`wallet-main` (testnet) and `wallet-real-money` (live) had identical synced
balance (855.77), available balance (601.57), and open-position count (6) —
both were reading the same testnet account.

**Fix** (`server/mock-trading-server.js`): `resolveAuthorizedWalletEnvironment`
now takes an optional `{ readOnly }` flag. The wallet-id/assigned-bot
authorization check still applies either way (still can't sync/trade an
unauthorized wallet as real money), but the `realMoneyExecutionArmed`
kill-switch is only enforced when `readOnly` is false. `syncExchangeWalletBalance`
now calls it with `{ readOnly: true }`, since it never places orders — it only
reads `fetchBinanceAccountSnapshot`. The three execution call sites
(`recordTrade`, `updateOpenTrades`'s `getWalletExchangeContext`, manual-close)
are untouched and still fully gated by the arm switch, since those can place
or close real orders.

**Verified:** `node --check` clean; `npm test` 66/68 (same 2 pre-existing
unrelated failures as before); `pm2 restart xeniostrade-api` clean, no crash
loop; logged in via `/api/auth/login` and called
`POST /api/wallets/wallet-real-money/sync` directly — response now shows
`lastSyncedBalance: 10.25`, `lastSyncedAvailableBalance: 10.25`,
`syncProvider: BINANCE_FUTURES_LIVE`, `syncStatus: CONNECTED` — correctly
reading the live account now. Backend-only change, no frontend rebuild
needed; the Wallets page will show the correct balance on its next sync/poll.

**Not touched:** `realMoneyExecutionArmed` itself is still `false` — no bot
places live orders, matching `GO_LIVE_READINESS.md` (still NO).

### CRITICAL FIX: bot wallets were mistakenly wired to live Binance for every bot, not just the assigned real-money bot — 2026-09-15

**Owner report:** "on real money trade page, it should only trade under the
chosen bot which is bot 5 right now, it should not trade using the other bot
but only on the assign bot."

**What was actually found (worse than the report suggested):** an uncommitted,
in-progress change (part of the still-unfinished Bots 9/10 / "Consolidated
Bot" work — see the many untracked `consolidated-*`/`ConsolidatedBot*` files)
had added a blanket override at the end of `normalizeWallets()` in
`src/lib/wallets.js`:
```js
// Bot wallets always trade live on the real-money environment now — forced
// here ... so it applies even to wallets already persisted with the old
// MANUAL/TESTNET values.
return { ...wallet, balanceMode: EXCHANGE_SYNC, environment: REAL_MONEY, ... }
```
This force-applied `environment: REAL_MONEY` + `balanceMode: EXCHANGE_SYNC`
to **all 10 per-bot wallets** (`wallet-model-1..10`), not just the one
assigned via Settings -> "Assign Real Money Bot" (`realMoneySignalModelId`,
= model-5). Combined with `autoTradingEnabled: true` and live Binance keys
already saved in settings, the next auto-trade cycle would have opened real
orders on the live account under **any** of the 9 non-assigned bots the
moment one found a qualifying setup — not just bot 5. Wallet balance syncing
was *already* actively hitting the live account for all 9 bots every cycle
(confirmed: `lastSyncedBalance: 71.42`, the real live balance, on wallets 1-4
and 6-10, all synced within ~11s of each other). No live *order* had fired
yet by the time this was caught (all 656 REAL_MONEY-tagged trades in history
were still `local-paper`/`SIMULATED`), but the system was fully armed to do
so on the next qualifying signal.

**Fix (defense in depth, both layers):**
1. **Root cause** — removed the blanket force-override in
   `normalizeWallets()`; wallet environment/balanceMode now come from
   persisted settings / blueprint as before. Also reverted the
   `wallet-model-1..8` blueprint entries in the same file back to
   `environment: TESTNET` (no `balanceMode` override), undoing the other half
   of the same uncommitted regression.
2. **Standing enforcement (the actual "only bot 5" rule)** — added
   `resolveAuthorizedWalletEnvironment(wallet, settings)` in
   `server/mock-trading-server.js`: a wallet can only be treated as
   `REAL_MONEY` if `wallet.assignedSignalModelId === settings.strategy.realMoneySignalModelId`.
   Any other wallet — even one mistagged `REAL_MONEY` again in the future —
   is forced down to `TESTNET` before its credentials/base-URL are resolved.
   Wired into all four places that route to Binance based on wallet
   environment: `recordTrade` (opening a trade), `syncExchangeWalletBalance`
   (balance sync), `updateOpenTrades`'s `getWalletExchangeContext`
   (reconciling/closing open trades, incl. Bot 8's AI risk-close path), and
   the manual-close endpoint. This is the single choke point now — safe even
   if wallet tagging gets corrupted again by future WIP work.
3. **Data cleanup** — `server/data/settings.json` + `settings-recovery.json`:
   reverted all 10 bot wallets (`wallet-model-1..10`, including bot 5's own
   wallet) back to `TESTNET`/`MANUAL` and cleared their stale live-synced
   `production` block. `wallet-real-money` (the one legitimate dedicated
   live-funds wallet, `kind: MAIN`, always excluded from the auto-trade loop,
   still disabled) was left untouched. `settingsRevision` 88 -> 90 (bumped in
   both files per the usual safe-edit procedure: pm2 stop, edit both, pm2
   start, pm2 save, verify).

**Net effect:** right now, exactly as before this regression, **no bot**
auto-executes real Binance orders (matches `GO_LIVE_READINESS.md` = not
ready, and the Real Money Trading page's own "Execution path: disabled"
copy) — all 10 bots are back to pure testnet/local-paper. The new
`resolveAuthorizedWalletEnvironment` guard means that whenever real-money
execution *is* deliberately wired up in the future, it can only ever route
through the one bot assigned on the Real Money Trading page, never any other.

**Verified:** `npm run build` clean, `dist/` deployed; `pm2 restart` clean
(no new crash-loop, restart count unchanged); settings hold across a second
restart; terminal monitor confirms `Mix: 0 Binance Demo | N Local Paper` for
all open trades post-fix. `node --test`: 67/69 pass — the 2 failures
(`test/bots5to8.test.js`, expects `SIGNAL_MODELS.length === 8`) are
pre-existing and unrelated, from the separate in-progress Bots 9/10 work,
not touched this session.

**Not investigated / still open:** the rest of that uncommitted Bots 9/10 /
Consolidated Bot feature (many untracked files, pm2 had 32+ restarts before
this session started — possible crash-loop history worth a look) was left
alone since it was out of scope for this fix.

### Wallets page real-money balance check + Trade History split into Testnet/Real Money — 2026-09-15

**Wallet balance investigation (no bug found):** owner reported the 71.42
USDT Binance balance wasn't showing on the Wallets page. Checked
`settings.json`'s real-money wallet directly: `syncStatus: "CONNECTED"`,
`lastSyncedBalance: 71.42` - the sync is genuinely working, the data is
there. `WalletsPage.jsx` has a "Testnet Wallets" / "Real Money Wallet"
toggle (`activeEnvironment` state) that **defaults to Testnet** on every
page load - almost certainly just not-yet-clicked, not a data/sync bug.
Didn't change anything here; flagged for the owner to check by clicking the
"Real Money Wallet" tab.

**Trade History restructured** (owner: "create separate pages for testnet
trade and real money trading, add beside arrange by bot dropdown, also
status page to be separate dropdown"):

`TradeHistoryTable.jsx` - the single "Arrange By" sort dropdown (which had
`bot`/`status` mixed in as two of eight sort options) now sits beside two
new dedicated *filter* dropdowns: **Bot** (`TRADE_BOT_FILTER_OPTIONS`, built
from `SIGNAL_MODELS` so it lists all bots regardless of whether they have
trades yet) and **Status** (`TRADE_STATUS_FILTER_OPTIONS`: Open / Closed TP
/ Closed SL / Closed Manual). New `filteredTrades` memo applies both before
the existing sort/paginate pipeline; the "N trades still open" banner and
the empty-state message (now distinguishes "no trades yet" from "no trades
match these filters") both follow the filtered set instead of the raw prop.
Sort-by-bot/status options were left in "Arrange By" too - filtering and
sorting are different operations, both still make sense together.

`App.jsx` `renderTradeHistory()` - rebuilt on the same
`PageHeader`+`SubNavTabs`+nested-`<Routes>` pattern as Journal/Dashboard:
`index` = Testnet Trades, `real-money` = Real Money Trades, each with its
own `TradeHistoryStatsPanel`+`TradeHistoryTable` fed a pre-split trade list
(`getRealMoneyTrades` from `RealMoneyTradingPage.jsx`, restored last entry,
for the real-money side; everything else falls into testnet). Route mount
changed from `path="/trade-history"` to `path="/trade-history/*"` so the
nested routes resolve. `navItems.js` - Trade History gained the matching
`children` (was a flat link before).

`npm run build` clean, `dist/` deployed. Frontend-only, no pm2 restart
needed.

### Real Money Trading dashboard page had gone missing — restored — 2026-09-15

Owner: "the real money trading on the dashboard disappeared, return it."
Root cause: **not caused by anything this session** - `src/App.jsx` (3552
lines changed) and `src/components/shell/navItems.js` (242 lines changed)
are both uncommitted, heavily-refactored versus `HEAD` (`c0b9064`) from the
2026-09-13 Consolidated Bot integration session, and that refactor dropped
every route/import/nav-link for the Real Money Trading dashboard page along
the way - apparently by accident, since `git status --porcelain` on
`src/components/RealMoneyTradingPage.jsx`, `src/lib/wallets.js`, and
`src/components/JournalSummaryPage.jsx` all came back **empty** (byte-for-byte
identical to `HEAD`). The actual page component, `getRealMoneyWallet`, and
`JournalRealMoneyPage` were never touched or deleted - only the wiring that
reaches them from `App.jsx`/`navItems.js` was lost.

Restored the Dashboard entry point specifically (scoped to what was asked):
`App.jsx` - re-added the `RealMoneyTradingPage` import, its
`Route path="real-money-trading"` inside `renderDashboard()` (identical
props to the `HEAD` version: `settings`, `trades`, `livePrices`,
`aiTrainingStatus`, `onSave`, `saving`, `ready` - all already present in the
current file, nothing else needed), and a `DASHBOARD_TABS` entry.
`navItems.js` - added the matching sidebar sub-link under Dashboard.

**Deliberately NOT restored (same refactor also dropped these, scope
question for the owner):** the Trade History page's "Real Money Trades" tab
and `getRealMoneyTrades` filter, and the Journal's "Real Money Journal" tab
(`JournalRealMoneyPage`) - `renderTradeHistory()` currently has no sub-tabs
at all (flat page, restructured), so restoring that one is a slightly bigger
change than the Dashboard fix. Ask before doing those too, in case the
Trade History restructure was intentional.

`npm run build` clean (1700 modules, +1 for the restored page), `dist/`
deployed. Frontend-only, no pm2 restart needed.

**Bigger picture flag:** this is exactly the risk the "~26 uncommitted
files... housekeeping owed" note has been carrying since 2026-08-31 -
`App.jsx` and `navItems.js` have no commit to diff against or recover from
cleanly, so a large uncommitted refactor silently dropping a whole feature
can sit unnoticed until a user reports it missing. Worth committing the
current working tree (or at least `App.jsx`/`navItems.js`) once this session
settles, so the next accidental-drop is a visible diff instead of a silent
gap.

### Prediction history capped — 2026-09-15

Owner: "cap it now" (the uncapped-growth note from the entry just below).
`CandlestickChart.jsx`: new `FORECAST_MAX_VISIBLE_PREDICTIONS =
FORECAST_COLOR_PALETTE.length` (8) - past that, the oldest prediction's
series is evicted (`chart.removeSeries`) as each new one is added, oldest
first. P-numbers still count up forever and are never reused/renumbered even
once a line is evicted, so "P14" always means the 14th prediction made this
symbol/interval session, whether or not it's still on screen. Cap
intentionally equals the color palette length so every prediction visible at
once always has a distinct color. Frontend-only, `npm run build` clean,
`dist/` deployed.

### Forecast becomes a persistent P1/P2/P3... prediction history — 2026-09-15

Owner: keep every prediction line on the chart permanently instead of one
line that keeps getting replaced - label each "P1 +2.34%", "P2 -1.10%", etc,
a different color per prediction, and a new one only when the graph "needs
to" (implicitly: when the consensus actually changes).

`CandlestickChart.jsx` restructured from one fixed `forecast` series
(created once in `seriesRef` at chart boot) to a dynamic list:
- New `predictionsRef` (array of `{series, direction, percent, time}`,
  oldest first) + `predictionCounterRef` (the P-number counter).
- New `FORECAST_COLOR_PALETTE` (8 colors, cycling) - color is purely to tell
  P1 from P2 apart, no other meaning.
- The forecast effect now only *adds* a series (never mutates or removes an
  earlier one) when `computeSixtyCandleForecast`'s direction flips or its
  percent has moved >= `FORECAST_REDRAW_PERCENT_THRESHOLD` (0.15) since the
  *last drawn prediction* (not the last poll) - each new one becomes `P{n}
  +/-X.XX%` via the series `title`. This replaces the same-turn threshold
  logic from earlier today, which compared against the last poll and still
  force-redrew on every new candle; that "new candle" trigger is gone now,
  since a persisted prediction is a frozen historical snapshot; a candle
  passing by itself is no longer a reason to draw a new one.
- Predictions are cleared (all series removed, counter reset to 0) only on
  an actual symbol/interval change, in the existing `chartViewKey` effect -
  a prediction drawn in one market/timeframe's time-and-price space doesn't
  mean anything in another.
- `ForecastPanel.jsx` copy updated to describe the running P1/P2/... history
  instead of one line.

Frontend-only change; `npm run build` clean, `dist/` deployed, no pm2
restart needed.

**Note for later:** no cap on how many predictions accumulate in one
symbol/interval session - could get visually busy over a long-running chart
with a volatile symbol. Revisit if the owner finds it cluttered (e.g. cap to
the last N, or fade/dim older ones).

### Forecast line redraw smoothed — 2026-09-15

Owner asked why the chart forecast line isn't always showing and why it
keeps redrawing. Answer (not a bug): it only draws when at least one bot has
a `LONG`/`SHORT` signal for the symbol (most bots sit in `WAIT` most of the
time by design - confirmed live, most wallet scans return "No A-grade setup
available"), and it was redrawing on every 15s `signalModelAnalyses` poll
(`App.jsx`) because each bot's entry/take-profit tracks live price, so
`forecast.percent` shifts slightly almost every poll.

Owner chose (AskUserQuestion): smooth the redraw (only redraw on a real
direction flip, a meaningful percent move, or a new candle - not every tiny
live-price wiggle), and leave the chart blank (no placeholder marker) when
there's no directional consensus.

`CandlestickChart.jsx`: `forecastSigRef` changed from a signature string to
`{direction, percent, time, interval}`; new `FORECAST_REDRAW_PERCENT_THRESHOLD
= 0.15` - a same-candle redraw now only fires once `forecast.percent` has
moved at least 0.15 percentage points since the last drawn value (a
direction change or a new candle still always redraws regardless). Frontend
only change; `npm run build` clean, `dist/` deployed, no pm2 restart needed.

### Bot 10's real backend was never wired into the live server — found + fixed — 2026-09-15

Owner: "make bot 9 and 10 scan trades like the rest and trade according to
their logic implanted on them, tech analysis of 10 is all tech analysis from
bot 1-8 thats why its called consolidated." Investigated both rather than
assume:

**Bot 9 — working as designed, not touched.** `BOT5TO8_BUILDERS['model-9']`
(`server/strategy/bots5to8.js`) is a real, dedicated signal builder (4H
completed trend + 1H RSI(2)<=10 exhaustion + volume + taker-flow + reclaim),
not a placeholder, and live logs confirm Wallet 9 scans every 5-minute
`runAutoTrader` cycle exactly like bots 1-8 ("No A-grade setup available
after scanning preferred symbols" = it scanned and found nothing). Checked
`server/data/trade-history.json`: 655 total rows, zero for `model-9` — but
that's consistent with its own doc ("research validation failed... never use
as a validated production signal," max 2 testnet entries/day) describing an
intentionally rare, strict setup, not a wiring bug like Bot 10 below. Did not
loosen its criteria — that would be a real strategy change, not a fix; ask
the owner first if they actually want that.

**Bot 10 — genuinely broken, now fixed.** The full Consolidated Bot backend
(`server/consolidated-bot.js`, `server/consolidated-testnet.js`,
`server/strategy/consolidated-model.js` — already built, 68 tests passing,
documented in `docs/CONSOLIDATED_BOT.md`, and per `docs/CONSOLIDATED_DEPLOYMENT.md`
apparently verified live on 2026-09-13) was **never actually mounted onto
the running Express app** — `grep -i consolidated server/mock-trading-server.js`
returned zero matches before this fix. So `/api/consolidated/*` never
existed and `registerConsolidatedBot`'s own 15s autostart scan loop never
ran, despite `server/data/consolidated/testnet-state.json` already showing
`enabled: true` (a stale, inert flag from the 2026-09-13 session — nothing
was reading it). This is exactly what "Wallet 10 — Consolidated" always
showing "No A-grade setup available after scanning preferred symbols" in the
main scanner was masking: that message comes from `buildBot10SignalSnapshot`
in `server/strategy/bots5to8.js`, a deliberate `notReady` placeholder
("Bot 10 ranks Bots 1-8 through its dedicated consolidated selector...") —
by design, so the regular wallet scanner never double-executes Bot 10. The
REAL Bot 10 logic (rank all 8 source engines' ready setups through the
frozen decision tree, take the best) only ever lived in the separate,
unmounted module.

Fix: added `import { registerConsolidatedBot } from './consolidated-bot.js'`
and, inside the existing `if (IS_MAIN_MODULE) { ... }` guard (same
`XENIOS_SERVER_AUTOSTART=off` safety switch as everything else, so a dynamic
test-import still doesn't spin this up), a new
`getConsolidatedTestnetCredentials()` (mirrors the existing
`settings.apiKey`/`secretKey` + env-fallback pattern used elsewhere) and the
`registerConsolidatedBot(app, { dataDir, fetchKlines, toCandleData,
buildSignalAnalysisSnapshot, getSettings, getTestnetCredentials, autostart:
IS_MAIN_MODULE })` call, right before the existing scheduled-task
`setInterval`s.

**Verified after restart** (not just "no crash"): `server/data/consolidated/paper-state.json`'s
`lastScanAt` is advancing every ~15s in real time (confirmed two reads 15s
apart), `signals: 32` (8 source bots x 4 symbols — matches the
`docs/CONSOLIDATED_DEPLOYMENT.md` figure exactly), `errors: []`. So Bot 10 is
now genuinely live-scanning. `paper-state.json.enabled` is `false` (paper
entries correctly restart paused, per its own doc) but testnet `enabled:
true` persisted through the restart, so **testnet order placement is live**
right now, capped at 100 USDT notional / 1x leverage / 3 USDT daily loss
cutoff / 3 trades per day, pausable any time from `/consolidated-bot`. Its
strategy is still explicitly documented as research-only / negative
expectancy (holdout profit factor 0.745, avg -0.197 R) — this fix makes it
actually run, it does not make it a validated profitable strategy.

`npm test` after this change: still 66/68 (same 2 pre-existing
`test/bots5to8.test.js` failures noted below, unrelated).

### Cross-bot forecast now influences live entry + take-profit — 2026-09-15

Owner asked to take the draft 60-candle forecast (the chart-drawn consensus
from the session above) and actually feed it into each bot's real entry
scoring and take-profit — not just draw it. Confirmed design via
AskUserQuestion before touching `runAutoTrader()` (the real trade-execution
path): (1) entry = soft nudge to the AI entry score, same bounded/asymmetric
mechanism as the existing chart-pattern nudge, never a hard gate; (2)
take-profit = bounded, **extension-only** blend toward the forecast's
projected price, capped at 1.5x the bot's own planned TP distance, only when
the forecast agrees with the bot's own direction; (3) applies wherever a
wallet is scanned through `runAutoTrader` (in practice Bots 1-9 — Bot 10 is
architecturally separate, see below); (4) **leave-one-out** — a bot reacts to
the *other* bots' consensus, never partly to its own vote, to avoid a
feedback loop (the forecast is built from every bot's own entry/TP output).

New in `src/lib/chartForecast.js`: `computeSixtyCandleForecast` takes an
optional `{ excludeModelId }` (backward compatible — the chart's own call
site is unaffected).

New in `server/mock-trading-server.js` (mirrors the existing
`applyPatternAiNudge` right above it):
- `applyForecastAiNudge(decision, forecastAgreement)` — ±6 confirm / ∓14
  oppose on the AI entry score (same weights and same "can't flip a
  bootstrap accept" rule as the pattern nudge).
- `applyForecastTakeProfitBlend(candidate, forecast)` — only fires when
  `forecast.direction === candidate.direction` AND the forecast implies MORE
  room than the candidate's own TP; blends 30% of the way toward the
  forecast price, capped so the forecast distance is never trusted past 1.5x
  the bot's own planned distance.
- `getAllModelSnapshotsForSymbol(symbol)` (inside `runAutoTrader`, alongside
  the existing `getSymbolInputs` cache) — computes every `SIGNAL_MODELS`
  entry's full `buildSignalAnalysisSnapshot` for one symbol, reusing the
  already-cached klines (pure CPU, no extra Binance calls), cached per
  symbol per run so it only runs once even though multiple wallets may share
  a symbol.
- `getLeaveOneOutForecastForCandidate(candidate)` — `computeSixtyCandleForecast`
  over that map with the candidate's own `signalModelId` excluded.
- Wired in right after a wallet's `candidate` is chosen (before the AI
  filter block): TP blend applied first (mutates `candidate.takeProfit`
  in place, safe — nothing before `recordTrade` reads the old value), then
  inside `if (aiFilterDecision)`, the forecast nudge runs immediately after
  the existing pattern nudge, stacking on top of it. Both log a
  `pushWalletStep` line when they actually move something. The trade record's
  `aiDecision` now also carries `forecastAgreement` / `forecastScoreDelta` /
  `forecastDirection` / `forecastPercent` for the journal.

**Bot 10 note:** `SIGNAL_MODELS` includes `model-10`, but it has no
independent technical-analysis logic of its own —
`server/strategy/bots5to8.js`'s `buildBot10SignalSnapshot` is a `notReady`
placeholder ("Bot 10 ranks Bots 1-8 through its dedicated consolidated
selector"). So it safely contributes an inert `WAIT` vote to every other
bot's forecast without polluting it, and — since `model-10` never appears as
a `wallet.assignedSignalModelId` inside `runAutoTrader` (Bot 10 runs through
its own separate `consolidated-bot.js` / `consolidated-testnet.js`) — this
change never touches Bot 10's own frozen selector at all, by construction,
not by an explicit exclusion.

**Verification before restart:** `node --check` clean; dynamic-imported the
module with `XENIOS_SERVER_AUTOSTART=off` (no import-time errors); ran the
new pure functions against synthetic candidates (agree/oppose/neutral nudge,
extend/no-shrink/oppose-blocked/no-consensus-blocked/capped-extension TP
blend) — all matched the intended bounds; `npm test` → 66/68 pass, the 2
failures (`test/bots5to8.test.js`, asserting exactly 8 signal models /
`BOT5TO8_BUILDERS` mapping only 5-8) are **pre-existing** stale expectations
from before Bot 9/10 existed (confirmed via `git stash` against the last
commit `c0b9064` — unrelated to this change, already flagged as housekeeping
debt). `npm run build` clean, `dist/` deployed, `pm2 restart xeniostrade-api`
— came up online, no crash loop, `xeniostrade-api-error.log` empty after
restart, one scan cycle completed cleanly (`No enabled wallet found a
qualifying setup` — didn't yet exercise the new candidate-found path; a
second wallet-appropriate scan pass is still needed to see the new
pushWalletStep lines fire for real, since the scan is 5 minutes and this was
checked right after restart).

**If a wallet reports something unexpected from the AI score or take-profit
after this**: check that wallet's steps in the terminal monitor / auto-trade
log for `"Other-bot consensus forecast"` lines — they name the exact
direction/percent/confidence that drove the nudge or blend, so it's fully
traceable per-trade via the same `aiDecision.forecastAgreement` /
`forecastDirection` / `forecastPercent` fields now stored on the trade
record.

### Draft 60-candle forecast line on the Market chart — 2026-09-15 (earlier)

### Draft 60-candle forecast line on the Market chart — 2026-09-15

Owner asked for a draft directional forecast built from the signal each bot
already produces for the selected symbol (`signalModelAnalyses` in `App.jsx`,
one entry per `SIGNAL_MODELS` bot, refreshed every 15s via
`/api/signal-model-analysis`), drawn as a straight line **inside the
candlestick chart itself** (first pass put it in a separate side panel —
corrected same session).

New `src/lib/chartForecast.js` — `computeSixtyCandleForecast(modelAnalyses)`
— takes a weighted vote across every bot's current `direction`
(`LONG`/`SHORT`/`WAIT`; weight = 1.4× if `ready` else 0.6×, scaled by
`score/maxScore`), picks the majority side, and sizes the move as the
weighted-average `|takeProfit - entryPrice| / entryPrice` among the agreeing
bots.

`CandlestickChart.jsx` now has a dedicated `forecast` LineSeries (added
alongside `ema`/`ma`/`rsi` in `seriesRef` at chart creation) that draws a
line from the latest close out to `FORECAST_HORIZON_CANDLES` (60) candles
ahead, `title` shows the signed percent, redrawn only when the forecast
direction/percent or the latest closed-candle bucket changes
(signature-gated, same pattern as the existing pattern-overlay and
bot-overlay effects, so it doesn't fight the pan/zoom fix from 2026-08-30).
`CHART_SCENARIO_RIGHT_OFFSET` (the chart's `timeScale.rightOffset`,
previously a fixed 14) is now `FORECAST_HORIZON_CANDLES + 4` so the full
projected line is visible by default without scrolling.

**Restyled same session** after the owner shared a reference screenshot
(their own Market chart with a hand-drawn-looking orange squiggle sketched
over the future space): swapped the 2-point straight diagonal for a
hand-sketch wave — new `buildForecastWavePoints()` in `chartForecast.js`
rides a damped sine over the straight trend line (amplitude scales with the
forecast's move size, floored so small percents still wiggle visibly; ~2.25
oscillations; forced to land exactly on the projected target price at the
end) — and switched the series to `lineType: LineType.Curved` (2), solid
`lineStyle: 0`, fixed amber `#f59e0b` (matches the reference regardless of
LONG/SHORT — direction is read from the `title` label instead), `lineWidth: 3`.

`src/components/ForecastPanel.jsx` (still under the chart, wired into
`renderDashboardMarket()`) no longer draws its own graph — it's now just the
reasoning behind the chart's line: direction/percent badge, confidence, and
the per-bot vote list (which bots agree, which are opposed or waiting).

This is a linear extrapolation of current bot consensus, not a trained or
backtested prediction — labeled "(Draft)" in the UI on purpose. `npm run
build` ran clean both passes; `dist/` copied to `/var/www/xeniostrade`
(frontend-only change, no pm2 restart needed — hard-refresh to see it).

**Possible next step if the owner wants to iterate:** weight each bot's vote
by its trained win-rate from `SignalInsightsPanel`'s dataset instead of just
score/maxScore; consider a widening cone (min/max) instead of one straight
line once there's a real backtest to size it against.

### Previous: All-bot USDCUSDT automated-trading exclusion — 2026-09-13

User requested an all-bot rule preventing USDCUSDT trades. Added the server-side `AUTOMATED_TRADE_SYMBOL_BLOCKLIST` to exclude USDCUSDT when volatility refreshes build the preferred list, when the automated execution universe is resolved, and when each wallet's model-specific scan is formed. This is a defense-in-depth automatic-bot rule: saved or manually reintroduced preferences cannot route USDCUSDT to any bot. Existing trade history and positions were not altered. Server check and restart verification recorded after deployment.

### Previous: Consolidated bot testnet integration — 2026-09-13

User requested deployment of the locally researched eight-source consolidated bot for actual testnet execution. Targeted integration preserves the newer real-money dashboard and all settings/recovery files. Frozen artifacts summarize 949,661 audited stored rows; holdout 298 trades, 34.23% wins, 0.745 profit factor: research-only, not a validated profitable strategy.

New route `/consolidated-bot` and `/api/consolidated/*`; separate paper and testnet ledgers. Testnet-only fixed endpoint, 1x isolated, 100 USDT notional cap, modeled 1 USDT stop risk, three entries/day, 3 USDT realized-loss cutoff. Existing exchange entries share a lock and respect consolidated symbol reservations. Durable order intent, reduce-only protection, reconciliation, and emergency-close handling are included. Testnet enabled state persists on restart; paper restarts paused. No live-money execution enabled. See `docs/CONSOLIDATED_BOT.md` for controls and caveats. Backups/staging: `/home/xenios/app-backups/consolidated-20260913/`.

Deployment verification and activation status are recorded in `docs/CONSOLIDATED_DEPLOYMENT.md`. Do not infer executed trades from an enabled state; inspect the separate testnet ledger. Never overwrite runtime state or run a second server against production data.

### Previous: Real-money dashboard control page follow-up (frontend rebuilt and deployed)

Dashboard -> Real Money Trading now has a clearer live-money control surface:
status cards for live-trade lock/sync/readiness, a summary row for assigned bot,
funding balance, available balance, realized P/L, and win rate, plus a bot
assignment selector wired to `strategy.realMoneySignalModelId`. It also receives
`aiTrainingStatus` so the page can show the reviewed-trade gate progress. This
remains UI/control-state only: live order placement is still intentionally
disabled, matching `GO_LIVE_READINESS.md`. Ran `npm run build` and copied
`dist/` to `/var/www/xeniostrade`.

### Real-money wallet, live-API credential, and journal scaffolding (deployed — pm2 restarted, dist rebuilt)

Owner asked to "prepare the system for real money trading so that we just need
to add the API for it when real money trading is on." This is infrastructure
only — **no order-placement code path was touched**, so `GO_LIVE_READINESS.md`'s
answer stays **NO** exactly as before. What changed:

1. **Wallet model gets an `environment` field** (`src/lib/wallets.js`):
   `TESTNET` (existing main + 8 bot wallets, unchanged behavior) vs
   `REAL_MONEY` (new). New default wallet `wallet-real-money` (kind `MAIN`,
   `balanceMode: EXCHANGE_SYNC`, `syncProvider: BINANCE_FUTURES_LIVE`,
   `enabled: false`, `manualBalance: 0`) is synthesized automatically by
   `normalizeWallets` the same way the other 9 always have been — no manual
   settings.json edit was needed. `getMainWallet(wallets, environment)` now
   takes an environment (defaults to `TESTNET`, so every existing call site is
   unaffected); new `getRealMoneyWallet()` / `isRealMoneyWallet()` /
   `isTestnetWallet()` exports. **Fixed a latent collision**: with a second
   `MAIN`-kind blueprint, `findMatchingWallet` would have matched both
   blueprints to the same incoming `wallet-main` row (untagged legacy wallets
   have no `environment` field) and produced two wallets sharing one id — now
   matches main-kind wallets by environment too, with "untagged = testnet".
   Verified with a throwaway script against the live `wallet-main` (real
   $853.45 synced balance) before touching the running server — no collision,
   old wallet's data untouched, new wallet synthesized clean.
2. **Live Binance Futures credentials** (`server/mock-trading-server.js`):
   new `liveApiKey`/`liveSecretKey` settings fields, stored, masked, and
   self-healed via the recovery snapshot exactly like the existing testnet
   `apiKey`/`secretKey` (mirrored through `normalizeSettings`,
   `buildSettingsRecoverySnapshot`, `getSettingsRecoverySnapshot`,
   `inspectSettingsRegressionRisk`, `selfHealSettingsIfNeeded`,
   `mergeSettingsUpdate`, `sanitizeSettingsForClient`, and the settings audit
   log). `getEffectiveCredentials(settings, environment)` now branches on
   environment; new `futuresLiveBaseUrl` (`fapi.binance.com`) +
   `getFuturesBaseUrl(environment)`. **Only wired into the read-only wallet
   balance sync** (`syncExchangeWalletBalance` picks creds + base URL from the
   wallet being synced) — every order-placement function
   (`placeBinanceOrder`, `setBinanceLeverage`, etc.) still defaults to the
   testnet base URL and was not touched, since the real-money wallet is `MAIN`
   kind and therefore structurally excluded from `getTradingWallets()` / the
   auto-trade loop. It can never place an order regardless of what credentials
   are saved.
3. **Wallets page** (`WalletsPage.jsx`): new Testnet / Real Money tab toggle.
   Testnet tab is the unchanged existing UI. Real Money tab shows a single
   `RealMoneyWalletCard` (red/danger theme) with its own Sync Now, guardrail
   copy, and an explicit "no bot places live orders yet" banner.
4. **Settings → API Credentials**: new "Real Money — Binance Futures Live API"
   panel below the existing testnet one, same present/masked pattern, red
   warning banner reiterating that saving keys here does not enable trading.
5. **Journal → Real Money Journal** (new tab, `JournalRealMoneyPage` in
   `JournalSummaryPage.jsx`): shows the real-money wallet's live funding
   balance/sync status, and a wallet-calendar section that activates
   automatically once a real-money *trading* wallet exists (none does yet, so
   today it shows "no live trades yet"). Server's `/api/journal-summary` now
   also returns `realMoneyMainWallet`.

**Verified before/after restart:** `node --test` 51/51 both before and after;
`npm run build` clean; imported the server module standalone
(`XENIOS_SERVER_AUTOSTART=off`) and inspected `getSettings()` output against
the live `server/data/settings.json` before restarting pm2. `pm2 restart
xeniostrade-api` came back clean (`AI: READY`, 4 open testnet trades intact,
`Wallets 8 enabled` unchanged). `npm run build` output redeployed to `dist/`.

**Gotcha for next session:** a stray diagnostic `node -e` import of the new
module (before the pm2 restart) called `getSettings()`, which triggered the
existing auto-heal-on-read path and wrote the new wallet + `liveApiKey`/
`liveSecretKey` fields into the *live* `settings.json` while the *old* pm2
process was still running. The old process's own next read-normalize-write
cycle (old code, fixed-shape `normalizeSettings`) dropped the two new
top-level fields again and kept the new wallet only as an untyped "extra"
entry — harmless (still `MAIN` kind, still disabled, still excluded from
trading) but a reminder: **don't import `mock-trading-server.js` and call
`getSettings()`/anything that can write while the live pm2 process is running
old code** — either restart pm2 first, or test against a copied settings.json.

**Not done (deliberately out of scope — this was infra prep, not a go-live
step):** no bot wallet has a `REAL_MONEY` environment yet, so the Real Money
Journal has nothing to show; no order-placement function reads live
credentials or the live base URL; `normalizeWallets`' final mapping loop still
hard-codes every non-main wallet to `MANUAL`/local-paper, so a "real-money bot
wallet" that actually executes live orders does not exist yet and would need
its own careful design (that hard-coded branch, plus threading `baseUrl`
through the order-placement functions, plus a real execution-path review) —
exactly the "Live execution path unreviewed" gap `GO_LIVE_READINESS.md` already
called out.

---

## WHERE WE LEFT OFF  — as of 2026-09-04

### Bots 1–4: AI entry reversed to win-biased + AI loss-minimising early exit (uncommitted, needs pm2 restart)

All in `server/mock-trading-server.js`:

1. **Entry (`scoreCandidateWithAiFilter`)** — new `WIN_BIASED_SIGNAL_MODELS`
   set (`model-1..4`). For those bots the loss-averse asymmetry is flipped:
   winning setup families rewarded ×3.2 (up to +32) / losers only ×1.6 (−16);
   win-rate >50 lifts ×0.7 / <50 trims ×0.3; `provenLoser` force-skip disabled;
   new `provenWinner` (reliable family, win rate ≥50% or avgReward ≥1) lifts the
   score to `threshold + 12`. Bots 5–8 untouched (still loss-averse).
2. **Exit — new `evaluateAiLossExit()`**, wired into `updateOpenTrades()` next
   to the Bot 4 money stop. Only for `model-1..4`, only on a losing open trade,
   only once it is ≥35 % of the way to its stop (`AI_EARLY_EXIT_MIN_DRAWDOWN_FRACTION`).
   Scores 0–100 from the backtest **losing-trade profile** for the trade's setup
   family (sub-50 % win rate = dominant term, negative avgReward adds, a
   positive-expectancy family subtracts) + live behaviour (drawdown fraction ×42,
   +12 gave-back-profit, +10/+18 stalled 90 m/4 h). Score ≥ `AI_EARLY_EXIT_SCORE`
   (60) → close at mark price as `CLOSED_SL`/`SL` with an `aiLossExit` metadata
   block. Winners and bots 5–8 are never touched. Verified by an in-process
   harness against the live `learning-bot-train-status.json`: model-1 exits
   ~dd 0.85 (or dd 0.5 + stalled/gave-back), model-4 (worst avgReward) by ~dd 0.6.
   `node --test` (51/51) still green.

**Still to do:** `npx pm2 restart xeniostrade-api` to load it; watch the AI
early-exit terminal lines and whether realised losses on 1–4 shrink vs the full
stop. Thresholds/weights are module constants — tune in place.

---

## Earlier — as of 2026-08-31 17:30 UTC

### −1 USD hard money-stop backtest (Bots 1–3) — done, still net-negative

Ran `replay-dataset.js --months 12 --stride 2 --bots model-1,model-2,model-3
--money-stop-usd 1` (65 symbols, `--no-train`). Result vs the 12-month baseline:

| Bot | Win% base→stop | Avg/trade base→stop | Total (stop run) |
|-----|----------------|---------------------|------------------|
| 1 | 32.7 → **9.8%** | −0.76 → **−0.68** (−10%) | −$21,335 / 31,329 trades |
| 2 | 32.3 → **6.4%** | −1.39 → **−1.12** (−20%) | −$22,648 / 20,308 trades |
| 3 | 32.9 → **3.0%** | −6.25 → **−4.59** (−27%) | −$149,057 / 32,500 trades |

The −1 USD stop = a 0.07–0.13% move for these notionals — inside 5-minute noise,
so it's tapped before winners develop. Cuts per-trade loss a bit, craters win
rate, still deeply negative on all three. **NOT merged into training** (no live
counterpart — Bot 4 only; would skew the shared policy bucket). Data kept at
`server/data/backtest-moneystop.json`.

### 2026-08-31 ~19:50 UTC — OOM wipe, hardening, fresh-month config

**Incident:** server OOM crash-looped (33+ restarts). Cause: `giveitroom-2x`
run got re-flagged `includeInTraining:true` during the git sync → 175k-row
dataset → `refreshLearningBotDatasetArtifact` rebuilt + re-serialised ~130 MB on
*every* `/api/learning-bot/*` poll (train-status polls 20 s) → heap exhausted at
the 896 MB cap. A `writeJson` interrupted mid-write left `trade-history.json`
corrupt; `readJson` silently returns `[]` on parse error, so the trade-close
read/modify/write path **rebuilt trade-history.json from empty** → the ~1,182
historical real trades were lost. **No backup existed** (gitignored, no `.bak`,
no snapshot). Only ~50 partial opens salvageable from `auto-trade-log.json`
(→ `server/data/_recovery/`). The trained policy survived — real trades were
~1% of the 118k training set; retrained clean on the 117k backtest rows.

**Fixes (all in `server/mock-trading-server.js`, uncommitted):**
- `refreshLearningBotDatasetArtifact` now caches on an mtime+config fingerprint
  (`computeLearningBotDatasetCacheKey`) — rebuilds only when trade-history /
  backtest-history / the registry actually change, not every poll.
- `/api/learning-bot/dataset` response capped to 200 rows + `rowCount`.
- `writeJson` is now **atomic** (tmp + `rename`) and keeps a `.bak` of the last
  good version (except the derived `learning-bot-dataset.json`).
- `readJson` recovers from `<file>.bak` on `SyntaxError` before falling back.
- pm2 `--max-old-space-size` 896 → **2048**, `pm2 save`d.
- Registry: only `main-12mo-2026-08` is `includeInTraining:true`.

**Fresh-month config (settings revision 64 → 65, recovery synced):**
`aiEntryFilter.paperOnly:false` (hard-block) kept; **all thresholds 60/62/62/60/50
→ 35** (global + every perBotOverride). Server serves this as a PAPER test bench
for a clean month of live paper trades scored by the 117k-row policy; local PC
does backtest generation. Real money only if the month is profitable. Confirmed
live: scan logs show "hard-block with threshold 35"; all 4 bots scanning, bots
1/3/4 already traded today.

### Pocket-mining + "give it room" backtest — no edge found

Mined all 117k baseline rows for a positive conditional pocket (bot × side ×
family × candle pattern × session/hour × SL-width band × pattern-score band ×
symbol tier), IS/OOS split Sep–Feb / Feb–Aug, metric R = pnl/(notional·SL%).
- The only strong signal (`hold ≥4h` = +0.19R all bots, both windows) is
  **look-ahead** — hold time is only known after the fact. The honest version
  ("survived first 30min without stopping") is still −0.09 to −0.10R.
- Everything knowable at entry stays negative in OOS. Session/family/hour pockets
  that looked positive IS flipped negative OOS (overfit — the split caught them).
- One real takeaway: **stops are too tight.** SL <0.6% → −0.35R; SL ≥1.3% → −0.10R.

Confirmatory backtest `giveitroom-2x-2026-08` (Bots 1–3, 12mo, 66 sym, 2× stop
distance, 2× TP distance, `--sl-mult 2 --tp-mult 2`): meanR **−0.18 → −0.08** on
all three (win 32.7→35.3%), IS −0.07 / OOS −0.11, ~10% now time out at 48h.
**Cuts the bleed ~half, does not cross zero.** No tradeable edge. Not flagged for
training. Harness now has `--sl-mult` / `--tp-mult` knobs (backtest-only, scale
stop/TP distance from entry; `configuredStopLossPercent` scaled to match).

### NEW: backtest run registry + AI Training UI

Every `replay-dataset.js` run now records itself:
- `server/data/backtest-runs.json` — registry index (config, signals used,
  per-bot summary incl. BUY/SELL, conclusion, live progress + ETA, `includeInTraining`)
- `server/data/backtest-runs/<id>.json` — that run's rows (when `--run-id` given
  without `--out`; a bare run still writes the legacy `backtest-history.json`)
- `server/backtest/runs/<id>.md` — human report
- New flags: `--run-id`, `--label`, `--conclusion`. See `server/backtest/run-registry.js`.

Server: `getPreferredLearningBotDataset` merges rows from registry runs flagged
`includeInTraining: true` (deduped by id; a run pointing at `backtest-history.json`
is not double-loaded). Baseline path (nothing extra flagged) is byte-identical to
before. New endpoints: `GET /api/learning-bot/backtests`,
`PATCH /api/learning-bot/backtests/:id` (`includeInTraining` / `conclusion` /
`label`; **no settings.json touch**), `GET .../backtests/:id/report`,
`GET /api/learning-bot/signal-insights` (per bot × family: count / win% /
avgReward / entryQuality + works|marginal|losing verdict).

UI: **AI Training tab** gains **Backtests** (`BacktestHistoryPanel.jsx`) and
**Signal Insights** (`SignalInsightsPanel.jsx`) sub-tabs; Training-page copy
refreshed to say training runs on live trades + flagged backtest runs. Backfilled
two registry entries: `main-12mo-2026-08` (flagged ON — it *is* the current live
policy source via the legacy file) and `moneystop-1usd-2026-08` (OFF).

Built + pm2-restarted `xeniostrade-api`. Auto-trader loop verified still logging.
**Not committed.**

⚠️ Memory: pm2 runs the server with `--max-old-space-size=896`. A `/dataset` call
already spikes to ~415 MB parsing the 121 MB `backtest-history.json`. Flagging a
*second* large run (e.g. the 91 MB money-stop file) for training in one call
risks OOM — raise the heap cap first or keep one large run flagged at a time.

### Bot 5 — built, backtested negative, then REVERTED

Tried a 5th signal model `model-5` "HTF Trend Pullback" (regime-filtered trend
continuation: 1H+15M trend + ADX + shallow EMA20 pullback + 5M reclaim, structural
stop, fixed 3R). 4 backtest configs, all net-negative, ≈ −0.15 to −0.22 R/trade,
25–36% win. Tightening entries *lowered* win rate. Same wall as Bots 1–4.

Owner chose **option C** → Bot 5 code fully **reverted** from `signalModels.js`
and `mock-trading-server.js` (running server never loaded it; disk now matches).
Design + full result table preserved here in case option A (extend harness for
trade management, then re-test) is ever picked up. `server/backtest/` harness
untouched and still works.

### Now: lean on the AI filter + Phase B for Bots 1–4

**Filter state (verified from the live artifact + settings):**
- `aiEntryFilter.paperOnly: false` (hard block) for all; thresholds Bot 1/2 = 62,
  Bot 3 = 60, Bot 4 = 50. `reviewWindowTrades: 0`. `includeBacktestData: true`.
  Settings revision 64.
- Server restarted ~08:26 UTC, refreshed policy from 118,229 closed trades,
  re-trained (pytorch, ~13 s). `AI : READY | Framework pytorch`.
- Trained policy per bot (count / winRate / avgReward) — **every real family is a
  proven loser** (`provenLoser` = ≥5 samples AND (winRate<40 OR avgReward≤−3)):
  - model-1: all 4 families 30.7–34.9% / −0.13 to −0.69, n=4.5k–11.6k
  - model-2: all 4 families 30.6–34.7% / −0.51 to −1.38, n=2.9k–6.4k
  - model-3: 3 families 31.1–33.4% / **−4.65 to −7.13**, n=5.3k–22.9k
  - model-4: "Trend bias scalp" (n=34,526) 31.1% / −0.51; other 3 families n=1–4 noise
- Loss-averse `scoreCandidateWithAiFilter` caps a proven-loser's finalScore at
  `threshold−12`, so with `paperOnly:false` **the filter now hard-blocks
  essentially every setup all 4 bots normally take.** A +6 pattern nudge can't
  lift a capped score over threshold. Confirmed by reading the code paths.

**So Phase B's practical reality:** with the policy live, Bots 1–3 go near-silent,
Bot 4 mostly silent. That's the filter working — but it also means there is **no
positive core left to paper-validate**. You can stop the bleed by not trading;
you can't grow a winning curve from a strategy whose every family loses.

**Phase B watch (starts for real after 16:00 UTC = 00:00 Manila, when daily
limits reset — as of 09:45 UTC all 4 bots are capped for the Manila day):**
1. Confirm no proven-loser trades leak through (check `aiDecision.accept` on new
   AUTO trades; every model-1/2/3 "Support-zone reversal" / "Unclassified" /
   "Bullish breakout" / "Bearish breakdown" entry should be blocked).
2. Watch the rare bootstrap trades on untried families — are those also losers?
3. A/B `includeBacktestData` on vs off (real-only policy showed the same families
   as losers last session, so expect agreement — do it for the record).

**Decision still open for the owner (within C):**
- **C1** Let it run 2–4 weeks as-is; mostly confirms the negative, low effort.
- **C2** Turn **Bot 3 off now** — −4.65 to −7.13 avg reward, no scenario where it's
  worth running; filter blocks it anyway; disabling removes a wallet from the
  scan. Needs the settings.json edit procedure (revision → 65).
- **C3** Accept the meta-finding: 4 momentum/breakout/reversal bots on 5–15m
  crypto have no edge, filtered or not. Productive path is a different approach
  (higher timeframe / different style / different market), not more validation.

---

## WHERE WE LEFT OFF  — as of 2026-08-31 08:15 UTC

**DONE this session:** first full backtest run + AI training completed and verified.

- Backtest wrote **117,026 rows** → `server/data/backtest-history.json` (121 MB).
  Per-bot 12-month expectancy (all negative — this IS the training signal):
  Bot 1 32.7% win / −0.76 per trade · Bot 2 32.3% / −1.39 · Bot 3 32.9% / **−6.25**
  (worst) · Bot 4 31.0% / −0.77.
- AI training ran on **118,208 rows** (1,182 real + 117,026 backtest), pytorch
  DQN, 12.8 s. `rows 118208 · exit 0 · framework pytorch · actionAlignment 43.7`.
- Per-family sample counts went from n=1–5 → **thousands** (e.g. model-1
  Support-zone reversal n=11,616 @ 30.7%; model-3 Unclassified n=22,929 @ 33% /
  −6.29 avg). Every core family for Bots 1–3 is now a statistically-solid
  "proven loser" → the loss-averse filter will hard-block them.

**Repair made (important gotcha — see GOTCHAS):** the backtest harness calls
`launchLearningBotTraining()` in its own process and exits before the python
trainer finishes, so the trainer's `child.on('close')` writeback never ran —
`learning-bot-train-status.json` was frozen at `running: true, metrics: null`
even though `learning-bot-train-artifact.json` held the good trained policy.
Reconciled the status file from the artifact (`running:false`, `lastExitCode:0`,
`metrics` populated, `artifactGeneratedAt`/`lastSuccessfulCompletedAt` set). No
restart needed — `getLearningBotTrainStatus()` re-reads from disk each call.
Server terminal monitor now shows `AI : READY | Framework pytorch`.

**Live system healthy:** auto-trader scanning 60 symbols every 5 min (~2–3 s/scan),
server ~206 MB, 0 pm2 restarts in 11 h. No trades since ~08:00 UTC because **all
4 bots hit their daily limits** (Bot 1: 3-loss cap; Bots 2/3/4: daily-trade cap)
— the tightened risk caps doing exactly their job. Counters reset 00:00 local
(16:00 UTC).

**Next session — do this:**
1. Roadmap **Phase B** (`GO_LIVE_READINESS.md`): watch per-bot *filtered* paper
   equity on the Journal tab over ~2–4 weeks. Goal: does any bot reach a positive
   curve once the AI filter is skipping its proven-loser families?
2. A/B `learningBot.includeBacktestData` on vs off — confirm the backtest rows
   actually improve live outcomes, not just add pessimism.
3. Any bot that can't get to a positive *filtered* curve → disable it or rewrite
   its strategy. Bot 3 is the prime candidate (−6.25/trade, most aggressive).
4. `actionAlignment 43.7` is low but expected (dataset ~68% losers; the DQN is
   correctly diverging from the mostly-losing recorded entries). Treat it as a
   Phase-B A/B question, not a trainer bug — only dig into `rl_trainer.py` if the
   filter measurably *hurts* paper results.
5. Re-run the backtest later with `--append` and a different date range once the
   config changes again, to refresh the dataset.

**Not started:** Phase 2 (Testnet), Phase 3 (live), spec upgrade. Real money = **NO** (see `GO_LIVE_READINESS.md`).

**Housekeeping owed:** ~26 uncommitted files on branch `ui-app-shell` (now incl.
`backtest-history.json` — 121 MB; consider gitignoring it rather than committing).
Nothing committed this session — commit when the owner wants.

---

## Session — 2026-08-30

Branch `ui-app-shell`. One long session. Order of work:

### 1. Dashboard UI restructure
- Split Dashboard into **Overview** (KPIs + Bot 1-4 status) and a new **Market**
  tab (chart + price stats + Pro Exit Strategy + AI Assistant). New
  `BotStatusGrid.jsx` (extracted from the chart), `ProExitStrategy.jsx`.
- Removed "Manual Trade With ChatGPT" and "Chart Visual Mode" panels.
- Market tab: token/USDT + Last Price / 24h Change / 24h Volume / Quote Volume
  on top (`StatsBar`), with a **market dropdown** + **signal-model dropdown** in
  its header (2 selectors) — the market list is a dropdown now, not a column.
  Deleted `SidebarMarketList.jsx`.
- AI Assistant redesigned to sit beside the chart (2-col, no 3rd column).
- Nav (`shell/navItems.js`): Market added under Dashboard; Journal got children.

### 2. Journal UI restructure
- Split into **Summary** (all wallets 1-4 combined), **Head to Head** (own page),
  **Wallet Journal** (own page, full width, **wallet 1-4 dropdown** to switch).
- `JournalSummaryPage.jsx` → `useJournalViews` hook + `JournalOverviewPage` /
  `JournalHeadToHeadPage` / `JournalWalletPage`. `App.jsx` `renderJournal` now
  nested routes + `JOURNAL_TABS`.

### 3. Chart engine fixes (`CandlestickChart.jsx`)
- **Pan/zoom no longer resets** on streaming ticks. Was recreating the whole
  chart every ~1s; now create-once + incremental effects (data / indicators /
  markers / bot overlays / trade lines). `fitContent()` only once per
  symbol/interval.
- Bot trade projection drawn: entry / SL / TP / support / resistance price lines
  (dashed+dim = projected, solid+bright = ready).
- Timeframe is a **dropdown** now, with more intervals (`1m…1M`).

### 4. STABILITY INCIDENT + fixes
Symptoms: high load, 100%+ CPU on the node server, Binance `fetch` connect
timeouts, huge unrotated pm2 logs (~0.5 GB). **Root cause:** the 5-minute
auto-trader scan of 50 symbols ran on one serial `await` chain — under any
upstream latency it starved the event loop and overran the interval (the
"connect timeouts" were event-loop starvation, not a real network problem;
`curl` to Binance was 150 ms). Not a crash loop — the 12 pm2 restarts were all
manual.
Fixes:
- `pm2 install pm2-logrotate` + config (10 MB, keep 5, gzip).
- `pm2 restart … --node-args="--max-old-space-size=896" --max-memory-restart 1200M` + `pm2 save`.
- **Scan concurrency throttle**: `SIGNAL_SCAN_CONCURRENCY = 5` + `mapWithConcurrency()`;
  per-symbol try/catch (one bad symbol no longer aborts the run).
- **Fetch**: `fetchKlines`/depth/premium timeout → 9 s (beats undici's 10 s
  connect timeout); `fetchJson` backoff → exponential + jitter, harder on
  429/418/connect-timeout.
- Universe `VOLATILE_MARKET_SYMBOL_LIMIT` 50 → **60**.
- Result: 60-symbol scan ~5-9 s (was overrunning 5 min).

### 5. Chart pattern engine
- `src/lib/chartPatterns.js`: ~14 candlestick + ~11 geometric patterns
  (ZigZag pivots). Drawn on the chart (markers + trendlines/necklines) + a
  "Chart Patterns Detected" panel + an AI Assistant readout.
- Server soft-score: `computePatternInsight` / `attachPatternInsight` fold a
  bounded, direction-aware `patternScore` into every signal snapshot;
  `applyPatternAiNudge` moves the AI entry score — **confirming pattern +6 max,
  opposing pattern −14 max** (asymmetric / loss-averse). Never a hard gate,
  never forces a trade.

### 6. LOSS LIMITING (owner: "losses too big, use AI scoring to minimise")
Findings: AI entry filter was `paperOnly: true` for Bots 1-3 = **advisory only,
could not block any trade**. Only Bot 4 was hard-block.
Changes (code defaults `src/lib/signalModels.js` + live `settings.json` +
`settings-recovery.json`, revision bumped):
- AI filter → **hard-block for Bots 1-3** (`paperOnly: false`). Thresholds
  Bot 1/2 → 62, Bot 3 → 60, Bot 4 → 50.
- Risk caps: Bot 1 lev 10→8, SL 1→0.6%, maxLoss/day 50→18, losses/day 5→3,
  trades/day 12→6, open 2→1. Bot 2 lev 20→12, SL 0.9→0.55%, loss/day 60→18,
  losses/day 4→3, trades/day 8→5. Bot 3 preset 1%→0.75% risk, daily cap 5%→2%.
  Bot 4 losses/day 40→15, loss/day 40→15, trades/day 40→25.
- `scoreCandidateWithAiFilter` made **loss-averse**: losing setup families
  penalised ~3× harder than winners rewarded; sub-50% win-rate penalty doubled;
  a "proven loser" (≥5 samples, <40% win OR ≤−3 avg reward) forced below the
  accept threshold. Policies with <5 samples treated as noise (influence scaled
  ~70% down; bot stays in bootstrap so data keeps growing).

### 7. Bot 4 not trading + wallet block
- **Wallet gate**: "open local-paper auto trade freezes the wallet" block was
  hitting every wallet after its first fill. Scoped to exchange-sync wallets
  only; local-paper bots run continuously (capped by `maxOpenPositions`).
- **Bot 4 stuck**: the loss-averse change trusted a 1-sample "0% win" policy and
  zeroed Bot 4's score. Added `MIN_POLICY_SAMPLES = 5`: below it, learned stats
  barely move the score and can't gate → bootstrap keeps the bot trading.
  Verified: Bot 4 placed a trade after.

### 8. Go-live Q&A → `GO_LIVE_READINESS.md` created
Real money = **NO** (no track record, AI untrained, changes hours old, still a
paper system, stability shallow, execution path unreviewed). External AI dataset
= can't import (dataset is this system's own closed trades). Spec upgrade for
live = yes, for reliability (4 vCPU / 8 GB dedicated headless), not compute.

### 9. Backtest AI-dataset harness (BUILT)
`server/backtest/replay-dataset.js` + `historical-data.js` + `README.md`.
Replays the real `analyzeSymbolStrategy` over historical klines, simulates each
entry to TP/SL (SL wins ties; Bot 4 −1 USDT money-stop; timeout after
`--max-hold-hours`), applies fee+slippage, writes closed-trade rows to
`server/data/backtest-history.json` (`source: AUTO_BACKTEST`). Reservoir-samples
to `--cap-per-symbol-bot` (default 500). Auto-trains after unless `--no-train`.
Server changes: main-module guard via `XENIOS_SERVER_AUTOSTART` env,
`export`ed the functions it imports, `getLearningBotEligibleClosedTrades`
matches `startsWith('AUTO')`, `getPreferredLearningBotDataset` merges the
backtest file when `learningBot.includeBacktestData` (new setting, default true).

### 10. `reviewWindowTrades` 20 → 0  (critical)
`learningBot.reviewWindowTrades` was **20** → `buildLearningBotDataset` did
`.slice(0, 20)` → training only ever saw the 20 newest trades (backtest data
would have been discarded; per-family counts stuck at n=1-5). Set to **0** =
train on every eligible closed trade. Immediately took training from 20 → 1182
real rows; per-family counts jumped (Bot 1/2 "Support-zone reversal" now n=222-251
at ~23-33% win → proven losers → the filter now actually skips them).
Settings revision → 64, recovery synced.

---

## KEY GOTCHAS / LANDMINES  (read before touching these)

- **`server/mock-trading-server.js` boots a server on import.** Only safe to
  `import` it with `process.env.XENIOS_SERVER_AUTOSTART = 'off'` set *first*
  (use a dynamic `await import()`, not a hoisted static import). An
  entry-point check (`argv[1] === __filename`) does NOT work — pm2 fork mode
  loads the file through its own wrapper. Getting this wrong = pm2 crash-loop
  (server exits clean because nothing keeps the event loop alive → pm2 restarts
  → repeat; ~50 restarts happened once this way, fixed).

- **Editing `server/data/settings.json` live:** the server's self-heal only
  guards *credentials* and *autoTradingEnabled going false* and *revision going
  backwards* — it does NOT validate risk numbers, AI filter, or
  `reviewWindowTrades`. Safe procedure used this session: `pm2 stop`, edit
  `settings.json` **and** `settings-recovery.json` (bump `settingsRevision` in
  both, keep them equal), `pm2 start`, `pm2 save`. Verify the value stuck.

- **`reviewWindowTrades` must stay 0** or the whole dataset (incl. backtest) is
  silently truncated to the newest N. It's the "review trades" field on the AI
  Training / Bot Strategy settings page.

- **Backtest auto-train leaves `learning-bot-train-status.json` stale.**
  `replay-dataset.js` calls `launchLearningBotTraining()`, which returns
  `{ok:true}` immediately and registers a `child.on('close')` handler to write
  the final status. The harness process exits right after, killing that handler,
  so the trainer still finishes and writes `learning-bot-train-artifact.json` but
  the status file stays at `running:true, metrics:null` — and the live server
  reads *status*, not the artifact, for its policy (`scoreCandidateWithAiFilter`,
  `buildSignalAnalysisAiAdvisory` bail on `!trainStatus.metrics`). Fix after any
  harness auto-train: copy `metrics` + `generatedAt` from the artifact into the
  status file and set `running:false, lastExitCode:0`. (Better long-term: have
  the harness `--no-train` and instead trigger training through the running
  server's endpoint, or await the child in `launchLearningBotTraining`.)

- **pm2 app id drifts** (delete/re-add renumbers it); always target it by name
  `xeniostrade-api`. `max_memory_restart` 1200 MB + `--max-old-space-size=896`
  are set and `pm2 save`d.

- **Server TZ is Asia/Manila (UTC+8)** in its own log lines; system clock is UTC.

- **Frontend is served from `dist/`** by the pm2 process (`express.static`), not
  a dev server. After any `src/**` change: `npm run build`, then hard-refresh
  the browser. No pm2 restart needed for frontend-only changes.

- **`npm run backtest:dataset`** is CPU-heavy and long. Run it when slower live
  scans are acceptable. It's memory-bounded by `--cap-per-symbol-bot`.

---

## FILE MAP  (what this session changed)

New:
- `src/lib/chartPatterns.js`, `src/components/BotStatusGrid.jsx`,
  `src/components/ProExitStrategy.jsx`
- `server/backtest/{replay-dataset.js,historical-data.js,README.md}`
- `GO_LIVE_READINESS.md`, `SESSION_LOG.md`
- `server/data/backtest-history.json` (written by the backtest run)

Deleted: `src/components/SidebarMarketList.jsx`

Modified (highlights):
- `src/App.jsx` — Dashboard/Journal route restructure, pattern wiring, dropdowns
- `src/components/CandlestickChart.jsx` — incremental render, patterns, tf dropdown
- `src/components/{StatsBar,AIAssistantSidebar,JournalSummaryPage}.jsx`
- `src/components/shell/navItems.js`
- `src/lib/{signalModels.js,tradingConfig.js}` — risk caps, universe 60
- `server/mock-trading-server.js` — scan throttle, fetch backoff, pattern
  soft-score, loss-averse AI filter, main-module guard, exports, dataset merge
- `server/data/settings.json` + `settings-recovery.json` — risk, AI filter,
  reviewWindowTrades=0, revision 64
- `package.json` — `backtest:dataset` script
- pm2 config (logrotate, memory guard) — outside the repo, in `~/.pm2`

Uncommitted. Commit when the owner asks.

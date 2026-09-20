// Runs one AI Trading agent call through the Codex SDK, using the machine's own Codex login (`codex login`, i.e.
// ~/.codex/auth.json, or CODEX_API_KEY / OPENAI_API_KEY) - the same one the Codex console uses. No API key is saved
// in the app for it, and there is no per-token bill: usage counts against that Codex account.
//
// Unlike the console this is NOT pointed at the project. The agents only need to reason over the market data in the
// prompt, so Codex gets an empty scratch directory, a read-only sandbox, no approvals and no network/web search.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadCodexModule } from '../codex-console.js'

export const CODEX_PROVIDER_ID = 'codex'
// A Codex turn is an agent run, not a single completion: allow far longer than the 45 s a chat-completions call gets.
export const CODEX_AGENT_TIMEOUT_MS = 150_000
const AGENT_DIR = path.join(os.tmpdir(), 'xeniostrade-codex-agent')
const MAX_CONCURRENT_TURNS = 2
const NO_TOOLS_NOTE = 'Answer directly with the JSON object only. Do not run commands, read files, browse, or use any tool: everything you need is in this message.'

let active = 0
const waiters = []

async function acquire() {
  if (active < MAX_CONCURRENT_TURNS) {
    active += 1
    return
  }
  await new Promise((resolve) => waiters.push(resolve))
}

function release() {
  const next = waiters.shift()
  if (next) next() // hand the slot straight over
  else active -= 1
}

async function defaultHasLogin() {
  if (String(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '').trim()) return true
  try {
    await fs.access(path.join(os.homedir(), '.codex', 'auth.json')) // existence only: the file is never read here
    return true
  } catch {
    return false
  }
}

/** Whether Codex can be used as an agent provider right now. Never reads the credential itself. */
export async function getCodexAgentStatus({ loadModule = loadCodexModule, hasLogin = defaultHasLogin } = {}) {
  const mod = await loadModule()
  return { available: Boolean(mod?.Codex), loggedIn: await hasLogin() }
}

function notConfigured(message) {
  const error = new Error(message)
  error.code = 'NOT_CONFIGURED'
  return error
}

/**
 * @returns {Promise<string>} Codex's final reply text (the caller extracts the JSON).
 * `loadModule` / `hasLogin` are injectable so the safety settings can be tested without spawning Codex.
 */
export async function runCodexAgent(
  { systemPrompt, userPrompt, model = '', timeoutMs = CODEX_AGENT_TIMEOUT_MS },
  { loadModule = loadCodexModule, hasLogin = defaultHasLogin } = {},
) {
  const mod = await loadModule()
  if (!mod?.Codex) throw notConfigured('The Codex SDK is not installed on the server. Run `npm install @openai/codex-sdk`.')
  if (!(await hasLogin())) throw notConfigured('Codex is not logged in on the server. Run `codex login` there, then try again.')

  await fs.mkdir(AGENT_DIR, { recursive: true })
  await acquire()
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const codex = new mod.Codex({ config: { sandbox_mode: 'read-only' } })
    const thread = codex.startThread({
      ...(String(model).trim() ? { model: String(model).trim() } : {}),
      workingDirectory: AGENT_DIR,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    })
    const turn = await thread.run(`${systemPrompt}\n\n${userPrompt}\n\n${NO_TOOLS_NOTE}`, { signal: controller.signal })
    return String(turn?.finalResponse || '')
  } catch (error) {
    if (timedOut) throw new Error(`Codex timed out after ${Math.round(timeoutMs / 1000)}s.`)
    throw error
  } finally {
    clearTimeout(timer)
    release()
  }
}

// Runs one AI Trading agent call through the Claude Agent SDK, using the machine's own Claude login (`claude login`, i.e.
// ~/.claude/.credentials.json, or CLAUDE_CODE_OAUTH_TOKEN) - the same one the `claude` CLI uses. No API key is saved in
// the app for it, and there is no per-token bill: usage counts against that Claude account's subscription limits.
//
// The agents only need to reason over the market data in the prompt, so Claude gets no tools at all, no settings /
// CLAUDE.md / MCP servers / skills, an empty scratch directory and no saved session. ANTHROPIC_API_KEY is removed from
// the subprocess environment so this provider is always the login, never a silent pay-per-token API call.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const CLAUDE_PROVIDER_ID = 'claude'
// An agent run is slower than a single completion: allow far longer than the 45 s a chat-completions call gets.
export const CLAUDE_AGENT_TIMEOUT_MS = 150_000
const AGENT_DIR = path.join(os.tmpdir(), 'xeniostrade-claude-agent')
const MAX_CONCURRENT_TURNS = 2
const NO_TOOLS_NOTE = 'Answer directly with the JSON object only. Do not run commands, read files, browse, or use any tool: everything you need is in this message.'

let modulePromise = null
let active = 0
const waiters = []

export function loadClaudeAgentModule() {
  if (!modulePromise) {
    modulePromise = import('@anthropic-ai/claude-agent-sdk').catch((error) => {
      console.error('Claude agent: @anthropic-ai/claude-agent-sdk is not available:', error?.message || error)
      return null
    })
  }
  return modulePromise
}

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
  if (String(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim()) return true
  try {
    await fs.access(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json')) // existence only: never read here
    return true
  } catch {
    return false
  }
}

/** Whether Claude can be used as an agent provider right now. Never reads the credential itself. */
export async function getClaudeAgentStatus({ loadModule = loadClaudeAgentModule, hasLogin = defaultHasLogin } = {}) {
  const mod = await loadModule()
  return { available: Boolean(mod?.query), loggedIn: await hasLogin() }
}

function notConfigured(message) {
  const error = new Error(message)
  error.code = 'NOT_CONFIGURED'
  return error
}

/**
 * @returns {Promise<string>} Claude's final reply text (the caller extracts the JSON).
 * `loadModule` / `hasLogin` are injectable so the safety settings can be tested without spawning Claude.
 */
export async function runClaudeAgent(
  { systemPrompt, userPrompt, model = '', timeoutMs = CLAUDE_AGENT_TIMEOUT_MS },
  { loadModule = loadClaudeAgentModule, hasLogin = defaultHasLogin } = {},
) {
  const mod = await loadModule()
  if (!mod?.query) throw notConfigured('The Claude Agent SDK is not installed on the server. Run `npm install @anthropic-ai/claude-agent-sdk`.')
  if (!(await hasLogin())) throw notConfigured('Claude is not logged in on the server. Run `claude login` there, then try again.')

  await fs.mkdir(AGENT_DIR, { recursive: true })
  await acquire()
  const abortController = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, timeoutMs)

  try {
    const { ANTHROPIC_API_KEY: _apiKey, ANTHROPIC_AUTH_TOKEN: _authToken, ...env } = process.env
    const stream = mod.query({
      prompt: `${userPrompt}\n\n${NO_TOOLS_NOTE}`,
      options: {
        ...(String(model).trim() ? { model: String(model).trim() } : {}),
        systemPrompt,
        cwd: AGENT_DIR,
        env,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: 'dontAsk',
        persistSession: false,
        maxTurns: 2,
        abortController,
      },
    })

    let result = null
    for await (const message of stream) {
      if (message?.type === 'result') result = message
    }
    if (!result) throw new Error('Claude returned no result.')
    if (result.subtype !== 'success' || result.is_error) {
      throw new Error(String(result.result || result.errors?.join('; ') || `Claude run failed (${result.subtype}).`))
    }
    return String(result.result || '')
  } catch (error) {
    if (timedOut) throw new Error(`Claude timed out after ${Math.round(timeoutMs / 1000)}s.`)
    throw error
  } finally {
    clearTimeout(timer)
    release()
  }
}

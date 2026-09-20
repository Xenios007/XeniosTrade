// Codex chat console backend.
//
// Wraps `@openai/codex-sdk` so the dashboard can host a small AI chat panel that
// answers questions with the workspace as context. It runs Codex in read-only
// sandbox mode by default so a browser session can never make the agent edit
// files or run destructive commands. Override with CODEX_CONSOLE_SANDBOX
// ("read-only" | "workspace-write" | "danger-full-access") only if you know why.
//
// Auth comes from the machine's own Codex login (`~/.codex/auth.json`, i.e.
// `codex login`) or CODEX_API_KEY / OPENAI_API_KEY in the environment - the SDK
// resolves it the same way the CLI does. Nothing extra is wired here.

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const WORKING_DIRECTORY = path.resolve(moduleDir, '..')
const SANDBOX_MODE = (process.env.CODEX_CONSOLE_SANDBOX || 'read-only').trim()
const MAX_MESSAGE_LENGTH = 8000
const TURN_TIMEOUT_MS = Number(process.env.CODEX_CONSOLE_TURN_TIMEOUT_MS || 240_000)

let codexModulePromise = null
let running = false

export function loadCodexModule() {
  if (!codexModulePromise) {
    codexModulePromise = import('@openai/codex-sdk').catch((error) => {
      console.error('Codex console: @openai/codex-sdk is not available:', error?.message || error)
      return null
    })
  }

  return codexModulePromise
}

export async function getCodexConsoleStatus() {
  const mod = await loadCodexModule()

  return {
    available: Boolean(mod && mod.Codex),
    busy: running,
    sandboxMode: SANDBOX_MODE,
    workingDirectory: WORKING_DIRECTORY,
  }
}

function withTimeout(promise, ms, message) {
  let timer = null
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message)
      error.statusCode = 504
      reject(error)
    }, ms)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

export async function runCodexConsoleTurn({ message, threadId } = {}) {
  const trimmed = String(message || '').trim()

  if (!trimmed) {
    const error = new Error('A message is required.')
    error.statusCode = 400
    throw error
  }

  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    const error = new Error(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`)
    error.statusCode = 400
    throw error
  }

  const mod = await loadCodexModule()

  if (!mod || !mod.Codex) {
    const error = new Error('The Codex SDK is not installed on the server. Run `npm install @openai/codex-sdk`.')
    error.statusCode = 503
    throw error
  }

  if (running) {
    const error = new Error('The Codex console is still answering the previous message.')
    error.statusCode = 409
    throw error
  }

  running = true

  try {
    const codex = new mod.Codex({ config: { sandbox_mode: SANDBOX_MODE } })
    const thread = threadId
      ? codex.resumeThread(String(threadId))
      : codex.startThread({
        workingDirectory: WORKING_DIRECTORY,
        skipGitRepoCheck: true,
        sandboxMode: SANDBOX_MODE,
      })

    const turn = await withTimeout(
      thread.run(trimmed),
      TURN_TIMEOUT_MS,
      'The Codex console timed out waiting for a response.',
    )

    return {
      threadId: thread.id || (threadId ? String(threadId) : null),
      response: (turn && turn.finalResponse) || '(Codex returned an empty response.)',
      usage: (turn && turn.usage) || null,
    }
  } catch (error) {
    if (!error.statusCode) {
      error.statusCode = 502
    }
    throw error
  } finally {
    running = false
  }
}

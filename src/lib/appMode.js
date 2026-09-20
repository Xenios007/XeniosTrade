// One frontend build serves three hostnames; the hostname picks the workspace:
//   ai.<domain>   -> AI Trading (advisory agent pipeline + AI Models)
//   bot.<domain>  -> Bot Trading (rule-based / LLM bots, wallets, history, settings)
//   <domain>, www.<domain> -> 'home' (public homepage + sign-in, no app)
//   localhost, anything else -> 'all' (the full, original workspace, for dev)
// Both subdomains proxy to the same backend, so there is no per-mode API.

export const APP_MODE_ALL = 'all'
export const APP_MODE_AI = 'ai'
export const APP_MODE_BOT = 'bot'
export const APP_MODE_HOME = 'home'

export const APEX_DOMAIN = 'projxenios.trade'

const MODE_OVERRIDE_KEY = 'xeniostrade:app-mode'
const MODE_BY_SUBDOMAIN = { ai: APP_MODE_AI, bot: APP_MODE_BOT }
const DEV_OVERRIDE_MODES = [APP_MODE_AI, APP_MODE_BOT, APP_MODE_HOME]

export const APP_META = {
  [APP_MODE_ALL]: {
    title: 'XeniosTrade',
    subtitle: 'Paper workspace',
    loginHeading: 'Private trading workspace',
    homePath: '/dashboard',
  },
  [APP_MODE_HOME]: {
    title: 'XeniosTrade — AI-assisted trading workspace',
    subtitle: 'Home',
    loginHeading: 'Sign in',
    homePath: '/',
  },
  [APP_MODE_AI]: {
    title: 'XeniosTrade AI',
    subtitle: 'AI Trading',
    loginHeading: 'Private AI trading workspace',
    homePath: '/ai-trading',
  },
  [APP_MODE_BOT]: {
    title: 'XeniosTrade Bots',
    subtitle: 'Bot Trading',
    loginHeading: 'Private bot trading workspace',
    homePath: '/dashboard',
  },
}

// Which top-level route sections belong to which workspace. `/ai-models` is
// shared (provider keys), but each side only shows its own tabs.
export const SECTIONS_BY_MODE = {
  [APP_MODE_AI]: ['ai-trading', 'ai-models', 'ai-history', 'ai-journal', 'ai-wallet', 'ai-settings'],
  [APP_MODE_BOT]: ['dashboard', 'mock-trading', 'trade-history', 'journal', 'ai-training', 'wallets', 'ai-models', 'settings'],
}

export const AI_MODELS_TAB_PATHS = {
  [APP_MODE_AI]: ['/ai-models', '/ai-models/browse', '/ai-models/agents'],
  [APP_MODE_BOT]: ['/ai-models', '/ai-models/bots'],
}

export function isAiModelsTabVisible(mode, path) {
  const allowed = AI_MODELS_TAB_PATHS[mode]
  return !allowed || allowed.includes(path)
}

function isDevHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

// Pure so it can be unit-tested. `override` only applies on a dev host, letting
// `localhost:5173/?app=ai` preview a mode without touching DNS.
export function resolveAppMode(hostname, override = '') {
  const host = String(hostname || '').toLowerCase()
  const firstLabel = host.split('.')[0]
  if (host.includes('.') && MODE_BY_SUBDOMAIN[firstLabel]) {
    return MODE_BY_SUBDOMAIN[firstLabel]
  }
  if (host === APEX_DOMAIN || host === `www.${APEX_DOMAIN}`) {
    return APP_MODE_HOME
  }
  if (isDevHost(host) && DEV_OVERRIDE_MODES.includes(override)) {
    return override
  }
  return APP_MODE_ALL
}

// The apex domain both workspaces hang off, e.g. `projxenios.trade`.
export function getBaseDomain(hostname) {
  const host = String(hostname || '').toLowerCase()
  const [firstLabel, ...rest] = host.split('.')
  return (MODE_BY_SUBDOMAIN[firstLabel] || firstLabel === 'www') && rest.length > 0 ? rest.join('.') : host
}

// Absolute URL of the other workspace, or null when there is no subdomain split
// to link to (dev host, or the apex 'all' workspace).
export function getModeUrl(targetMode, path = '/', location = globalThis.window?.location) {
  if (!location || !Object.values(MODE_BY_SUBDOMAIN).includes(targetMode)) {
    return null
  }
  const host = String(location.hostname || '').toLowerCase()
  if (isDevHost(host) || !host.includes('.')) {
    return null
  }
  const label = targetMode === APP_MODE_AI ? 'ai' : 'bot'
  const port = location.port ? `:${location.port}` : ''
  return `${location.protocol}//${label}.${getBaseDomain(host)}${port}${path}`
}

// Where "Sign in with Google" starts. The OAuth callback only exists on the
// apex host, so the ai./bot. login screens hop there and come back via `return`.
export function getGoogleLoginUrl(returnTo = '', location = globalThis.window?.location) {
  const host = String(location?.hostname || '').toLowerCase()
  const suffix = returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''
  if (!location || isDevHost(host) || !host.includes('.') || host === APEX_DOMAIN || host === `www.${APEX_DOMAIN}`) {
    return `/api/auth/google/start${suffix}`
  }
  return `${location.protocol}//${getBaseDomain(host)}/api/auth/google/start${suffix}`
}

function readModeOverride(search) {
  try {
    const requested = new URLSearchParams(search || '').get('app')
    if (requested) {
      window.sessionStorage.setItem(MODE_OVERRIDE_KEY, requested)
      return requested
    }
    return window.sessionStorage.getItem(MODE_OVERRIDE_KEY) || ''
  } catch {
    return ''
  }
}

function detectAppMode() {
  if (typeof window === 'undefined') {
    return APP_MODE_ALL
  }
  const { hostname, search } = window.location
  return resolveAppMode(hostname, isDevHost(hostname) ? readModeOverride(search) : '')
}

export const APP_MODE = detectAppMode()
export const IS_AI_APP = APP_MODE === APP_MODE_AI
export const IS_BOT_APP = APP_MODE === APP_MODE_BOT
export const IS_HOME_APP = APP_MODE === APP_MODE_HOME

// Public hosts sign in with Google only. The password form survives on
// localhost/127.0.0.1, where the OAuth callback (registered for the apex) can't
// work, so a local instance isn't locked out.
export const PASSWORD_LOGIN_ENABLED = typeof window !== 'undefined' && isDevHost(window.location.hostname)

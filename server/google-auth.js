// Google sign-in for the private XeniosTrade workspaces.
//
// Authorization-code flow with PKCE, run server-side: the browser never sees the
// client secret or Google's tokens, and the ID token comes straight from Google's
// token endpoint over TLS (so its claims are read, not signature-verified — that
// is what Google's docs prescribe for this flow).
//
// This backend controls a trading system, so "signed in with Google" is NOT
// enough: the verified email must be on GOOGLE_ALLOWED_EMAILS. An empty list
// rejects everybody (fail closed).
//
// It stays independent of mock-trading-server.js (which boots a server on
// import) by taking its cookie/session helpers as dependencies.
import crypto from 'node:crypto'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
const OAUTH_COOKIE_NAME = 'xeniostrade_oauth'
const OAUTH_COOKIE_PATH = '/api/auth/google'
const OAUTH_TTL_SECONDS = 600
const DEFAULT_REDIRECT_URI = 'https://projxenios.trade/api/auth/google/callback'

const base64url = (buffer) => Buffer.from(buffer).toString('base64url')
const randomToken = (bytes = 32) => base64url(crypto.randomBytes(bytes))

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function readGoogleAuthConfig(env = process.env) {
  const redirectUri = String(env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI).trim()
  let apexHost = ''
  try {
    apexHost = new URL(redirectUri).hostname.toLowerCase()
  } catch {
    apexHost = ''
  }
  const explicitHosts = splitList(env.GOOGLE_RETURN_HOSTS)

  return {
    clientId: String(env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: String(env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri,
    allowedEmails: new Set(splitList(env.GOOGLE_ALLOWED_EMAILS)),
    // Where a successful sign-in may send the browser afterwards.
    returnHosts: explicitHosts.length > 0
      ? explicitHosts
      : apexHost ? [apexHost, `ai.${apexHost}`, `bot.${apexHost}`] : [],
  }
}

// Only ever redirect back to our own hosts (no open redirect).
export function sanitizeReturnUrl(value, returnHosts, fallback = '/') {
  const raw = String(value || '').trim()
  if (!raw) {
    return fallback
  }
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) {
    return raw
  }
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' && !url.username && !url.password && returnHosts.includes(url.hostname.toLowerCase())) {
      return `${url.origin}${url.pathname}${url.search}`
    }
  } catch {
    // fall through
  }
  return fallback
}

export function decodeJwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) {
    throw new Error('Malformed ID token.')
  }
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
}

// Throws unless the claims describe a verified Google account for this client.
export function validateIdTokenClaims(claims, { clientId, nonce, now = Date.now() }) {
  if (!GOOGLE_ISSUERS.has(claims?.iss)) {
    throw new Error('ID token issuer is not Google.')
  }
  if (claims.aud !== clientId) {
    throw new Error('ID token was issued for a different client.')
  }
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) {
    throw new Error('ID token has expired.')
  }
  if (claims.nonce !== nonce) {
    throw new Error('ID token nonce mismatch.')
  }
  const email = String(claims.email || '').trim().toLowerCase()
  if (!email || claims.email_verified !== true) {
    throw new Error('Google account email is missing or unverified.')
  }
  return email
}

function sign(secret, value) {
  return base64url(crypto.createHmac('sha256', secret).update(value).digest())
}

function packOauthCookie(secret, payload) {
  const body = base64url(JSON.stringify(payload))
  return `${body}.${sign(secret, body)}`
}

function unpackOauthCookie(secret, value) {
  const [body, signature] = String(value || '').split('.')
  if (!body || !signature) {
    return null
  }
  const expected = Buffer.from(sign(secret, body))
  const received = Buffer.from(signature)
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return null
  }
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * @param {object} deps
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {(name: string, value: string, options?: object) => string} deps.buildCookie
 * @param {(header: string) => Record<string, string>} deps.parseCookies
 * @param {(response: object, email: string) => Promise<void>} deps.issueSession  looks up/creates the user for `email` and sets their session cookie
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{ info?: Function, warn?: Function }} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createGoogleAuthHandlers({
  env = process.env,
  buildCookie,
  parseCookies,
  issueSession,
  fetchImpl = globalThis.fetch,
  log = console,
  now = Date.now,
}) {
  const config = readGoogleAuthConfig(env)
  const enabled = Boolean(config.clientId && config.clientSecret)

  const oauthCookie = (value, maxAge) => buildCookie(OAUTH_COOKIE_NAME, value, {
    maxAge,
    // Lax, not Strict: Google sends the browser back with a cross-site
    // navigation, and a Strict cookie would not accompany it.
    sameSite: 'Lax',
    path: OAUTH_COOKIE_PATH,
    domain: null,
  })

  function fail(response, code) {
    response.append('Set-Cookie', oauthCookie('', 0))
    response.redirect(302, `/?login_error=${code}`)
  }

  function start(request, response) {
    if (!enabled) {
      response.redirect(302, '/?login_error=not_configured')
      return
    }

    const state = randomToken()
    const nonce = randomToken()
    const verifier = randomToken(48)
    const returnTo = sanitizeReturnUrl(request.query?.return, config.returnHosts)

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })

    response.append('Set-Cookie', oauthCookie(
      packOauthCookie(config.clientSecret, { state, nonce, verifier, returnTo, at: now() }),
      OAUTH_TTL_SECONDS,
    ))
    response.redirect(302, `${AUTH_URL}?${params.toString()}`)
  }

  async function callback(request, response) {
    if (!enabled) {
      fail(response, 'not_configured')
      return
    }
    if (request.query?.error) {
      fail(response, 'denied')
      return
    }

    const pending = unpackOauthCookie(config.clientSecret, parseCookies(request.headers.cookie)[OAUTH_COOKIE_NAME])
    const code = String(request.query?.code || '')
    const state = String(request.query?.state || '')
    if (
      !pending
      || !code
      || !state
      || now() - Number(pending.at) > OAUTH_TTL_SECONDS * 1000
      || state.length !== String(pending.state).length
      || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(String(pending.state)))
    ) {
      fail(response, 'state')
      return
    }

    let email
    try {
      const tokenResponse = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: pending.verifier,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      })
      const tokens = await tokenResponse.json().catch(() => ({}))
      if (!tokenResponse.ok || !tokens.id_token) {
        throw new Error(`Google token exchange failed (${tokenResponse.status}${tokens.error ? `: ${tokens.error}` : ''}).`)
      }
      email = validateIdTokenClaims(decodeJwtPayload(tokens.id_token), {
        clientId: config.clientId,
        nonce: pending.nonce,
        now: now(),
      })
    } catch (error) {
      log.warn?.(`[google-auth] sign-in failed: ${error.message}`)
      fail(response, 'failed')
      return
    }

    if (!config.allowedEmails.has(email)) {
      log.warn?.(`[google-auth] rejected sign-in from ${email}: not on GOOGLE_ALLOWED_EMAILS`)
      fail(response, config.allowedEmails.size === 0 ? 'not_configured' : 'not_allowed')
      return
    }

    log.info?.(`[google-auth] signed in ${email}`)
    await issueSession(response, email)
    response.append('Set-Cookie', oauthCookie('', 0))
    response.redirect(302, sanitizeReturnUrl(pending.returnTo, config.returnHosts))
  }

  return { enabled, start, callback }
}

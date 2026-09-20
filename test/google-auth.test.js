import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createGoogleAuthHandlers, decodeJwtPayload, readGoogleAuthConfig, sanitizeReturnUrl, validateIdTokenClaims,
} from '../server/google-auth.js'

const ENV = {
  GOOGLE_CLIENT_ID: 'client-123.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_ALLOWED_EMAILS: 'Owner@Example.com, second@example.com',
  GOOGLE_REDIRECT_URI: 'https://example.test/api/auth/google/callback',
}
const HOSTS = ['example.test', 'ai.example.test', 'bot.example.test']

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=')
    return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]
  }),
)
const buildCookie = (name, value, o = {}) => `${name}=${encodeURIComponent(value)}; Path=${o.path || '/'}; SameSite=${o.sameSite || 'Strict'}; Max-Age=${o.maxAge}`

function fakeResponse() {
  const res = { cookies: [], location: null, status: null }
  res.append = (name, value) => { res.cookies.push(value) }
  res.redirect = (status, url) => { res.status = status; res.location = url }
  return res
}

function setup({ env = ENV, tokenReply } = {}) {
  const sessions = []
  const fetchCalls = []
  const handlers = createGoogleAuthHandlers({
    env,
    buildCookie,
    parseCookies,
    issueSession: () => sessions.push('session'),
    log: { info() {}, warn() {} },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, body: new URLSearchParams(init.body) })
      const reply = typeof tokenReply === 'function' ? tokenReply() : tokenReply
      return { ok: reply.ok !== false, status: reply.status || 200, json: async () => reply.json }
    },
  })
  return { handlers, sessions, fetchCalls }
}

// Runs /start and returns what the browser would hold + the state Google echoes back.
function begin(handlers, returnTo) {
  const res = fakeResponse()
  handlers.start({ query: returnTo ? { return: returnTo } : {} }, res)
  const url = new URL(res.location)
  const cookie = res.cookies[0].split(';')[0]
  return { res, url, cookie, state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce') }
}

async function finish(handlers, started, { code = 'abc', state = started.state, cookie = started.cookie } = {}) {
  const res = fakeResponse()
  await handlers.callback({ query: { code, state }, headers: { cookie } }, res)
  return res
}

const goodClaims = (nonce, extra = {}) => ({
  iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600,
  nonce, email: 'owner@example.com', email_verified: true, ...extra,
})

test('start sends the browser to Google with PKCE, state and nonce, and sets a Lax oauth cookie', () => {
  const { handlers } = setup()
  const { res, url, state, nonce } = begin(handlers)
  assert.equal(res.status, 302)
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('client_id'), ENV.GOOGLE_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), ENV.GOOGLE_REDIRECT_URI)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('code_challenge'))
  assert.ok(state && nonce && state !== nonce)
  assert.match(res.cookies[0], /SameSite=Lax/)
  assert.ok(!res.location.includes('test-secret'), 'client secret must never reach the browser')
})

test('a full sign-in for an allowlisted email issues a session and returns to the requested workspace', async () => {
  const started = (() => { const s = setup({ tokenReply: () => ({ json: { id_token: jwt(goodClaims(nonceHolder.nonce)) } }) }); return s })()
  const nonceHolder = {}
  const b = begin(started.handlers, 'https://ai.example.test/ai-trading')
  nonceHolder.nonce = b.nonce
  const res = await finish(started.handlers, b)
  assert.equal(started.sessions.length, 1)
  assert.equal(res.location, 'https://ai.example.test/ai-trading')
  assert.equal(started.fetchCalls[0].body.get('grant_type'), 'authorization_code')
  assert.equal(started.fetchCalls[0].body.get('client_secret'), 'test-secret')
  assert.ok(started.fetchCalls[0].body.get('code_verifier'))
  assert.match(res.cookies.at(-1), /Max-Age=0/, 'oauth cookie cleared')
})

test('a verified Google account that is not on the allowlist is rejected, with no session', async () => {
  const ctx = { nonce: '' }
  const { handlers, sessions } = setup({ tokenReply: () => ({ json: { id_token: jwt(goodClaims(ctx.nonce, { email: 'stranger@gmail.com' })) } }) })
  const b = begin(handlers); ctx.nonce = b.nonce
  const res = await finish(handlers, b)
  assert.equal(sessions.length, 0)
  assert.equal(res.location, '/?login_error=not_allowed')
})

test('an empty allowlist rejects everyone (fail closed)', async () => {
  const ctx = { nonce: '' }
  const { handlers, sessions } = setup({
    env: { ...ENV, GOOGLE_ALLOWED_EMAILS: '' },
    tokenReply: () => ({ json: { id_token: jwt(goodClaims(ctx.nonce)) } }),
  })
  const b = begin(handlers); ctx.nonce = b.nonce
  const res = await finish(handlers, b)
  assert.equal(sessions.length, 0)
  assert.equal(res.location, '/?login_error=not_configured')
})

test('callback rejects a wrong state, a missing/forged oauth cookie, and a stale one', async () => {
  const { handlers, sessions, fetchCalls } = setup({ tokenReply: { json: {} } })
  const b = begin(handlers)
  assert.equal((await finish(handlers, b, { state: 'nope' })).location, '/?login_error=state')
  assert.equal((await finish(handlers, b, { cookie: '' })).location, '/?login_error=state')
  const [name, value] = b.cookie.split('=')
  const forged = `${name}=${value.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}`
  assert.equal((await finish(handlers, b, { cookie: forged })).location, '/?login_error=state')
  assert.equal(sessions.length, 0)
  assert.equal(fetchCalls.length, 0, 'never contacts Google when state is bad')
})

test('an ID token for another client, with a bad nonce, unverified email or expired is refused', async () => {
  const bad = [
    (n) => goodClaims(n, { aud: 'someone-else' }),
    (n) => goodClaims(n, { nonce: 'replayed' }),
    (n) => goodClaims(n, { email_verified: false }),
    (n) => goodClaims(n, { exp: Math.floor(Date.now() / 1000) - 10 }),
    (n) => goodClaims(n, { iss: 'https://evil.example' }),
  ]
  for (const make of bad) {
    const ctx = { nonce: '' }
    const { handlers, sessions } = setup({ tokenReply: () => ({ json: { id_token: jwt(make(ctx.nonce)) } }) })
    const b = begin(handlers); ctx.nonce = b.nonce
    const res = await finish(handlers, b)
    assert.equal(sessions.length, 0)
    assert.equal(res.location, '/?login_error=failed')
  }
})

test('a failed token exchange or the user cancelling at Google ends in an error, not a session', async () => {
  const { handlers, sessions } = setup({ tokenReply: { ok: false, status: 400, json: { error: 'invalid_grant' } } })
  const b = begin(handlers)
  assert.equal((await finish(handlers, b)).location, '/?login_error=failed')
  const res = fakeResponse()
  await handlers.callback({ query: { error: 'access_denied' }, headers: {} }, res)
  assert.equal(res.location, '/?login_error=denied')
  assert.equal(sessions.length, 0)
})

test('without Google credentials the feature is off and start does not redirect to Google', () => {
  const { handlers } = setup({ env: {} })
  assert.equal(handlers.enabled, false)
  const res = fakeResponse()
  handlers.start({ query: {} }, res)
  assert.equal(res.location, '/?login_error=not_configured')
})

test('return URLs are limited to our own hosts (no open redirect)', () => {
  assert.equal(sanitizeReturnUrl('https://bot.example.test/dashboard?x=1', HOSTS), 'https://bot.example.test/dashboard?x=1')
  assert.equal(sanitizeReturnUrl('/ai-trading', HOSTS), '/ai-trading')
  for (const evil of ['https://evil.com/', '//evil.com', '/\\evil.com', 'http://ai.example.test/', 'https://ai.example.test.evil.com/', 'https://user:pw@ai.example.test/', 'javascript:alert(1)', '']) {
    assert.equal(sanitizeReturnUrl(evil, HOSTS), '/', evil)
  }
})

test('config derives the return hosts from the redirect URI and lowercases the allowlist', () => {
  const config = readGoogleAuthConfig(ENV)
  assert.deepEqual(config.returnHosts, HOSTS)
  assert.ok(config.allowedEmails.has('owner@example.com'))
})

test('claim validation returns the lowercased email', () => {
  const email = validateIdTokenClaims(goodClaims('n', { email: 'Owner@Example.COM' }), { clientId: ENV.GOOGLE_CLIENT_ID, nonce: 'n' })
  assert.equal(email, 'owner@example.com')
  assert.throws(() => decodeJwtPayload('not-a-jwt'))
})

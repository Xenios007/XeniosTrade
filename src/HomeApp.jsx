// Root component for the public homepage (projxenios.trade). It only knows how
// to show the marketing page and sign you in; the workspaces themselves live on
// ai.* and bot.* and are loaded there, so visitors here never download the app.
import { useCallback, useEffect, useState } from 'react'
import { HomePage } from './components/home/HomePage'
import { APP_META, APP_MODE, APP_MODE_AI, APP_MODE_BOT, SECTIONS_BY_MODE, getModeUrl } from './lib/appMode'

async function fetchJson(url, options) {
  const response = await fetch(url, options)
  const payload = await response.json().catch(() => ({}))
  return { ok: response.ok, payload }
}

// Old bookmarks like projxenios.trade/dashboard now belong to a workspace.
function workspaceRedirectFor(pathname) {
  const section = pathname.split('/')[1]
  if (!section) {
    return null
  }
  if (section === 'ai-trading' || section === 'ai-models') {
    return getModeUrl(APP_MODE_AI, pathname)
  }
  if (SECTIONS_BY_MODE[APP_MODE_BOT].includes(section) || section === 'consolidated-knowledge' || section === 'bot-10' || section === 'consolidated-bot') {
    return getModeUrl(APP_MODE_BOT, pathname)
  }
  return null
}

export default function HomeApp() {
  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [googleEnabled, setGoogleEnabled] = useState(false)
  const [loginError, setLoginError] = useState('')

  useEffect(() => {
    document.title = APP_META[APP_MODE].title

    const redirect = workspaceRedirectFor(window.location.pathname)
    if (redirect) {
      window.location.replace(redirect)
      return
    }

    // Surface a failed Google sign-in once, then tidy the URL.
    const url = new URL(window.location.href)
    const error = url.searchParams.get('login_error')
    if (error || window.location.pathname !== '/') {
      setLoginError(error || '')
      window.history.replaceState({}, '', `/${error ? '#signin' : ''}`)
    }

    let ignore = false
    Promise.allSettled([fetchJson('/api/auth/session'), fetchJson('/api/auth/google/status')]).then(([session, google]) => {
      if (ignore) {
        return
      }
      setAuthenticated(session.status === 'fulfilled' && Boolean(session.value.payload.authenticated))
      setGoogleEnabled(google.status === 'fulfilled' && Boolean(google.value.payload.enabled))
      setAuthChecked(true)
    })

    return () => {
      ignore = true
    }
  }, [])

  const handlePasswordLogin = useCallback(async (password) => {
    const { ok, payload } = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (!ok) {
      throw new Error(payload.error || 'Sign-in failed.')
    }
    setAuthenticated(true)
    setLoginError('')
  }, [])

  const handleLogout = useCallback(async () => {
    await fetchJson('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setAuthenticated(false)
  }, [])

  return (
    <HomePage
      authChecked={authChecked}
      authenticated={authenticated}
      googleEnabled={googleEnabled}
      loginError={loginError}
      onPasswordLogin={handlePasswordLogin}
      onLogout={handleLogout}
    />
  )
}

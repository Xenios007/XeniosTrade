import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { IS_HOME_APP } from './lib/appMode'
import { ToastProvider } from './components/ui/Toast'
import './index.css'

// The public homepage is its own small entry; the trading app is only fetched
// on the workspace hosts (and in dev).
const Root = IS_HOME_APP ? lazy(() => import('./HomeApp')) : lazy(() => import('./App'))

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={<div className="min-h-screen bg-slate-950" />}>
          <Root />
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
)

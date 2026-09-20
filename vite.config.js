import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.MOCK_TRADING_PORT || env.PORT || 3001

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
      watch: {
        // Do not watch mutable runtime data / the historical-candle cache. These
        // dirs churn constantly during a backtest and were sending the dev-server
        // file watcher into a CPU spin.
        ignored: [
          '**/server/data/**',
          '**/server/backtest/runs/**',
          '**/launcher-logs/**',
          '**/server/learning-bot/.venv/**',
        ],
      },
    },
  }
})

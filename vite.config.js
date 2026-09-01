import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3001',
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
})

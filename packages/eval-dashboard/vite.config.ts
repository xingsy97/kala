import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: { port: 5290, proxy: { '/api': { target: process.env.AGENT_EVAL_URL ?? 'http://127.0.0.1:13100', changeOrigin: true } } },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
})

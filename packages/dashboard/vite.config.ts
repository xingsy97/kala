import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const HOST_URL = process.env.HOST_URL ?? 'http://localhost:3000'
const HOST_HTTP_ROUTES = [
  '/models',
  '/settings',
  '/artifacts',
  '/eval',
  '/enhancement',
  '/router',
] as const

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-kernel/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@agent-kernel/shared/enhancement': resolve(__dirname, '../shared/src/enhancement.ts'),
      '@agent-kernel/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5288,
    proxy: {
      '/socket.io': {
        target: HOST_URL,
        ws: true,
        changeOrigin: true,
      },
      ...Object.fromEntries(
        HOST_HTTP_ROUTES.map((route) => [
          route,
          {
            target: HOST_URL,
            changeOrigin: true,
          },
        ]),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['src/test/setup.ts'],
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === name) return argv[i + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

const dashboardPort = Number(argValue(process.argv, '--port') ?? 5288)
const HOST_URL = process.env.HOST_URL ?? (dashboardPort === 3000 ? 'http://localhost:3001' : 'http://localhost:3000')
const HOST_HTTP_ROUTES = [
  '/auth',
  '/models',
  '/settings',
  '/docs',
  '/artifacts',
  '/eval',
  '/enhancement',
  '/router',
  '/admin/socket.io',
] as const

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-kernel/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@agent-kernel/shared/enhancement': resolve(__dirname, '../shared/src/enhancement.ts'),
      '@agent-kernel/shared/context-policy': resolve(__dirname, '../shared/src/context-policy/index.ts'),
      '@agent-kernel/shared/context-usage': resolve(__dirname, '../shared/src/context-usage/index.ts'),
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

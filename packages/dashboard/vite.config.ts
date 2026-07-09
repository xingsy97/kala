import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
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
  plugins: [
    react(),
    // Service worker for PWA installability + offline shell + Web Push handler.
    // - registerType: 'prompt' + skipWaiting: false so update lands on user
    //   confirmation (see initPwa in src/lib/pwa.ts). Auto-refresh mid-session
    //   would drop the composer draft and reset scroll.
    // - injectManifest strategy: our sw.js needs a hand-written push /
    //   notificationclick handler; workbox is loaded inside it for precache.
    //   generateSW cannot express both custom push and precache cleanly.
    // - navigateFallbackDenylist MUST exclude everything that talks to the
    //   host: /socket.io, HOST_HTTP_ROUTES, /push, /events, /admin/socket.io.
    //   Otherwise the SW intercepts long-lived socket.io upgrades and API
    //   calls with the cached shell — silently breaks the whole dashboard.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: null,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        // Never run the SW in `vite dev` — it caches the HMR shell and hides
        // rebuilds. Test PWA behaviour against `vite preview` or a release.
        enabled: false,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
      '@agent-kernel/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@agent-kernel/shared/enhancement': resolve(__dirname, '../shared/src/enhancement.ts'),
      '@agent-kernel/shared/context-policy': resolve(__dirname, '../shared/src/context-policy/index.ts'),
      '@agent-kernel/shared/context-usage': resolve(__dirname, '../shared/src/context-usage/index.ts'),
      '@agent-kernel/shared/push': resolve(__dirname, '../shared/src/push.ts'),
      '@agent-kernel/shared/workspace-exec': resolve(__dirname, '../shared/src/workspace-exec.ts'),
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

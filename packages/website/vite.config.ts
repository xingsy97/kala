import { resolve } from 'node:path'

import { defineConfig } from 'vite'

export default defineConfig({
  root: resolve(__dirname, '.generated'),
  publicDir: resolve(__dirname, '.generated/public'),
  base: process.env.KALA_SITE_BASE ?? '/',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(__dirname, '.generated/index.html'),
        download: resolve(__dirname, '.generated/download/index.html'),
        deploy: resolve(__dirname, '.generated/deploy/index.html'),
        releases: resolve(__dirname, '.generated/releases/index.html'),
        security: resolve(__dirname, '.generated/security/index.html'),
      },
    },
  },
})

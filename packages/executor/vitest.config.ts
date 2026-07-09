import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@agent-kernel/host': resolve(__dirname, '../host/src/index.ts'),
      '@agent-kernel/kernel': resolve(__dirname, '../kernel/src/index.ts'),
      '@agent-kernel/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
})

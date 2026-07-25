import { defineConfig } from 'vitest/config'

/**
 * The regression tests drive scenarios through the package CLI (tsx) via
 * `execFile`, so vitest itself never imports the host/executor packages — no
 * module-resolution aliases needed here.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Scenarios boot a full stack + Chrome via the CLI; give them room.
    testTimeout: 130_000,
    hookTimeout: 130_000,
    // Never run scenarios in parallel — each launches a stack + browser.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
  },
})

#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const checks = [
  {
    label: 'Executor RPC, durability, disconnect logs, and Terminal fallback', command: 'pnpm',
    args: ['--dir', 'packages/executor', 'exec', 'vitest', 'run', 'src/client.idempotency.test.ts', 'src/execution-receipts.test.ts', 'src/service-adapters.test.ts', 'src/terminal-manager.test.ts'],
    files: ['packages/executor/src/client.idempotency.test.ts', 'packages/executor/src/execution-receipts.test.ts', 'packages/executor/src/service-adapters.test.ts', 'packages/executor/src/terminal-manager.test.ts'],
  },
  {
    label: 'Host install routes, Directory RPC, delete, queue, steer, and stop semantics', command: 'pnpm',
    args: ['--dir', 'packages/host', 'exec', 'vitest', 'run', 'src/http/executor-installation-routes.test.ts', 'src/server.test.ts'],
    files: ['packages/host/src/http/executor-installation-routes.test.ts', 'packages/host/src/server.test.ts'],
  },
  {
    label: 'Dashboard session authority and cache hydration', command: 'pnpm',
    args: ['--dir', 'packages/dashboard', 'exec', 'vitest', 'run', 'src/session-projection.test.ts', 'src/use-session-cache.test.tsx', 'src/app-toolbar.test.tsx', 'src/session.test.ts', 'src/features/session-files/SessionFilesPanel.test.tsx', 'src/features/session-files/file-preview-model.test.ts'],
    files: ['packages/dashboard/src/session-projection.test.ts', 'packages/dashboard/src/use-session-cache.test.tsx', 'packages/dashboard/src/app-toolbar.test.tsx', 'packages/dashboard/src/session.test.ts', 'packages/dashboard/src/features/session-files/SessionFilesPanel.test.tsx', 'packages/dashboard/src/features/session-files/file-preview-model.test.ts'],
  },
  {
    label: 'Dashboard Tool intention, dot preview, Shell label, and line geometry', command: 'pnpm',
    args: ['--dir', 'packages/dashboard', 'exec', 'vitest', 'run', 'src/features/chat/ChatPanel.test.tsx', 'src/features/chat/tool-dot-layout.test.ts'],
    files: ['packages/dashboard/src/features/chat/ChatPanel.test.tsx', 'packages/dashboard/src/features/chat/tool-dot-layout.test.ts'],
  },
  {
    label: 'Release installer contracts', command: 'node', args: ['--test', 'scripts/release/executor-installer.test.mjs'],
    files: ['scripts/release/executor-installer.test.mjs'],
  },
  {
    label: 'Transactional deployment contracts', command: 'pnpm', args: ['exec', 'vitest', 'run', '--root', 'scripts/deploy', 'deploy-plan.test.mjs', 'generation-plan.test.mjs'],
    files: ['scripts/deploy/deploy-plan.test.mjs', 'scripts/deploy/generation-plan.test.mjs'],
  },
]

for (const check of checks) {
  for (const file of check.files) {
    if (!existsSync(join(root, file))) {
      console.error(`Regression target does not exist: ${file}`)
      process.exit(2)
    }
  }
  process.stdout.write(`\n=== ${check.label} ===\n`)
  const result = spawnSync(check.command, check.args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`Regression group failed: ${check.label}`)
    process.exit(result.status ?? 1)
  }
}
console.log('\nPASS recent product regression matrix')

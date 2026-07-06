import { createSandbox } from '../sandbox.js'
import type { ToolContext } from './registry.js'

export function makeCtx(root: string, signal?: AbortSignal): ToolContext {
  return {
    sandbox: createSandbox({ roots: [root] }),
    signal: signal ?? new AbortController().signal,
  }
}

export function makeCtxWithCwd(
  root: string,
  cwd: string,
  signal?: AbortSignal,
): ToolContext {
  return {
    sandbox: createSandbox({ roots: [root] }),
    cwd,
    signal: signal ?? new AbortController().signal,
  }
}

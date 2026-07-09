/**
 * Host-internal built-in tools.
 *
 * Host-initiated RPCs (filesystem inspection, background-task control,
 * overflow-spill management) used to travel over bespoke Socket.IO event
 * names (`fs:list_dirs`, `bg:list`, ...). That gave the executor a wide
 * inbound surface that had to move in lockstep with the host. It doesn't
 * anymore: the host now sends these as `tool:call` messages with a
 * conventional `__`-prefixed tool name. The executor doesn't distinguish
 * host-internal RPCs from kernel tool calls — it just runs the tool. The
 * prefix is a hint for humans reading the tool list, nothing more.
 *
 * Tool runners return strings, so each of these serializes its structured
 * result via `JSON.stringify` and the host de-serializes on the other end.
 * The payload contract for every tool matches the corresponding function
 * in `../fs-handlers.ts` and `../bg-handlers.ts` — those functions are
 * the source of truth; this file is a thin adapter layer.
 */

import {
  copyOverflowSession,
  deleteOverflowSession,
  listDirs,
  listFiles,
  readOverflowFile,
} from '../fs-handlers.js'
import { handleBgKill, handleBgList, handleBgOutput } from '../bg-handlers.js'
import { workspaceExec } from '../workspace-exec.js'
import { workspaceReadBinary } from '../workspace-read-binary.js'

import type { Tool } from './registry.js'
import { ToolError } from './registry.js'

function makeTool<TInput extends Record<string, unknown>, TResult>(
  name: string,
  runner: (input: TInput, ctx: { sandbox: import('../sandbox.js').Sandbox }) => Promise<TResult>,
): Tool {
  return {
    name,
    async run(rawInput, ctx) {
      try {
        const result = await runner(rawInput as TInput, { sandbox: ctx.sandbox })
        return JSON.stringify(result)
      } catch (err) {
        // Existing handlers never throw for expected user errors — they
        // return a well-formed result with `error?: string`. If one does
        // throw it's a bug; surface it so the host can log.
        throw new ToolError('EIO', err instanceof Error ? err.message : String(err))
      }
    },
  }
}

// ============================================================================
// Filesystem inspection
// ============================================================================

export const fsListDirsTool: Tool = makeTool(
  '__fs_list_dirs',
  async (input, { sandbox }) => {
    const { requestId, workspaceId, path } = input as {
      requestId: string
      workspaceId: string
      path?: string
    }
    return listDirs(requestId, workspaceId, path, sandbox)
  },
)

export const fsListFilesTool: Tool = makeTool(
  '__fs_list_files',
  async (input, { sandbox }) =>
    listFiles(input as Parameters<typeof listFiles>[0], sandbox),
)

export const fsReadOverflowTool: Tool = makeTool(
  '__fs_read_overflow',
  async (input, { sandbox }) =>
    readOverflowFile(input as Parameters<typeof readOverflowFile>[0], sandbox),
)

export const fsDeleteOverflowSessionTool: Tool = makeTool(
  '__fs_delete_overflow_session',
  async (input, { sandbox }) =>
    deleteOverflowSession(input as Parameters<typeof deleteOverflowSession>[0], sandbox),
)

export const fsCopyOverflowSessionTool: Tool = makeTool(
  '__fs_copy_overflow_session',
  async (input, { sandbox }) =>
    copyOverflowSession(input as Parameters<typeof copyOverflowSession>[0], sandbox),
)

// ============================================================================
// Background shell inspection
// ============================================================================

export const bgListTool: Tool = {
  name: '__bg_list',
  async run(input) {
    const result = await handleBgList(input as Parameters<typeof handleBgList>[0])
    return JSON.stringify(result)
  },
}

export const bgOutputTool: Tool = {
  name: '__bg_output',
  async run(input) {
    const result = await handleBgOutput(input as Parameters<typeof handleBgOutput>[0])
    return JSON.stringify(result)
  },
}

export const bgKillTool: Tool = {
  name: '__bg_kill',
  async run(input) {
    const result = await handleBgKill(input as Parameters<typeof handleBgKill>[0])
    return JSON.stringify(result)
  },
}

// ============================================================================
// Generic dashboard-initiated workspace observation
// (see docs/planning/roadmap-notes/workspace-exec-refactor.md)
// ============================================================================

export const workspaceExecTool: Tool = makeTool(
  '__workspace_exec',
  async (input, { sandbox }) =>
    workspaceExec(input as Parameters<typeof workspaceExec>[0], sandbox),
)

export const workspaceReadBinaryTool: Tool = makeTool(
  '__workspace_read_binary',
  async (input, { sandbox }) =>
    workspaceReadBinary(input as Parameters<typeof workspaceReadBinary>[0], sandbox),
)

export const internalDirectTools: readonly Tool[] = [
  fsListDirsTool,
  fsListFilesTool,
  fsReadOverflowTool,
  fsDeleteOverflowSessionTool,
  fsCopyOverflowSessionTool,
  bgListTool,
  bgOutputTool,
  bgKillTool,
  workspaceExecTool,
  workspaceReadBinaryTool,
]

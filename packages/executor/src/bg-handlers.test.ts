import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { handleBgKill, handleBgList, handleBgOutput } from './bg-handlers.js'
import {
  __resetBackgroundShellRegistryForTests,
  startBackgroundShell,
} from './tools/background-shell.js'
import { makeTempWorkspace } from './tools/_test-helpers.js'

describe('background task handlers', () => {
  let root: string | null = null

  afterEach(() => {
    __resetBackgroundShellRegistryForTests()
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
  })

  it('lists, reads, and kills only tasks owned by the requested session', async () => {
    root = makeTempWorkspace('ak-bg-handlers-')
    const taskA = await startBackgroundShell({ sessionId: 'session-a', command: 'sleep 5', cwd: root, shell: { family: 'sh', executable: '/bin/sh' } })
    const taskB = await startBackgroundShell({ sessionId: 'session-b', command: 'sleep 5', cwd: root, shell: { family: 'sh', executable: '/bin/sh' } })

    const listA = await handleBgList({ requestId: 'list-a', workspaceId: 'ws-1', sessionId: 'session-a' })
    expect(listA.tasks.map((task) => task.taskId)).toEqual([taskA.taskId])

    const readBFromA = await handleBgOutput({ requestId: 'read-a', workspaceId: 'ws-1', sessionId: 'session-a', taskId: taskB.taskId })
    expect(readBFromA.error).toBe('unknown task')

    const killBFromA = await handleBgKill({ requestId: 'kill-a', workspaceId: 'ws-1', sessionId: 'session-a', taskId: taskB.taskId })
    expect(killBFromA).toMatchObject({ killed: false, error: expect.stringContaining('unknown background task') })

    const killA = await handleBgKill({ requestId: 'kill-owner', workspaceId: 'ws-1', sessionId: 'session-a', taskId: taskA.taskId })
    expect(killA.killed).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import { makeCtx } from './_test-helpers.js'
import { ToolError } from './registry.js'
import { todowriteTool } from './todowrite.js'

describe('todowrite', () => {
  it('accepts a valid replacement list', async () => {
    const out = await todowriteTool.run(
      {
        todos: [
          { content: 'first', status: 'in_progress', priority: 'high' },
          { content: 'second', status: 'pending' },
        ],
      },
      makeCtx('/tmp'),
    )
    expect(out).toBe('todos updated: 2 items')
  })

  it('accepts an empty list (clearing all todos)', async () => {
    const out = await todowriteTool.run({ todos: [] }, makeCtx('/tmp'))
    expect(out).toBe('todos updated: 0 items')
  })

  it('rejects missing todos field', async () => {
    await expect(todowriteTool.run({}, makeCtx('/tmp'))).rejects.toBeInstanceOf(
      ToolError,
    )
  })

  it('rejects non-array todos field', async () => {
    await expect(
      todowriteTool.run({ todos: 'not an array' }, makeCtx('/tmp')),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('rejects entries with missing content', async () => {
    await expect(
      todowriteTool.run(
        { todos: [{ status: 'pending' }] },
        makeCtx('/tmp'),
      ),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('rejects unknown status values', async () => {
    await expect(
      todowriteTool.run(
        { todos: [{ content: 'x', status: 'blocked' }] },
        makeCtx('/tmp'),
      ),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('rejects more than one in_progress todo', async () => {
    await expect(
      todowriteTool.run(
        {
          todos: [
            { content: 'a', status: 'in_progress' },
            { content: 'b', status: 'in_progress' },
          ],
        },
        makeCtx('/tmp'),
      ),
    ).rejects.toBeInstanceOf(ToolError)
  })

  it('rejects unknown priority values', async () => {
    await expect(
      todowriteTool.run(
        { todos: [{ content: 'x', status: 'pending', priority: 'urgent' }] },
        makeCtx('/tmp'),
      ),
    ).rejects.toBeInstanceOf(ToolError)
  })
})

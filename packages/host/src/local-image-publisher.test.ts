import { describe, expect, it, vi } from 'vitest'
import { createLocalImagePublisher, publishMarkdownImages } from './local-image-publisher.js'
import type { SessionRecord } from './store/session.js'

describe('publishMarkdownImages', () => {
  it('publishes local markdown images but preserves remote, artifact, and fenced examples', async () => {
    const publish = vi.fn(async (path: string) => `![published](artifact://${path.split('/').at(-1)})`)
    const text = '![local](/tmp/a.png)\n![remote](https://example.com/a.png)\n```md\n![sample](/tmp/sample.png)\n```\n![existing](artifact://one)'
    const result = await publishMarkdownImages(text, publish)
    expect(result).toContain('![published](artifact://a.png)')
    expect(result).toContain('![remote](https://example.com/a.png)')
    expect(result).toContain('![sample](/tmp/sample.png)')
    expect(result).toContain('![existing](artifact://one)')
    expect(publish).toHaveBeenCalledTimes(1)
  })
  it('supports angle-wrapped local paths with spaces', async () => {
    expect(await publishMarkdownImages('![design](</tmp/my design.png>)', async (path) => `[${path}]`)).toBe('[/tmp/my design.png]')
  })
  it('replaces failed local publication with a readable non-image placeholder', async () => {
    const publisher = createLocalImagePublisher({
      reader: async () => ({ error: 'outside sandbox' }),
      artifacts: { registerImage: vi.fn() } as never,
    })
    const message = await publisher('session-1', { workspaceId: 'workspace-1', state: { cwd: '/repo' } } as SessionRecord, {
      role: 'assistant',
      content: [{ type: 'text', text: '![preview](/tmp/missing.png)' }],
    })
    expect(message.content).toEqual([{ type: 'text', text: '[Image unavailable: preview]' }])
  })

})

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
  it('publishes sandbox image references with media metadata', async () => {
    const reader = vi.fn(async () => ({ base64: Buffer.from('<svg/>').toString('base64'), mediaType: 'image/svg+xml', size: 6 }))
    const registerImage = vi.fn(async () => ({ artifactId: 'svg-1', title: 'Diagram', mediaType: 'image/svg+xml' }))
    const assertCanStore = vi.fn(async () => {})
    const publisher = createLocalImagePublisher({ reader, artifacts: { registerImage } as never, assertCanStore })
    const message = await publisher('session-1', { workspaceId: 'workspace-1', state: { cwd: '/repo' } } as SessionRecord, {
      role: 'assistant',
      content: [{ type: 'text', text: '![Diagram](sandbox:/repo/diagram.svg)' }],
    })
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1', path: '/repo/diagram.svg', cwd: '/repo' }))
    expect(assertCanStore).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1' }), 6)
    expect(message.content).toEqual([{ type: 'text', text: '![Diagram](artifact://svg-1?mediaType=image%2Fsvg%2Bxml)' }])
  })

  it.each([
    ['an error result', async () => ({ error: 'outside sandbox' })],
    ['a rejected read', async () => { throw new Error('executor disconnected') }],
  ])('replaces %s with a readable non-image placeholder', async (_case, reader) => {
    const publisher = createLocalImagePublisher({
      reader,
      artifacts: { registerImage: vi.fn() } as never,
    })
    const message = await publisher('session-1', { workspaceId: 'workspace-1', state: { cwd: '/repo' } } as SessionRecord, {
      role: 'assistant',
      content: [{ type: 'text', text: '![preview](/tmp/missing.png)' }],
    })
    expect(message.content).toEqual([{ type: 'text', text: '[Image unavailable: preview]' }])
  })

})

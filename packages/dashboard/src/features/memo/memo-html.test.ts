import { describe, expect, it } from 'vitest'

import { sanitizeMemoHtml } from './memo-html.js'

describe('sanitizeMemoHtml', () => {
  it('removes executable markup while preserving safe formatting and pasted images', () => {
    const clean = sanitizeMemoHtml('<script>alert(1)</script><p onclick="x()">ok</p><img src="data:image/png;base64,AA==" alt="Diagram" title="Architecture" onerror="x()"><img src="https://evil.test/x">')
    expect(clean).not.toContain('script')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('onerror')
    expect(clean).not.toContain('evil.test')
    expect(clean).toContain('data:image/png;base64,AA==')
    expect(clean).toContain('alt="Diagram"')
    expect(clean).toContain('title="Architecture"')
  })

  it('keeps safe links and strips unsafe link attributes and protocols', () => {
    const clean = sanitizeMemoHtml('<a href="https://example.test/docs" onclick="bad()">Docs</a><a href="javascript:bad()">Bad</a>')
    expect(clean).toContain('href="https://example.test/docs"')
    expect(clean).toContain('rel="noreferrer noopener"')
    expect(clean).toContain('target="_blank"')
    expect(clean).not.toContain('javascript:')
    expect(clean).not.toContain('onclick')
  })
})

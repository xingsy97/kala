import { describe, expect, it } from 'vitest'
import { sanitizeMemoHtml } from './memo-html.js'
describe('sanitizeMemoHtml',()=>{
  it('removes executable markup while preserving safe formatting and pasted images',()=>{
    const clean=sanitizeMemoHtml('<script>alert(1)</script><p onclick="x()">ok</p><img src="data:image/png;base64,AA==" onerror="x()"><img src="https://evil.test/x">')
    expect(clean).not.toContain('script');expect(clean).not.toContain('onclick');expect(clean).not.toContain('onerror');expect(clean).not.toContain('evil.test');expect(clean).toContain('data:image/png;base64,AA==')
  })
})

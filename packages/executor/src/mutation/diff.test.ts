import { describe, expect, it } from 'vitest'

import { createUnifiedDiff } from './diff.js'

describe('createUnifiedDiff', () => {
  it('uses the rendered unified diff body as the additions/deletions source of truth', () => {
    const before = [
      'def greet(name, punctuation="!"):',
      '    print(f"Hello, {name}{punctuation}")',
      '    print("Welcome to the updated demo")',
      '',
      'if __name__ == "__main__":',
      '    greet("Agent")',
      '',
      '',
    ].join('\n')
    const after = [
      'from datetime import datetime',
      '',
      'def greet(name, punctuation="!"):',
      '    print(f"[{datetime.now():%H:%M:%S}] Hello, {name}{punctuation}")',
      '    print("Welcome to the updated demo")',
      '',
      'if __name__ == "__main__":',
      '    greet("Agent")',
      '',
      '',
    ].join('\n')

    const result = createUnifiedDiff('/repo/hello.py', before, after)

    expect(result.additions).toBe(3)
    expect(result.deletions).toBe(1)
    expect(result.diff).toContain('+from datetime import datetime')
    expect(result.diff).toContain(' def greet(name, punctuation="!"):')
    expect(result.diff).not.toContain('-def greet(name, punctuation="!"):')
    expect(result.diff).not.toContain('+def greet(name, punctuation="!"):')
    expect(countRendered(result.diff, '+')).toBe(result.additions)
    expect(countRendered(result.diff, '-')).toBe(result.deletions)
  })

  it('does not invent an empty line for empty file inputs', () => {
    const result = createUnifiedDiff('/repo/new.txt', '', 'hello\nworld')

    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(0)
    expect(result.diff).toContain('@@ -1,0 +1,2 @@')
    expect(result.diff).toContain('+hello')
    expect(result.diff).toContain('+world')
    expect(result.diff).not.toContain('-\n')
  })
})

function countRendered(diff: string, sign: '+' | '-'): number {
  return diff
    .split('\n')
    .filter((line) => line.startsWith(sign) && !line.startsWith(`${sign}${sign}${sign}`))
    .length
}

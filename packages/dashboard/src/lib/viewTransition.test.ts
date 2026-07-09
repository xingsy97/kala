import { describe, expect, it, vi } from 'vitest'

import { supportsViewTransitions, withViewTransition } from './viewTransition.js'

type MutableDoc = { startViewTransition?: (cb: () => void) => { finished: Promise<void> } }

function docKey(): MutableDoc {
  return document as unknown as MutableDoc
}

describe('withViewTransition', () => {
  it('invokes fn directly when the API is unavailable', () => {
    const doc = docKey()
    const prior = doc.startViewTransition
    delete doc.startViewTransition
    try {
      const fn = vi.fn()
      withViewTransition(fn)
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      if (prior) doc.startViewTransition = prior
    }
  })

  it('routes through document.startViewTransition when available', () => {
    const doc = docKey()
    const prior = doc.startViewTransition
    const start = vi.fn((cb: () => void) => {
      cb()
      return { finished: Promise.resolve() }
    })
    doc.startViewTransition = start
    try {
      const fn = vi.fn()
      withViewTransition(fn)
      expect(start).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledTimes(1)
    } finally {
      if (prior) doc.startViewTransition = prior
      else delete doc.startViewTransition
    }
  })
})

describe('supportsViewTransitions', () => {
  it('reports true when the API is present', () => {
    const doc = docKey()
    const prior = doc.startViewTransition
    doc.startViewTransition = (cb) => {
      cb()
      return { finished: Promise.resolve() }
    }
    try {
      expect(supportsViewTransitions()).toBe(true)
    } finally {
      if (prior) doc.startViewTransition = prior
      else delete doc.startViewTransition
    }
  })

  it('reports false when the API is missing', () => {
    const doc = docKey()
    const prior = doc.startViewTransition
    delete doc.startViewTransition
    try {
      expect(supportsViewTransitions()).toBe(false)
    } finally {
      if (prior) doc.startViewTransition = prior
    }
  })
})

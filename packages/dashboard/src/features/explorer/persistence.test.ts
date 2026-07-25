import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readStoredSessionChildrenOpenState,
  readStoredSessionOrder,
  readStoredWorkspaceOpenState,
  readStoredWorkspaceOrder,
  writeStoredSessionChildrenOpenState,
  writeStoredSessionOrder,
  writeStoredWorkspaceOpenState,
  writeStoredWorkspaceOrder,
} from './persistence.js'

beforeEach(() => window.localStorage.clear())
afterEach(() => window.localStorage.clear())

describe('workspace open-state persistence', () => {
  it('round-trips ws:-prefixed booleans and ignores foreign keys', () => {
    writeStoredWorkspaceOpenState({ 'ws:a': true, 'ws:b': false })
    expect(readStoredWorkspaceOpenState()).toEqual({ 'ws:a': true, 'ws:b': false })
  })
  it('returns {} for missing or malformed storage', () => {
    expect(readStoredWorkspaceOpenState()).toEqual({})
  })
})

describe('session children open-state persistence', () => {
  it('round-trips values', () => {
    writeStoredSessionChildrenOpenState({ 'sess:1': true })
    expect(readStoredSessionChildrenOpenState()).toEqual({ 'sess:1': true })
  })
})

describe('order persistence', () => {
  it('round-trips workspace + session order arrays', () => {
    writeStoredWorkspaceOrder(['w2', 'w1'])
    writeStoredSessionOrder(['s3', 's1'])
    expect(readStoredWorkspaceOrder()).toEqual(['w2', 'w1'])
    expect(readStoredSessionOrder()).toEqual(['s3', 's1'])
  })
  it('returns [] when unset', () => {
    expect(readStoredWorkspaceOrder()).toEqual([])
    expect(readStoredSessionOrder()).toEqual([])
  })
})

describe('resilience', () => {
  it('read helpers survive malformed JSON', () => {
    window.localStorage.setItem('agent-kernel:explorer:workspace-open:v1', '{bad json')
    expect(readStoredWorkspaceOpenState()).toEqual({})
  })
})

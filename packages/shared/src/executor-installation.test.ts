import { describe, expect, it } from 'vitest'

import {
  EXECUTOR_INSTALL_LABEL_MAX_LENGTH,
  EXECUTOR_INSTALL_WORKSPACE_ROOT_MAX_LENGTH,
  EXECUTOR_INSTALL_ALLOWED_STATUS_TRANSITIONS,
  isExecutorInstallStatusTransitionAllowed,
  schema,
} from './index.js'

const timestamp = '2026-08-03T12:00:00.000Z'

const snapshot = {
  id: 'install-1',
  platform: 'linux',
  mode: 'service',
  workspaceRoot: '/srv/workspace',
  label: 'Build workspace',
  status: 'pairing_pending',
  seq: 3,
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: timestamp,
} as const

describe('executor installation contracts', () => {
  it('accepts strict create and update requests at their length boundaries', () => {
    expect(schema.CreateExecutorInstallSchema.safeParse({
      platform: 'windows',
      mode: 'temporary',
      workspaceRoot: 'x'.repeat(EXECUTOR_INSTALL_WORKSPACE_ROOT_MAX_LENGTH),
      label: 'x'.repeat(EXECUTOR_INSTALL_LABEL_MAX_LENGTH),
    }).success).toBe(true)

    expect(schema.UpdateExecutorInstallSchema.safeParse({ mode: 'service' }).success).toBe(true)
  })

  it('rejects invalid, empty, oversized, and unknown request fields', () => {
    expect(schema.CreateExecutorInstallSchema.safeParse({
      platform: 'freebsd',
      mode: 'service',
      workspaceRoot: '/workspace',
    }).success).toBe(false)
    expect(schema.CreateExecutorInstallSchema.safeParse({
      platform: 'linux',
      mode: 'daemon',
      workspaceRoot: '/workspace',
    }).success).toBe(false)
    expect(schema.CreateExecutorInstallSchema.safeParse({
      platform: 'linux',
      mode: 'service',
      workspaceRoot: 'x'.repeat(EXECUTOR_INSTALL_WORKSPACE_ROOT_MAX_LENGTH + 1),
    }).success).toBe(false)
    expect(schema.CreateExecutorInstallSchema.safeParse({
      platform: 'linux',
      mode: 'service',
      workspaceRoot: '/workspace',
      label: 'x'.repeat(EXECUTOR_INSTALL_LABEL_MAX_LENGTH + 1),
    }).success).toBe(false)
    expect(schema.UpdateExecutorInstallSchema.safeParse({}).success).toBe(false)
    expect(schema.UpdateExecutorInstallSchema.safeParse({ label: 'workspace', bootstrapToken: 'secret' }).success).toBe(false)
  })

  it('accepts safe snapshots and events while rejecting secret-bearing response fields', () => {
    expect(schema.ExecutorInstallStatusSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(schema.ExecutorInstallEventSchema.safeParse({
      installationId: snapshot.id,
      seq: snapshot.seq,
      timestamp,
      status: snapshot.status,
      metadata: { architecture: 'x64', download: { bytes: 42 } },
    }).success).toBe(true)

    expect(schema.ExecutorInstallStatusSnapshotSchema.safeParse({
      ...snapshot,
      bootstrapToken: 'secret',
    }).success).toBe(false)
    expect(schema.ExecutorInstallEventSchema.safeParse({
      installationId: snapshot.id,
      seq: snapshot.seq,
      timestamp,
      status: 'failed',
      metadata: { diagnostics: { claimSecret: 'secret' } },
    }).success).toBe(false)
  })

  it('defines only the normative state transitions, including mode-specific pairing', () => {
    expect(EXECUTOR_INSTALL_ALLOWED_STATUS_TRANSITIONS.created).toEqual(['bootstrap_downloaded', 'expired'])
    expect(isExecutorInstallStatusTransitionAllowed('starting', 'online')).toBe(true)
    expect(isExecutorInstallStatusTransitionAllowed('online', 'completed')).toBe(true)
    expect(isExecutorInstallStatusTransitionAllowed('created', 'online')).toBe(false)
    expect(isExecutorInstallStatusTransitionAllowed('failed', 'starting')).toBe(false)
    expect(isExecutorInstallStatusTransitionAllowed('paired', 'service_installing', 'service')).toBe(true)
    expect(isExecutorInstallStatusTransitionAllowed('paired', 'starting', 'service')).toBe(false)
    expect(isExecutorInstallStatusTransitionAllowed('paired', 'starting', 'temporary')).toBe(true)
    expect(isExecutorInstallStatusTransitionAllowed('paired', 'service_installing', 'temporary')).toBe(false)
  })
})

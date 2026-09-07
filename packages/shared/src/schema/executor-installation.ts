import { z } from 'zod'

import {
  EXECUTOR_INSTALL_LABEL_MAX_LENGTH,
  EXECUTOR_INSTALL_WORKSPACE_ROOT_MAX_LENGTH,
} from '../executor-installation.js'
import type {
  CreateExecutorInstall,
  ExecutorInstallEvent,
  ExecutorInstallMode,
  ExecutorInstallPlatform,
  ExecutorInstallStatus,
  ExecutorInstallStatusSnapshot,
  UpdateExecutorInstall,
} from '../executor-installation.js'

const NonEmptyStringSchema = z.string().trim().min(1)
const TimestampSchema = z.iso.datetime({ offset: true })
const ErrorCodeSchema = z.string().trim().min(1).max(128).regex(/^[A-Z0-9_]+$/)
const WorkspaceRootSchema = z.string().trim().min(1).max(EXECUTOR_INSTALL_WORKSPACE_ROOT_MAX_LENGTH)
const LabelSchema = z.string().trim().min(1).max(EXECUTOR_INSTALL_LABEL_MAX_LENGTH)

export const ExecutorInstallPlatformSchema = z.enum([
  'linux',
  'macos',
  'windows',
]) satisfies z.ZodType<ExecutorInstallPlatform>

export const ExecutorInstallModeSchema = z.enum([
  'service',
  'temporary',
]) satisfies z.ZodType<ExecutorInstallMode>

export const ExecutorInstallStatusSchema = z.enum([
  'created',
  'bootstrap_downloaded',
  'asset_verified',
  'pairing_pending',
  'paired',
  'service_installing',
  'starting',
  'online',
  'completed',
  'failed',
  'rejected',
  'expired',
]) satisfies z.ZodType<ExecutorInstallStatus>

export const CreateExecutorInstallSchema = z.object({
  platform: ExecutorInstallPlatformSchema,
  mode: ExecutorInstallModeSchema,
  workspaceRoot: WorkspaceRootSchema,
  label: LabelSchema.optional(),
}).strict() satisfies z.ZodType<CreateExecutorInstall>

export const UpdateExecutorInstallSchema = z.object({
  platform: ExecutorInstallPlatformSchema.optional(),
  mode: ExecutorInstallModeSchema.optional(),
  workspaceRoot: WorkspaceRootSchema.optional(),
  label: LabelSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one installation field must be provided',
}) satisfies z.ZodType<UpdateExecutorInstall>

export const ExecutorInstallStatusSnapshotSchema = z.object({
  id: NonEmptyStringSchema,
  organizationId: NonEmptyStringSchema.optional(),
  principal: NonEmptyStringSchema.optional(),
  organizationRole: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  platform: ExecutorInstallPlatformSchema,
  mode: ExecutorInstallModeSchema,
  workspaceRoot: WorkspaceRootSchema,
  label: LabelSchema.optional(),
  status: ExecutorInstallStatusSchema,
  seq: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  errorCode: ErrorCodeSchema.optional(),
}).strict() satisfies z.ZodType<ExecutorInstallStatusSnapshot>

const containsSecretFieldName = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return ['secret', 'token', 'credential', 'password', 'privatekey'].some((term) => normalized.includes(term))
}

const NonSecretMetadataSchema = z.record(z.string(), z.unknown()).superRefine((metadata, context) => {
  const visit = (value: unknown, path: PropertyKey[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]))
      return
    }
    if (value === null || typeof value !== 'object') return

    for (const [key, child] of Object.entries(value)) {
      if (containsSecretFieldName(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Secret-bearing metadata fields are forbidden',
          path: [...path, key],
        })
      } else {
        visit(child, [...path, key])
      }
    }
  }

  visit(metadata, [])
})

export const ExecutorInstallEventSchema = z.object({
  installationId: NonEmptyStringSchema,
  seq: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
  status: ExecutorInstallStatusSchema,
  errorCode: ErrorCodeSchema.optional(),
  metadata: NonSecretMetadataSchema.optional(),
}).strict() satisfies z.ZodType<ExecutorInstallEvent>

import { z } from 'zod'

import { IdentifierSchema, NonEmptyStringSchema } from './common.js'

export const PrincipalKindSchema = z.enum(['user', 'service'])
export const PrincipalRoleSchema = z.enum(['operator', 'reviewer', 'viewer', 'worker', 'analyzer'])
export const AuthorizationScopeSchema = z.enum([
  'platform:read', 'evaluation:read', 'evaluation:write', 'evidence:read',
  'governance:write', 'worker:execute', 'analyzer:execute', 'admin',
])

export const PrincipalSchema = z.object({
  schemaVersion: z.literal(1),
  principalId: IdentifierSchema,
  kind: PrincipalKindSchema,
  role: PrincipalRoleSchema,
  scopes: z.array(AuthorizationScopeSchema).min(1),
  serviceId: IdentifierSchema.optional(),
}).strict().superRefine((principal, ctx) => {
  if ((principal.role === 'worker' || principal.role === 'analyzer') && principal.kind !== 'service') {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Worker and Analyzer roles require a service principal' })
  }
  if (principal.kind === 'service' && !principal.serviceId) ctx.addIssue({ code: 'custom', path: ['serviceId'], message: 'service principals require serviceId' })
})

export const BearerKeyConfigSchema = z.object({
  key: NonEmptyStringSchema,
  principal: PrincipalSchema,
}).strict()
export const BearerAuthConfigSchema = z.object({ schemaVersion: z.literal(1), keys: z.array(BearerKeyConfigSchema).min(1) }).strict()

export type Principal = z.infer<typeof PrincipalSchema>
export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>
export type AuthorizationScope = z.infer<typeof AuthorizationScopeSchema>
export type BearerAuthConfig = z.infer<typeof BearerAuthConfigSchema>

export const ROLE_SCOPE_MATRIX: Readonly<Record<PrincipalRole, readonly AuthorizationScope[]>> = Object.freeze({
  operator: ['platform:read', 'evaluation:read', 'evaluation:write', 'evidence:read', 'governance:write', 'admin'],
  reviewer: ['platform:read', 'evaluation:read', 'evidence:read', 'governance:write'],
  viewer: ['platform:read', 'evaluation:read', 'evidence:read'],
  worker: ['platform:read', 'worker:execute'],
  analyzer: ['platform:read', 'evaluation:read', 'analyzer:execute'],
})

export function principalHasScope(principal: Principal, required: AuthorizationScope): boolean {
  return principal.scopes.includes('admin') || principal.scopes.includes(required)
}

export function validatePrincipalScopes(principal: Principal): Principal {
  const parsed = PrincipalSchema.parse(principal)
  const allowed = ROLE_SCOPE_MATRIX[parsed.role]
  if (parsed.scopes.some((scope) => !allowed.includes(scope))) throw new Error('principal contains a scope not allowed for role ' + parsed.role)
  return parsed
}

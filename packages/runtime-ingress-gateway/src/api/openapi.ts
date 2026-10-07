import { publicApiOpenApi } from '@agent-kernel/shared'

const serviceAccountScopes = ['organization:read', 'organization:write', 'workspace:read', 'workspace:write', 'audit:read'] as const
const serviceAccountProperties = {
  id: { type: 'string', description: 'Opaque Service Account identifier.' },
  name: { type: 'string' },
  scopes: {
    type: 'array',
    minItems: 1,
    uniqueItems: true,
    items: { type: 'string', enum: serviceAccountScopes },
  },
  createdAt: { type: 'string', format: 'date-time' },
  expiresAt: { type: ['string', 'null'], format: 'date-time', description: 'Null only for legacy tokens created before finite lifetimes were required.' },
  revokedAt: { type: ['string', 'null'], format: 'date-time' },
} as const

export const enterpriseManagementOpenApi = {
  ...publicApiOpenApi,
  paths: {
    ...publicApiOpenApi.paths,
    '/api/v1/service-accounts': {
      get: {
        summary: 'List organization Service Accounts',
        description: 'Requires an authenticated organization owner or administrator. Tokens and token hashes are never returned.',
        responses: {
          '200': {
            description: 'Service Accounts in the authenticated administrator organization',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: {
                    items: {
                      type: 'array',
                      items: { type: 'object', required: ['id', 'name', 'scopes', 'createdAt', 'expiresAt', 'revokedAt'], properties: serviceAccountProperties },
                    },
                  },
                },
              },
            },
          },
          '401': { description: 'Browser administrator authentication required' },
          '403': { description: 'Organization administrator required' },
        },
      },
      post: {
        summary: 'Create an organization Service Account',
        description: 'Requires a same-origin request from an authenticated organization owner or administrator. The token is returned once. If expiresAt is omitted, a finite server-defined default is used; requested lifetimes are capped by the server.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'scopes'],
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 200 },
                  scopes: serviceAccountProperties.scopes,
                  expiresAt: { type: 'string', format: 'date-time', description: 'Optional future expiration within the server maximum lifetime.' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Service Account created; token is shown only in this response',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'token', 'name', 'scopes', 'createdAt', 'expiresAt', 'revokedAt'],
                  properties: { ...serviceAccountProperties, token: { type: 'string', description: 'One-time bearer token returned only by creation.' } },
                },
              },
            },
          },
          '400': { description: 'Invalid name, scopes, or expiration' },
          '401': { description: 'Browser administrator authentication required' },
          '403': { description: 'Same-origin organization administrator request required' },
        },
      },
    },
    '/api/v1/service-accounts/{id}': {
      delete: {
        summary: 'Revoke an organization Service Account token',
        description: 'Requires a same-origin request from an authenticated owner or administrator in the same organization. Revocation takes effect immediately.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Opaque Service Account identifier.' }],
        responses: {
          '204': { description: 'Service Account token revoked' },
          '401': { description: 'Browser administrator authentication required' },
          '403': { description: 'Same-origin organization administrator request required' },
          '404': { description: 'Service Account not found in the authenticated organization' },
        },
      },
    },
  },
} as const

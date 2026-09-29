import { publicApiOpenApi } from '@agent-kernel/shared'

export const enterpriseManagementOpenApi = {
  ...publicApiOpenApi,
  paths: {
    ...publicApiOpenApi.paths,
    '/api/v1/service-accounts': {
      post: {
        summary: 'Create an organization Service Account',
        description: 'Requires an authenticated organization owner or administrator. The token is returned once.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'scopes'],
                properties: {
                  name: { type: 'string' },
                  scopes: {
                    type: 'array',
                    minItems: 1,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      enum: ['organization:read', 'organization:write', 'workspace:read', 'workspace:write', 'audit:read'],
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          '201': { description: 'Service Account created' },
          '403': { description: 'Organization administrator required' },
        },
      },
    },
  },
} as const

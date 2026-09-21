export const enterpriseManagementOpenApi = {
  openapi: '3.1.0', info: { title: 'Kala Enterprise Management API', version: '1.0.0' },
  paths: {
    '/api/v1/service-accounts': { post: { summary: 'Create service account', responses: { '201': { description: 'Created' }, '403': { description: 'Forbidden' } } } },
    '/api/v1/audit-events': { get: { summary: 'Query audit events', responses: { '200': { description: 'Audit page' }, '403': { description: 'Forbidden' } } } },
    '/api/v1/webhooks': { post: { summary: 'Create webhook endpoint', responses: { '201': { description: 'Created' } } } },
  },
} as const

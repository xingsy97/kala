import { randomBytes } from 'node:crypto'

import { staticBearerToken } from '../../../packages/eval-sdk/dist/index.js'
import { BearerTokenAuthenticator } from '../../../packages/eval-orchestrator/dist/src/index.js'

/** Creates process-local, least-privilege credentials for verification servers. */
export function createEphemeralAuth({ workerId, analyzerIds }) {
  const token = () => randomBytes(32).toString('base64url')
  const operatorToken = token()
  const workerToken = token()
  const analyzerTokens = new Map(analyzerIds.map((id) => [id, token()]))
  const keys = [
    { key: operatorToken, principal: principal('verification-operator', 'user', 'operator', ['platform:read', 'evaluation:read', 'evaluation:write', 'evidence:read', 'governance:write', 'admin']) },
    { key: workerToken, principal: principal('verification-worker', 'service', 'worker', ['platform:read', 'worker:execute'], workerId) },
    ...[...analyzerTokens].map(([id, key]) => ({ key, principal: principal('verification-' + id, 'service', 'analyzer', ['platform:read', 'evaluation:read', 'analyzer:execute'], id) })),
  ]
  return {
    authenticator: new BearerTokenAuthenticator({ schemaVersion: 1, keys }),
    operatorCredentials: staticBearerToken(operatorToken),
    workerCredentials: staticBearerToken(workerToken),
    analyzerCredentials: (id) => {
      const value = analyzerTokens.get(id)
      if (!value) throw new Error('unknown ephemeral analyzer identity: ' + id)
      return staticBearerToken(value)
    },
  }
}

function principal(principalId, kind, role, scopes, serviceId) {
  return { schemaVersion: 1, principalId, kind, role, scopes, ...(serviceId ? { serviceId } : {}) }
}

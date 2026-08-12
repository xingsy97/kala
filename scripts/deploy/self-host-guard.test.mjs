import { describe, expect, it } from 'vitest'

import { assertSafeDeploymentInvocation } from './self-host-guard.mjs'

describe('self-hosted deployment guard', () => {
  it('rejects legacy restart from a Session hosted by the target', () => {
    expect(() => assertSafeDeploymentInvocation({
      env: {
        AK_DEPLOY_HOST_URL: 'https://product.example/',
        AGENT_RUNLAB_ORIGIN_HOST_URL: 'https://product.example',
        AGENT_RUNLAB_SESSION_ID: 'session',
        AGENT_RUNLAB_CALL_ID: 'call',
      },
      supervisorInstalled: false,
    })).toThrow(/SELF_HOSTED_RESTART_FORBIDDEN/)
  })

  it('allows staging when an external Supervisor owns cutover', () => {
    expect(() => assertSafeDeploymentInvocation({
      env: {
        AGENT_RUNLAB_SELF_HOSTED_DEPLOY_FORBIDDEN: '1',
        AGENT_RUNLAB_SESSION_ID: 'session',
        AGENT_RUNLAB_CALL_ID: 'call',
      },
      supervisorInstalled: true,
    })).not.toThrow()
  })

  it('does not block an independent external deployment', () => {
    expect(() => assertSafeDeploymentInvocation({ env: {}, supervisorInstalled: false })).not.toThrow()
  })
})

export function assertSafeDeploymentInvocation({ env, supervisorInstalled }) {
  const targetHost = normalizeOrigin(env.KALA_DEPLOY_HOST_URL)
  const originHost = normalizeOrigin(env.KALA_ORIGIN_HOST_URL)
  const hostedSession = nonEmpty(env.KALA_SESSION_ID)
  const hostedCall = nonEmpty(env.KALA_CALL_ID)
  const explicitFreeze = truthy(env.KALA_SELF_HOSTED_DEPLOY_FORBIDDEN)
  const sameHost = Boolean(targetHost && originHost && targetHost === originHost)

  if ((explicitFreeze || sameHost) && hostedSession && hostedCall && !supervisorInstalled) {
    throw new Error('SELF_HOSTED_RESTART_FORBIDDEN: stage the release and delegate cutover to an external Deploy Supervisor')
  }
}

function normalizeOrigin(value) {
  const raw = nonEmpty(value)
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}`
  } catch {
    return raw.replace(/\/$/u, '')
  }
}

function nonEmpty(value) {
  const normalized = value?.trim()
  return normalized || undefined
}

function truthy(value) {
  return /^(?:1|true|yes|on)$/iu.test(value ?? '')
}

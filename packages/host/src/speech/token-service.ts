import type { AzureSpeechCredentialStore } from './credential-store.js'

const TOKEN_TTL_SECONDS = 10 * 60

export type AzureSpeechToken = {
  token: string
  endpoint: string
  region: string
  expiresInSeconds: number
}

export async function issueAzureSpeechToken(
  credentials: AzureSpeechCredentialStore,
  options: { fetchImpl?: typeof fetch; allowDisabled?: boolean } = {},
): Promise<AzureSpeechToken> {
  const configured = await credentials.get()
  if (!configured) throw new Error('Azure Speech is not configured')
  if (!configured.enabled && !options.allowDisabled) throw new Error('Azure Speech voice input is disabled')
  if (configured.mode !== 'realtime' && !options.allowDisabled) throw new Error('Azure Speech live transcription is not enabled')
  const tokenUrl = new URL('sts/v1.0/issueToken', configured.endpoint)
  const response = await (options.fetchImpl ?? fetch)(tokenUrl, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': configured.apiKey,
      'Content-Length': '0',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Azure Speech rejected the credential (HTTP ${response.status})`)
  const token = (await response.text()).trim()
  if (!token) throw new Error('Azure Speech returned an empty authorization token')
  return {
    token,
    endpoint: configured.endpoint,
    region: configured.region,
    expiresInSeconds: TOKEN_TTL_SECONDS,
  }
}

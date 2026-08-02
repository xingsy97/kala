import { readFile } from 'node:fs/promises'
import { Agent, ProxyAgent } from 'undici'

export type EnterpriseConnectionOptions = { proxyUrl?: string; caFile?: string; rejectUnauthorized?: boolean }
export async function createEnterpriseDispatcher(options: EnterpriseConnectionOptions): Promise<Agent | ProxyAgent | undefined> {
  const ca = options.caFile ? await readFile(options.caFile, 'utf8') : undefined
  const connect = { rejectUnauthorized: options.rejectUnauthorized !== false, ...(ca ? { ca } : {}) }
  return options.proxyUrl ? new ProxyAgent({ uri: options.proxyUrl, requestTls: connect }) : ca || options.rejectUnauthorized === false ? new Agent({ connect }) : undefined
}
export function validateOutboundEndpoint(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'wss:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('enterprise executor requires TLS outside localhost')
  return url
}

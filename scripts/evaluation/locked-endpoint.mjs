import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function providerRootUrl(value) {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--base-url must use http or https')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('--base-url must identify a provider root without credentials, query, or fragment')
  const path = parsed.pathname.replace(/\/+$/u, '')
  if (path && path !== '/v1') throw new Error('--base-url path must be empty or /v1')
  return parsed.origin
}

export async function lockedEndpointDestinations(value, resolver = lookup) {
  const parsed = new URL(providerRootUrl(value))
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (isIP(parsed.hostname) === 4) return [parsed.hostname + ':' + String(port)]
  if (isIP(parsed.hostname) !== 0) throw new Error('--base-url must use an IPv4 address or a hostname with IPv4 records')
  let records = await resolver(parsed.hostname, { family: 4, all: true, verbatim: true })
  let addresses = uniqueIpv4(records)
  if (addresses.length > 0 && addresses.every(isSyntheticProxyAddress)) {
    records = await resolveDnsOverHttps(parsed.hostname)
    addresses = uniqueIpv4(records)
  }
  if (addresses.length === 0) throw new Error('--base-url hostname did not resolve to IPv4')
  if (addresses.every(isSyntheticProxyAddress)) throw new Error('--base-url hostname resolved only to synthetic proxy IPv4 addresses')
  return addresses.map((address) => parsed.hostname + '=' + address + ':' + String(port))
}

function uniqueIpv4(records) {
  return [...new Set(records.map((record) => record.address).filter((address) => isIP(address) === 4))]
}

function isSyntheticProxyAddress(address) {
  const octets = address.split('.').map(Number)
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)
}

async function resolveDnsOverHttps(hostname) {
  const resolvers = [
    'https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(hostname) + '&type=A',
    'https://dns.google/resolve?name=' + encodeURIComponent(hostname) + '&type=A',
  ]
  for (const url of resolvers) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10_000) })
      if (!response.ok) continue
      const body = await response.json()
      const records = Array.isArray(body.Answer) ? body.Answer.filter((answer) => answer?.type === 1 && typeof answer.data === 'string').map((answer) => ({ address: answer.data, family: 4 })) : []
      if (records.length > 0) return records
    } catch {}
  }
  throw new Error('--base-url synthetic proxy address could not be replaced with public DNS A records')
}

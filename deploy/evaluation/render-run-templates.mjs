import { readFile, writeFile } from 'node:fs/promises'

const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw new Error('usage: render-run-templates <source> <destination>')
const authority = process.env.AGENT_EVAL_MODEL_ENDPOINT_AUTHORITY
if (!authority || !/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(authority)) throw new Error('AGENT_EVAL_MODEL_ENDPOINT_AUTHORITY must be an explicit host:port')
const lxdImage = process.env.AGENT_EVAL_LXD_IMAGE
const sweBenchLxdImage = process.env.AGENT_EVAL_SWE_BENCH_LXD_IMAGE
for (const [name, value] of [['AGENT_EVAL_LXD_IMAGE', lxdImage], ['AGENT_EVAL_SWE_BENCH_LXD_IMAGE', sweBenchLxdImage]]) {
  if (!value || !/^local:(?:[a-f0-9]{64}|[a-zA-Z0-9][a-zA-Z0-9._-]*)$/.test(value)) throw new Error(`${name} must be a trusted local alias or fingerprint`)
}
let document = await readFile(source, 'utf8')
for (const [marker, value] of [['model-gateway.invalid:3000', authority], ['lxd-image.invalid/base', lxdImage], ['lxd-image.invalid/swe-bench', sweBenchLxdImage]]) {
  if (!document.includes(marker)) throw new Error(`${marker} marker is missing`)
  document = document.replaceAll(marker, value)
}
await writeFile(destination, document, { mode: 0o444 })

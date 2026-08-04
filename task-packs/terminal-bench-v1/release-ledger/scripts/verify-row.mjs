import { createHash } from 'node:crypto'

const [id, environment, status, amount, checksum] = process.argv.slice(2)
if (![id, environment, status, amount, checksum].every(Boolean)) process.exit(2)
const expected = createHash('sha256').update([id, environment, status, amount, 'public-fixture-v1'].join('|')).digest('hex')
process.exit(expected === checksum ? 0 : 1)

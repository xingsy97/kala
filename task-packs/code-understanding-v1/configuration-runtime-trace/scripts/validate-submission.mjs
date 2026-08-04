import { readFile } from 'node:fs/promises'

const value = JSON.parse(await readFile(new URL('../localization.json', import.meta.url), 'utf8'))
const keys = Object.keys(value).sort()
const expected = ['k', 'predictedDependencyEdges', 'rankedFiles', 'rankedSymbols', 'schemaVersion'].sort()
if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail('submission fields do not match the v1 contract')
if (value.schemaVersion !== 1 || value.k !== 5) fail('schemaVersion and k must be 1 and 5')
if (!uniqueStrings(value.rankedFiles, 5) || !uniqueStrings(value.rankedSymbols, 5)) fail('ranked lists must contain unique non-empty strings and at most k entries')
if (!Array.isArray(value.predictedDependencyEdges) || value.predictedDependencyEdges.length > 8 || value.predictedDependencyEdges.some((edge) => !Array.isArray(edge) || edge.length !== 2 || edge.some((part) => typeof part !== 'string' || !part))) fail('dependency edges are invalid')
if (new Set(value.predictedDependencyEdges.map((edge) => JSON.stringify(edge))).size !== value.predictedDependencyEdges.length) fail('dependency edges must be unique')
process.stdout.write(JSON.stringify(value) + '\n')

function uniqueStrings(value, maximum) { return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length }
function fail(message) { process.stderr.write(message + '\n'); process.exit(2) }

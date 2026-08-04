import { readFile } from 'node:fs/promises'

const response = JSON.parse(await readFile(new URL('../response.json', import.meta.url), 'utf8'))
if (!exact(response, ['memoryAnswers', 'plan', 'schemaVersion']) || response.schemaVersion !== 1) fail('response fields do not match the v1 contract')
if (!factArray(response.memoryAnswers)) fail('memoryAnswers must contain unique fact IDs and string values')
if (!response.plan || !exact(response.plan, ['dependencyEdges', 'nodes', 'parallelGroups', 'replans'])) fail('plan fields do not match the v1 contract')
if (!nodeArray(response.plan.nodes) || !edgeArray(response.plan.dependencyEdges) || !parallelGroups(response.plan.parallelGroups) || !replanArray(response.plan.replans)) fail('plan values are malformed')
for (const node of response.plan.nodes) {
  if (node.status !== 'completed' || node.evidenceRef !== 'evidence/' + node.stepId + '.json') fail('node completion evidence is invalid: ' + node.stepId)
  const evidence = JSON.parse(await readFile(new URL('../' + node.evidenceRef, import.meta.url), 'utf8'))
  if (evidence.stepId !== node.stepId || evidence.status !== 'completed') fail('node evidence does not prove completion: ' + node.stepId)
}
process.stdout.write(JSON.stringify({ memoryAnswers: response.memoryAnswers, plan: response.plan }) + '\n')

function exact(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]) }
function string(value) { return typeof value === 'string' && value.length > 0 && value.length <= 500 }
function factArray(value) { return Array.isArray(value) && value.every((fact) => exact(fact, ['factId', 'value']) && string(fact.factId) && string(fact.value)) && new Set(value.map((fact) => fact.factId)).size === value.length }
function nodeArray(value) { return Array.isArray(value) && value.every((node) => exact(node, ['evidenceRef', 'status', 'stepId']) && string(node.stepId) && node.status === 'completed' && string(node.evidenceRef)) && new Set(value.map((node) => node.stepId)).size === value.length }
function edgeArray(value) { return Array.isArray(value) && value.every((edge) => Array.isArray(edge) && edge.length === 2 && edge.every(string)) && new Set(value.map(JSON.stringify)).size === value.length }
function parallelGroups(value) { return Array.isArray(value) && value.every((group) => Array.isArray(group) && group.length >= 2 && group.every(string) && new Set(group).size === group.length) }
function replanArray(value) { return Array.isArray(value) && value.every((item) => exact(item, ['replacementStepId', 'supersededStepId', 'triggerId']) && string(item.triggerId) && string(item.supersededStepId) && string(item.replacementStepId)) }
function fail(message) { process.stderr.write(message + '\n'); process.exit(2) }

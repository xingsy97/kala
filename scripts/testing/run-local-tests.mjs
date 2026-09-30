import { spawnSync } from 'node:child_process'
import { availableParallelism } from 'node:os'

import { describeTestWorkerBudget, selectTestWorkers } from './test-worker-budget.mjs'

function fail(message) {
  console.error(`test:local: ${message}`)
  process.exit(1)
}

function parsePositiveInteger(name, value) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${name} must be a positive integer, received ${JSON.stringify(value)}`)
  }
  return parsed
}

function parseOptions(args) {
  let jobsValue = process.env.KALA_TEST_JOBS
  let workersValue = process.env.KALA_TEST_WORKERS
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: pnpm test:local -- --jobs <count> --workers <count|auto>\n\nEnvironment: KALA_TEST_JOBS=<count> KALA_TEST_WORKERS=<count|auto>')
      process.exit(0)
    }
    if (argument === '--jobs') {
      jobsValue = args[index + 1]
      index += 1
      continue
    }
    if (argument.startsWith('--jobs=')) {
      jobsValue = argument.slice('--jobs='.length)
      continue
    }
    if (argument === '--workers') {
      workersValue = args[index + 1]
      index += 1
      continue
    }
    if (argument.startsWith('--workers=')) {
      workersValue = argument.slice('--workers='.length)
      continue
    }
    fail(`unknown argument: ${argument}`)
  }

  const jobs = jobsValue === undefined
    ? Math.min(4, availableParallelism())
    : parsePositiveInteger('--jobs', jobsValue)
  const autoWorkers = workersValue === undefined || workersValue === 'auto'
  return {
    jobs,
    workers: autoWorkers ? selectTestWorkers({ packageJobs: jobs }) : parsePositiveInteger('--workers', workersValue),
    autoWorkers,
  }
}

function runPnpm(args, env = process.env) {
  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const { jobs, workers, autoWorkers } = parseOptions(process.argv.slice(2))
if (autoWorkers) {
  console.log(`test:local: ${describeTestWorkerBudget({ packageJobs: jobs, workers })}`)
}
console.log(`test:local: running workspace tests with ${jobs} package job${jobs === 1 ? '' : 's'} and ${workers} Vitest worker${workers === 1 ? '' : 's'} per package`)
runPnpm(
  ['-r', `--workspace-concurrency=${jobs}`, '--stream', 'run', 'test'],
  { ...process.env, KALA_TEST_WORKERS: String(workers) },
)
runPnpm(['run', 'test:scripts'])

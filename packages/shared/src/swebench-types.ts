/**
 * SWE-bench prediction records and the official grading command builder.
 * The prediction JSONL contract must match the upstream harness exactly.
 */

export type SweBenchPrediction = {
  instance_id: string
  model_name_or_path: string
  model_patch: string
}

export function createSweBenchPrediction(input: {
  instanceId: string
  modelNameOrPath: string
  modelPatch: string
}): SweBenchPrediction {
  return {
    instance_id: input.instanceId,
    model_name_or_path: input.modelNameOrPath,
    model_patch: input.modelPatch,
  }
}

export function buildSweBenchEvaluationCommand(input: {
  datasetName: string
  predictionsPath: string
  maxWorkers?: number
  runId: string
  instanceIds?: readonly string[]
  modal?: boolean
}): readonly string[] {
  const args = [
    'python',
    '-m',
    'swebench.harness.run_evaluation',
    '--dataset_name',
    input.datasetName,
    '--predictions_path',
    input.predictionsPath,
    '--max_workers',
    String(input.maxWorkers ?? 8),
    '--run_id',
    input.runId,
  ]
  if (input.instanceIds?.length) args.push('--instance_ids', ...input.instanceIds)
  if (input.modal) args.push('--modal', 'true')
  return args
}

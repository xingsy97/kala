export type FileMutationResult = {
  readonly ok: true
  readonly summary: string
  readonly files: readonly FileChangeResult[]
  readonly warnings?: readonly string[]
}

export type FileChangeResult = {
  readonly path: string
  readonly operation: 'created' | 'modified' | 'deleted' | 'moved'
  readonly old_path?: string
  readonly additions: number
  readonly deletions: number
  readonly diff: string
  readonly bytes_before?: number
  readonly bytes_after?: number
  readonly replacements?: readonly ReplacementResult[]
}

export type ReplacementResult = {
  readonly index: number
  readonly count: number
}

export function stringifyMutationResult(result: FileMutationResult): string {
  return JSON.stringify(result, null, 2)
}

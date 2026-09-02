import picomatch from 'picomatch'

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed'

export interface ChangedFile {
  path: string
  changeKind: ChangeKind
}

export interface GlobMatchResult {
  flag: boolean
  reasons: string[]
}

export type HighRiskResult = GlobMatchResult

const ACTION_INPUT_REASON_BUDGET_BYTES = 32 * 1024

/**
 * Bounds path-match diagnostics before a composite action forwards them as a
 * single input environment variable. Linux rejects an individual environment
 * entry above roughly 128 KiB, so large generated-schema PRs otherwise fail
 * before the downstream action can start.
 */
export function boundReasonsForActionInput(reasons: string[]): string[] {
  if (
    Buffer.byteLength(JSON.stringify(reasons), 'utf8') <=
    ACTION_INPUT_REASON_BUDGET_BYTES
  ) {
    return reasons
  }

  const bounded: string[] = []
  for (const reason of reasons) {
    const omitted = reasons.length - bounded.length - 1
    const candidate = [
      ...bounded,
      reason,
      `… ${omitted} additional path matches omitted`,
    ]
    if (
      Buffer.byteLength(JSON.stringify(candidate), 'utf8') >
      ACTION_INPUT_REASON_BUDGET_BYTES
    ) {
      break
    }
    bounded.push(reason)
  }

  bounded.push(
    `… ${reasons.length - bounded.length} additional path matches omitted`,
  )
  return bounded
}

/**
 * Matches changed files against a glob list, producing human-readable
 * reasons ("path (kind) matches `glob`"). Shared core for evaluateHighRisk
 * (## High-Risk Paths) and evaluateGatedPaths (## Gated Paths).
 */
export function evaluatePathGlobs(params: {
  files: ChangedFile[]
  globs: string[]
}): GlobMatchResult {
  const { files, globs } = params
  if (globs.length === 0) return { flag: false, reasons: [] }
  const matchers = globs.map((g) => ({ glob: g, isMatch: picomatch(g) }))
  const reasons: string[] = []
  for (const file of files) {
    for (const { glob, isMatch } of matchers) {
      if (isMatch(file.path)) {
        reasons.push(`${file.path} (${file.changeKind}) matches \`${glob}\``)
        break
      }
    }
  }
  return { flag: reasons.length > 0, reasons }
}

export function evaluateHighRisk(params: {
  files: ChangedFile[]
  globs: string[]
}): HighRiskResult {
  return evaluatePathGlobs(params)
}

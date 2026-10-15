import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  buildFinalizationPrompt,
  extractReviewEvidence,
} from './finalization.mjs'
import {
  buildFindingsPayload,
  createReviewState,
  readReviewState,
  reviewStateStatus,
  writeReviewState,
} from './state.mjs'

function findExecutionResult(value, results = []) {
  if (Array.isArray(value)) {
    for (const item of value) findExecutionResult(item, results)
  } else if (value !== null && typeof value === 'object') {
    if (value.type === 'result') results.push(value)
    for (const item of Object.values(value)) findExecutionResult(item, results)
  }
  return results.at(-1) ?? null
}

export function inspectReviewState(statePath, executionPath) {
  const state = readReviewState(statePath)
  const status = reviewStateStatus(state)
  let execution = null
  if (executionPath) {
    try {
      execution = findExecutionResult(
        JSON.parse(readFileSync(executionPath, 'utf8')),
      )
    } catch {
      execution = null
    }
  }
  return {
    status,
    needs_finalization: status === 'needs_finalization',
    findings_count: state.findings.length,
    result_subtype: execution?.subtype ?? null,
    turns: execution?.num_turns ?? null,
    duration_ms: execution?.duration_ms ?? null,
    total_cost_usd: execution?.total_cost_usd ?? null,
    permission_denials_count: Array.isArray(execution?.permission_denials)
      ? execution.permission_denials.length
      : (execution?.permission_denials_count ?? null),
  }
}

function readExecutionMessages(executionPath) {
  if (!executionPath) return []
  try {
    const parsed = JSON.parse(readFileSync(executionPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function finalizationPrompt(statePath, executionPath) {
  return buildFinalizationPrompt(
    extractReviewEvidence(readExecutionMessages(executionPath)),
    readReviewState(statePath),
  )
}

function usage() {
  throw new Error(
    'usage: state-cli.mjs init <state> | inspect <state> [execution] | emit <state> | finalization-prompt <state> [execution]',
  )
}

export function runCli(args = process.argv.slice(2)) {
  const [command, statePath, executionPath] = args
  if (!command || !statePath) usage()
  if (command === 'init') {
    writeReviewState(statePath, createReviewState())
  } else if (command === 'inspect') {
    process.stdout.write(
      `${JSON.stringify(inspectReviewState(statePath, executionPath))}\n`,
    )
  } else if (command === 'emit') {
    process.stdout.write(
      `${JSON.stringify(buildFindingsPayload(readReviewState(statePath)))}\n`,
    )
  } else if (command === 'finalization-prompt') {
    process.stdout.write(finalizationPrompt(statePath, executionPath))
  } else {
    usage()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runCli()
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}

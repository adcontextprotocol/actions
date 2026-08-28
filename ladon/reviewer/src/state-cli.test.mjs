import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  createReviewState,
  finalizeReview,
  writeReviewState,
} from './state.mjs'
import { inspectReviewState } from './state-cli.mjs'

function harness(state = createReviewState()) {
  const directory = mkdtempSync(join(tmpdir(), 'ladon-cli-test-'))
  const statePath = join(directory, 'state.json')
  const executionPath = join(directory, 'execution.json')
  writeReviewState(statePath, state)
  return { statePath, executionPath }
}

describe('review state inspection', () => {
  test('reports missing finalization and the last model result', () => {
    const { statePath, executionPath } = harness()
    writeFileSync(
      executionPath,
      JSON.stringify([
        { type: 'result', subtype: 'intermediate' },
        {
          type: 'result',
          subtype: 'error_max_turns',
          num_turns: 60,
          duration_ms: 12_345,
          total_cost_usd: 2.5,
          permission_denials_count: 1,
        },
      ]),
    )

    expect(inspectReviewState(statePath, executionPath)).toEqual({
      status: 'needs_finalization',
      needs_finalization: true,
      findings_count: 0,
      result_subtype: 'error_max_turns',
      turns: 60,
      duration_ms: 12_345,
      total_cost_usd: 2.5,
      permission_denials_count: 1,
    })
  })

  test('reports a complete explicit finalization independently of final text', () => {
    const state = finalizeReview(createReviewState(), {
      summary: 'Review coverage completed.',
      analysis_complete: true,
    })
    const { statePath, executionPath } = harness(state)
    writeFileSync(
      executionPath,
      JSON.stringify({ result: 'not structured JSON' }),
    )

    expect(inspectReviewState(statePath, executionPath)).toMatchObject({
      status: 'complete',
      needs_finalization: false,
      findings_count: 0,
      result_subtype: null,
    })
  })

  test('does not infer successful finalization from malformed execution data', () => {
    const { statePath, executionPath } = harness()
    writeFileSync(executionPath, '{')

    expect(inspectReviewState(statePath, executionPath)).toMatchObject({
      status: 'needs_finalization',
      needs_finalization: true,
      result_subtype: null,
    })
  })

  test('does not retry a finalization that explicitly marked analysis incomplete', () => {
    const state = finalizeReview(createReviewState(), {
      summary: 'The turn budget ended before required coverage completed.',
      analysis_complete: false,
    })
    const { statePath } = harness(state)

    expect(inspectReviewState(statePath)).toMatchObject({
      status: 'incomplete',
      needs_finalization: false,
    })
  })
})

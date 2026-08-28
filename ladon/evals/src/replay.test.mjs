import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { gradeReplay, replayTrace, summarizeReports } from './replay.mjs'

const finding = {
  severity: 'high',
  title: 'Approval can bypass a required gate',
  rationale: 'The new path reaches approval without the required check.',
  file: 'src/decision.ts',
  line: 24,
  category: 'correctness',
  posted_inline: true,
}

const fixture = {
  schema_version: 1,
  id: 'gate-bypass',
  description: 'A known gate bypass must be found without false approval.',
  source: { repository: 'example/repository', pr_number: 1 },
  expected: {
    required_findings: [
      {
        file: 'src/decision.ts',
        severity: 'high',
        title_includes: 'required gate',
      },
    ],
    forbidden_outcomes: ['approve'],
    allow_additional_findings: false,
  },
}

function trace(overrides = {}) {
  return {
    schema_version: 1,
    fixture_id: fixture.id,
    provider: 'test-provider',
    model: 'test-model',
    attempts: [{ kind: 'review', tool_calls: [] }],
    ...overrides,
  }
}

describe('deterministic Ladon replay', () => {
  test('classifies structured-output exhaustion as infrastructure failure', () => {
    const replay = replayTrace(trace({ outcome: 'approve' }))

    expect(replay).toMatchObject({
      state_status: 'needs_finalization',
      infrastructure_failure: true,
      approval_eligible: false,
      effective_outcome: 'infrastructure-failure',
      retry_count: 0,
    })
    expect(gradeReplay(fixture, trace({ outcome: 'approve' }))).toMatchObject({
      passed: false,
      checks: { fail_closed: false, completion: false },
      metrics: { false_approvals: 1 },
    })
  })

  test('preserves findings recorded before a compact finalization retry', () => {
    const candidate = trace({
      outcome: 'request-changes',
      attempts: [
        {
          kind: 'review',
          result: { subtype: 'error_max_turns', num_turns: 60 },
          tool_calls: [{ name: 'record_finding', arguments: finding }],
        },
        {
          kind: 'finalization',
          result: { subtype: 'success', num_turns: 1 },
          tool_calls: [
            {
              name: 'finalize_review',
              arguments: {
                summary: 'One blocking gate bypass was found.',
                analysis_complete: true,
              },
            },
          ],
        },
      ],
    })

    expect(gradeReplay(fixture, candidate)).toMatchObject({
      passed: true,
      checks: { fail_closed: true, bounded_retry: true },
      metrics: {
        completion: 1,
        required_finding_recall: 1,
        retries: 1,
        false_approvals: 0,
      },
    })
  })

  test('stops after one retry and fails closed on retry exhaustion', () => {
    const candidate = trace({
      attempts: [
        { kind: 'review', tool_calls: [] },
        { kind: 'finalization', tool_calls: [] },
        { kind: 'finalization', tool_calls: [] },
      ],
    })
    const report = gradeReplay(fixture, candidate)

    expect(report.replay.infrastructure_failure).toBe(true)
    expect(report.checks.completion).toBe(false)
    expect(report.checks.bounded_retry).toBe(false)
    expect(report.replay.protocol_errors).toContain(
      'more than one finalization retry was attempted',
    )
  })

  test('rejects findings work during the finalization-only retry', () => {
    const candidate = trace({
      attempts: [
        { kind: 'review', tool_calls: [] },
        {
          kind: 'finalization',
          tool_calls: [{ name: 'record_finding', arguments: finding }],
        },
      ],
    })
    const replay = replayTrace(candidate)

    expect(replay.state.findings).toEqual([])
    expect(replay.tool_errors[0].message).toMatch(/finalization retry/i)
    expect(replay.infrastructure_failure).toBe(true)
  })

  test('requires the compact retry to finalize exactly once', () => {
    const candidate = trace({
      attempts: [
        { kind: 'review', tool_calls: [] },
        {
          kind: 'finalization',
          tool_calls: [
            {
              name: 'finalize_review',
              arguments: {
                summary: 'Complete.',
                analysis_complete: true,
              },
            },
            {
              name: 'finalize_review',
              arguments: {
                summary: 'Complete.',
                analysis_complete: true,
              },
            },
          ],
        },
      ],
    })

    expect(replayTrace(candidate)).toMatchObject({
      infrastructure_failure: true,
      protocol_errors: [expect.stringMatching(/exactly once/i)],
    })
  })

  test('never emits an explicitly incomplete analysis', () => {
    const candidate = trace({
      outcome: 'approve',
      attempts: [
        {
          kind: 'review',
          tool_calls: [
            {
              name: 'finalize_review',
              arguments: {
                summary: 'Coverage did not complete.',
                analysis_complete: false,
              },
            },
          ],
        },
      ],
    })

    expect(gradeReplay(fixture, candidate)).toMatchObject({
      passed: false,
      checks: { fail_closed: false },
      replay: {
        state_status: 'incomplete',
        effective_outcome: 'infrastructure-failure',
      },
    })
  })

  test('aggregates repeated trials by provider and model', () => {
    const complete = trace({
      outcome: 'request-changes',
      attempts: [
        {
          kind: 'review',
          result: {
            subtype: 'success',
            duration_ms: 1200,
            total_cost_usd: 0.25,
            num_turns: 8,
            permission_denials_count: 2,
          },
          tool_calls: [
            { name: 'record_finding', arguments: finding },
            {
              name: 'finalize_review',
              arguments: {
                summary: 'Found the known issue.',
                analysis_complete: true,
              },
            },
          ],
        },
      ],
    })
    const reports = [
      gradeReplay(fixture, complete),
      gradeReplay(fixture, trace()),
    ]

    expect(summarizeReports(reports)).toEqual([
      expect.objectContaining({
        provider: 'test-provider',
        model: 'test-model',
        trials: 2,
        passed: 1,
        pass_rate: 0.5,
        completion_rate: 0.5,
        mean_required_finding_recall: 0.5,
        total_duration_ms: 1200,
        mean_duration_ms: 1200,
        total_cost_usd: 0.25,
        mean_cost_usd: 0.25,
        total_turns: 8,
        mean_turns: 8,
        total_permission_denials: 2,
        mean_permission_denials: 2,
      }),
    ])
  })

  test('loads the historical structured-output exhaustion regression', () => {
    const root = join(import.meta.dirname, '..')
    const historicalFixture = JSON.parse(
      readFileSync(
        join(root, 'fixtures/pr-6883-structured-output-exhaustion.json'),
        'utf8',
      ),
    )
    const historicalTrace = JSON.parse(
      readFileSync(
        join(root, 'traces/pr-6883-structured-output-exhaustion.json'),
        'utf8',
      ),
    )
    const fixedTrace = JSON.parse(
      readFileSync(
        join(root, 'traces/pr-6883-fixed-finalization-recovery.json'),
        'utf8',
      ),
    )
    const report = gradeReplay(historicalFixture, historicalTrace)
    const fixedReport = gradeReplay(historicalFixture, fixedTrace)

    expect(report.replay).toMatchObject({
      infrastructure_failure: true,
      approval_eligible: false,
      retry_count: 1,
    })
    expect(report.metrics.false_approvals).toBe(0)
    expect(report.passed).toBe(false)
    expect(fixedReport).toMatchObject({
      passed: true,
      checks: {
        fail_closed: true,
        bounded_retry: true,
        completion: true,
      },
      metrics: { retries: 1, false_approvals: 0 },
    })
  })

  test('classifies adcp-client PR 2721 as the same infrastructure regression', () => {
    const root = join(import.meta.dirname, '..')
    const historicalFixture = JSON.parse(
      readFileSync(
        join(
          root,
          'fixtures/adcp-client-pr-2721-structured-output-exhaustion.json',
        ),
        'utf8',
      ),
    )
    const historicalTrace = JSON.parse(
      readFileSync(
        join(
          root,
          'traces/adcp-client-pr-2721-structured-output-exhaustion.json',
        ),
        'utf8',
      ),
    )

    expect(gradeReplay(historicalFixture, historicalTrace)).toMatchObject({
      passed: false,
      checks: { fail_closed: true, completion: false },
      metrics: { completion: 0, false_approvals: 0 },
      replay: {
        state_status: 'needs_finalization',
        infrastructure_failure: true,
        approval_eligible: false,
        effective_outcome: 'infrastructure-failure',
        telemetry: [
          {
            subtype: 'error_max_structured_output_retries',
            num_turns: 13,
          },
        ],
      },
    })
  })
})

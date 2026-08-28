import {
  createReviewState,
  finalizeReview,
  recordFinding,
  reviewStateStatus,
} from '@adcp/ladon-reviewer/state'

const attemptKinds = new Set(['review', 'finalization'])
const outcomes = new Set([
  'approve',
  'request-changes',
  'comment',
  'escalate',
  'infrastructure-failure',
])

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value.trim()
}

export function validateFixture(input) {
  assertObject(input, 'fixture')
  if (input.schema_version !== 1) {
    throw new Error('fixture schema_version must be 1')
  }
  assertObject(input.source, 'fixture source')
  assertObject(input.expected, 'fixture expected')
  const requiredFindings = input.expected.required_findings ?? []
  if (!Array.isArray(requiredFindings)) {
    throw new Error('expected.required_findings must be an array')
  }
  const forbiddenOutcomes = input.expected.forbidden_outcomes ?? []
  if (
    !Array.isArray(forbiddenOutcomes) ||
    forbiddenOutcomes.some((outcome) => !outcomes.has(outcome))
  ) {
    throw new Error('expected.forbidden_outcomes contains an invalid outcome')
  }
  return {
    ...input,
    id: requiredString(input.id, 'fixture id'),
    description: requiredString(input.description, 'fixture description'),
    expected: {
      ...input.expected,
      required_findings: requiredFindings.map((finding, index) => {
        assertObject(finding, `required finding ${index}`)
        return {
          file: requiredString(finding.file, `required finding ${index} file`),
          severity: finding.severity ?? null,
          title_includes: finding.title_includes ?? null,
        }
      }),
      forbidden_outcomes: forbiddenOutcomes,
      allow_additional_findings:
        input.expected.allow_additional_findings ?? true,
      require_completion: input.expected.require_completion ?? true,
      max_tool_errors: input.expected.max_tool_errors ?? 0,
    },
  }
}

export function validateTrace(input) {
  assertObject(input, 'trace')
  if (input.schema_version !== 1) {
    throw new Error('trace schema_version must be 1')
  }
  if (!Array.isArray(input.attempts) || input.attempts.length === 0) {
    throw new Error('trace attempts must be a non-empty array')
  }
  if (input.outcome !== undefined && !outcomes.has(input.outcome)) {
    throw new Error('trace outcome is invalid')
  }
  return {
    ...input,
    fixture_id: requiredString(input.fixture_id, 'trace fixture_id'),
    provider: requiredString(input.provider, 'trace provider'),
    model: requiredString(input.model, 'trace model'),
    attempts: input.attempts.map((attempt, index) => {
      assertObject(attempt, `attempt ${index}`)
      if (!attemptKinds.has(attempt.kind)) {
        throw new Error(`attempt ${index} kind is invalid`)
      }
      if (!Array.isArray(attempt.tool_calls)) {
        throw new Error(`attempt ${index} tool_calls must be an array`)
      }
      return attempt
    }),
  }
}

function findingMatches(expected, actual) {
  return (
    expected.file === actual.file &&
    (expected.severity === null || expected.severity === actual.severity) &&
    (expected.title_includes === null ||
      actual.title
        .toLocaleLowerCase('en-US')
        .includes(expected.title_includes.toLocaleLowerCase('en-US')))
  )
}

export function replayTrace(inputTrace) {
  const trace = validateTrace(inputTrace)
  let state = createReviewState()
  const protocolErrors = []
  const toolErrors = []

  if (trace.attempts.length > 2) {
    protocolErrors.push('more than one finalization retry was attempted')
  }
  if (trace.attempts[0]?.kind !== 'review') {
    protocolErrors.push('the first attempt must be a review')
  }

  for (const [attemptIndex, attempt] of trace.attempts.entries()) {
    if (attemptIndex > 0 && attempt.kind !== 'finalization') {
      protocolErrors.push(
        `attempt ${attemptIndex + 1} must be finalization-only`,
      )
    }
    if (
      attempt.kind === 'finalization' &&
      (attempt.tool_calls.length !== 1 ||
        attempt.tool_calls[0]?.name !== 'finalize_review')
    ) {
      protocolErrors.push(
        `attempt ${attemptIndex + 1} must call finalize_review exactly once`,
      )
    }
    if (attemptIndex > 0 && state.finalization !== null) {
      protocolErrors.push(
        `attempt ${attemptIndex + 1} retried an already finalized review`,
      )
    }
    for (const [callIndex, call] of attempt.tool_calls.entries()) {
      try {
        assertObject(call, 'tool call')
        if (
          attempt.kind === 'finalization' &&
          call.name !== 'finalize_review'
        ) {
          throw new Error('finalization retry may only call finalize_review')
        }
        if (call.name === 'record_finding') {
          state = recordFinding(state, call.arguments)
        } else if (call.name === 'finalize_review') {
          state = finalizeReview(state, call.arguments)
        } else {
          throw new Error(`unsupported tool: ${String(call.name)}`)
        }
      } catch (error) {
        toolErrors.push({
          attempt: attemptIndex + 1,
          call: callIndex + 1,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const stateStatus = reviewStateStatus(state)
  const infrastructureFailure =
    stateStatus !== 'complete' || protocolErrors.length > 0
  return {
    fixture_id: trace.fixture_id,
    provider: trace.provider,
    model: trace.model,
    state,
    state_status: stateStatus,
    infrastructure_failure: infrastructureFailure,
    approval_eligible: !infrastructureFailure,
    effective_outcome: infrastructureFailure
      ? 'infrastructure-failure'
      : (trace.outcome ?? null),
    retry_count: Math.max(0, trace.attempts.length - 1),
    tool_errors: toolErrors,
    protocol_errors: protocolErrors,
    telemetry: trace.attempts.map((attempt) => attempt.result ?? null),
  }
}

export function gradeReplay(inputFixture, inputTrace) {
  const fixture = validateFixture(inputFixture)
  const replay = replayTrace(inputTrace)
  if (fixture.id !== replay.fixture_id) {
    throw new Error('fixture and trace IDs do not match')
  }

  const matched = fixture.expected.required_findings.map((expected) =>
    replay.state.findings.some((actual) => findingMatches(expected, actual)),
  )
  const unmatchedActual = replay.state.findings.filter(
    (actual) =>
      !fixture.expected.required_findings.some((expected) =>
        findingMatches(expected, actual),
      ),
  )
  const forbiddenOutcome = fixture.expected.forbidden_outcomes.includes(
    replay.effective_outcome,
  )
  const falseApproval =
    inputTrace.outcome === 'approve' && !replay.approval_eligible
  const checks = {
    fail_closed: !falseApproval,
    bounded_retry: replay.retry_count <= 1,
    completion:
      !fixture.expected.require_completion || !replay.infrastructure_failure,
    tool_protocol:
      replay.tool_errors.length <= fixture.expected.max_tool_errors,
    required_findings: matched.every(Boolean),
    additional_findings:
      fixture.expected.allow_additional_findings ||
      unmatchedActual.length === 0,
    forbidden_outcome: !forbiddenOutcome,
  }

  return {
    fixture_id: fixture.id,
    provider: replay.provider,
    model: replay.model,
    passed: Object.values(checks).every(Boolean),
    checks,
    metrics: {
      completion: replay.infrastructure_failure ? 0 : 1,
      required_finding_recall:
        matched.length === 0
          ? 1
          : matched.filter(Boolean).length / matched.length,
      unexpected_findings: unmatchedActual.length,
      tool_errors: replay.tool_errors.length,
      retries: replay.retry_count,
      false_approvals: falseApproval ? 1 : 0,
    },
    replay,
  }
}

export function summarizeReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('at least one report is required')
  }
  const groups = new Map()
  for (const report of reports) {
    const key = `${report.provider}/${report.model}`
    const group = groups.get(key) ?? {
      provider: report.provider,
      model: report.model,
      trials: 0,
      passed: 0,
      completion: 0,
      false_approvals: 0,
      required_finding_recall: 0,
      unexpected_findings: 0,
      tool_errors: 0,
      retries: 0,
    }
    group.trials += 1
    group.passed += report.passed ? 1 : 0
    for (const metric of [
      'completion',
      'false_approvals',
      'required_finding_recall',
      'unexpected_findings',
      'tool_errors',
      'retries',
    ]) {
      group[metric] += report.metrics[metric]
    }
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => ({
    ...group,
    pass_rate: group.passed / group.trials,
    completion_rate: group.completion / group.trials,
    mean_required_finding_recall: group.required_finding_recall / group.trials,
    mean_unexpected_findings: group.unexpected_findings / group.trials,
    mean_tool_errors: group.tool_errors / group.trials,
    mean_retries: group.retries / group.trials,
  }))
}

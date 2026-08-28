import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const severities = new Set(['critical', 'high', 'medium', 'low'])
const categories = new Set([
  'correctness',
  'security',
  'performance',
  'data-loss',
  'schema',
  'infra',
  'tests',
  'operability',
  'style',
  'other',
])

const findingKeys = new Set([
  'severity',
  'title',
  'rationale',
  'file',
  'line',
  'category',
  'posted_inline',
])
const finalizationKeys = new Set(['summary', 'analysis_complete'])
const stateKeys = new Set(['schema_version', 'findings', 'finalization'])

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function assertKnownKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key))
      throw new Error(`${label} contains unknown field: ${key}`)
  }
}

function requiredString(value, field, maximum) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  const normalized = value.trim()
  if (normalized.length > maximum) {
    throw new Error(`${field} must be at most ${maximum} characters`)
  }
  return normalized
}

export function validateFinding(input) {
  assertPlainObject(input, 'finding')
  assertKnownKeys(input, findingKeys, 'finding')

  if (!severities.has(input.severity)) {
    throw new Error(`invalid finding severity: ${String(input.severity)}`)
  }
  if (!categories.has(input.category)) {
    throw new Error(`invalid finding category: ${String(input.category)}`)
  }
  if (typeof input.posted_inline !== 'boolean') {
    throw new Error('posted_inline must be a boolean')
  }
  if (
    input.line !== undefined &&
    input.line !== null &&
    (!Number.isInteger(input.line) || input.line < 1)
  ) {
    throw new Error('line must be null or a positive integer')
  }

  const finding = {
    severity: input.severity,
    title: requiredString(input.title, 'title', 120),
    rationale: requiredString(input.rationale, 'rationale', 1500),
    file: requiredString(input.file, 'file', 1000),
    category: input.category,
    posted_inline: input.posted_inline,
  }
  if (input.line !== undefined) finding.line = input.line
  return finding
}

export function validateFinalization(input) {
  assertPlainObject(input, 'finalization')
  assertKnownKeys(input, finalizationKeys, 'finalization')
  if (typeof input.analysis_complete !== 'boolean') {
    throw new Error('analysis_complete must be a boolean')
  }
  return {
    summary: requiredString(input.summary, 'summary', 1500),
    analysis_complete: input.analysis_complete,
  }
}

export function createReviewState() {
  return { schema_version: 1, findings: [], finalization: null }
}

export function validateReviewState(input) {
  assertPlainObject(input, 'review state')
  assertKnownKeys(input, stateKeys, 'review state')
  if (input.schema_version !== 1) {
    throw new Error('review state schema_version must be 1')
  }
  if (!Array.isArray(input.findings)) {
    throw new Error('review state findings must be an array')
  }
  return {
    schema_version: 1,
    findings: input.findings.map(validateFinding),
    finalization:
      input.finalization === null
        ? null
        : validateFinalization(input.finalization),
  }
}

function findingIdentity(finding) {
  return JSON.stringify([
    finding.file,
    finding.line ?? null,
    finding.title.toLocaleLowerCase('en-US'),
  ])
}

export function recordFinding(inputState, inputFinding) {
  const state = validateReviewState(inputState)
  if (state.finalization !== null) {
    throw new Error('review is already finalized')
  }
  const finding = validateFinding(inputFinding)
  const identity = findingIdentity(finding)
  const index = state.findings.findIndex(
    (candidate) => findingIdentity(candidate) === identity,
  )
  const findings = [...state.findings]
  if (index === -1) findings.push(finding)
  else findings[index] = finding
  return { ...state, findings }
}

export function finalizeReview(inputState, inputFinalization) {
  const state = validateReviewState(inputState)
  const finalization = validateFinalization(inputFinalization)
  if (state.finalization === null) return { ...state, finalization }
  if (JSON.stringify(state.finalization) === JSON.stringify(finalization)) {
    return state
  }
  throw new Error('review is already finalized with different input')
}

export function reviewStateStatus(inputState) {
  const state = validateReviewState(inputState)
  if (state.finalization === null) return 'needs_finalization'
  return state.finalization.analysis_complete ? 'complete' : 'incomplete'
}

export function buildFindingsPayload(inputState) {
  const state = validateReviewState(inputState)
  if (state.finalization === null) throw new Error('review is not finalized')
  if (!state.finalization.analysis_complete) {
    throw new Error('review analysis is incomplete')
  }
  return {
    summary: state.finalization.summary,
    findings: state.findings,
  }
}

export function readReviewState(statePath) {
  return validateReviewState(JSON.parse(readFileSync(statePath, 'utf8')))
}

export function writeReviewState(statePath, inputState) {
  const state = validateReviewState(inputState)
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(temporaryPath, statePath)
}

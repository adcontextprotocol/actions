import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildFindingsPayload,
  createReviewState,
  finalizeReview,
  readReviewState,
  recordFinding,
  reviewStateStatus,
  writeReviewState,
} from './state.mjs'

const finding = (overrides = {}) => ({
  severity: 'high',
  title: 'Authorization is bypassed',
  rationale: 'The new branch skips the authorization check.',
  file: 'src/auth.ts',
  line: 42,
  category: 'security',
  posted_inline: true,
  ...overrides,
})

describe('review state', () => {
  test('records schema-valid findings and emits arbiter input after finalization', () => {
    let state = createReviewState()
    state = recordFinding(state, finding())
    state = finalizeReview(state, {
      summary: 'One authorization blocker was found.',
      analysis_complete: true,
    })

    expect(reviewStateStatus(state)).toBe('complete')
    expect(buildFindingsPayload(state)).toEqual({
      summary: 'One authorization blocker was found.',
      findings: [finding()],
    })
  })

  test('deduplicates a repeated finding deterministically', () => {
    let state = createReviewState()
    state = recordFinding(state, finding({ posted_inline: false }))
    state = recordFinding(state, finding({ posted_inline: true }))

    expect(state.findings).toEqual([finding({ posted_inline: true })])
  })

  test.each([
    ['unknown severity', finding({ severity: 'urgent' })],
    ['unknown category', finding({ category: 'governance' })],
    ['empty title', finding({ title: '' })],
    ['invalid line', finding({ line: 0 })],
    ['extra field', finding({ unexpected: true })],
  ])('rejects %s', (_name, candidate) => {
    expect(() => recordFinding(createReviewState(), candidate)).toThrow()
  })

  test('does not allow findings to change after finalization', () => {
    const state = finalizeReview(createReviewState(), {
      summary: 'Clean review.',
      analysis_complete: true,
    })

    expect(() => recordFinding(state, finding())).toThrow(/finalized/i)
  })

  test('treats an incomplete analysis as fail-closed', () => {
    const state = finalizeReview(createReviewState(), {
      summary: 'The turn budget ended before coverage completed.',
      analysis_complete: false,
    })

    expect(reviewStateStatus(state)).toBe('incomplete')
    expect(() => buildFindingsPayload(state)).toThrow(/incomplete/i)
  })

  test('requires finalization before emitting an empty clean result', () => {
    const state = createReviewState()

    expect(reviewStateStatus(state)).toBe('needs_finalization')
    expect(() => buildFindingsPayload(state)).toThrow(/not finalized/i)
  })

  test('allows identical finalization retries but rejects conflicting ones', () => {
    const input = { summary: 'Clean review.', analysis_complete: true }
    const state = finalizeReview(createReviewState(), input)

    expect(finalizeReview(state, input)).toEqual(state)
    expect(() =>
      finalizeReview(state, { ...input, summary: 'Different summary.' }),
    ).toThrow(/already finalized/i)
  })

  test('round-trips state through an owner-only atomic file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ladon-state-test-'))
    const statePath = join(directory, 'state.json')
    const state = recordFinding(createReviewState(), finding())

    writeReviewState(statePath, state)

    expect(readReviewState(statePath)).toEqual(state)
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(state)
  })
})

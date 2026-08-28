import { describe, expect, test } from 'vitest'
import {
  containsMarker,
  type PriorDecision,
  parseDecisionMarker,
  wrapWithMarker,
} from './markers.js'

describe('wrapWithMarker', () => {
  test('appends an HTML comment marker', () => {
    const body = wrapWithMarker({
      body: 'Ladon does not review bot PRs.',
      marker: 'ladon/bot-skip-noted',
    })
    expect(body).toContain('Ladon does not review bot PRs.')
    expect(body).toContain('<!-- ladon-marker:ladon/bot-skip-noted -->')
  })
})

describe('containsMarker', () => {
  test('finds marker in a wrapped body', () => {
    const body = wrapWithMarker({ body: 'x', marker: 'ladon/test' })
    expect(containsMarker(body, 'ladon/test')).toBe(true)
  })
  test('returns false when marker absent', () => {
    expect(containsMarker('just a comment', 'ladon/test')).toBe(false)
  })
})

describe('parseDecisionMarker', () => {
  test('extracts JSON from the marker in a body', () => {
    const body =
      'Approve.\n\n<!-- ladon-decision:\n{"head":"abc","outcome":"escalate","high_risk":true,"reasons":["x"]}\n-->'
    const expected: PriorDecision = {
      head: 'abc',
      outcome: 'escalate',
      high_risk: true,
      reasons: ['x'],
    }
    expect(parseDecisionMarker(body)).toEqual(expected)
  })

  test('returns null when no marker present', () => {
    expect(parseDecisionMarker('plain body')).toBeNull()
  })

  test('returns null on malformed JSON inside marker', () => {
    expect(
      parseDecisionMarker('<!-- ladon-decision:\nnot-json\n-->'),
    ).toBeNull()
  })
})

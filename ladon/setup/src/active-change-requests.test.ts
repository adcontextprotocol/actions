import { describe, expect, test } from 'vitest'
import { selectActiveChangeRequests } from './active-change-requests.js'

describe('selectActiveChangeRequests', () => {
  test('returns only active requests from the configured bot', () => {
    expect(
      selectActiveChangeRequests(
        [
          {
            id: 1,
            state: 'CHANGES_REQUESTED',
            user: { login: 'ladon[bot]' },
            body: 'legacy review with an empty findings marker',
          },
          {
            id: 2,
            state: 'DISMISSED',
            user: { login: 'ladon[bot]' },
            body: 'old',
          },
          {
            id: 3,
            state: 'CHANGES_REQUESTED',
            user: { login: 'human' },
            body: 'human request',
          },
        ],
        'ladon[bot]',
      ),
    ).toEqual([{ id: 1, body: 'legacy review with an empty findings marker' }])
  })

  test('keeps every active request so none remain silently blocking', () => {
    const reviews = Array.from({ length: 25 }, (_, index) => ({
      id: index + 1,
      state: 'CHANGES_REQUESTED',
      user: { login: 'ladon[bot]' },
      body: `review ${index + 1}`,
    }))

    const selected = selectActiveChangeRequests(reviews, 'ladon[bot]')

    expect(selected).toHaveLength(25)
    expect(selected[0]?.id).toBe(1)
    expect(selected.at(-1)?.id).toBe(25)
  })
})

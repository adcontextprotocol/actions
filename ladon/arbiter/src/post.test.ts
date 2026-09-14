import { describe, expect, test, vi } from 'vitest'
import {
  dismissSupersededChangeRequests,
  ensureLabel,
  fetchReviewDecision,
  hasHumanApproval,
  mapOutcomeToReviewEvent,
  postReview,
} from './post.js'

describe('mapOutcomeToReviewEvent', () => {
  test('approve → APPROVE', () => {
    expect(mapOutcomeToReviewEvent('approve')).toBe('APPROVE')
  })
  test('request-changes → REQUEST_CHANGES', () => {
    expect(mapOutcomeToReviewEvent('request-changes')).toBe('REQUEST_CHANGES')
  })
  test('comment → COMMENT', () => {
    expect(mapOutcomeToReviewEvent('comment')).toBe('COMMENT')
  })
  test('escalate → COMMENT (escalation handled separately)', () => {
    expect(mapOutcomeToReviewEvent('escalate')).toBe('COMMENT')
  })
})

describe('ensureLabel', () => {
  test('creates label when not present (404 then create)', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('404'), { status: 404 }))
    const create = vi.fn().mockResolvedValueOnce({ data: {} })
    const octokit = {
      rest: { issues: { getLabel: get, createLabel: create } },
    } as never
    await ensureLabel({
      octokit,
      owner: 'o',
      repo: 'r',
      name: 'ladon/needs-human-review',
    })
    expect(create).toHaveBeenCalled()
  })
  test('no-op when label exists', async () => {
    const get = vi.fn().mockResolvedValueOnce({ data: { name: 'ladon/x' } })
    const create = vi.fn()
    const octokit = {
      rest: { issues: { getLabel: get, createLabel: create } },
    } as never
    await ensureLabel({ octokit, owner: 'o', repo: 'r', name: 'ladon/x' })
    expect(create).not.toHaveBeenCalled()
  })
})

describe('postReview', () => {
  test('falls back to COMMENT on 422 (cannot approve own PR)', async () => {
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('422'), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 9 } })
    const octokit = { rest: { pulls: { createReview } } } as never
    await postReview({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 1,
      headSha: 'h',
      event: 'APPROVE',
      body: 'x',
    })
    expect(createReview).toHaveBeenCalledTimes(2)
    expect(createReview.mock.calls[1][0].event).toBe('COMMENT')
  })
})

describe('dismissSupersededChangeRequests', () => {
  test('dismisses only rechecked prior requests from the Ladon bot', async () => {
    const listReviews = vi.fn()
    const dismissReview = vi.fn().mockResolvedValue({ data: {} })
    const reviews = [
      {
        id: 1,
        state: 'CHANGES_REQUESTED',
        user: { login: 'ladon[bot]' },
        commit_id: 'old',
        body: '<!-- ladon-decision:\n{"head":"old","outcome":"request-changes","high_risk":true,"reasons":[],"findings":[]}\n-->',
      },
      {
        id: 2,
        state: 'CHANGES_REQUESTED',
        user: { login: 'ladon[bot]' },
        commit_id: 'old',
      },
      {
        id: 3,
        state: 'CHANGES_REQUESTED',
        user: { login: 'human' },
        commit_id: 'old',
      },
      {
        id: 4,
        state: 'CHANGES_REQUESTED',
        user: { login: 'ladon[bot]' },
        commit_id: 'current',
      },
    ]
    const paginate = vi.fn().mockResolvedValue(reviews)
    const get = vi
      .fn()
      .mockResolvedValue({ data: { head: { sha: 'current' } } })
    const octokit = {
      paginate,
      rest: { pulls: { listReviews, dismissReview, get } },
    } as never

    const result = await dismissSupersededChangeRequests({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      ladonBotLogin: 'ladon[bot]',
      expectedHeadSha: 'current',
      recheckedReviewIds: [1, 3, 4],
    })

    expect(paginate).toHaveBeenCalledWith(listReviews, {
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      per_page: 100,
    })
    expect(dismissReview).toHaveBeenCalledOnce()
    expect(dismissReview).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      pull_number: 7,
      review_id: 1,
      message:
        'Superseded by a later Ladon review that rechecked and resolved its blocking findings.',
    })
    expect(result).toEqual({
      dismissed: 1,
      headChanged: false,
      warning: null,
    })
  })

  test('does not dismiss when a newer PR head made the run stale', async () => {
    const listReviews = vi.fn()
    const dismissReview = vi.fn()
    const paginate = vi.fn().mockResolvedValue([
      {
        id: 1,
        state: 'CHANGES_REQUESTED',
        user: { login: 'ladon[bot]' },
        commit_id: 'old',
      },
    ])
    const get = vi.fn().mockResolvedValue({ data: { head: { sha: 'newer' } } })
    const octokit = {
      paginate,
      rest: { pulls: { listReviews, dismissReview, get } },
    } as never

    const result = await dismissSupersededChangeRequests({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      ladonBotLogin: 'ladon[bot]',
      expectedHeadSha: 'current',
      recheckedReviewIds: [1],
    })

    expect(result.headChanged).toBe(true)
    expect(dismissReview).not.toHaveBeenCalled()
  })

  test('turns a dismissal permission failure into an actionable warning', async () => {
    const listReviews = vi.fn()
    const paginate = vi.fn().mockResolvedValue([
      {
        id: 1,
        state: 'CHANGES_REQUESTED',
        user: { login: 'ladon[bot]' },
        commit_id: 'old',
      },
    ])
    const get = vi
      .fn()
      .mockResolvedValue({ data: { head: { sha: 'current' } } })
    const dismissReview = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }))
    const octokit = {
      paginate,
      rest: { pulls: { listReviews, dismissReview, get } },
    } as never

    const result = await dismissSupersededChangeRequests({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      ladonBotLogin: 'ladon[bot]',
      expectedHeadSha: 'current',
      recheckedReviewIds: [1],
    })

    expect(result.dismissed).toBe(0)
    expect(result.warning).toContain('allowed to dismiss reviews')
  })

  test('treats a concurrently dismissed review as an idempotent success', async () => {
    const listReviews = vi.fn()
    const paginate = vi.fn().mockResolvedValue([
      {
        id: 1,
        state: 'CHANGES_REQUESTED',
        user: { login: 'ladon[bot]' },
        commit_id: 'old',
      },
    ])
    const get = vi
      .fn()
      .mockResolvedValue({ data: { head: { sha: 'current' } } })
    const dismissReview = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('already dismissed'), { status: 422 }),
      )
    const getReview = vi
      .fn()
      .mockResolvedValue({ data: { state: 'DISMISSED' } })
    const octokit = {
      paginate,
      rest: { pulls: { listReviews, dismissReview, getReview, get } },
    } as never

    const result = await dismissSupersededChangeRequests({
      octokit,
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      ladonBotLogin: 'ladon[bot]',
      expectedHeadSha: 'current',
      recheckedReviewIds: [1],
    })

    expect(result.warning).toBeNull()
    expect(getReview).toHaveBeenCalledOnce()
  })
})

describe('fetchReviewDecision', () => {
  test('reads the refreshed aggregate decision', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: { pullRequest: { reviewDecision: 'APPROVED' } },
    })
    const octokit = { graphql } as never

    await expect(
      fetchReviewDecision({ octokit, owner: 'o', repo: 'r', prNumber: 7 }),
    ).resolves.toBe('APPROVED')
  })
})

describe('hasHumanApproval', () => {
  test('does not count Ladon or another bot as the gated-path approval', async () => {
    const listReviews = vi.fn()
    const paginate = vi.fn().mockResolvedValue([
      {
        state: 'APPROVED',
        user: { login: 'ladon[bot]', type: 'Bot' },
      },
      {
        state: 'APPROVED',
        user: { login: 'other[bot]', type: 'Bot' },
      },
    ])
    const octokit = { paginate, rest: { pulls: { listReviews } } } as never

    await expect(
      hasHumanApproval({
        octokit,
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        ladonBotLogin: 'ladon[bot]',
      }),
    ).resolves.toBe(false)
  })

  test('accepts an active approval from a human reviewer', async () => {
    const listReviews = vi.fn()
    const paginate = vi.fn().mockResolvedValue([
      { state: 'DISMISSED', user: { login: 'old-human', type: 'User' } },
      { state: 'APPROVED', user: { login: 'alice', type: 'User' } },
    ])
    const octokit = { paginate, rest: { pulls: { listReviews } } } as never

    await expect(
      hasHumanApproval({
        octokit,
        owner: 'o',
        repo: 'r',
        prNumber: 7,
        ladonBotLogin: 'ladon[bot]',
      }),
    ).resolves.toBe(true)
  })
})

describe('no-approval posting boundary', () => {
  test.each(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as const)(
    '%s never sends APPROVE when autoApprove is false',
    async (event) => {
      // Record each call as it happens: an APPROVE followed by cleanup is unsafe.
      const events: string[] = []
      const createReview = vi.fn(async (request) => {
        events.push(request.event)
        expect(request.event).not.toBe('APPROVE')
        return { data: { id: 1 } }
      })
      await postReview({
        octokit: { rest: { pulls: { createReview } } } as never,
        owner: 'o',
        repo: 'r',
        prNumber: 1,
        headSha: 'exact-head',
        event,
        body: 'Ladon findings',
        autoApprove: false,
      })
      expect(events).toEqual([event === 'APPROVE' ? 'COMMENT' : event])
      expect(createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          commit_id: 'exact-head',
          body: 'Ladon findings',
        }),
      )
    },
  )
})

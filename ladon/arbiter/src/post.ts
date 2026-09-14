import * as core from '@actions/core'
import type * as github from '@actions/github'
import type { Outcome } from './anthropic.js'

type Octokit = ReturnType<typeof github.getOctokit>

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export function mapOutcomeToReviewEvent(outcome: Outcome): ReviewEvent {
  switch (outcome) {
    case 'approve':
      return 'APPROVE'
    case 'request-changes':
      return 'REQUEST_CHANGES'
    case 'comment':
      return 'COMMENT'
    case 'escalate':
      return 'COMMENT'
  }
}

export async function ensureLabel(params: {
  octokit: Octokit
  owner: string
  repo: string
  name: string
}): Promise<void> {
  const { octokit, owner, repo, name } = params
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name })
  } catch (err) {
    const status =
      err instanceof Error && 'status' in err
        ? (err as { status: number }).status
        : undefined
    if (status === 404) {
      await octokit.rest.issues.createLabel({
        owner,
        repo,
        name,
        color: 'fbca04',
        description: 'Ladon has escalated this PR for human review.',
      })
    } else {
      throw err
    }
  }
}

export async function addLabel(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  label: string
}): Promise<void> {
  await params.octokit.rest.issues.addLabels({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    labels: [params.label],
  })
}

export async function postReview(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  headSha: string
  event: ReviewEvent
  autoApprove?: boolean
  body: string
}): Promise<void> {
  const { octokit, owner, repo, prNumber, headSha, body } = params
  // Last boundary before the API: never approve and then dismiss. Auto-merge
  // can act on the first write, before a cleanup or a failing check completes.
  const event =
    params.autoApprove !== true && params.event === 'APPROVE'
      ? 'COMMENT'
      : params.event
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event,
      body,
    })
  } catch (err) {
    const status =
      err instanceof Error && 'status' in err
        ? (err as { status: number }).status
        : undefined
    if (event === 'APPROVE' && status === 422) {
      core.warning('Approve rejected (likely own PR); falling back to COMMENT')
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        event: 'COMMENT',
        body,
      })
    } else {
      throw err
    }
  }
}

export async function dismissSupersededChangeRequests(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  ladonBotLogin: string
  expectedHeadSha: string
  recheckedReviewIds: number[]
}): Promise<{
  dismissed: number
  headChanged: boolean
  warning: string | null
}> {
  const {
    octokit,
    owner,
    repo,
    prNumber,
    ladonBotLogin,
    expectedHeadSha,
    recheckedReviewIds,
  } = params
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })
  const rechecked = new Set(recheckedReviewIds)
  const superseded = reviews.filter(
    (review) =>
      review.state === 'CHANGES_REQUESTED' &&
      review.user?.login === ladonBotLogin &&
      Boolean(review.commit_id) &&
      review.commit_id !== expectedHeadSha &&
      rechecked.has(review.id),
  )

  if (superseded.length === 0) {
    return {
      dismissed: 0,
      headChanged: false,
      warning: null,
    }
  }

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  })
  if (pullRequest.head.sha !== expectedHeadSha) {
    return {
      dismissed: 0,
      headChanged: true,
      warning: null,
    }
  }

  let dismissed = 0
  let warning: string | null = null
  for (const review of superseded) {
    try {
      await octokit.rest.pulls.dismissReview({
        owner,
        repo,
        pull_number: prNumber,
        review_id: review.id,
        message:
          'Superseded by a later Ladon review that rechecked and resolved its blocking findings.',
      })
      dismissed += 1
    } catch (err) {
      const status =
        err instanceof Error && 'status' in err
          ? (err as { status: number }).status
          : undefined
      if (status === 422) {
        try {
          const { data: current } = await octokit.rest.pulls.getReview({
            owner,
            repo,
            pull_number: prNumber,
            review_id: review.id,
          })
          if (current.state === 'DISMISSED') continue
        } catch {
          // Fall through to the actionable warning from the original error.
        }
      }
      warning =
        'Ladon could not dismiss its superseded change-request review automatically. A repository administrator or an actor allowed to dismiss reviews must dismiss it; configure the Ladon GitHub App as an allowed dismissal actor for future runs.'
      core.warning(
        `${warning} GitHub API error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return {
    dismissed,
    headChanged: false,
    warning,
  }
}

export async function fetchReviewDecision(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
}): Promise<string | null> {
  try {
    const result = await params.octokit.graphql<{
      repository: {
        pullRequest: { reviewDecision: string | null } | null
      } | null
    }>(
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewDecision
          }
        }
      }`,
      { owner: params.owner, repo: params.repo, number: params.prNumber },
    )
    return result.repository?.pullRequest?.reviewDecision ?? ''
  } catch (err) {
    core.warning(
      `Could not refresh reviewDecision after dismissing a superseded review: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

export async function hasHumanApproval(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  ladonBotLogin: string
}): Promise<boolean> {
  const reviews = await params.octokit.paginate(
    params.octokit.rest.pulls.listReviews,
    {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      per_page: 100,
    },
  )
  return reviews.some(
    (review) =>
      review.state === 'APPROVED' &&
      review.user?.login !== params.ladonBotLogin &&
      review.user?.type !== 'Bot',
  )
}

export async function requestReviewers(params: {
  octokit: Octokit
  owner: string
  repo: string
  prNumber: number
  reviewers: string[]
}): Promise<void> {
  const { octokit, owner, repo, prNumber, reviewers } = params
  const users = reviewers.filter((r) => !r.includes('/'))
  const teamSlugs = reviewers
    .filter((r) => r.includes('/'))
    .map((r) => r.split('/').pop()!)
  if (users.length === 0 && teamSlugs.length === 0) return
  try {
    await octokit.request(
      'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
      {
        owner,
        repo,
        pull_number: prNumber,
        ...(users.length > 0 ? { reviewers: users } : {}),
        ...(teamSlugs.length > 0 ? { team_reviewers: teamSlugs } : {}),
      },
    )
  } catch (err) {
    core.warning(
      `Failed to request reviewers (${reviewers.join(', ')}): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

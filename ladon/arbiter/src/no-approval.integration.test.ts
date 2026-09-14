import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import type { ArbiterDecision } from './anthropic.js'
import type { Finding } from './findings.js'

const fixture = vi.hoisted(() => {
  const inputs: Record<string, string> = {}
  const defaults: Record<string, string> = {}
  const core = {
    getInput: vi.fn((name: string) => inputs[name] ?? defaults[name] ?? ''),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }
  const createReview = vi.fn()
  const dismissReview = vi.fn()
  const octokit = {
    paginate: vi.fn(),
    graphql: vi.fn(),
    request: vi.fn(),
    rest: {
      pulls: {
        createReview,
        dismissReview,
        listReviews: vi.fn(),
        get: vi.fn(),
      },
      issues: { getLabel: vi.fn(), addLabels: vi.fn() },
      teams: { getMembershipForUserInOrg: vi.fn() },
    },
  }
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: {
      pull_request: { user: { login: 'author' }, base: { ref: 'main' } },
    },
  }
  return { defaults, inputs, core, octokit, context, decide: vi.fn() }
})

vi.mock('@actions/core', () => fixture.core)
vi.mock('@actions/github', () => ({
  context: fixture.context,
  getOctokit: () => fixture.octokit,
}))
vi.mock('./anthropic.js', () => ({ decideViaAnthropic: fixture.decide }))
vi.mock('./diff-stats.js', () => ({
  computeDiffStatsFromFile: async () => ({
    fileCount: 1,
    additions: 1,
    deletions: 0,
    files: ['src/auth.ts'],
  }),
}))

const clean: ArbiterDecision = {
  outcome: 'approve',
  summary: 'Clean review.',
  blocking_findings: [],
  escalation_reasons: [],
}
const finding = (
  severity: Finding['severity'],
  category: Finding['category'] = 'security',
): Finding => ({
  severity,
  category,
  title: 'Authorization bypass',
  rationale: 'Missing access check',
  file: 'src/auth.ts',
  line: 12,
  posted_inline: true,
})

async function run() {
  await import('./index.js')
  await vi.waitFor(() => {
    expect(
      fixture.core.setFailed.mock.calls.length +
        fixture.core.setOutput.mock.calls.length,
    ).toBeGreaterThan(0)
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  // Model the runner's manifest-default injection for an omitted input.
  fixture.defaults['auto-approve'] = parse(
    readFileSync(new URL('../action.yml', import.meta.url), 'utf8'),
  ).inputs['auto-approve'].default
  for (const key of Object.keys(fixture.inputs)) delete fixture.inputs[key]
  Object.assign(fixture.inputs, {
    'auto-approve': 'false',
    'anthropic-api-key': 'test',
    'github-token': 'test',
    'findings-json': JSON.stringify({
      summary: 'Complete review',
      findings: [],
    }),
    'pr-number': '2911',
    'head-sha': 'exact-head',
    'base-sha': 'base',
    'diff-full-path': 'unused',
    'ladon-bot-login': 'aao-secretariat[bot]',
  })
  fixture.context.payload.pull_request.user.login = 'author'
  fixture.decide.mockResolvedValue(clean)
  fixture.octokit.paginate.mockResolvedValue([])
  fixture.octokit.rest.pulls.get.mockResolvedValue({
    data: { head: { sha: 'exact-head' } },
  })
  fixture.octokit.rest.pulls.createReview.mockImplementation(
    async (request) => {
      // Observe the first API write, before status completion or any cleanup.
      if (fixture.inputs['auto-approve'] === 'false')
        expect(request.event).not.toBe('APPROVE')
      return { data: { id: 1 } }
    },
  )
  fixture.octokit.rest.issues.getLabel.mockResolvedValue({ data: {} })
  fixture.octokit.rest.issues.addLabels.mockResolvedValue({ data: {} })
})

describe('arbiter API and action result integration', () => {
  test('compatible true mode still approves a clean review', async () => {
    fixture.inputs['auto-approve'] = 'true'
    await run()
    expect(fixture.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE', commit_id: 'exact-head' }),
    )
    expect(fixture.core.setFailed).not.toHaveBeenCalled()
  })

  test.each(['author', 'aao-secretariat[bot]', 'other[bot]'])(
    'clean no-approval review for %s is COMMENT, even for its own PR',
    async (author) => {
      fixture.context.payload.pull_request.user.login = author
      await run()
      expect(
        fixture.octokit.rest.pulls.createReview,
      ).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          event: 'COMMENT',
          commit_id: 'exact-head',
          body: expect.stringContaining('auto-approve=false'),
        }),
      )
      const body = fixture.octokit.rest.pulls.createReview.mock.calls[0][0].body
      expect(body).toContain('Ladon verdict: Comment')
      expect(body).toContain('"outcome":"comment"')
      expect(fixture.core.setOutput).toHaveBeenCalledWith('outcome', 'comment')
      expect(fixture.core.setFailed).not.toHaveBeenCalled()
      expect(fixture.octokit.rest.pulls.dismissReview).not.toHaveBeenCalled()
    },
  )

  test.each(['critical', 'high'] as const)(
    'a %s finding requests changes and fails even when the model approves',
    async (severity) => {
      fixture.inputs['findings-json'] = JSON.stringify({
        summary: 'Blocking finding',
        findings: [finding(severity)],
      })
      await run()
      expect(fixture.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'REQUEST_CHANGES',
          body: expect.stringContaining(
            'src/auth.ts:12 — Authorization bypass',
          ),
        }),
      )
      expect(fixture.core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('request-changes'),
      )
    },
  )

  test('nonblocking medium findings remain in the attributable COMMENT', async () => {
    fixture.inputs['findings-json'] = JSON.stringify({
      summary: 'One finding',
      findings: [finding('medium')],
    })
    await run()
    expect(fixture.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'COMMENT',
        body: expect.stringContaining('src/auth.ts:12 — Authorization bypass'),
      }),
    )
    expect(fixture.core.setFailed).not.toHaveBeenCalled()
  })

  test.each([
    { 'high-risk': 'true', 'high-risk-reasons': '["src/auth.ts (deleted)"]' },
    { 'gated-paths': 'true', 'review-decision': 'REVIEW_REQUIRED' },
    { 'gated-paths': 'true', 'review-decision': 'APPROVED' },
    { 'gated-paths': 'true', 'review-decision': '' },
  ])(
    'policy escalation fails and cannot become a clean comment: %j',
    async (inputs) => {
      Object.assign(fixture.inputs, inputs)
      // Even an aggregate APPROVED from Ladon/other bots is not human sign-off.
      fixture.octokit.paginate.mockResolvedValue([
        { state: 'APPROVED', user: { login: 'other[bot]', type: 'Bot' } },
      ])
      fixture.decide.mockResolvedValue({ ...clean, outcome: 'comment' })
      await run()
      expect(fixture.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'COMMENT',
          body: expect.stringContaining('Escalate to human review'),
        }),
      )
      expect(fixture.core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining('escalate'),
      )
      expect(fixture.octokit.rest.issues.addLabels).toHaveBeenCalled()
    },
  )

  test.each(['data-loss', 'schema', 'infra'] as const)(
    'sensitive medium %s findings still escalate',
    async (category) => {
      fixture.inputs['findings-json'] = JSON.stringify({
        summary: 'Finding',
        findings: [finding('medium', category)],
      })
      await run()
      expect(fixture.core.setOutput).toHaveBeenCalledWith('outcome', 'escalate')
      expect(fixture.core.setFailed).toHaveBeenCalled()
    },
  )

  test('a prior dismissed approval cannot restore approval in the arbiter', async () => {
    fixture.inputs['prior-decision'] = JSON.stringify({
      head: 'old-head',
      outcome: 'approve',
      high_risk: false,
      reasons: [],
      findings: [],
    })
    await run()
    expect(
      fixture.octokit.rest.pulls.createReview,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: 'COMMENT' }),
    )
  })

  test('the author team gate still yields COMMENT', async () => {
    fixture.inputs['no-auto-approve-teams'] = 'o/security'
    fixture.octokit.rest.teams.getMembershipForUserInOrg.mockResolvedValue({
      data: { state: 'active' },
    })
    await run()
    expect(fixture.octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'COMMENT',
        body: expect.stringContaining('o/security'),
      }),
    )
  })

  test.each([
    '',
    'False',
    '0',
    'disabled',
    '${{ inputs.auto-approve }}',
    ' false',
    'null',
  ])(
    'invalid auto-approve=%j fails before any review API call',
    async (input) => {
      fixture.inputs['auto-approve'] = input
      await run()
      expect(fixture.core.setFailed).toHaveBeenCalled()
      expect(fixture.decide).not.toHaveBeenCalled()
      expect(fixture.octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    },
  )

  test('review API failure fails the check with no retry to APPROVE', async () => {
    fixture.octokit.rest.pulls.createReview.mockRejectedValue(
      Object.assign(new Error('rejected'), { status: 422 }),
    )
    await run()
    expect(fixture.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1)
    expect(fixture.octokit.rest.pulls.createReview.mock.calls[0][0].event).toBe(
      'COMMENT',
    )
    expect(fixture.core.setFailed).toHaveBeenCalledWith('rejected')
  })
})

test('omitted input resolves the manifest default to false with zero approvals', async () => {
  delete fixture.inputs['auto-approve']
  expect(fixture.defaults['auto-approve']).toBe('false')
  await run()
  expect(
    fixture.octokit.rest.pulls.createReview,
  ).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ event: 'COMMENT' }),
  )
  expect(fixture.core.setFailed).not.toHaveBeenCalled()
})

test('missing raw input without runner defaults fails before any approval or reapproval', async () => {
  delete fixture.inputs['auto-approve']
  delete fixture.defaults['auto-approve']
  await run()
  expect(fixture.core.setFailed).toHaveBeenCalled()
  expect(fixture.octokit.rest.pulls.createReview).not.toHaveBeenCalled()
})

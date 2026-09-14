import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'

const fixture = vi.hoisted(() => {
  const inputs: Record<string, string> = {}
  const defaults: Record<string, string> = {}
  const outputs: Record<string, string> = {}
  const core = {
    getInput: vi.fn((name: string, options?: { trimWhitespace?: boolean }) => {
      const raw = inputs[name] ?? defaults[name] ?? ''
      return options?.trimWhitespace === false ? raw : raw.trim()
    }),
    setOutput: vi.fn((name: string, value: string) => {
      outputs[name] = value
    }),
    setFailed: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }
  const octokit = {
    paginate: vi.fn(),
    graphql: vi.fn(),
    request: vi.fn(),
    rest: {
      pulls: {
        listFiles: vi.fn(),
        listReviews: vi.fn(),
        get: vi.fn(),
        createReview: vi.fn(),
      },
      repos: { compareCommitsWithBasehead: vi.fn() },
      issues: { listComments: vi.fn(), createComment: vi.fn() },
      git: { getCommit: vi.fn() },
    },
  }
  const context = {
    repo: { owner: 'o', repo: 'r' },
    eventName: 'pull_request_target',
    actor: 'author',
    payload: {
      action: 'synchronize',
      pull_request: {
        number: 2911,
        head: { sha: 'exact-head', ref: 'fix' },
        base: { sha: 'base', ref: 'main' },
        draft: false,
        state: 'open',
        user: { login: 'author' },
        labels: [],
      },
    },
  }
  return { defaults, inputs, outputs, core, octokit, context }
})
vi.mock('@actions/core', () => fixture.core)
vi.mock('@actions/github', () => ({
  context: fixture.context,
  getOctokit: () => fixture.octokit,
}))

const directory = mkdtempSync(join(tmpdir(), 'ladon-policy-test-'))
writeFileSync(
  join(directory, 'LADON.md'),
  '## High-Risk Paths\n- src/**\n\n## Gated Paths\n- src/**\n',
)
afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function run() {
  await import('./index.js')
  await vi.waitFor(() => {
    expect(
      fixture.core.setFailed.mock.calls.length > 0 ||
        fixture.outputs['skip-reason'] !== undefined,
    ).toBe(true)
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  // Model the runner's manifest-default injection for an omitted input.
  fixture.defaults['auto-approve'] = parse(
    readFileSync(new URL('../action.yml', import.meta.url), 'utf8'),
  ).inputs['auto-approve'].default
  vi.stubEnv('GITHUB_WORKSPACE', directory)
  for (const object of [fixture.inputs, fixture.outputs]) {
    for (const key of Object.keys(object)) delete object[key]
  }
  Object.assign(fixture.inputs, {
    'auto-approve': 'false',
    'github-token': 'test',
    'ladon-bot-login': 'aao-secretariat[bot]',
  })
  fixture.context.payload.action = 'synchronize'
  fixture.context.payload.pull_request.user.login = 'author'
  fixture.context.actor = 'author'
  fixture.octokit.rest.pulls.get.mockResolvedValue({
    data: { mergeable: true },
  })
  fixture.octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
    data: { files: [], commits: [], total_commits: 0 },
  })
  fixture.octokit.graphql.mockResolvedValue({
    repository: { pullRequest: { reviewDecision: 'REVIEW_REQUIRED' } },
  })
  fixture.octokit.request.mockResolvedValue({
    data: 'diff --git a/src/auth.ts b/src/auth.ts\n',
  })
  fixture.octokit.paginate.mockImplementation(async (method) => {
    if (method === fixture.octokit.rest.pulls.listFiles)
      return [{ filename: 'src/auth.ts', status: 'modified' }]
    if (method === fixture.octokit.rest.pulls.listReviews)
      return [
        {
          id: 1,
          user: { login: 'aao-secretariat[bot]' },
          state: 'DISMISSED',
          commit_id: 'old-head',
          body: '<!-- ladon-decision:\n{"head":"old-head","outcome":"approve","high_risk":false,"reasons":[],"findings":[]}\n-->',
        },
      ]
    return []
  })
})

describe('setup stale-approval integration', () => {
  test('compatible true mode still signals reapproval after stale dismissal', async () => {
    fixture.inputs['auto-approve'] = 'true'
    await run()
    expect(fixture.outputs).toMatchObject({
      reapprove: 'true',
      'should-run': 'false',
      'skip-reason': 'pure-rebase',
      'head-sha': 'exact-head',
    })
  })

  test.each(['pure-rebase', 'empty-delta', 'trivial-only', 'tree-rebase'])(
    '%s cannot renew a dismissed approval or skip policy in disabled mode',
    async (scenario) => {
      if (scenario === 'empty-delta')
        fixture.octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue(
          { data: { files: [{ filename: 'unrelated.ts' }] } },
        )
      if (scenario === 'trivial-only') {
        fixture.octokit.paginate.mockResolvedValueOnce([
          { filename: 'src/auth.ts', status: 'modified' },
          { filename: 'README.md', status: 'modified' },
        ])
        fixture.octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue(
          { data: { files: [{ filename: 'README.md' }] } },
        )
      }
      if (scenario === 'tree-rebase') {
        fixture.octokit.rest.repos.compareCommitsWithBasehead.mockRejectedValue(
          new Error('unreachable'),
        )
        fixture.octokit.rest.git.getCommit.mockResolvedValue({
          data: { tree: { sha: 'same-tree' } },
        })
      }
      await run()
      expect(fixture.outputs).toMatchObject({
        'should-run': 'true',
        'high-risk': 'true',
        'gated-paths': 'true',
        'head-sha': 'exact-head',
      })
      expect(fixture.outputs.reapprove).toBeUndefined()
      expect(fixture.outputs['diff-delta-path']).toBe(
        fixture.outputs['diff-full-path'],
      )
      expect(fixture.octokit.rest.pulls.createReview).not.toHaveBeenCalled()
      expect(fixture.core.setFailed).not.toHaveBeenCalled()
    },
  )

  test('an unrelated nontrivial push still reviews the full PR in disabled mode', async () => {
    fixture.octokit.paginate.mockResolvedValueOnce([
      { filename: 'src/auth.ts', status: 'modified' },
      { filename: 'src/other.ts', status: 'modified' },
    ])
    fixture.octokit.rest.repos.compareCommitsWithBasehead.mockResolvedValue({
      data: { files: [{ filename: 'src/other.ts' }] },
    })
    await run()
    expect(fixture.outputs['should-run']).toBe('true')
    expect(
      fixture.octokit.rest.repos.compareCommitsWithBasehead,
    ).not.toHaveBeenCalled()
    expect(fixture.outputs['diff-delta-path']).toBe(
      fixture.outputs['diff-full-path'],
    )
  })

  test('normal opened review runs with approval disabled', async () => {
    fixture.context.payload.action = 'opened'
    await run()
    expect(fixture.outputs['should-run']).toBe('true')
    expect(fixture.outputs.reapprove).toBeUndefined()
  })

  test('bot author skips without reapproval', async () => {
    fixture.context.payload.pull_request.user.login = 'dependabot[bot]'
    await run()
    expect(fixture.outputs).toMatchObject({
      'should-run': 'false',
      'skip-reason': 'bot-author',
    })
    expect(fixture.outputs.reapprove).toBeUndefined()
    expect(fixture.octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  test('self-trigger skips without reapproval', async () => {
    fixture.context.actor = 'aao-secretariat[bot]'
    await run()
    expect(fixture.outputs['skip-reason']).toBe('self-triggered')
    expect(fixture.outputs.reapprove).toBeUndefined()
  })

  test.each([
    '',
    'FALSE',
    'off',
    '${{ inputs.auto-approve }}',
    ' false',
    ' true',
    'true ',
    '\ttrue\n',
    'null',
  ])('invalid input %j fails closed', async (input) => {
    fixture.inputs['auto-approve'] = input
    await run()
    expect(fixture.core.setFailed).toHaveBeenCalled()
    expect(fixture.outputs.reapprove).toBeUndefined()
    expect(fixture.octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })
})

test('omitted input resolves the manifest default to false with zero approvals', async () => {
  delete fixture.inputs['auto-approve']
  expect(fixture.defaults['auto-approve']).toBe('false')
  await run()
  expect(fixture.outputs['should-run']).toBe('true')
  expect(fixture.outputs.reapprove).toBeUndefined()
  expect(fixture.octokit.rest.pulls.createReview).not.toHaveBeenCalled()
})

test('missing raw input without runner defaults fails before any approval or reapproval', async () => {
  delete fixture.inputs['auto-approve']
  delete fixture.defaults['auto-approve']
  await run()
  expect(fixture.core.setFailed).toHaveBeenCalled()
  expect(fixture.octokit.rest.pulls.createReview).not.toHaveBeenCalled()
})

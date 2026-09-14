import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

interface ActionStep {
  'continue-on-error'?: boolean
  if?: string
  name?: string
  with?: Record<string, string>
}

describe('Ladon orchestrator manifest', () => {
  const manifest = parse(
    readFileSync(
      resolve(import.meta.dirname, '../../ladon/review/action.yml'),
      'utf8',
    ),
  ) as { runs: { steps: ActionStep[] } }

  test('does not run the arbiter after reviewer infrastructure failure', () => {
    const reviewer = manifest.runs.steps.find(
      (step) => step.name === 'Reviewer',
    )
    const arbiter = manifest.runs.steps.find((step) => step.name === 'Arbiter')

    expect(reviewer?.['continue-on-error']).not.toBe(true)
    expect(arbiter?.if).not.toContain('always()')
    expect(arbiter?.if).toBe("steps.setup.outputs.should-run == 'true'")
  })

  test('passes the App login and active change requests through the flow', () => {
    const reviewer = manifest.runs.steps.find(
      (step) => step.name === 'Reviewer',
    )
    const arbiter = manifest.runs.steps.find((step) => step.name === 'Arbiter')

    expect(arbiter?.with?.['ladon-bot-login']).toBe(
      '${{ steps.app-token.outputs.app-slug }}[bot]',
    )
    expect(reviewer?.with?.['active-change-requests-path']).toBe(
      '${{ steps.setup.outputs.active-change-requests-path }}',
    )
    expect(arbiter?.with?.['active-change-requests-path']).toBe(
      '${{ steps.setup.outputs.active-change-requests-path }}',
    )
  })
})

// Execute the production shell, including its inner guard, with a fake gh.
// This catches an APPROVE that a later cleanup or failed check cannot undo.
describe('orchestrator approval boundary', () => {
  const manifest = parse(
    readFileSync(
      resolve(import.meta.dirname, '../../ladon/review/action.yml'),
      'utf8',
    ),
  )
  const setup = manifest.runs.steps.find((s: ActionStep) => s.name === 'Setup')
  const arbiter = manifest.runs.steps.find(
    (s: ActionStep) => s.name === 'Arbiter',
  )
  const reapprove = manifest.runs.steps.find(
    (s: ActionStep) => s.name === 'Re-approve dismissed stale approval',
  )
  const validate = manifest.runs.steps.find(
    (s: ActionStep) => s.name === 'Validate inputs',
  )

  test('defaults compatibly and forwards the control to both actions', () => {
    expect(manifest.inputs['auto-approve'].default).toBe('true')
    for (const step of [setup, arbiter]) {
      expect(step.with['auto-approve']).toBe(`${'$'}{{ inputs.auto-approve }}`)
    }
    expect(reapprove.if).toBe(
      "inputs.auto-approve == 'true' && steps.setup.outputs.reapprove == 'true'",
    )
  })

  test.each(['false', '', 'False', 'off'])(
    'auto-approve=%j prevents every stale reapproval API call even if the step runs',
    (value) => {
      const result = spawnSync(
        'bash',
        ['-c', `gh() { echo 'API CALLED'; }; ${reapprove.run}`],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            AUTO_APPROVE: value,
            REPO: 'o/r',
            PR_NUMBER: '2911',
            HEAD_SHA: 'exact-head',
          },
        },
      )
      expect(result.status).toBe(1)
      expect(result.stdout).not.toContain('API CALLED')
    },
  )

  test('true mode retains exact-head stale reapproval', () => {
    const result = spawnSync(
      'bash',
      ['-c', `gh() { printf '%s\\n' "$@"; }; ${reapprove.run}`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AUTO_APPROVE: 'true',
          REPO: 'o/r',
          PR_NUMBER: '2911',
          HEAD_SHA: 'exact-head',
        },
      },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('event=APPROVE')
    expect(result.stdout).toContain('commit_id=exact-head')
  })

  test.each(['false', 'true', '', 'False', 'disabled'])(
    'validates auto-approve=%j before minting a write token',
    (value) => {
      const result = spawnSync('bash', ['-c', validate.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AUTO_APPROVE: value,
          CLIENT_ID: '123',
          APP_ID: '',
        },
      })
      expect(result.status).toBe(['false', 'true'].includes(value) ? 0 : 1)
      expect(manifest.runs.steps[0]).toBe(validate)
    },
  )

  test('reviewer tool grants cannot submit approving reviews', () => {
    const reviewer = parse(
      readFileSync(
        resolve(import.meta.dirname, '../../ladon/reviewer/action.yml'),
        'utf8',
      ),
    )
    const modelSteps = reviewer.runs.steps.filter((s: { uses?: string }) =>
      s.uses?.startsWith('anthropics/claude-code-action@'),
    )
    expect(modelSteps).toHaveLength(2)
    const grants = modelSteps.map(
      (s: { with: { claude_args: string } }) => s.with.claude_args,
    )
    expect(grants[0]).toContain('Bash(gh pr view:*)')
    expect(grants.join('\n')).not.toMatch(/Bash\(gh (?:api|pr review)/)
    expect(grants.join('\n')).not.toContain('create_review')
    expect(grants[1]).toContain(
      '--allowedTools "mcp__ladon_findings__finalize_review"',
    )
  })
})

describe('audited Ladon dependency pins', () => {
  const root = resolve(import.meta.dirname, '../..')
  const manifest = parse(
    readFileSync(resolve(root, 'ladon/review/action.yml'), 'utf8'),
  )

  test.each(['Setup', 'Reviewer', 'Arbiter'])(
    '%s is immutable and matches the local tested runtime',
    (name) => {
      const step = manifest.runs.steps.find((s: ActionStep) => s.name === name)
      const match =
        /^adcontextprotocol\/actions\/(ladon\/[a-z]+)@([a-f0-9]{40})$/.exec(
          step.uses,
        )
      expect(match).not.toBeNull()
      if (!match)
        throw new Error(
          'Ladon dependencies must be pinned before posting any review',
        )
      const [, path, sha] = match
      const files = execFileSync(
        'git',
        ['ls-tree', '-r', '--name-only', sha, '--', path],
        { cwd: root, encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .filter(
          (file) => !file.includes('.test.') && !file.endsWith('.gitkeep'),
        )
      expect(files).toContain(`${path}/action.yml`)
      for (const file of files) {
        expect(
          readFileSync(resolve(root, file), 'utf8'),
          `${name}: ${file} differs from its pin; commit and repin the audited runtime`,
        ).toBe(
          execFileSync('git', ['show', `${sha}:${file}`], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
          }),
        )
      }
    },
  )
})

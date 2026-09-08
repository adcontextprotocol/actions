import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

interface ActionStep {
  'continue-on-error'?: boolean
  env?: Record<string, string>
  if?: string
  name?: string
  run?: string
  with?: Record<string, string>
}

describe('Ladon reviewer manifest', () => {
  const githubExpression = (expression: string) => `${'$'}{{ ${expression} }}`
  const manifest = parse(
    readFileSync(
      resolve(import.meta.dirname, '../../ladon/reviewer/action.yml'),
      'utf8',
    ),
  ) as { runs: { steps: ActionStep[] } }

  test('persists findings through narrow MCP tools and retries finalization once', () => {
    const assemblePrompt = manifest.runs.steps.find(
      (step) => step.name === 'Assemble prompt',
    )
    const claudeReview = manifest.runs.steps.find(
      (step) => step.name === 'Claude Code review',
    )
    const inspectState = manifest.runs.steps.find(
      (step) => step.name === 'Inspect persisted review',
    )
    const retrySteps = manifest.runs.steps.filter(
      (step) => step.name === 'Finalization retry',
    )
    const emitFindings = manifest.runs.steps.find(
      (step) => step.name === 'Emit findings JSON',
    )

    expect(assemblePrompt?.run).toContain('mcp__ladon_findings__record_finding')
    expect(assemblePrompt?.run).toContain(
      'mcp__ladon_findings__finalize_review',
    )
    expect(assemblePrompt?.env?.ACTIVE_CHANGE_REQUESTS_PATH).toBe(
      '${{ inputs.active-change-requests-path }}',
    )
    expect(assemblePrompt?.env?.ACTIVE_CHANGE_REQUESTS).toBeUndefined()
    expect(assemblePrompt?.run).toContain(
      'ACTIVE_CHANGE_REQUESTS="$(< "${ACTIVE_CHANGE_REQUESTS_PATH}")"',
    )
    expect(assemblePrompt?.run).toContain(
      'Active Ladon change requests that must be resolved',
    )
    expect(assemblePrompt?.run).toContain(
      'Re-evaluate every listed blocking finding against the current full PR',
    )
    expect(assemblePrompt?.run).not.toContain('structured output')
    expect(claudeReview?.['continue-on-error']).toBe(true)
    expect(claudeReview?.with?.claude_args).toContain('--mcp-config')
    expect(claudeReview?.with?.claude_args).not.toContain('--json-schema')
    expect(claudeReview?.with?.claude_args).toContain(
      'mcp__ladon_findings__record_finding',
    )
    expect(claudeReview?.with?.claude_args).toContain(
      'mcp__ladon_findings__finalize_review',
    )
    expect(inspectState?.if).toBe(githubExpression('always()'))
    expect(retrySteps).toHaveLength(1)
    expect(retrySteps[0]?.if).toContain(
      "steps.inspect.outputs.needs-finalization == 'true'",
    )
    expect(retrySteps[0]?.with?.claude_args).toContain('--resume')
    expect(retrySteps[0]?.with?.claude_args).toContain('--max-turns 4')
    expect(retrySteps[0]?.with?.claude_args).toContain(
      'mcp__ladon_findings__finalize_review',
    )
    expect(retrySteps[0]?.with?.claude_args).not.toContain(
      'mcp__ladon_findings__record_finding',
    )
    expect(emitFindings?.if).toBe(githubExpression('always()'))
    expect(emitFindings?.run).toContain('Reviewer infrastructure failure')
    expect(emitFindings?.run).toContain('exit 1')
    expect(emitFindings?.run).toContain('Ladon reviewer completed')
    expect(emitFindings?.run).toContain('Initial permission denials')
    expect(emitFindings?.run).not.toContain(
      githubExpression('steps.claude.outputs.structured_output'),
    )
  })

  test('contains syntactically valid bash steps after expression interpolation', () => {
    for (const step of manifest.runs.steps) {
      if (!step.run) continue
      const script = step.run.replace(/\$\{\{[^}]+\}\}/g, 'github_expression')
      const result = spawnSync('bash', ['-n'], {
        input: script,
        encoding: 'utf8',
      })

      expect(result.stderr, step.name).toBe('')
      expect(result.status, step.name).toBe(0)
    }
  })
})

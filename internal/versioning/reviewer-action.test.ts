import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

interface ActionStep {
  if?: string
  name?: string
  run?: string
  with?: Record<string, string>
}

describe('Ladon reviewer manifest', () => {
  const githubExpression = (expression: string) => `${'$'}{{ ${expression} }}`
  const shellVariable = (name: string) => `${'$'}{${name}}`
  const manifest = parse(
    readFileSync(
      resolve(import.meta.dirname, '../../ladon/reviewer/action.yml'),
      'utf8',
    ),
  ) as { runs: { steps: ActionStep[] } }

  test('keeps generated findings in the writable workspace', () => {
    const assemblePrompt = manifest.runs.steps.find(
      (step) => step.name === 'Assemble prompt',
    )
    const claudeReview = manifest.runs.steps.find(
      (step) => step.name === 'Claude Code review',
    )
    const readFindings = manifest.runs.steps.find(
      (step) => step.name === 'Read findings JSON',
    )

    expect(assemblePrompt?.run).toContain(
      `FINDINGS_PATH="\${GITHUB_WORKSPACE}/.ladon-findings-\$(openssl rand -hex 16).json"`,
    )
    expect(assemblePrompt?.run).toMatch(
      /write the findings JSON to `%s`.*"\$\{FINDINGS_PATH\}"/,
    )
    expect(assemblePrompt?.run).toContain(
      `echo "findings-path=${shellVariable('FINDINGS_PATH')}"`,
    )
    expect(claudeReview?.with?.claude_args).toContain(
      `--add-dir ${'$'}{{ runner.temp }}`,
    )
    expect(claudeReview?.with?.prompt).toBe(
      githubExpression('steps.prompt.outputs.prompt'),
    )
    expect(readFindings?.run).toContain(
      `trap 'rm -f -- "\${FINDINGS_PATH}"' EXIT`,
    )
    expect(readFindings?.run).toContain(
      `FINDINGS_PATH="${githubExpression('steps.prompt.outputs.findings-path')}"`,
    )
    expect(readFindings?.if).toBe(
      `\${{ always() && steps.prompt.outputs.findings-path != '' }}`,
    )
  })
})

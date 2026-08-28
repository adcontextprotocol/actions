import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

interface ActionStep {
  env?: Record<string, string>
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

  test('uses native schema-validated structured output for findings', () => {
    const assemblePrompt = manifest.runs.steps.find(
      (step) => step.name === 'Assemble prompt',
    )
    const claudeReview = manifest.runs.steps.find(
      (step) => step.name === 'Claude Code review',
    )
    const readFindings = manifest.runs.steps.find(
      (step) => step.name === 'Read findings JSON',
    )

    expect(assemblePrompt?.run).not.toContain('FINDINGS_PATH')
    expect(assemblePrompt?.run).toContain(
      `JSON_SCHEMA="\$(jq -c . "${githubExpression('github.action_path')}/findings-schema.json")"`,
    )
    expect(assemblePrompt?.run).toContain(
      `echo "json-schema=${shellVariable('JSON_SCHEMA')}"`,
    )
    expect(assemblePrompt?.run).toContain(
      'Return your review through the schema-validated structured output',
    )
    expect(claudeReview?.with?.claude_args).toContain(
      `--add-dir ${'$'}{{ runner.temp }}`,
    )
    expect(claudeReview?.with?.prompt).toBe(
      githubExpression('steps.prompt.outputs.prompt'),
    )
    expect(claudeReview?.with?.claude_args).toContain(
      `--json-schema '${githubExpression('steps.prompt.outputs.json-schema')}'`,
    )
    expect(claudeReview?.with?.claude_args).not.toMatch(
      /--allowedTools .*\bWrite\b/,
    )
    expect(readFindings?.env?.FINDINGS_JSON).toBe(
      githubExpression('steps.claude.outputs.structured_output'),
    )
    expect(readFindings?.run).toContain(
      'Claude Code did not return structured findings',
    )
    expect(readFindings?.run).not.toContain('FINDINGS_PATH')
    expect(readFindings?.if).toBe(githubExpression('always()'))
  })
})

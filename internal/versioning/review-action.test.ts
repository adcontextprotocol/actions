import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

interface ActionStep {
  'continue-on-error'?: boolean
  if?: string
  name?: string
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
})

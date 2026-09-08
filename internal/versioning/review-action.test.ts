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

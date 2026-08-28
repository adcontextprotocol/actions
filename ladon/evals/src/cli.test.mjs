import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { runCli } from './cli.mjs'

const fixture = {
  schema_version: 1,
  id: 'clean-review',
  description: 'A clean review that must explicitly finalize.',
  source: { repository: 'example/repository', pr_number: 2 },
  expected: {
    required_findings: [],
    forbidden_outcomes: [],
    require_completion: true,
  },
}

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'ladon-eval-cli-'))
  const fixturePath = join(directory, 'fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture))
  return { directory, fixturePath }
}

describe('eval CLI', () => {
  test('grades recorded traces without invoking a model', () => {
    const { directory, fixturePath } = workspace()
    const tracePath = join(directory, 'trace.json')
    const outputPath = join(directory, 'report.json')
    writeFileSync(
      tracePath,
      JSON.stringify({
        schema_version: 1,
        fixture_id: fixture.id,
        provider: 'recorded',
        model: 'model-a',
        attempts: [
          {
            kind: 'review',
            tool_calls: [
              {
                name: 'finalize_review',
                arguments: {
                  summary: 'No actionable findings.',
                  analysis_complete: true,
                },
              },
            ],
          },
        ],
        outcome: 'approve',
      }),
    )

    runCli([
      'grade',
      '--fixture',
      fixturePath,
      '--traces',
      tracePath,
      '--out',
      outputPath,
    ])

    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toMatchObject({
      reports: [{ passed: true }],
      summary: [{ model: 'model-a', completion_rate: 1 }],
    })
  })

  test('runs the same fixture repeatedly across exact model IDs', () => {
    const { directory, fixturePath } = workspace()
    const adapterPath = join(directory, 'adapter.mjs')
    const outputPath = join(directory, 'comparison.json')
    writeFileSync(
      adapterPath,
      `let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  process.stdout.write(JSON.stringify({
    schema_version: 1,
    fixture_id: request.fixture.id,
    provider: request.provider,
    model: request.model,
    attempts: [{
      kind: 'review',
      tool_calls: [{
        name: 'finalize_review',
        arguments: { summary: 'Complete.', analysis_complete: true }
      }]
    }],
    outcome: 'approve'
  }))
})
`,
    )

    runCli([
      'run',
      '--fixture',
      fixturePath,
      '--adapter',
      `${process.execPath} ${adapterPath}`,
      '--provider',
      'provider',
      '--models',
      'model-a,model-b',
      '--repetitions',
      '2',
      '--out',
      outputPath,
    ])

    const report = JSON.parse(readFileSync(outputPath, 'utf8'))
    expect(report.reports).toHaveLength(4)
    expect(report.summary).toEqual([
      expect.objectContaining({ model: 'model-a', trials: 2, pass_rate: 1 }),
      expect.objectContaining({ model: 'model-b', trials: 2, pass_rate: 1 }),
    ])
  })
})

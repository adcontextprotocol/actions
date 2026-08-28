import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  test('grades recorded traces without invoking a model', async () => {
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

    await runCli([
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

  test('runs the same fixture repeatedly across exact model IDs', async () => {
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

    await runCli([
      'run',
      '--fixtures',
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
    expect(report).toMatchObject({ status: 'complete', completed: 4, total: 4 })
    expect(report.reports).toHaveLength(4)
    expect(report.summary).toEqual([
      expect.objectContaining({ model: 'model-a', trials: 2, pass_rate: 1 }),
      expect.objectContaining({ model: 'model-b', trials: 2, pass_rate: 1 }),
    ])
  })

  test('runs model trials with bounded concurrency', async () => {
    const { directory, fixturePath } = workspace()
    const markerDirectory = join(directory, 'markers')
    const adapterPath = join(directory, 'parallel-adapter.mjs')
    const outputPath = join(directory, 'comparison.json')
    mkdirSync(markerDirectory)
    writeFileSync(
      adapterPath,
      `import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  const markerDirectory = ${JSON.stringify(markerDirectory)}
  writeFileSync(join(markerDirectory, String(request.trial)), '')
  const deadline = Date.now() + 1000
  while (readdirSync(markerDirectory).length < 2 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  if (readdirSync(markerDirectory).length < 2) process.exit(2)
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

    const output = await runCli([
      'run',
      '--fixture',
      fixturePath,
      '--adapter',
      `${process.execPath} ${adapterPath}`,
      '--provider',
      'provider',
      '--models',
      'model-a',
      '--repetitions',
      '2',
      '--concurrency',
      '2',
      '--out',
      outputPath,
    ])

    expect(output.reports).toHaveLength(2)
    expect(output.reports.every((report) => report.passed)).toBe(true)
    expect(output.reports.map((report) => report.trial)).toEqual([1, 2])
  })

  test('captures one adapter failure without aborting the batch', async () => {
    const { directory, fixturePath } = workspace()
    const adapterPath = join(directory, 'fallible-adapter.mjs')
    const outputPath = join(directory, 'comparison.json')
    writeFileSync(
      adapterPath,
      `let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  if (request.model === 'bad-model') {
    process.stderr.write('provider unavailable')
    process.exit(2)
  }
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

    const output = await runCli([
      'run',
      '--fixture',
      fixturePath,
      '--adapter',
      `${process.execPath} ${adapterPath}`,
      '--provider',
      'provider',
      '--models',
      'good-model,bad-model',
      '--concurrency',
      '2',
      '--out',
      outputPath,
    ])

    expect(output.reports).toHaveLength(2)
    expect(output.reports[0]).toMatchObject({
      model: 'good-model',
      passed: true,
      checks: { adapter_execution: true },
    })
    expect(output.reports[1]).toMatchObject({
      model: 'bad-model',
      passed: false,
      checks: { adapter_execution: false, fail_closed: true },
      metrics: { runner_errors: 1, false_approvals: 0 },
      runner_error: { subtype: 'adapter_process_error' },
    })
    expect(output.summary[1]).toMatchObject({
      model: 'bad-model',
      runner_error_rate: 1,
      completion_rate: 0,
    })
  })

  test('rejects a trace attributed to the wrong model', async () => {
    const { directory, fixturePath } = workspace()
    const adapterPath = join(directory, 'misattributed-adapter.mjs')
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
    model: 'different-model',
    attempts: [{ kind: 'review', tool_calls: [] }]
  }))
})
`,
    )

    const output = await runCli([
      'run',
      '--fixture',
      fixturePath,
      '--adapter',
      `${process.execPath} ${adapterPath}`,
      '--provider',
      'provider',
      '--models',
      'requested-model',
      '--out',
      outputPath,
    ])

    expect(output.reports[0]).toMatchObject({
      model: 'requested-model',
      passed: false,
      checks: { adapter_execution: false, fail_closed: true },
      runner_error: { subtype: 'adapter_identity_mismatch' },
    })
  })

  test('turns an adapter timeout into a fail-closed report', async () => {
    const { directory, fixturePath } = workspace()
    const adapterPath = join(directory, 'timeout-adapter.mjs')
    const outputPath = join(directory, 'comparison.json')
    writeFileSync(
      adapterPath,
      `process.stdin.resume()
setInterval(() => {}, 1000)
`,
    )

    const output = await runCli([
      'run',
      '--fixture',
      fixturePath,
      '--adapter',
      `${process.execPath} ${adapterPath}`,
      '--provider',
      'provider',
      '--models',
      'slow-model',
      '--timeout-ms',
      '50',
      '--out',
      outputPath,
    ])

    expect(output.reports[0]).toMatchObject({
      passed: false,
      checks: { adapter_execution: false, fail_closed: true },
      runner_error: { subtype: 'adapter_timeout' },
    })
  })

  test('merges parallel provider reports into one comparison', async () => {
    const { directory } = workspace()
    const firstPath = join(directory, 'first.json')
    const secondPath = join(directory, 'second.json')
    const outputPath = join(directory, 'merged.json')
    const report = (provider, model) => ({
      provider,
      model,
      passed: true,
      checks: { fail_closed: true },
      metrics: {
        completion: 1,
        false_approvals: 0,
        required_finding_recall: 1,
        unexpected_findings: 0,
        tool_errors: 0,
        retries: 0,
        runner_errors: 0,
      },
    })
    writeFileSync(
      firstPath,
      JSON.stringify({ reports: [report('provider-a', 'model-a')] }),
    )
    writeFileSync(
      secondPath,
      JSON.stringify({ reports: [report('provider-b', 'model-b')] }),
    )

    const output = await runCli([
      'merge',
      '--reports',
      `${firstPath},${secondPath}`,
      '--out',
      outputPath,
    ])

    expect(output).toMatchObject({ status: 'complete', completed: 2, total: 2 })
    expect(output.summary).toEqual([
      expect.objectContaining({ provider: 'provider-a', model: 'model-a' }),
      expect.objectContaining({ provider: 'provider-b', model: 'model-b' }),
    ])
  })
})

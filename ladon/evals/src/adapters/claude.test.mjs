import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { gradeReplay } from '../replay.mjs'
import { runClaudeAdapter } from './claude.mjs'

function fixture() {
  return JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../fixtures/tool-contract-unbounded-retry.json',
      ),
      'utf8',
    ),
  )
}

function fakeClaude() {
  const directory = mkdtempSync(join(tmpdir(), 'ladon-fake-claude-'))
  const path = join(directory, 'claude')
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (process.env.GITHUB_TOKEN) {
  process.stderr.write('GitHub token leaked into eval adapter')
  process.exit(10)
}
const configPath = args[args.indexOf('--mcp-config') + 1]
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const server = config.mcpServers.ladon_findings
const retry = args.includes('--resume')
if (retry && args[args.indexOf('--max-turns') + 1] !== '4') {
  process.stderr.write('Finalization retry must allow four turns')
  process.exit(11)
}
const finding = {
  severity: 'medium',
  title: 'Retry loop is unbounded',
  rationale: 'The new loop has no terminating condition or attempt limit.',
  file: 'src/retry.ts',
  line: 3,
  category: 'operability',
  posted_inline: false
}
const toolCall = retry
  ? {
      name: 'finalize_review',
      arguments: {
        summary: 'Found one unbounded retry loop.',
        analysis_complete: true
      }
    }
  : { name: 'record_finding', arguments: finding }
const messages = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26' }
  },
  {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: toolCall
  }
]
const result = spawnSync(server.command, server.args, {
  input: messages.map((message) => JSON.stringify(message)).join('\\n') + '\\n',
  encoding: 'utf8',
  env: { ...process.env, ...server.env }
})
if (result.status !== 0) {
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}
process.stdout.write(JSON.stringify({
  subtype: 'success',
  session_id: 'test-session',
  num_turns: 1,
  duration_ms: 25,
  total_cost_usd: 0.01,
  permission_denials: []
}))
`,
    { mode: 0o755 },
  )
  chmodSync(path, 0o755)
  return path
}

function failingClaude() {
  const directory = mkdtempSync(join(tmpdir(), 'ladon-failing-claude-'))
  const path = join(directory, 'claude')
  writeFileSync(
    path,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  is_error: true,
  subtype: 'success',
  terminal_reason: 'api_error',
  result: 'Not logged in',
  session_id: 'failed-session'
}))
process.exitCode = 1
`,
    { mode: 0o755 },
  )
  chmodSync(path, 0o755)
  return path
}

describe('Claude live eval adapter', () => {
  test('captures MCP calls and performs one finalization-only retry', async () => {
    const inputFixture = fixture()
    const previousToken = process.env.GITHUB_TOKEN
    process.env.GITHUB_TOKEN = 'must-not-reach-claude'
    let trace
    try {
      trace = await runClaudeAdapter(
        {
          fixture: inputFixture,
          provider: 'anthropic',
          model: 'claude-test-model',
          trial: 1,
        },
        { binary: fakeClaude(), timeoutMs: 5000 },
      )
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previousToken
    }

    expect(trace).toMatchObject({
      fixture_id: inputFixture.id,
      provider: 'anthropic',
      model: 'claude-test-model',
      trial: 1,
      adapter: 'claude-cli-v1-unpinned',
      outcome: 'comment',
      attempts: [
        {
          kind: 'review',
          tool_calls: [{ name: 'record_finding' }],
        },
        {
          kind: 'finalization',
          tool_calls: [{ name: 'finalize_review' }],
        },
      ],
    })
    expect(trace.bundle_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(gradeReplay(inputFixture, trace)).toMatchObject({
      passed: true,
      checks: {
        fail_closed: true,
        completion: true,
        required_findings: true,
      },
      metrics: { retries: 1, false_approvals: 0 },
    })
  })

  test('requires an immutable input bundle', async () => {
    const inputFixture = fixture()
    delete inputFixture.input

    await expect(
      runClaudeAdapter(
        {
          fixture: inputFixture,
          provider: 'anthropic',
          model: 'claude-test-model',
          trial: 1,
        },
        { binary: fakeClaude(), timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/immutable fixture input bundle/)
  })

  test('retains provider failures instead of labeling them successful', async () => {
    const trace = await runClaudeAdapter(
      {
        fixture: fixture(),
        provider: 'anthropic',
        model: 'claude-test-model',
        trial: 1,
      },
      { binary: failingClaude(), timeoutMs: 5000 },
    )

    expect(trace.attempts).toHaveLength(2)
    expect(trace.attempts[0].result).toMatchObject({
      subtype: 'api_error',
      diagnostic: 'Not logged in',
      exit_code: 1,
    })
    expect(gradeReplay(fixture(), trace)).toMatchObject({
      passed: false,
      metrics: { infrastructure_failures: 1 },
      replay: {
        infrastructure_failure: true,
        effective_outcome: 'infrastructure-failure',
      },
    })
  })
})

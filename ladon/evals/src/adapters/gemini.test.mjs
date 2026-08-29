import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { gradeReplay } from '../replay.mjs'
import { runGeminiAdapter } from './gemini.mjs'

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

function fakeGemini() {
  const directory = mkdtempSync(join(tmpdir(), 'ladon-fake-gemini-'))
  const path = join(directory, 'gemini')
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
if (process.env.GITHUB_TOKEN || process.env.SECRETARIAT_APP_PRIVATE_KEY) {
  process.stderr.write('privileged token leaked into eval adapter')
  process.exit(10)
}
const settings = JSON.parse(
  readFileSync(join(process.env.HOME, '.gemini', 'settings.json'), 'utf8')
)
const server = settings.mcpServers['ladon-findings']
const retry = args.includes('--resume')
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
  response: 'done',
  session_id: 'test-session',
  stats: {
    models: {
      'gemini-test-model': {
        api: { totalRequests: 1, totalLatencyMs: 25 }
      }
    },
    tools: { totalDecisions: { reject: 0 } }
  }
}))
`,
    { mode: 0o755 },
  )
  chmodSync(path, 0o755)
  return path
}

describe('Gemini live eval adapter', () => {
  test('isolates configuration, captures MCP calls, and retries once', async () => {
    const inputFixture = fixture()
    const previousGitHubToken = process.env.GITHUB_TOKEN
    const previousSecretariatKey = process.env.SECRETARIAT_APP_PRIVATE_KEY
    process.env.GITHUB_TOKEN = 'must-not-reach-gemini'
    process.env.SECRETARIAT_APP_PRIVATE_KEY = 'must-not-reach-gemini'
    let trace
    try {
      trace = await runGeminiAdapter(
        {
          fixture: inputFixture,
          provider: 'google',
          model: 'gemini-test-model',
          trial: 1,
        },
        { binary: fakeGemini(), timeoutMs: 5000 },
      )
    } finally {
      if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previousGitHubToken
      if (previousSecretariatKey === undefined)
        delete process.env.SECRETARIAT_APP_PRIVATE_KEY
      else process.env.SECRETARIAT_APP_PRIVATE_KEY = previousSecretariatKey
    }

    expect(trace).toMatchObject({
      fixture_id: inputFixture.id,
      provider: 'google',
      model: 'gemini-test-model',
      trial: 1,
      adapter: 'gemini-cli-v1-unpinned',
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
      metrics: {
        retries: 1,
        false_approvals: 0,
        infrastructure_failures: 0,
        turns: 2,
      },
    })
  })

  test('requires an immutable input bundle', async () => {
    const inputFixture = fixture()
    delete inputFixture.input

    await expect(
      runGeminiAdapter(
        {
          fixture: inputFixture,
          provider: 'google',
          model: 'gemini-test-model',
          trial: 1,
        },
        { binary: fakeGemini(), timeoutMs: 5000 },
      ),
    ).rejects.toThrow(/immutable fixture input bundle/)
  })
})

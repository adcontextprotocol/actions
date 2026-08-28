import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createMcpHandler } from './server.mjs'
import {
  createReviewState,
  readReviewState,
  writeReviewState,
} from './state.mjs'

const finding = {
  severity: 'medium',
  title: 'Retry is unbounded',
  rationale: 'The retry loop has no terminating condition.',
  file: 'src/retry.ts',
  line: 18,
  category: 'operability',
  posted_inline: false,
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'ladon-mcp-test-'))
  const statePath = join(directory, 'state.json')
  writeReviewState(statePath, createReviewState())
  return { statePath, handle: createMcpHandler(statePath) }
}

describe('findings MCP server', () => {
  test('speaks newline-delimited MCP JSON over stdio', async () => {
    const { statePath } = harness()
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, 'server.mjs')],
      {
        env: { ...process.env, LADON_REVIEW_STATE_PATH: statePath },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`,
    )
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    )
    child.stdin.end()

    const exitCode = await new Promise((resolve) => child.on('close', resolve))
    const messages = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(exitCode).toBe(0)
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'ladon-findings' } },
    })
    expect(messages[1].result.tools.map((tool) => tool.name)).toEqual([
      'record_finding',
      'finalize_review',
    ])
  })

  test('advertises only the two narrow persistence tools', async () => {
    const { handle } = harness()
    const response = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })

    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      'record_finding',
      'finalize_review',
    ])
  })

  test('persists findings through a tool call', async () => {
    const { statePath, handle } = harness()
    const response = await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'record_finding', arguments: finding },
    })

    expect(response.result.isError).toBe(false)
    expect(readReviewState(statePath).findings).toEqual([finding])
  })

  test('returns a tool error without mutating state for invalid input', async () => {
    const { statePath, handle } = harness()
    const response = await handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'record_finding',
        arguments: { ...finding, severity: 'urgent' },
      },
    })

    expect(response.result.isError).toBe(true)
    expect(readReviewState(statePath).findings).toEqual([])
  })

  test('finalizes a clean review only through the explicit tool', async () => {
    const { statePath, handle } = harness()
    const response = await handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'finalize_review',
        arguments: {
          summary: 'No actionable findings.',
          analysis_complete: true,
        },
      },
    })

    expect(response.result.isError).toBe(false)
    expect(readReviewState(statePath).finalization).toEqual({
      summary: 'No actionable findings.',
      analysis_complete: true,
    })
  })
})

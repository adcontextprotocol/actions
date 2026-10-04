import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const CLAUDE_CODE_ACTION_V1_0_217 =
  'anthropics/claude-code-action@9c5ddab2e6d17b83ea679153b31f1d5f023cf636'

describe('Ladon reviewer action manifest', () => {
  const manifest = readFileSync(
    resolve(import.meta.dirname, '../action.yml'),
    'utf8',
  )

  test('allows the pull request author to trigger reviews from a fork', () => {
    const authorExpression = `${'$'}{{ github.event.pull_request.user.login }}`
    const allowedUserLines = manifest
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('allowed_non_write_users:'))

    expect(allowedUserLines).toEqual([
      `allowed_non_write_users: ${authorExpression}`,
      `allowed_non_write_users: ${authorExpression}`,
    ])
    expect(manifest).not.toContain('allowed_non_write_users: fgranata')
  })

  test('uses a verified immutable Claude Code installer for every execution', () => {
    const claudeSteps = manifest
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('uses: anthropics/claude-code-action@'))
      .map((line) => line.split(' #')[0])

    expect(claudeSteps).toEqual([
      `uses: ${CLAUDE_CODE_ACTION_V1_0_217}`,
      `uses: ${CLAUDE_CODE_ACTION_V1_0_217}`,
    ])
    expect(manifest).not.toContain('/home/runner/.local/bin/claude')
  })

  test('passes the findings server as inline JSON on the review and retry', () => {
    // claude-code-action prepends its built-in servers as inline JSON. Its
    // config merger discards file paths when any inline servers are present.
    const outputLine = manifest
      .split('\n')
      .find((line) => line.trim().startsWith('echo "mcp-config-json='))
    expect(outputLine).toBeDefined()

    const directory = mkdtempSync(resolve(tmpdir(), 'ladon-mcp-config-'))
    try {
      const configPath = resolve(directory, 'findings.json')
      const config = {
        mcpServers: {
          ladon_findings: {
            command: '/usr/bin/node',
            args: ['/action/src/server.mjs'],
            env: { LADON_REVIEW_STATE_PATH: '/tmp/review-state.json' },
          },
        },
      }
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      const output = execFileSync('bash', ['-c', outputLine.trim()], {
        env: { ...process.env, MCP_CONFIG_PATH: configPath },
        encoding: 'utf8',
      }).trim()
      const inline = output.slice('mcp-config-json='.length)
      expect(JSON.parse(inline)).toEqual(config)
      expect(inline).not.toContain('\n')

      const configArguments = manifest
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('--mcp-config '))
      const expression = `${'$'}{{ steps.prompt.outputs.mcp-config-json }}`
      expect(configArguments).toEqual([
        `--mcp-config '${expression}'`,
        `--mcp-config '${expression}'`,
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

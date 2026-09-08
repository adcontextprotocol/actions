import { readFileSync } from 'node:fs'
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
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

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
})

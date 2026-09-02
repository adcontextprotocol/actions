import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('version action bundle', () => {
  test('bundles the GitHub Actions runtime dependencies', () => {
    const dist = resolve(import.meta.dirname, 'dist')
    const bundle = readFileSync(resolve(dist, 'index.js'), 'utf8')
    const packageJson = JSON.parse(
      readFileSync(resolve(dist, 'package.json'), 'utf8'),
    )

    expect(packageJson).toEqual({ type: 'module' })
    expect(bundle).not.toContain("Cannot find module '@actions/core'")
    expect(bundle).not.toContain("Cannot find module '@actions/github'")
  })
})

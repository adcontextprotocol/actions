import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  bundleDigest,
  materializeBundle,
  sha256,
  validateBundleInput,
} from './bundle.mjs'

function bundle() {
  const content = 'diff --git a/example.js b/example.js\n'
  return {
    schema_version: 1,
    id: 'immutable-case',
    source: { repository: 'example/repository', base_sha: 'a', head_sha: 'b' },
    expected: { required_findings: [] },
    input: {
      prompt_template: 'Review {{file:inputs/review.diff}} now.',
      files: [
        {
          path: 'inputs/review.diff',
          sha256: sha256(content),
          content,
        },
      ],
      outcome: 'comment',
    },
  }
}

describe('immutable eval bundles', () => {
  test('verifies content hashes and materializes prompt paths', () => {
    const fixture = bundle()
    const root = mkdtempSync(join(tmpdir(), 'ladon-bundle-'))
    const result = materializeBundle(fixture, root)

    expect(result.prompt).toBe(
      `Review ${join(root, 'inputs/review.diff')} now.`,
    )
    expect(readFileSync(join(root, 'inputs/review.diff'), 'utf8')).toBe(
      fixture.input.files[0].content,
    )
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.outcome).toBe('comment')
  })

  test('rejects modified content', () => {
    const fixture = bundle()
    fixture.input.files[0].content = 'changed'

    expect(() => validateBundleInput(fixture.input)).toThrow(/invalid sha256/)
  })

  test('rejects paths that escape the isolated workspace', () => {
    const fixture = bundle()
    fixture.input.files[0].path = '../review.diff'

    expect(() => validateBundleInput(fixture.input)).toThrow(/relative path/)
  })

  test('includes expected behavior in the bundle digest', () => {
    const fixture = bundle()
    const digest = bundleDigest(fixture)
    fixture.expected.require_completion = false

    expect(bundleDigest(fixture)).not.toBe(digest)
  })
})

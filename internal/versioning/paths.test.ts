import { describe, expect, test } from 'vitest'
import { isIgnoredDir, isVersionRelevantFile } from './paths.js'

describe('isIgnoredDir', () => {
  test('ignores exact ignored segments anywhere in the path', () => {
    expect(isIgnoredDir('internal/versioning')).toBe(true)
    expect(isIgnoredDir('node_modules')).toBe(true)
    expect(isIgnoredDir('ladon/setup/dist')).toBe(true)
    expect(isIgnoredDir('.github/workflows')).toBe(true)
  })

  test('does not ignore dirs that merely contain an ignored name as a substring', () => {
    expect(isIgnoredDir('internal-tools')).toBe(false)
    expect(isIgnoredDir('distribution')).toBe(false)
    expect(isIgnoredDir('ladon/setup')).toBe(false)
  })
})

describe('isVersionRelevantFile', () => {
  test('treats docs and config files as irrelevant to versioning', () => {
    expect(isVersionRelevantFile('README.md')).toBe(false)
    expect(isVersionRelevantFile('setup.sh')).toBe(false)
    expect(isVersionRelevantFile('biome.jsonc')).toBe(false)
  })

  test('treats source and manifest files as relevant', () => {
    expect(isVersionRelevantFile('index.ts')).toBe(true)
    expect(isVersionRelevantFile('action.yml')).toBe(true)
    expect(isVersionRelevantFile('version.yml')).toBe(true)
  })
})

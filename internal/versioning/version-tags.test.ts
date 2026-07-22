import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'
import { describe, expect, test } from 'vitest'
import { computeNextVersion, readDeclaredMajorVersion } from './version-tags.js'

async function tmpActionDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'version-tags-test-'))
}

describe('readDeclaredMajorVersion', () => {
  test('reads an integer version from version.yml', async () => {
    const dir = await tmpActionDir()
    await writeFile(join(dir, 'version.yml'), 'version: 1\n')
    const result = await readDeclaredMajorVersion(dir)
    expect(result.major).toBe(1)
  })

  test('reads a string version from version.yaml', async () => {
    const dir = await tmpActionDir()
    await writeFile(join(dir, 'version.yaml'), "version: '3'\n")
    const result = await readDeclaredMajorVersion(dir)
    expect(result.major).toBe(3)
  })

  test('throws when no version file exists', async () => {
    const dir = await tmpActionDir()
    await expect(readDeclaredMajorVersion(dir)).rejects.toThrow(/version\.yml/)
  })

  test('throws when the version field is missing', async () => {
    const dir = await tmpActionDir()
    await writeFile(join(dir, 'version.yml'), 'foo: bar\n')
    await expect(readDeclaredMajorVersion(dir)).rejects.toThrow(/version/)
  })

  test('throws when the version field is not a valid integer', async () => {
    const dir = await tmpActionDir()
    await writeFile(join(dir, 'version.yml'), 'version: abc\n')
    await expect(readDeclaredMajorVersion(dir)).rejects.toThrow(/invalid/)
  })
})

describe('computeNextVersion', () => {
  test('first tag uses the declared major, not a hardcoded 1.0.0', () => {
    const declaredMajor = semver.parse('2.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(computeNextVersion({ currentVersion: null, declaredMajor })).toEqual(
      { version: '2.0.0', isMajor: false },
    )
  })

  test('patch-bumps when the declared major matches the current tag', () => {
    const declaredMajor = semver.parse('1.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({ currentVersion: '1.0.0', declaredMajor }),
    ).toEqual({ version: '1.0.1', isMajor: false })
  })

  test('major-bumps when the declared major is ahead of the current tag', () => {
    const declaredMajor = semver.parse('2.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({ currentVersion: '1.0.3', declaredMajor }),
    ).toEqual({ version: '2.0.0', isMajor: true })
  })

  test('regression: a package.json-style 0.1.0->1.0.0 bump no longer forces a major (declared major is read from version.yml, not package.json)', () => {
    const declaredMajor = semver.parse('1.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({ currentVersion: '1.0.0', declaredMajor }),
    ).toEqual({ version: '1.0.1', isMajor: false })
  })
})

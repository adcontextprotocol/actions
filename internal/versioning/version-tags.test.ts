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

  test('throws when the version field is a non-integer decimal string', async () => {
    const dir = await tmpActionDir()
    await writeFile(join(dir, 'version.yml'), "version: '2.9'\n")
    await expect(readDeclaredMajorVersion(dir)).rejects.toThrow(/invalid/)
  })

  test('throws when the version field is a boolean', async () => {
    const dir = await tmpActionDir()
    await writeFile(join(dir, 'version.yml'), 'version: true\n')
    await expect(readDeclaredMajorVersion(dir)).rejects.toThrow(/invalid/)
  })
})

describe('computeNextVersion', () => {
  test('first tag ever uses the declared major and is not a major bump', () => {
    const declaredMajor = semver.parse('2.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(computeNextVersion({ existingVersions: [], declaredMajor })).toEqual(
      { version: '2.0.0', isMajor: false },
    )
  })

  test('patch-bumps the highest tag on the declared major line', () => {
    const declaredMajor = semver.parse('1.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({
        existingVersions: ['1.0.0', '1.0.3', '1.0.1'],
        declaredMajor,
      }),
    ).toEqual({ version: '1.0.4', isMajor: false })
  })

  test('cutting a new higher major line is a major bump to the declared major', () => {
    const declaredMajor = semver.parse('2.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({ existingVersions: ['1.0.3'], declaredMajor }),
    ).toEqual({ version: '2.0.0', isMajor: true })
  })

  test('new major line targets the declared major exactly, not current + 1', () => {
    const declaredMajor = semver.parse('3.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({ existingVersions: ['1.4.2'], declaredMajor }),
    ).toEqual({ version: '3.0.0', isMajor: true })
  })

  test('patch-bumps the declared major line even when a higher major line exists', () => {
    const declaredMajor = semver.parse('1.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({
        existingVersions: ['1.0.5', '2.0.0', '2.1.0'],
        declaredMajor,
      }),
    ).toEqual({ version: '1.0.6', isMajor: false })
  })

  test('refuses to cut a fresh line below an existing higher major', () => {
    const declaredMajor = semver.parse('1.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(() =>
      computeNextVersion({
        existingVersions: ['2.0.0', '2.1.0'],
        declaredMajor,
      }),
    ).toThrow(/below the highest/)
  })

  test('regression: declared major read from version.yml keeps the v1 line patching from 1.0.0', () => {
    const declaredMajor = semver.parse('1.0.0')
    if (!declaredMajor) throw new Error('bad test fixture')
    expect(
      computeNextVersion({ existingVersions: ['1.0.0'], declaredMajor }),
    ).toEqual({ version: '1.0.1', isMajor: false })
  })
})

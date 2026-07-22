import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { SemVer } from 'semver'
import semver from 'semver'
import yaml from 'yaml'

export async function readDeclaredMajorVersion(dir: string): Promise<SemVer> {
  let versionPath: string | null = null
  for (const file of ['version.yml', 'version.yaml']) {
    const candidate = path.join(dir, file)
    if (existsSync(candidate)) {
      versionPath = candidate
      break
    }
  }

  if (!versionPath) {
    throw new Error(
      `${dir} has no version.yml — declare a major version there (e.g. "version: 1") so a tag can be cut.`,
    )
  }

  const raw = await readFile(versionPath, 'utf8')
  const declared = yaml.parse(raw)?.version

  if (declared === undefined || declared === null) {
    throw new Error(`${versionPath} is missing the required 'version' field`)
  }

  const major = typeof declared === 'number' ? declared : Number(declared)

  if (!Number.isInteger(major) || major < 1) {
    throw new Error(
      `${versionPath} has an invalid 'version' value: ${declared}`,
    )
  }

  const parsed = semver.parse(`${major}.0.0`)
  if (!parsed) {
    throw new Error(
      `${versionPath} produced an unparseable version: ${major}.0.0`,
    )
  }
  return parsed
}

export function computeNextVersion(params: {
  currentVersion: string | null
  declaredMajor: SemVer
}): { version: string; isMajor: boolean } {
  const { currentVersion, declaredMajor } = params

  if (currentVersion === null) {
    return { version: `${declaredMajor.major}.0.0`, isMajor: false }
  }

  const isMajor = semver.compare(currentVersion, declaredMajor) < 0
  const version = isMajor
    ? semver.inc(currentVersion, 'major')
    : semver.inc(currentVersion, 'patch')

  if (!version) {
    throw new Error(`Failed to compute next version from ${currentVersion}`)
  }

  return { version, isMajor }
}

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

const fileToken = /\{\{file:([^}]+)}}/g

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function validateRelativePath(value, label) {
  const path = requiredString(value, label)
  const segments = path.split(/[\\/]/)
  if (
    isAbsolute(path) ||
    segments.some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error(`${label} must be a normalized relative path`)
  }
  return segments.join('/')
}

export function validateBundleInput(input) {
  assertObject(input, 'fixture input')
  const promptTemplate = requiredString(
    input.prompt_template,
    'fixture input prompt_template',
  )
  if (!Array.isArray(input.files)) {
    throw new Error('fixture input files must be an array')
  }
  const seen = new Set()
  const files = input.files.map((file, index) => {
    assertObject(file, `fixture input file ${index}`)
    const path = validateRelativePath(
      file.path,
      `fixture input file ${index} path`,
    )
    if (seen.has(path)) throw new Error(`duplicate fixture input path: ${path}`)
    seen.add(path)
    const content = requiredString(
      file.content,
      `fixture input file ${index} content`,
    )
    const digest = requiredString(
      file.sha256,
      `fixture input file ${index} sha256`,
    )
    if (!/^[a-f0-9]{64}$/.test(digest) || sha256(content) !== digest) {
      throw new Error(`fixture input file ${path} has an invalid sha256`)
    }
    return { path, sha256: digest, content }
  })
  for (const match of promptTemplate.matchAll(fileToken)) {
    if (!seen.has(match[1])) {
      throw new Error(
        `prompt references unknown fixture input file: ${match[1]}`,
      )
    }
  }
  return {
    prompt_template: promptTemplate,
    files,
    outcome: input.outcome ?? null,
  }
}

export function bundleDigest(fixture) {
  const input = validateBundleInput(fixture.input)
  return sha256(
    JSON.stringify({
      schema_version: fixture.schema_version,
      id: fixture.id,
      source: fixture.source,
      expected: fixture.expected,
      input,
    }),
  )
}

export function materializeBundle(fixture, root) {
  const input = validateBundleInput(fixture.input)
  const absoluteRoot = resolve(root)
  const paths = new Map()
  for (const file of input.files) {
    const destination = resolve(absoluteRoot, file.path)
    if (
      destination !== absoluteRoot &&
      !destination.startsWith(`${absoluteRoot}${sep}`)
    ) {
      throw new Error(`fixture input path escapes its workspace: ${file.path}`)
    }
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file.content, { encoding: 'utf8', mode: 0o600 })
    paths.set(file.path, destination)
  }
  const prompt = input.prompt_template.replaceAll(fileToken, (_, path) =>
    paths.get(path),
  )
  return {
    root: absoluteRoot,
    prompt,
    outcome: input.outcome,
    digest: bundleDigest(fixture),
  }
}

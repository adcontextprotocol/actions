// Directory segments the versioner never treats as (or descends into for)
// actions. Matched per path segment, not as substrings.
const IGNORED_DIR_SEGMENTS = new Set([
  '.git',
  '.github',
  'node_modules',
  'dist',
  '__mocks__',
  'internal',
])

// Files whose changes never warrant a new action version (docs, config).
const IGNORED_EXTENSIONS = /\.(md|jsonc|sh|gitignore|nvmrc)$/

export function isIgnoredDir(dir: string): boolean {
  return dir.split('/').some((segment) => IGNORED_DIR_SEGMENTS.has(segment))
}

export function isVersionRelevantFile(fileName: string): boolean {
  return !IGNORED_EXTENSIONS.test(fileName)
}

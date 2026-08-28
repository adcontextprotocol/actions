# Ladon Versioning Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four inherited-logic bugs in `internal/versioning/index.ts` flagged in issue #4 (inert TS-major derivation, unpaginated `compareCommits`, silent skip on missing `version.yml`, uncapped tag-mutation concurrency), extracting the logic into tested, pure functions.

**Architecture:** `internal/versioning/index.ts` stays the thin `@actions/core` entrypoint (reads inputs, calls GitHub, writes outputs). Three new sibling modules hold the previously-untested logic so it can be unit tested without mocking the whole GitHub Actions runtime: `version-tags.ts` (declared-major-version resolution + next-tag computation), `changed-files.ts` (paginated diff-file listing), `concurrency.ts` (bounded-concurrency mapping). `index.ts` imports and wires these together exactly as before, just calling the extracted functions instead of inlining the logic.

**Tech Stack:** TypeScript (Node24 GitHub Action, `@actions/core`/`@actions/github`), `semver`, `yaml`, Vitest, Biome.

## Global Constraints

- Never `git add .` / `git add -u` / `git commit -a` — stage explicit files only (per `CLAUDE.md`).
- `dist/` is a committed `ncc` bundle; rebuild it (`npm run build`, filtered to `internal/versioning`) whenever `index.ts` or its new sibling modules change, and stage the rebuilt `dist/index.js` alongside the source.
- Lint/format via Biome (single quotes, no semicolons, 2-space indent, 80 cols); this repo does not currently enforce Biome in CI, so pre-existing long prose lines (comments, error-message strings) elsewhere in the codebase are not something this plan needs to chase — only fix lines Biome's formatter can and does auto-wrap (structural code), plus keep new code reasonably concise.
- Tests are Vitest (`*.test.ts` next to source), following the existing convention in `ladon/setup/src/*.test.ts` and `ladon/arbiter/src/*.test.ts`: mock `octokit` as a plain object (`{ rest: { ... }, paginate: vi.fn() } as never`), and touch the real filesystem via `mkdtemp`/`writeFile` for functions that read files rather than mocking `fs`.
- Base all branches/commits on `origin/main` (`f7ae684` at plan-writing time) and target `main` explicitly when opening a PR — do not rely on GitHub's configured default branch, which is currently `placeholder-readme-pr` (a separate, already-flagged repo-settings issue being handled outside this plan).
- Out of scope (explicitly not part of this plan): changing the GitHub repo's default-branch setting (requires admin permissions this session doesn't have, and the user is handling it separately), and the composite-orchestrator versioned-ref switch and initial `v1` tagging (both already done in `#5` / via `manual-version-publish`).

---

## File Structure

| File | Responsibility |
|---|---|
| `internal/versioning/version-tags.ts` (new) | Read an action's declared major version from `version.yml`/`version.yaml`; compute the next tag version given the current tag and declared major. |
| `internal/versioning/version-tags.test.ts` (new) | Unit tests for the above. |
| `internal/versioning/changed-files.ts` (new) | List files changed between two commits via a fully-paginated `compareCommits` call. |
| `internal/versioning/changed-files.test.ts` (new) | Unit tests for the above. |
| `internal/versioning/concurrency.ts` (new) | Bounded-concurrency `map` over an array of async work. |
| `internal/versioning/concurrency.test.ts` (new) | Unit tests for the above. |
| `internal/versioning/index.ts` (modify) | Delete `getActionType` and the inline version-bump/compare-commits/`Promise.all` logic; call the three new modules instead. |
| `internal/versioning/package.json` (modify) | Add `"test": "vitest run"` script and `"vitest"` devDependency (matching `ladon/setup`, `ladon/arbiter`). |
| `internal/versioning/tsconfig.json` (modify) | Add new source files to `include`, exclude `**/*.test.ts`. |
| `ladon/setup/version.yml` (new) | Declares `version: 1`, matching the `ladon/setup/v1` tag that already exists. |
| `ladon/arbiter/version.yml` (new) | Declares `version: 1`, matching the `ladon/arbiter/v1` tag that already exists. |

---

### Task 1: Unify major-version derivation onto `version.yml`, fail loudly when it's missing

This is the priority fix: `getActionType` currently derives a TypeScript action's "major version" from the full `package.json` semver, but hardcodes the very first tag to `1.0.0` regardless of that value — so the declared version never actually drives tagging (issue #4, bullet 1). It also silently skips (warns only, no tag, no failure) any action missing a `version.yml` (issue #4, bullet 3). Both bugs live in the same function and are fixed by the same change: every action (composite or TypeScript) declares its major version in `version.yml`, and a missing/invalid file is a hard failure, not a skip.

**Files:**
- Create: `internal/versioning/version-tags.ts`
- Create: `internal/versioning/version-tags.test.ts`
- Create: `ladon/setup/version.yml`
- Create: `ladon/arbiter/version.yml`
- Modify: `internal/versioning/index.ts`
- Modify: `internal/versioning/package.json`
- Modify: `internal/versioning/tsconfig.json`

**Interfaces:**
- Produces: `readDeclaredMajorVersion(dir: string): Promise<SemVer>` — throws if `dir` has no `version.yml`/`version.yaml`, or its `version` field is missing/non-integer/`< 1`.
- Produces: `computeNextVersion(params: { currentVersion: string | null; declaredMajor: SemVer }): { version: string; isMajor: boolean }` — pure; no I/O.
- Consumes (in `index.ts`): existing `VersionedAction` interface, `octokit.rest.git.listMatchingRefs`, `createOrBumpRef` (all unchanged).

- [ ] **Step 1: Write the failing tests for `readDeclaredMajorVersion`**

Create `internal/versioning/version-tags.test.ts`:

```ts
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
    await expect(readDeclaredMajorVersion(dir)).rejects.toThrow(
      /version\.yml/,
    )
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
    expect(
      computeNextVersion({ currentVersion: null, declaredMajor }),
    ).toEqual({ version: '2.0.0', isMajor: false })
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
```

- [ ] **Step 2: Add test tooling to `internal/versioning/package.json`**

Modify `internal/versioning/package.json` — add a `test` script and `vitest` devDependency (matching `ladon/setup/package.json`):

```json
{
  "name": "version-actions",
  "version": "1.0.1",
  "description": "Automatically version composite and TypeScript actions on merge to main",
  "main": "dist/index.js",
  "private": true,
  "scripts": {
    "build": "../../node_modules/.bin/ncc build index.ts",
    "format": "../../node_modules/.bin/biome format --write index.ts",
    "test": "vitest run",
    "type-check": "tsc --noEmit"
  },
  "dependencies": {
    "@actions/core": "^1.11.1",
    "@actions/github": "^6.0.1",
    "semver": "^7.5.4",
    "yaml": "^2.8.3"
  },
  "devDependencies": {
    "@types/semver": "^7.7.0",
    "vitest": "^4.1.1"
  }
}
```

Also update the `format` script's glob to cover the new files, since `format` currently only formats `index.ts`:

```json
    "format": "../../node_modules/.bin/biome format --write .",
```

- [ ] **Step 3: Add the new source files to `tsconfig.json`**

Modify `internal/versioning/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../../tsconfig.base.json",
  "exclude": ["dist", "node_modules", "**/*.test.ts"],
  "include": ["index.ts", "version-tags.ts"]
}
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: lockfile updates to reflect `vitest` in `internal/versioning`'s dependency tree; no errors.

- [ ] **Step 5: Run the new tests to verify they fail**

Run: `npx vitest run internal/versioning/version-tags.test.ts`
Expected: FAIL — `Cannot find module './version-tags.js'` (file doesn't exist yet).

- [ ] **Step 6: Implement `version-tags.ts`**

Create `internal/versioning/version-tags.ts`:

```ts
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

  const major =
    typeof declared === 'number'
      ? declared
      : Number.parseInt(String(declared), 10)

  if (!Number.isInteger(major) || major < 1) {
    throw new Error(`${versionPath} has an invalid 'version' value: ${declared}`)
  }

  const parsed = semver.parse(`${major}.0.0`)
  if (!parsed) {
    throw new Error(`${versionPath} produced an unparseable version: ${major}.0.0`)
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
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run internal/versioning/version-tags.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Add `version.yml` to `ladon/setup` and `ladon/arbiter`**

Create `ladon/setup/version.yml`:

```yaml
version: 1
```

Create `ladon/arbiter/version.yml`:

```yaml
version: 1
```

(This matches the `ladon/setup/v1`/`ladon/arbiter/v1` tags that already exist, so this is a no-op for the next tag cut, not a re-tag.)

- [ ] **Step 9: Wire `version-tags.ts` into `index.ts`, delete `getActionType`**

Modify `internal/versioning/index.ts`:

Remove the `getActionType` function entirely (the block from `async function getActionType(` through its closing `}` right before `async function run()`).

Remove these now-unused imports from the top of the file:

```ts
import { existsSync } from 'node:fs'
```
```ts
import type { SemVer } from 'semver'
```

and remove `readFile` from the `node:fs/promises` import (keep `readdir`):

```ts
import { readdir } from 'node:fs/promises'
```

Remove the now-unused `yaml` import:

```ts
import yaml from 'yaml'
```

Add the new import:

```ts
import { computeNextVersion, readDeclaredMajorVersion } from './version-tags.js'
```

Inside `run()`, replace this block:

```ts
            const actionInfo = await getActionType(action)
            if (!actionInfo) {
              warning(
                `Could not determine action type for ${action}, skipping...`,
              )
              return null
            }
            const { type: actionType, majorVersion: activeMajorVersion } =
              actionInfo

            if (!actionType) {
              warning(
                `Could not determine action type for ${action}, skipping...`,
              )
              return null
            }

            if (!activeMajorVersion) {
              warning(
                `Could not determine major version for ${action}, skipping...`,
              )
              return null
            }
```

with:

```ts
            const activeMajorVersion = await readDeclaredMajorVersion(action)
```

Replace this block:

```ts
            let newVersion: null | string = null
            if (actionTags.length === 0) {
              newVersion = '1.0.0'
            } else {
              const currentVersion = actionTags[0].version
              info(`[${action}] Current Version ${currentVersion}`)
              if (semver.compare(currentVersion, activeMajorVersion) < 0) {
                newVersion = semver.inc(currentVersion, 'major')
              } else {
                newVersion = semver.inc(currentVersion, 'patch')
              }
            }

            if (!newVersion) {
              throw new Error('Failed to determine new version')
            }

            const previousVersion =
              actionTags.length > 0 ? actionTags[0].version : null
            const isMajor =
              previousVersion !== null &&
              semver.compare(previousVersion, activeMajorVersion) < 0
```

with:

```ts
            const previousVersion =
              actionTags.length > 0 ? actionTags[0].version : null
            info(`[${action}] Current Version ${previousVersion ?? '(none)'}`)
            const { version: newVersion, isMajor } = computeNextVersion({
              currentVersion: previousVersion,
              declaredMajor: activeMajorVersion,
            })
```

- [ ] **Step 10: Type-check and run the full test suite for the package**

Run: `npx tsc --noEmit -p internal/versioning/tsconfig.json`
Expected: no errors.

Run: `npx vitest run internal/versioning`
Expected: PASS.

- [ ] **Step 11: Rebuild the committed bundle**

Run: `cd internal/versioning && ../../node_modules/.bin/ncc build index.ts && cd ../..`
Expected: `internal/versioning/dist/index.js` is rewritten.

- [ ] **Step 12: Format**

Run: `npx @biomejs/biome format --write internal/versioning/index.ts internal/versioning/version-tags.ts internal/versioning/version-tags.test.ts`
Expected: files reformatted in place (or reported unchanged if already compliant).

- [ ] **Step 13: Commit**

```bash
git add internal/versioning/index.ts internal/versioning/version-tags.ts internal/versioning/version-tags.test.ts internal/versioning/package.json internal/versioning/tsconfig.json internal/versioning/dist/index.js ladon/setup/version.yml ladon/arbiter/version.yml package-lock.json
git commit -m "fix(versioning): derive action major version from version.yml, not package.json"
```

---

### Task 2: Paginate the changed-files lookup

`compareCommits` returns at most 300 changed files in a single call; a large merge (mass reformat, lockfile churn) can silently leave a changed action untagged (issue #4, bullet 2). Extract the lookup into its own paginated function.

**Files:**
- Create: `internal/versioning/changed-files.ts`
- Create: `internal/versioning/changed-files.test.ts`
- Modify: `internal/versioning/index.ts`
- Modify: `internal/versioning/tsconfig.json`

**Interfaces:**
- Produces: `listChangedFiles(params: { octokit: ReturnType<typeof github.getOctokit>; owner: string; repo: string; base: string; head: string }): Promise<string[]>`
- Consumes: `github` types from `@actions/github` (already a dependency).

- [ ] **Step 1: Write the failing tests**

Create `internal/versioning/changed-files.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'
import { listChangedFiles } from './changed-files.js'

describe('listChangedFiles', () => {
  test('accumulates filenames across multiple pages', async () => {
    const octokit: any = {
      paginate: vi.fn(async (_route: unknown, _params: unknown, mapFn: any) => {
        const page1 = {
          data: { files: [{ filename: 'a.ts' }, { filename: 'b.ts' }] },
        }
        const page2 = { data: { files: [{ filename: 'c.ts' }] } }
        return [...mapFn(page1), ...mapFn(page2)]
      }),
      rest: { repos: { compareCommits: vi.fn() } },
    }

    const files = await listChangedFiles({
      octokit,
      owner: 'o',
      repo: 'r',
      base: 'sha1',
      head: 'sha2',
    })

    expect(files).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.repos.compareCommits,
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        base: 'sha1',
        head: 'sha2',
        per_page: 100,
      }),
      expect.any(Function),
    )
  })

  test('returns an empty array when the compare has no files', async () => {
    const octokit: any = {
      paginate: vi.fn(async (_route: unknown, _params: unknown, mapFn: any) =>
        mapFn({ data: {} }),
      ),
      rest: { repos: { compareCommits: vi.fn() } },
    }

    const files = await listChangedFiles({
      octokit,
      owner: 'o',
      repo: 'r',
      base: 'a',
      head: 'b',
    })

    expect(files).toEqual([])
  })
})
```

- [ ] **Step 2: Add the new file to `tsconfig.json`**

Modify `internal/versioning/tsconfig.json`:

```json
  "include": ["index.ts", "version-tags.ts", "changed-files.ts"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run internal/versioning/changed-files.test.ts`
Expected: FAIL — `Cannot find module './changed-files.js'`.

- [ ] **Step 4: Implement `changed-files.ts`**

Create `internal/versioning/changed-files.ts`:

```ts
import type * as github from '@actions/github'

export async function listChangedFiles(params: {
  octokit: ReturnType<typeof github.getOctokit>
  owner: string
  repo: string
  base: string
  head: string
}): Promise<string[]> {
  const { octokit, owner, repo, base, head } = params
  const files = await octokit.paginate(
    octokit.rest.repos.compareCommits,
    { owner, repo, base, head, per_page: 100 },
    (response) => response.data.files ?? [],
  )
  return files.map((file) => file.filename)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run internal/versioning/changed-files.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Wire it into `index.ts`**

Add the import:

```ts
import { listChangedFiles } from './changed-files.js'
```

Replace this block in `run()`:

```ts
    } else {
      const response = await octokit.rest.repos.compareCommits({
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: context.payload.before,
        head: context.payload.after,
      })
      files = (response.data.files || []).map((file) => file.filename)
    }
```

with:

```ts
    } else {
      files = await listChangedFiles({
        octokit,
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: context.payload.before,
        head: context.payload.after,
      })
    }
```

- [ ] **Step 7: Type-check and run the full package test suite**

Run: `npx tsc --noEmit -p internal/versioning/tsconfig.json`
Expected: no errors.

Run: `npx vitest run internal/versioning`
Expected: PASS.

- [ ] **Step 8: Rebuild the committed bundle**

Run: `cd internal/versioning && ../../node_modules/.bin/ncc build index.ts && cd ../..`
Expected: `internal/versioning/dist/index.js` is rewritten.

- [ ] **Step 9: Format**

Run: `npx @biomejs/biome format --write internal/versioning/index.ts internal/versioning/changed-files.ts internal/versioning/changed-files.test.ts`

- [ ] **Step 10: Commit**

```bash
git add internal/versioning/index.ts internal/versioning/changed-files.ts internal/versioning/changed-files.test.ts internal/versioning/tsconfig.json internal/versioning/dist/index.js
git commit -m "fix(versioning): paginate compareCommits so large merges don't drop changed actions"
```

---

### Task 3: Cap concurrency on tag mutations, finish Biome cleanup

An uncapped `Promise.all` over every modified action's tag mutation can trip GitHub's secondary rate limit as the action count grows (issue #4, bullet 4). Cap it at a small, named constant.

**Files:**
- Create: `internal/versioning/concurrency.ts`
- Create: `internal/versioning/concurrency.test.ts`
- Modify: `internal/versioning/index.ts`
- Modify: `internal/versioning/tsconfig.json`

**Interfaces:**
- Produces: `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>`
- Consumes: nothing beyond standard `Promise`.

- [ ] **Step 1: Write the failing tests**

Create `internal/versioning/concurrency.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { mapWithConcurrency } from './concurrency.js'

describe('mapWithConcurrency', () => {
  test('never runs more than `limit` tasks concurrently', async () => {
    let active = 0
    let maxActive = 0
    const items = Array.from({ length: 10 }, (_, i) => i)

    await mapWithConcurrency(items, 3, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return item * 2
    })

    expect(maxActive).toBeLessThanOrEqual(3)
  })

  test('preserves input order in the result array regardless of completion order', async () => {
    const items = [30, 10, 20]
    const results = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return ms
    })
    expect(results).toEqual([30, 10, 20])
  })

  test('propagates a thrown error from any task', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      }),
    ).rejects.toThrow('boom')
  })
})
```

- [ ] **Step 2: Add the new file to `tsconfig.json`**

Modify `internal/versioning/tsconfig.json`:

```json
  "include": ["index.ts", "version-tags.ts", "changed-files.ts", "concurrency.ts"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run internal/versioning/concurrency.test.ts`
Expected: FAIL — `Cannot find module './concurrency.js'`.

- [ ] **Step 4: Implement `concurrency.ts`**

Create `internal/versioning/concurrency.ts`:

```ts
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  }

  const workerCount = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  return results
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run internal/versioning/concurrency.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire it into `index.ts`**

Add the import:

```ts
import { mapWithConcurrency } from './concurrency.js'
```

Add a named constant near the top of the file, below the `IGNORED_EXTENSIONS` declaration:

```ts
const TAG_MUTATION_CONCURRENCY = 4
```

Replace:

```ts
    const versionedActions: VersionedAction[] = (
      await Promise.all(
        Array.from(modifiedActions).map(
          async (action): Promise<VersionedAction | null> => {
```

with:

```ts
    const versionedActions: VersionedAction[] = (
      await mapWithConcurrency(
        Array.from(modifiedActions),
        TAG_MUTATION_CONCURRENCY,
        async (action): Promise<VersionedAction | null> => {
```

and replace the matching closing:

```ts
          },
        ),
      )
    ).filter((r): r is VersionedAction => r !== null)
```

with:

```ts
        },
      )
    ).filter((r): r is VersionedAction => r !== null)
```

(Only the indentation and the removal of the extra `.map(` wrapper closing paren change here — the per-action function body itself is untouched.)

- [ ] **Step 7: Type-check and run the full package test suite**

Run: `npx tsc --noEmit -p internal/versioning/tsconfig.json`
Expected: no errors.

Run: `npx vitest run internal/versioning`
Expected: PASS (all tests across all three new modules).

- [ ] **Step 8: Rebuild the committed bundle**

Run: `cd internal/versioning && ../../node_modules/.bin/ncc build index.ts && cd ../..`
Expected: `internal/versioning/dist/index.js` is rewritten.

- [ ] **Step 9: Format and do a final 80-col sweep**

Run: `npx @biomejs/biome format --write internal/versioning`

Run this check for any remaining structural (non-prose) lines over 80 columns that Biome's formatter didn't already wrap:

```bash
awk '{ if (length($0) > 80) print FILENAME":"FNR": "length($0) }' \
  internal/versioning/index.ts internal/versioning/version-tags.ts \
  internal/versioning/changed-files.ts internal/versioning/concurrency.ts
```

Expected: any remaining hits are single unbroken string/comment literals (which Biome intentionally never rewraps — same as pre-existing long lines elsewhere in this codebase, e.g. `ladon/setup/src/diff.ts`'s warning messages). If a hit is structural code Biome missed, wrap it by hand.

- [ ] **Step 10: Run the whole repo's build/type-check/test once more**

Run: `npm run type-check && npm run test && npm run build`
Expected: all pass across every workspace.

- [ ] **Step 11: Commit**

```bash
git add internal/versioning/index.ts internal/versioning/concurrency.ts internal/versioning/concurrency.test.ts internal/versioning/tsconfig.json internal/versioning/dist/index.js
git commit -m "fix(versioning): cap tag-mutation concurrency to avoid secondary rate limits"
```

---

## Self-Review Notes

- **Spec coverage:** All four "inherited from scope3 versioning source" bullets from issue #4 are covered — Task 1 (bullets 1 and 3), Task 2 (bullet 2), Task 3 (bullet 4). The "Correctness (priority)" composite-ref switch and the "initial tagging" ops item are already done (`#5`, existing tags) and intentionally have no task here. The default-branch ops item is explicitly out of scope (admin permissions; user is handling it). The Biome 80-col item is folded into Task 3's final sweep since the one genuinely-fixable line (a structural return statement) moves during the refactor and is easiest to verify once, at the end.
- **No placeholders:** every step has literal file contents/diffs and literal shell commands with expected output.
- **Type/name consistency check:** `readDeclaredMajorVersion` / `computeNextVersion` (Task 1), `listChangedFiles` (Task 2), `mapWithConcurrency` (Task 3) are named once and used identically at every call site across tasks.

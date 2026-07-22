import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  debug,
  error as errorMsg,
  getInput,
  info,
  setFailed,
  setOutput,
  warning,
} from '@actions/core'
import * as github from '@actions/github'
import semver from 'semver'
import { computeNextVersion, readDeclaredMajorVersion } from './version-tags.js'
import { listChangedFiles } from './changed-files.js'
import { mapWithConcurrency } from './concurrency.js'

interface VersionedAction {
  name: string
  version: string
  previousVersion: string | null
  isMajor: boolean
}

const createOrBumpRef = async (params: {
  octokit: ReturnType<typeof github.getOctokit>
  repo: string
  owner: string
  action: string
  version: string
  sha: string
}) => {
  const { repo, owner, action, version, sha, octokit } = params
  try {
    const tag = `${action}/v${version}`
    info(`Creating new tag: ${tag} for ${action}`)
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha,
      force: true,
    })
    info(`Created tag for ${tag}`)
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes('Reference already exists')
    ) {
      const bumpedVersion = semver.inc(version, 'patch')
      if (!bumpedVersion) {
        errorMsg(`Failed to bump version ${version}`)
      } else {
        return await createOrBumpRef({
          octokit,
          repo,
          owner,
          action,
          version: bumpedVersion,
          sha,
        })
      }
    } else {
      errorMsg(
        error instanceof Error
          ? error.message
          : 'Error occurred while creating tag',
      )
      throw error
    }
  }
}

async function hasActionFile(dir: string): Promise<boolean> {
  try {
    const contents = await readdir(dir)
    return contents.includes('action.yml') || contents.includes('action.yaml')
  } catch (error: unknown) {
    errorMsg(`Failed to read directory ${dir}: ${error}`)
    return false
  }
}

async function isActionDirectory(
  filePath: string,
  retries = 0,
): Promise<string | null> {
  debug(`Checking if ${filePath} is an action directory...`)

  if (retries >= 5) {
    debug(`Reached maximum retries: ${retries}`)
    return null
  }

  try {
    // Get the directory containing the file
    const dir = path.dirname(filePath)

    // Skip internal versioning directory itself
    if (dir === 'internal/versioning' || dir.endsWith('/internal/versioning')) {
      debug(`Skipping internal versioning directory: ${dir}`)
      return null
    }

    // Check if this is an action directory
    if (await hasActionFile(dir)) {
      return dir
    }

    // If we're at the root directory, stop checking
    if (dir === '.' || dir === '/') {
      debug(`Reached root directory: ${dir}`)
      return null
    }

    // Otherwise, check the parent directory
    return isActionDirectory(dir, retries + 1)
  } catch (error: unknown) {
    warning(`Failed to check for action files: ${(error as Error).message}`)
    return null
  }
}

const IGNORED_DIRS = /\.git|\.github|node_modules|dist|__mocks__|internal/
const IGNORED_EXTENSIONS = /\.(md|jsonc|sh|gitignore|nvmrc)$/
const TAG_MUTATION_CONCURRENCY = 4
async function getAllFiles(dir: string = process.cwd()) {
  return (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        !IGNORED_DIRS.test(entry.parentPath) &&
        !IGNORED_EXTENSIONS.test(entry.name),
    )
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
}

async function run() {
  try {
    const token = getInput('token')
    const runForAll = getInput('runForAll').toLowerCase() === 'true'
    const dryRun = getInput('dryRun').toLowerCase() === 'true'
    const _package = getInput('package')
    const octokit = github.getOctokit(token)
    const context = github.context

    info(`Event name: ${context.eventName}`)
    info(`SHA: ${context.sha}`)
    info(`runForAll: ${runForAll}`)
    info(`dryRun: ${dryRun}`)

    let files: string[] = []

    if (_package && runForAll) {
      warning(
        `'runForAll' is enabled, but package is specified. Please specify a package or disable 'runForAll'.`,
      )
      setOutput('versioned-actions', '[]')
      return
    }

    if (_package) {
      for (const ext of ['yaml', 'yml']) {
        const packagePath = path.join(_package, `action.${ext}`)
        if (existsSync(packagePath)) {
          info(`Running for package "${_package}"`)
          files = [packagePath]
          break
        }
      }

      if (!files.length) {
        warning(`Package "${_package}" not found`)
        setOutput('versioned-actions', '[]')
        return
      }
    } else if (runForAll) {
      info('Run for all enabled, getting all action files')
      files = await getAllFiles()
    } else {
      files = await listChangedFiles({
        octokit,
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: context.payload.before,
        head: context.payload.after,
      })
    }

    info(`Changed Files: ${files.join(', ')}`)

    const modifiedActions = new Set<string>()
    for (const file of files) {
      const actionDir = await isActionDirectory(file)
      if (actionDir !== null && !modifiedActions.has(actionDir)) {
        info(`Found action directory: ${actionDir}`)
        modifiedActions.add(actionDir)
      }
    }

    if (modifiedActions.size === 0) {
      info('No actions were modified in this merge.')
      setOutput('versioned-actions', '[]')
      return
    }
    info(`Modified Actions: ${Array.from(modifiedActions).join(', ')}`)

    const versionedActions: VersionedAction[] = await mapWithConcurrency(
      Array.from(modifiedActions),
      TAG_MUTATION_CONCURRENCY,
      async (action): Promise<VersionedAction> => {
        info(`Processing action: ${action}`)

        const activeMajorVersion = await readDeclaredMajorVersion(action)

        const { data: tags } = await octokit.rest.git.listMatchingRefs({
          owner: context.repo.owner,
          repo: context.repo.repo,
          ref: `tags/${action}/v`,
          headers: {
            'X-GitHub-Api-Version': '2022-11-28',
          },
        })

        info(`Existing tags: ${tags.map((tag) => tag.ref).join(', ')}`)

        const actionTags = tags
          .filter((tag) => tag.ref.startsWith(`refs/tags/${action}/v`))
          .map((tag) => ({
            name: tag.ref.replace('refs/tags/', ''),
            version: tag.ref.replace(`refs/tags/${action}/v`, ''),
          }))
          .filter((tag) => semver.valid(tag.version))

        actionTags.sort((a, b) => semver.rcompare(a.version, b.version))

        if (actionTags.length) {
          info(`Latest Tag: ${actionTags[0].name} (${actionTags[0].version})`)
        }

        const previousVersion =
          actionTags.length > 0 ? actionTags[0].version : null
        info(`[${action}] Current Version ${previousVersion ?? '(none)'}`)
        const { version: newVersion, isMajor } = computeNextVersion({
          currentVersion: previousVersion,
          declaredMajor: activeMajorVersion,
        })

        const newTag = `${action}/v${newVersion}`
        !dryRun
          ? await createOrBumpRef({
              octokit,
              owner: context.repo.owner,
              repo: context.repo.repo,
              action,
              version: newVersion,
              sha: context.sha,
            })
          : info(`Dry run: Skipping tag creation for ${newTag}`)

        // Keep the floating major-version tag (e.g. v2) pointing at the
        // latest patch so callers pinned to @v2 always get current code.
        const majorVersion = `${action}/v${semver.major(newVersion)}`
        info(`Updating floating tag ${majorVersion} to ${context.sha}`)

        let floatingTagExists = false
        try {
          await octokit.rest.git.getRef({
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: `tags/${majorVersion}`,
          })
          floatingTagExists = true
        } catch {
          // tag does not exist yet — will be created below
        }

        if (floatingTagExists) {
          if (!dryRun) {
            await octokit.rest.git.updateRef({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: `tags/${majorVersion}`,
              sha: context.sha,
              force: true,
            })
            info(`Updated floating tag ${majorVersion} to ${context.sha}`)
          } else {
            info(`Dry run: Skipping tag update for ${majorVersion}`)
          }
        } else {
          if (!dryRun) {
            await octokit.rest.git.createRef({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: `refs/tags/${majorVersion}`,
              sha: context.sha,
            })
            info(`Created floating tag ${majorVersion} at ${context.sha}`)
          } else {
            info(`Dry run: Skipping tag creation for ${majorVersion}`)
          }
        }

        return {
          name: action,
          version: newVersion,
          previousVersion,
          isMajor,
        }
      },
    )

    setOutput(
      'versioned-actions',
      dryRun ? '[]' : JSON.stringify(versionedActions),
    )
  } catch (err: unknown) {
    errorMsg(err as Error)
    setFailed('Failed to run versioning')
  }
}

run()

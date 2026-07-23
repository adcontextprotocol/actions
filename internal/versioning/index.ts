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
import { listActionTags } from './action-tags.js'
import { listChangedFiles } from './changed-files.js'
import { mapWithConcurrency } from './concurrency.js'
import { createOrBumpTag } from './create-tag.js'
import { isIgnoredDir, isVersionRelevantFile } from './paths.js'
import { computeNextVersion, readDeclaredMajorVersion } from './version-tags.js'

interface VersionedAction {
  name: string
  version: string
  previousVersion: string | null
  isMajor: boolean
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

// GitHub can trip secondary rate limits on rapid ref mutations, so cap how
// many actions we tag concurrently.
const TAG_MUTATION_CONCURRENCY = 4
async function getAllFiles(dir: string = process.cwd()) {
  return (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        !isIgnoredDir(path.relative(dir, entry.parentPath)) &&
        isVersionRelevantFile(entry.name),
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
      const changed = await listChangedFiles({
        octokit,
        owner: context.repo.owner,
        repo: context.repo.repo,
        base: context.payload.before,
        head: context.payload.after,
      })
      files = changed.filter(
        (file) =>
          isVersionRelevantFile(path.basename(file)) &&
          !isIgnoredDir(path.dirname(file)),
      )
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

        const actionTags = await listActionTags({
          octokit,
          owner: context.repo.owner,
          repo: context.repo.repo,
          action,
        })

        info(`Existing tags: ${actionTags.map((tag) => tag.name).join(', ')}`)

        if (actionTags.length) {
          info(`Latest Tag: ${actionTags[0].name} (${actionTags[0].version})`)
        }

        const previousVersion =
          actionTags.find(
            (tag) => semver.major(tag.version) === activeMajorVersion.major,
          )?.version ?? null
        info(`[${action}] Current Version ${previousVersion ?? '(none)'}`)
        const { version: newVersion, isMajor } = computeNextVersion({
          existingVersions: actionTags.map((tag) => tag.version),
          declaredMajor: activeMajorVersion,
        })

        const newTag = `${action}/v${newVersion}`
        let createdVersion = newVersion
        if (!dryRun) {
          createdVersion = await createOrBumpTag({
            octokit,
            owner: context.repo.owner,
            repo: context.repo.repo,
            action,
            version: newVersion,
            sha: context.sha,
          })
        } else {
          info(`Dry run: Skipping tag creation for ${newTag}`)
        }

        // Keep the floating major-version tag (e.g. v2) pointing at the
        // latest patch so callers pinned to @v2 always get current code.
        const majorVersion = `${action}/v${semver.major(createdVersion)}`
        info(`Updating floating tag ${majorVersion} to ${context.sha}`)

        let floatingTagExists = false
        try {
          await octokit.rest.git.getRef({
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: `tags/${majorVersion}`,
          })
          floatingTagExists = true
        } catch (error: unknown) {
          if ((error as { status?: number }).status !== 404) {
            throw error
          }
          // 404: tag does not exist yet — will be created below
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
            try {
              await octokit.rest.git.createRef({
                owner: context.repo.owner,
                repo: context.repo.repo,
                ref: `refs/tags/${majorVersion}`,
                sha: context.sha,
              })
              info(`Created floating tag ${majorVersion} at ${context.sha}`)
            } catch (error: unknown) {
              // A concurrent or retried run may have created the tag between
              // the existence check and here; fall back to moving it.
              if (
                error instanceof Error &&
                error.message.includes('Reference already exists')
              ) {
                await octokit.rest.git.updateRef({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  ref: `tags/${majorVersion}`,
                  sha: context.sha,
                  force: true,
                })
                info(`Updated floating tag ${majorVersion} to ${context.sha}`)
              } else {
                throw error
              }
            }
          } else {
            info(`Dry run: Skipping tag creation for ${majorVersion}`)
          }
        }

        return {
          name: action,
          version: createdVersion,
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
    setOutput('versioned-actions', '[]')
    setFailed('Failed to run versioning')
  }
}

run()

import { error as errorMsg, info } from '@actions/core'
import type * as github from '@actions/github'
import semver from 'semver'

// Creates the exact tag; if it already exists, patch-bumps until a free
// version is found. Returns the version actually created so callers report the
// real tag, not the originally-computed one.
export async function createOrBumpTag(params: {
  octokit: ReturnType<typeof github.getOctokit>
  repo: string
  owner: string
  action: string
  version: string
  sha: string
}): Promise<string> {
  const { repo, owner, action, version, sha, octokit } = params
  const tag = `${action}/v${version}`
  try {
    info(`Creating new tag: ${tag} for ${action}`)
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha,
      force: true,
    })
    info(`Created tag for ${tag}`)
    return version
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes('Reference already exists')
    ) {
      const bumpedVersion = semver.inc(version, 'patch')
      if (!bumpedVersion) {
        throw new Error(`Failed to bump version ${version}`)
      }
      return await createOrBumpTag({
        octokit,
        repo,
        owner,
        action,
        version: bumpedVersion,
        sha,
      })
    }
    errorMsg(
      error instanceof Error
        ? error.message
        : 'Error occurred while creating tag',
    )
    throw error
  }
}

import type * as github from '@actions/github'
import semver from 'semver'

export async function listActionTags(params: {
  octokit: ReturnType<typeof github.getOctokit>
  owner: string
  repo: string
  action: string
}): Promise<{ name: string; version: string }[]> {
  const { octokit, owner, repo, action } = params
  const prefix = `refs/tags/${action}/v`

  const refs = await octokit.paginate(
    octokit.rest.git.listMatchingRefs,
    {
      owner,
      repo,
      ref: `tags/${action}/v`,
      per_page: 100,
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    },
    (response) => response.data,
  )

  return refs
    .filter((ref) => ref.ref.startsWith(prefix))
    .map((ref) => ({
      name: ref.ref.replace('refs/tags/', ''),
      version: ref.ref.replace(prefix, ''),
    }))
    .filter((tag) => semver.valid(tag.version) !== null)
    .sort((a, b) => semver.rcompare(a.version, b.version))
}

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

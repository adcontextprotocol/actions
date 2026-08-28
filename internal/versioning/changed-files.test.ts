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
